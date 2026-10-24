import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { rollbackTo, baselineRef, InvalidGitRefError } from '@/lib/agentic/git-tools';
import { isActiveStatus, normalizeTaskStatus } from '@/lib/agentic/types';

export const runtime = 'nodejs';

/**
 * POST /api/agentic/tasks/[id]/rollback — roll the workspace back to a git
 * snapshot. Body: { ref?: 'baseline' | '<snapshot-ref>' }.
 *
 * `baseline` is the state before the task started; every passed step created
 * its own labelled snapshot, so any of them can be targeted by ref.
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
    if (isActiveStatus(status) && status !== 'paused') {
      return Response.json(
        { error: `Task is ${status} — pause or cancel it before rolling back` },
        { status: 400 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as { ref?: string };
    let ref = String(body.ref ?? 'baseline').trim() || 'baseline';
    if (ref === 'baseline') {
      ref = await baselineRef(id);
    }

    await rollbackTo(id, ref);
    await recordAudit({
      actor: 'user',
      taskId: id,
      action: 'task.rollback',
      category: 'task',
      approval: 'auto',
      details: { ref },
      ip: clientIp(req.headers),
    });
    return Response.json({ ok: true, ref });
  } catch (err) {
    if (err instanceof InvalidGitRefError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Rollback failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
