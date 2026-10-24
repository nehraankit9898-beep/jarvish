import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { resolveApprovedCommands } from '@/lib/agentic/approvals';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { isActiveStatus, normalizeTaskStatus } from '@/lib/agentic/types';

export const runtime = 'nodejs';

/** GET /api/recovery — list tasks that can be recovered after restart */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  try {
    const recoverable = await db.agenticTask.findMany({
      where: {
        status: {
          in: ['queued', 'running', 'paused', 'planning', 'verifying', 'awaiting_approval'],
        },
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        prompt: true,
        status: true,
        currentStep: true,
        plan: true,
        createdAt: true,
        updatedAt: true,
        pendingCommand: true,
      },
    });

    const tasks = recoverable.map((t) => ({
      ...t,
      plan: JSON.parse(t.plan || '[]'),
      pendingCommand: t.pendingCommand ? JSON.parse(t.pendingCommand) : null,
    }));

    return Response.json({ recoverable: tasks, count: tasks.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Recovery check failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** POST /api/recovery — resume a recoverable task */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const { taskId, decision, command } = body as {
      taskId: string;
      decision?: 'approve' | 'deny' | 'resume';
      command?: string;
    };

    const task = await db.agenticTask.findUnique({ where: { id: taskId } });
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!isActiveStatus(normalizeTaskStatus(task.status)) || task.status === 'queued') {
      return Response.json(
        { error: `Task ${task.status} cannot be recovered` },
        { status: 400 }
      );
    }

    // SECURITY: only the command the ENGINE asked for may be approved. A
    // client that sends an arbitrary command must not be able to pre-authorise
    // a destructive command — the approval gate is enforced everywhere else
    // through resolveApprovedCommands(), and it has to be enforced here too.
    const pending = task.pendingCommand ? JSON.parse(task.pendingCommand) : null;
    const approvedCommands = resolveApprovedCommands(
      pending,
      command ? [command] : []
    );

    if (decision === 'resume' || !decision) {
      // Resume execution in the BACKGROUND — the realtime events are delivered
      // through GET /api/agentic/tasks/[id]/stream, so a dropped connection
      // never stops the task.
      const { runTask } = await import('@/lib/agentic/orchestrator');
      await recordAudit({
        actor: 'user',
        taskId,
        action: 'task.recover',
        category: 'task',
        approval: approvedCommands.length ? 'approved' : 'auto',
        details: {
          status: task.status,
          approved: approvedCommands.length > 0,
        },
        ip: clientIp(req.headers),
      });
      void runTask(taskId, {
        approvedCommands,
      }).catch(async (err) => {
        const message = err instanceof Error ? err.message : 'Recovery execution failed';
        await db.agenticTask
          .update({ where: { id: taskId }, data: { status: 'failed', error: message } })
          .catch(() => {});
      });

      return Response.json({
        ok: true,
        taskId,
        status: 'running',
        streamUrl: `/api/agentic/tasks/${taskId}/stream`,
      });
    }

    return Response.json({ ok: true, taskId, status: task.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Recovery failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
