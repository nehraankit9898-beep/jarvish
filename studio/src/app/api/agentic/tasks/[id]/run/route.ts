import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { resolveApprovedCommands } from '@/lib/agentic/approvals';
import { normalizeTaskStatus, isTerminalStatus } from '@/lib/agentic/types';
import { normalizeAgentConfig, redactAgentConfig, type CredentialMap, type AgentRoutingConfig } from '@/lib/agentic/agent-config';
import { lastEventSeq } from '@/lib/agentic/event-store';
import { parallelConfigFromBody } from '@/lib/agentic/parallel';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/agentic/tasks/[id]/run — the run STATUS.
 *
 * The client polls this to tell "the task really finished" apart from "the
 * SSE connection dropped": a terminal status with `terminal: true` means the
 * engine itself is done, regardless of what the stream did.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const task = await db.agenticTask.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }
    const status = normalizeTaskStatus(task.status);
    const terminal = isTerminalStatus(status);
    const seq = await lastEventSeq(id);
    return Response.json({
      status,
      terminal,
      running: !terminal,
      lastEventSeq: seq,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Status check failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/agentic/tasks/[id]/run — start (or continue) the run.
 *
 * Body:
 *   { decision?: 'approve' | 'deny', command?: string }   — answer a pending
 *     approval; `command` must match the engine's pending command exactly.
 *   { agentConfig?, credentials? } — per-role routing + one-shot credentials
 *     (credentials are used for this run only and are never persisted).
 *
 * The run executes in the BACKGROUND — the realtime events are consumed via
 * GET /api/agentic/tasks/[id]/stream, so a dropped HTTP connection never
 * stops the task.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const task = await db.agenticTask.findUnique({ where: { id } });
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      decision?: 'approve' | 'deny';
      command?: string;
      agentConfig?: AgentRoutingConfig;
      credentials?: CredentialMap;
      /** how many agents may work at the same time (1-4) */
      parallelism?: number;
      /** let writing steps with disjoint declared scopes overlap */
      parallelWrites?: boolean;
    };

    const status = normalizeTaskStatus(task.status);
    if (isTerminalStatus(status) && status !== 'failed') {
      return Response.json(
        { error: `Task is ${status} — nothing to run` },
        { status: 400 }
      );
    }
    if (status === 'running' || status === 'verifying' || status === 'planning') {
      return Response.json(
        { error: `Task is already ${status}` },
        { status: 409 }
      );
    }

    // An approval answer: only the EXACT command the engine asked for can be
    // approved (resolveApprovedCommands enforces the exact-trim match).
    let approvedCommands: string[] = [];
    if (body.decision) {
      const pending = task.pendingCommand ? JSON.parse(task.pendingCommand) : null;
      if (!pending) {
        return Response.json(
          { error: 'No command is awaiting approval' },
          { status: 400 }
        );
      }
      approvedCommands = resolveApprovedCommands(
        pending,
        body.decision === 'approve' && body.command ? [body.command] : []
      );
      if (body.decision === 'approve' && !approvedCommands.length) {
        return Response.json(
          { error: 'Command does not match the pending approval' },
          { status: 400 }
        );
      }
      if (body.decision === 'deny') {
        await db.agenticStep
          .updateMany({
            where: { taskId: id, status: 'awaiting_approval' },
            data: { status: 'denied' },
          })
          .catch(() => {});
        await db.agenticTask.update({
          where: { id },
          data: { status: 'failed', pendingCommand: null, error: 'User denied the command' },
        });
        await recordAudit({
          actor: 'user',
          taskId: id,
          action: 'approval.deny',
          category: 'security',
          approval: 'denied',
          details: { command: pending.command },
          ip: clientIp(req.headers),
        });
        return Response.json({ ok: true, status: 'failed', denied: true });
      }
    }

    // per-role routing (redacted copy persisted, credentials never persisted)
    const routing = body.agentConfig
      ? normalizeAgentConfig(body.agentConfig, {
          provider: task.provider,
          model: task.model,
        })
      : undefined;
    if (routing) {
      await db.agenticTask.update({
        where: { id },
        data: { agentConfig: JSON.stringify(redactAgentConfig(routing)) },
      });
    }

    await recordAudit({
      actor: 'user',
      taskId: id,
      action: 'task.run',
      category: 'task',
      approval: approvedCommands.length ? 'approved' : 'auto',
      details: { approved: approvedCommands.length > 0, decision: body.decision ?? null },
      ip: clientIp(req.headers),
    });

    const { runTask } = await import('@/lib/agentic/orchestrator');
    void runTask(id, {
      approvedCommands,
      routing,
      credentials: body.credentials,
      taskConfig: parallelConfigFromBody(body),
    }).catch(async (err) => {
      const message = err instanceof Error ? err.message : 'Run failed';
      await db.agenticTask
        .update({ where: { id }, data: { status: 'failed', error: message } })
        .catch(() => {});
    });

    return Response.json({ ok: true, taskId: id, status: 'running' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Run failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
