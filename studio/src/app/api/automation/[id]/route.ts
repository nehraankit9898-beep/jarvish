import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  updateSchedule,
  deleteSchedule,
  startScheduleRun,
  cancelRun,
  AutomationError,
} from '@/lib/agentic/automation';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * PATCH /api/automation/[id] — update a schedule (enable/disable, interval,
 * prompt, provider, model). Enabling re-arms `nextRunAt`.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await req.json();
    const schedule = await updateSchedule(id, {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
      ...(typeof body.intervalMs === 'number' ? { intervalMs: body.intervalMs } : {}),
      ...(typeof body.cronExpr === 'string' ? { cronExpr: body.cronExpr } : {}),
      ...(typeof body.timezone === 'string' ? { timezone: body.timezone } : {}),
      ...(typeof body.misfirePolicy === 'string' ? { misfirePolicy: body.misfirePolicy } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.provider === 'string' ? { provider: body.provider } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
    });
    await recordAudit({
      actor: 'user',
      action: 'automation.update',
      category: 'automation',
      details: { scheduleId: id, patch: body },
      ip: clientIp(req.headers),
    });
    return Response.json(schedule);
  } catch (err) {
    if (err instanceof AutomationError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Update failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** PUT /api/automation/[id] — same as PATCH (update). */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return PATCH(req, { params });
}

/**
 * POST /api/automation/[id] — trigger an action.
 *
 *   { action: 'run' }                — start a run NOW (a duplicate run is
 *                                       prevented and answered `skipped`)
 *   { action: 'cancel', runId }      — cancel an in-progress run
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? 'run');

    if (action === 'cancel') {
      const ok = await cancelRun(String(body.runId ?? ''));
      if (!ok) {
        return Response.json(
          { error: 'Run not found or already finished' },
          { status: 400 }
        );
      }
      return Response.json({ ok: true, status: 'cancelled' });
    }

    if (action === 'run') {
      const run = await startScheduleRun(id, { trigger: 'manual' });
      return Response.json({
        ok: run.status !== 'failed',
        status: run.status,
        runId: run.id,
        taskId: run.taskId || undefined,
        error: run.error || undefined,
      });
    }

    return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    if (err instanceof AutomationError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Action failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/automation/[id] — remove a schedule and its runs. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const removed = await deleteSchedule(id);
    if (!removed) {
      return Response.json({ error: 'Schedule not found' }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
