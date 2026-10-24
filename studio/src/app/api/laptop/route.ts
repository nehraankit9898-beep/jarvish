import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  safetyStatus,
  engageKill,
  releaseKill,
  isKilled,
  getKillState,
} from '@/lib/agentic/safety';
import { allowedRoots, listTreeUnderRoot } from '@/lib/agentic/allowed-roots';
import {
  bridgeStatus,
  ensureBridge,
  stopBridge,
  isValidEndpoint,
} from '@/lib/agentic/desktop-bridge';
import { recentDownloads } from '@/lib/agentic/downloads';
import { searchBrowserHistory } from '@/lib/agentic/browser-history';
import { requestHostAction, hostMode, trustedDirs } from '@/lib/agentic/host-control';
import { registerLaptopTools } from '@/lib/agentic/laptop-tools';
import { connectRealChrome } from '@/lib/agentic/browser/browser-service';
import { telegramStatus, startTelegramBot, stopTelegramBot } from '@/lib/agentic/telegram-connector';
import { voiceBridgeStatus, ensureVoiceBridge } from '@/lib/agentic/voice-bridge';
import { createNotification } from '@/lib/agentic/notifications';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/laptop — one status payload for the Laptop panel:
 * safety (kill switch, modes, hotkey), allowed roots, desktop bridge,
 * recent downloads, telegram bot, host mode + trusted dirs.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  registerLaptopTools();
  const kill = getKillState();

  return Response.json({
    safety: safetyStatus(),
    killed: kill.killed,
    host: {
      mode: hostMode(),
      trustedDirs: trustedDirs(),
    },
    roots: allowedRoots(),
    bridge: bridgeStatus(),
    downloads: recentDownloads(15),
    telegram: telegramStatus(),
    // Jarvis #3/#1: the voice bridge (edge-tts + wake word) lives beside the
    // desktop bridge — the panel shows its status and install hint
    voice: { ...voiceBridgeStatus(), ensureHint: 'Voice bridge tab start hota hai jab voice feature use hota hai.' },
  });
}

/**
 * POST /api/laptop — user actions from the panel. Every op is audit-logged;
 * anything that touches the laptop flows through requestHostAction so the
 * SAME approval queue is used.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  let body: { op?: string; [k: string]: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const op = String(body.op ?? '');

  const audit = (action: string, details: Record<string, unknown>, ok = true, error?: string) =>
    recordAudit({
      actor: 'user',
      action,
      category: 'security',
      approval: 'auto',
      result: ok ? 'ok' : 'error',
      error,
      details,
      ip: clientIp(req.headers),
    });

  try {
    switch (op) {
      // ---- kill switch (Roadmap #1) ----
      case 'kill': {
        const state = engageKill('user pressed KILL in the UI', 'ui');
        stopBridge(); // mouse/keyboard process goes down immediately
        await audit('laptop.kill', { at: state.at });
        await createNotification({
          type: 'system',
          title: 'KILL SWITCH engaged',
          body: 'Saare laptop actions refused hain. Laptop panel me Resume dabao.',
          data: { source: 'ui' },
        });
        return Response.json({ ok: true, killed: true, state });
      }
      case 'resume': {
        const state = releaseKill('ui');
        await audit('laptop.resume', { at: state.at });
        return Response.json({ ok: true, killed: false, state });
      }
      case 'kill-status': {
        return Response.json({ ok: true, killed: isKilled() });
      }

      // ---- desktop bridge lifecycle ----
      case 'bridge-start': {
        const proc = await ensureBridge();
        const st = bridgeStatus();
        await audit('laptop.bridge_start', { ready: st.ready, error: st.lastError });
        return Response.json({ ok: Boolean(proc?.ready), status: st });
      }
      case 'bridge-stop': {
        stopBridge();
        await audit('laptop.bridge_stop', {});
        return Response.json({ ok: true, status: bridgeStatus() });
      }

      // ---- telegram bot lifecycle ----
      case 'telegram-start': {
        const started = startTelegramBot();
        await audit('laptop.telegram_start', { started });
        return Response.json({ ok: started, status: telegramStatus() });
      }
      case 'telegram-stop': {
        stopTelegramBot();
        await audit('laptop.telegram_stop', {});
        return Response.json({ ok: true, status: telegramStatus() });
      }

      // ---- allowed roots tree ----
      case 'tree': {
        const res = listTreeUnderRoot(String(body.path ?? ''), Number(body.maxDepth ?? 2));
        await audit('laptop.tree', { path: String(body.path ?? ''), ok: res.ok });
        return Response.json(res);
      }

      // ---- download a URL (approval-gated via host-control) ----
      case 'download': {
        const url = String(body.url ?? '').trim();
        if (!/^https?:\/\//i.test(url)) {
          return Response.json({ error: 'http(s) URL required' }, { status: 400 });
        }
        const out = await requestHostAction(
          { kind: 'download', url, filename: body.filename ? String(body.filename) : undefined },
          'user'
        );
        if (out.status === 'done') return Response.json({ ok: out.result.ok, result: out.result });
        if (out.status === 'approval_required') return Response.json({ ok: false, approval: out });
        return Response.json({ ok: false, error: out.reason }, { status: 403 });
      }

      // ---- browser history search (read-only, audited) ----
      case 'history-search': {
        try {
          const res = await searchBrowserHistory({
            query: String(body.query ?? ''),
            days: Number(body.days ?? 30),
            limit: Number(body.limit ?? 30),
            actor: 'user',
          });
          return Response.json({
            ok: true,
            entries: res.entries,
            sources: res.sources,
            note: res.note,
            suspicious: res.untrusted.suspicious,
          });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : 'history search failed' },
            { status: 200 }
          );
        }
      }

      // ---- direct desktop action from the panel (same approval gate) ----
      case 'desktop': {
        const endpoint = String(body.endpoint ?? '');
        if (!isValidEndpoint(endpoint)) {
          return Response.json({ error: `unknown desktop endpoint: ${endpoint}` }, { status: 400 });
        }
        const payload =
          body.payload && typeof body.payload === 'object' ? (body.payload as Record<string, unknown>) : {};
        const out = await requestHostAction({ kind: 'desktop', endpoint, payload }, 'user');
        if (out.status === 'done') return Response.json({ ok: out.result.ok, result: out.result });
        if (out.status === 'approval_required') return Response.json({ ok: false, approval: out });
        return Response.json({ ok: false, error: out.reason }, { status: 403 });
      }

      // ---- real Chrome CDP connect (Roadmap #5) ----
      case 'cdp-connect': {
        try {
          const session = await connectRealChrome({
            endpoint: body.endpoint ? String(body.endpoint) : undefined,
            actor: 'user',
          });
          await audit('laptop.cdp_connect', { sessionId: session.id });
          return Response.json({ ok: true, session });
        } catch (err) {
          await audit('laptop.cdp_connect', {}, false, err instanceof Error ? err.message : 'failed');
          return Response.json({ ok: false, error: err instanceof Error ? err.message : 'CDP connect failed' });
        }
      }

      default:
        return Response.json({ error: `unknown op: ${op}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'laptop op failed';
    await audit('laptop.error', { op }, false, message);
    return Response.json({ error: message }, { status: 500 });
  }
}
