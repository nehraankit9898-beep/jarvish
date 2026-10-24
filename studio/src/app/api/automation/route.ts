import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  listSchedules,
  listRuns,
  createSchedule,
  AutomationError,
} from '@/lib/agentic/automation';

export const runtime = 'nodejs';

/** GET /api/automation — the schedules and their recent runs. */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const scheduleId = searchParams.get('scheduleId') ?? undefined;
    const [schedules, runs] = await Promise.all([
      listSchedules(),
      listRuns(scheduleId),
    ]);
    return Response.json({ schedules, runs });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list automations';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/automation — create a schedule.
 *
 * A new schedule is created DISABLED; the user enables it explicitly.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'automation.create',
      category: 'security',
      result: 'error',
      errorCategory: 'unauthorized',
      error: 'Access denied',
      ip: clientIp(req.headers),
    });
    return denied;
  }
  try {
    const body = await req.json();
    const schedule = await createSchedule({
      name: body.name,
      prompt: body.prompt,
      intervalMs: body.intervalMs,
      cronExpr: body.cronExpr,
      timezone: body.timezone,
      misfirePolicy: body.misfirePolicy,
      enabled: body.enabled === true,
      provider: body.provider,
      model: body.model,
    });
    return Response.json(schedule, { status: 201 });
  } catch (err) {
    if (err instanceof AutomationError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to create automation';
    return Response.json({ error: message }, { status: 500 });
  }
}
