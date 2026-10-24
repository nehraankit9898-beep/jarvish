// offline-runner.ts — executes a deterministic offline command.
//
// Safety: this module NEVER runs a shell command. It can only
//   * open an allowlisted https URL,
//   * open an allowlisted application,
//   * read the assistant's own status / last error,
//   * cancel the latest running task,
// and it goes through `requestHostAction` for the launch actions, so the
// existing permission + approval + audit system stays in charge (in the
// default `ask` mode an open waits for the user's approval).

import { db } from '@/lib/db';
import {
  hostMode,
  requestHostAction,
  type HostAction,
} from './host-control';
import { recordAudit } from './audit';
import { cancelTaskExecution } from './execution-cancellation';
import { readLastError, recordLastError } from './last-action-error';
import { voiceBridgeStatus } from './voice-bridge';
import { listProviderConfigs, readStudioSettings } from './provider-store';
import {
  buildOfflineResult,
  openFailureSentence,
  openSuccessSentence,
  approvalSentence,
  OFFLINE_HELP_TEXT,
  type OfflineCommand,
  type OfflineResult,
} from './offline-commands';
import { createActionId, actionLabel } from '@/lib/action-lifecycle';
import { sanitizeProviderMessage } from '@/lib/provider-errors';

/** Is this a command the deterministic offline layer can handle? */
export async function runOfflineCommand(command: OfflineCommand): Promise<OfflineResult> {
  const actionId = createActionId('offline');
  const label = 'label' in command && typeof command.label === 'string' ? command.label : command.kind;

  try {
    switch (command.kind) {
      case 'open_site':
        return await openTarget(actionId, label, { kind: 'open', target: command.url }, 'website');
      case 'open_app':
        return await openTarget(actionId, label, { kind: 'open', target: command.target }, 'application');
      case 'status':
        return await statusResult(actionId);
      case 'last_error':
        return lastErrorResult(actionId);
      case 'cancel':
        return await cancelResult(actionId);
      case 'help':
        return buildOfflineResult({
          command,
          outcome: 'succeeded',
          actionId,
          spoken: OFFLINE_HELP_TEXT,
          detail: 'offline help',
        });
      default:
        return buildOfflineResult({
          command,
          outcome: 'unsupported',
          actionId,
          spoken: 'Yeh command offline mode me support nahi hai.',
          detail: 'unsupported',
        });
    }
  } catch (err) {
    const detail = sanitizeProviderMessage(err instanceof Error ? err.message : 'unknown error');
    recordLastError({ what: `Offline ${command.kind}`, category: 'unknown', message: detail });
    await recordAudit({
      actor: 'user',
      action: `offline.${command.kind}`,
      category: 'general',
      approval: 'auto',
      result: 'error',
      errorCategory: 'exception',
      error: detail,
      details: { label },
    }).catch(() => undefined);
    return buildOfflineResult({
      command,
      outcome: 'failed',
      actionId,
      spoken: `${label} fail ho gaya. Error: ${detail}`,
      detail,
      errorCategory: 'unknown',
    });
  }
}

async function openTarget(
  actionId: string,
  label: string,
  action: HostAction,
  what: 'website' | 'application'
): Promise<OfflineResult> {
  const outcome = await requestHostAction(action, 'user');

  if (outcome.status === 'refused') {
    const detail = sanitizeProviderMessage(outcome.reason);
    recordLastError({ what: `Open ${what}`, category: 'config', message: detail });
    await recordAudit({
      actor: 'user',
      action: `offline.${action.kind}`,
      category: 'security',
      approval: 'denied',
      result: 'error',
      errorCategory: 'config',
      error: detail,
      details: { target: action.kind === 'open' ? action.target : '' },
    }).catch(() => undefined);
    return buildOfflineResult({
      command: action.kind === 'open' ? 'open_site' : 'open_app',
      label,
      outcome: 'failed',
      actionId,
      spoken: `${label.replace(/\s+kholna$/i, '')} open nahi ho paya. Reason: ${detail}`,
      detail,
      errorCategory: 'config',
      refused: true,
    });
  }

  if (outcome.status === 'approval_required') {
    await recordAudit({
      actor: 'user',
      action: `offline.${action.kind}`,
      category: 'general',
      approval: 'auto',
      result: 'ok',
      details: { target: action.kind === 'open' ? action.target : '', approvalId: outcome.id },
    }).catch(() => undefined);
    return buildOfflineResult({
      command: action.kind === 'open' ? 'open_site' : 'open_app',
      label,
      outcome: 'needs_approval',
      actionId,
      approvalId: outcome.id,
      spoken: approvalSentence(label),
      detail: `${outcome.summary} — ${outcome.reason}`,
    });
  }

  const ok = outcome.result.ok;
  const detail = ok
    ? `opened ${action.kind === 'open' ? action.target : ''}`
    : sanitizeProviderMessage(outcome.result.error ?? 'the operating system refused the request');
  if (ok) {
    await recordAudit({
      actor: 'user',
      action: `offline.${action.kind}`,
      category: 'general',
      approval: 'auto',
      result: 'ok',
      details: { target: action.kind === 'open' ? action.target : '' },
    }).catch(() => undefined);
  } else {
    recordLastError({ what: `Open ${what}`, category: 'unknown', message: detail });
    await recordAudit({
      actor: 'user',
      action: `offline.${action.kind}`,
      category: 'general',
      approval: 'auto',
      result: 'error',
      errorCategory: 'unknown',
      error: detail,
      details: { target: action.kind === 'open' ? action.target : '' },
    }).catch(() => undefined);
  }

  return buildOfflineResult({
    command: action.kind === 'open' ? 'open_site' : 'open_app',
    label,
    outcome: ok ? 'succeeded' : 'failed',
    actionId,
    spoken: ok ? openSuccessSentence(label) : openFailureSentence(label, detail),
    detail,
    errorCategory: ok ? undefined : 'unknown',
  });
}

