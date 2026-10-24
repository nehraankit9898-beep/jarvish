import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { isActiveStatus, normalizeTaskStatus } from '@/lib/agentic/types';

export const runtime = 'nodejs';

/**
 * POST /api/agentic/tasks/[id]/pause — user-driven hold.
 *
 * The engine checks the status between steps (and mid-step between commands),
 * so pausing is cooperative: the task stops at the next safe checkpoint and
 * keeps its workspace, plan, retry budget and pending approval.
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
    if (!isActiveStatus(status) || status === 'paused') {
      return Response.json(
        { error: `Task is ${status} and cannot be paused` },
        { status: 400 }
      );
    }
    await db.agenticTask.update({
      where: { id },
      data: { status: 'paused' },
    });
    await db.agenticStep
      .updateMany({
        where: { taskId: id, status: 'running' },
        data: { status: 'paused' },
      })
      .catch(() => {});
    await recordAudit({
      actor: 'user',
      taskId: id,
      action: 'task.pause',
      category: 'task',
      details: { from: status },
      ip: clientIp(req.headers),
    });
    return Response.json({ ok: true, status: 'paused' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pause failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
