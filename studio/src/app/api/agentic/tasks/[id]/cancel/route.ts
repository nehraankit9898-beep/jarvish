import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { isActiveStatus, normalizeTaskStatus } from '@/lib/agentic/types';
import { cancelHostApprovalsForTask } from '@/lib/agentic/host-control';

export const runtime = 'nodejs';

/**
 * POST /api/agentic/tasks/[id]/cancel — terminal cancellation.
 *
 * The engine checks the status between commands; a cancelled task stops at
 * the next checkpoint. The workspace and the events stay intact so the user
 * can still inspect the diff or roll back.
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
    if (!isActiveStatus(status)) {
      return Response.json(
        { error: `Task is already ${status}` },
        { status: 400 }
      );
    }
    await db.agenticTask.update({
      where: { id },
      data: { status: 'cancelled', pendingCommand: null },
    });
    // drop any host approvals this task still had pending — otherwise the
    // screen loop stays blocked (up to its 10-min approval window) and a
    // late approve click would execute an action for a cancelled task
    const droppedApprovals = await cancelHostApprovalsForTask(id).catch(() => 0);
    await recordAudit({
      actor: 'user',
      taskId: id,
      action: 'task.cancel',
      category: 'task',
      details: { from: status, droppedApprovals },
      ip: clientIp(req.headers),
    });
    return Response.json({ ok: true, status: 'cancelled' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Cancel failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