async function statusResult(actionId: string): Promise<OfflineResult> {
  const host = hostMode();
  const voice = voiceBridgeStatus();

  let providerLine = 'Provider status database se nahi padh paya.';
  let configured = 0;
  let verified = 0;
  let failing: string[] = [];
  let selectedProvider = 'unknown';
  try {
    const [providers, settings] = await Promise.all([listProviderConfigs(), readStudioSettings()]);
    configured = providers.filter((p) => p.configured).length;
    verified = providers.filter((p) => p.lastTestOk === true).length;
    failing = providers
      .filter((p) => p.lastTestOk === false)
      .map((p) => `${p.name}${p.lastError ? ` (${sanitizeProviderMessage(p.lastError, []).slice(0, 60)})` : ''}`)
      .slice(0, 3);
    selectedProvider = settings.defaultProvider || 'zai';
    providerLine =
      verified > 0
        ? `${verified} provider verified, ${configured} configured. Selected: ${selectedProvider}.`
        : `${configured} provider configured, koi verified nahi. Selected: ${selectedProvider}.`;
  } catch {
    // database unavailable — the rest of the status is still useful
  }

  const voiceLine = voice.enabled
    ? voice.ready
      ? `Voice bridge ready${voice.ttsAvailable ? ' (natural TTS)' : ' (TTS unavailable — browser voice)'}`
      : `Voice bridge down${voice.lastError ? `: ${voice.lastError}` : ''}`
    : 'Voice bridge disabled — browser voice use hoga';

  const detail = [
    providerLine,
    voiceLine,
    `Laptop mode: ${host}`,
    failing.length ? `Failing: ${failing.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join(' | ');

  await recordAudit({
    actor: 'user',
    action: 'offline.status',
    category: 'general',
    approval: 'auto',
    details: { configured, verified, host, voiceReady: voice.ready },
  }).catch(() => undefined);

  return buildOfflineResult({
    command: 'status',
    outcome: 'succeeded',
    actionId,
    spoken: `Status: ${providerLine} ${voiceLine}. Laptop mode ${host}.`,
    detail,
  });
}

function lastErrorResult(actionId: string): OfflineResult {
  const last = readLastError();
  if (!last) {
    return buildOfflineResult({
      command: 'last_error',
      outcome: 'succeeded',
      actionId,
      spoken: 'Is session me abhi tak koi error record nahi hua.',
      detail: 'no error recorded',
    });
  }
  const when = new Date(last.at).toLocaleTimeString();
  return buildOfflineResult({
    command: 'last_error',
    outcome: 'succeeded',
    actionId,
    spoken: `Pichhli error (${when}): ${last.what} — ${last.message}${last.hint ? ` ${last.hint}` : ''}`,
    detail: `${last.what} [${last.category}] ${last.message}`,
    errorCategory: last.category,
  });
}

async function cancelResult(actionId: string): Promise<OfflineResult> {
  try {
    const task = await db.agenticTask.findFirst({
      where: { status: { in: ['planning', 'running', 'paused', 'awaiting_approval'] } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, prompt: true, status: true },
    });
    if (!task) {
      return buildOfflineResult({
        command: 'cancel',
        outcome: 'cancelled',
        actionId,
        spoken: 'Abhi koi chalu task nahi hai, isliye cancel karne ke liye kuch nahi mila.',
        detail: 'no active task',
      });
    }
    await db.agenticTask.update({
      where: { id: task.id },
      data: { status: 'cancelled', pendingCommand: null },
    });
    const stopped = cancelTaskExecution(task.id);
    const label = actionLabel(task.prompt, 'task');
    await recordAudit({
      actor: 'user',
      taskId: task.id,
      action: 'task.cancel',
      category: 'task',
      details: { via: 'offline command', from: task.status, cancelledOperations: stopped },
    }).catch(() => undefined);
    return buildOfflineResult({
      command: 'cancel',
      outcome: 'cancelled',
      actionId,
      spoken: `${label} cancel kar diya.`,
      detail: `cancelled task ${task.id}`,
    });
  } catch (err) {
    const detail = sanitizeProviderMessage(err instanceof Error ? err.message : 'cancel failed');
    recordLastError({ what: 'Cancel task', category: 'unknown', message: detail });
    return buildOfflineResult({
      command: 'cancel',
      outcome: 'failed',
      actionId,
      spoken: `Cancel nahi ho paya. Error: ${detail}`,
      detail,
      errorCategory: 'unknown',
    });
  }
}
