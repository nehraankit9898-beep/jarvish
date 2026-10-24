import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { getGoal, startNextGoalTask, abandonGoal } from '@/lib/agentic/goals';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** GET /api/goals/[id] — one goal with its task progress. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const goal = await getGoal(id);
    if (!goal) return Response.json({ error: 'Goal not found' }, { status: 404 });
    return Response.json(goal);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load goal';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/goals/[id] — act on a goal.
 *
 *   { action: 'next' }    — create + PLAN the next runnable task (the run is
 *                            started explicitly from the Agentic panel)
 *   { action: 'abandon' } — mark the goal abandoned
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };

    if (body.action === 'abandon') {
      const ok = await abandonGoal(id);
      if (!ok) return Response.json({ error: 'Goal not found or not active' }, { status: 404 });
      await recordAudit({
        actor: 'user',
        action: 'goal.abandon',
        category: 'task',
        details: { goalId: id },
        ip: clientIp(req.headers),
      });
      return Response.json({ ok: true });
    }

    if (body.action === 'next' || !body.action) {
      const result = await startNextGoalTask(id);
      if (!result.taskId) {
        return Response.json({ ok: false, reason: result.reason ?? 'Nothing to start' });
      }
      return Response.json({ ok: true, taskId: result.taskId, reason: result.reason });
    }

    return Response.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
