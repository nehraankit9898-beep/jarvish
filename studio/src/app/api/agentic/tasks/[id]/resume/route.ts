import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { resolveApprovedCommands } from '@/lib/agentic/approvals';
import { isTerminalStatus, normalizeTaskStatus } from '@/lib/agentic/types';
import { normalizeAgentConfig, redactAgentConfig, type CredentialMap, type AgentRoutingConfig } from '@/lib/agentic/agent-config';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/agentic/tasks/[id]/resume — resume a PAUSED or AWAITING_APPROVAL
 * task.
 *
 * Body:
 *   { approvedCommands?: string[] } — the destructive commands the user just
 *     approved. Only the command the ENGINE asked for is actually approved
 *     (exact-trim match, enforced by resolveApprovedCommands).
 *   { agentConfig?, credentials? } — per-role routing + one-shot credentials.
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

    const status = normalizeTaskStatus(task.status);
    if (isTerminalStatus(status)) {
      return Response.json(
        { error: `Task is ${status} and cannot be resumed` },
        { status: 400 }
      );
    }
    if (status === 'running' || status === 'verifying' || status === 'planning') {
      return Response.json(
        { error: `Task is already ${status}` },
        { status: 409 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      approvedCommands?: string[];
      agentConfig?: AgentRoutingConfig;
      credentials?: CredentialMap;
    };

    // SECURITY: only the command the engine asked for may be approved — a
    // client cannot pre-authorise an arbitrary destructive command.
    const pending = task.pendingCommand ? JSON.parse(task.pendingCommand) : null;
    const approvedCommands = resolveApprovedCommands(
      pending,
      Array.isArray(body.approvedCommands) ? body.approvedCommands : []
    );

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
      action: 'task.resume',
      category: 'task',
      approval: approvedCommands.length ? 'approved' : 'auto',
      details: { from: status, approved: approvedCommands.length > 0 },
      ip: clientIp(req.headers),
    });

    const { runTask } = await import('@/lib/agentic/orchestrator');
    void runTask(id, {
      approvedCommands,
      routing,
      credentials: body.credentials,
    }).catch(async (err) => {
      const message = err instanceof Error ? err.message : 'Resume failed';
      await db.agenticTask
        .update({ where: { id }, data: { status: 'failed', error: message } })
        .catch(() => {});
    });

    return Response.json({ ok: true, taskId: id, status: 'running' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Resume failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
