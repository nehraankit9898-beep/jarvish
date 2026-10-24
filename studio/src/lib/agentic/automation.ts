// automation.ts — explicit, observable schedules.
//
// A schedule stores a PROMPT (written by the user) and an interval. When it
// fires it creates a normal agentic task, so everything the agentic engine
// guarantees (workspace sandbox, command approval, test gate, audit trail)
// applies to automated runs as well.
//
// DUPLICATE RUNS
//   A schedule never runs twice at the same time. Two guards:
//     1. an in-process lock (a schedule that is already being started is
//        skipped), and
//     2. a database check — a schedule with a `running` run is skipped.
//
// RISKY ACTIONS
//   A scheduled task still needs the user's approval for destructive
//   commands: the task starts in `awaiting_approval` and the UI asks.

import { db } from '@/lib/db';
import { planTask } from './orchestrator';
import { recordAudit } from './audit';
import { nextCronRun, CronParseError } from './cron';
import { createNotification } from './notifications';

export interface AutomationScheduleDto {
  id: string;
  name: string;
  prompt: string;
  intervalMs: number;
  cronExpr: string;
  timezone: string;
  misfirePolicy: string;
  enabled: boolean;
  provider: string;
  model: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunDto {
  id: string;
  scheduleId: string;
  taskId: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';
  error: string;
  result: string;
}

export class AutomationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'AutomationError';
    this.field = field;
  }
}

const MIN_INTERVAL_MS = 60_000; // 1 minute
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MISFIRE_POLICIES = ['skip', 'run_once', 'catch_up'] as const;
const MAX_CATCH_UP_RUNS = 5;

/** In-process guard: a schedule that is currently being started. */
const starting = new Set<string>();

/**
 * The next run of a schedule from `now`:
 * - a cron schedule → the next cron firing in its timezone;
 * - an interval schedule → now + intervalMs.
 */
function computeNextRun(
  schedule: { cronExpr: string; timezone: string; intervalMs: number },
  now = new Date()
): Date | null {
  if (schedule.cronExpr) {
    return nextCronRun(schedule.cronExpr, now, schedule.timezone);
  }
  return new Date(now.getTime() + schedule.intervalMs);
}

function validateCronFields(cronExpr: string, timezone: string): void {
  if (cronExpr) {
    try {
      // a syntactically-valid expression that never fires (e.g. `0 5 30 2 *`)
      // would otherwise create an enabled schedule with nextRunAt = null —
      // which runDueSchedules used to treat as "due every tick" — so reject it
      if (nextCronRun(cronExpr, new Date(), timezone) === null) {
        throw new AutomationError(
          'cronExpr',
          'cron expression has no firing time within the next 4 years — check the day-of-month/day-of-week fields (e.g. Feb 30 never exists)'
        );
      }
    } catch (err) {
      if (err instanceof CronParseError) {
        throw new AutomationError('cronExpr', err.message);
      }
      throw err;
    }
  }
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new AutomationError('timezone', `Unknown timezone: ${timezone}`);
    }
  }
}

function toDto(row: {
  id: string;
  name: string;
  prompt: string;
  intervalMs: number;
  cronExpr: string;
  timezone: string;
  misfirePolicy: string;
  enabled: boolean;
  provider: string;
  model: string;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastStatus: string;
  createdAt: Date;
  updatedAt: Date;
}): AutomationScheduleDto {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    intervalMs: row.intervalMs,
    cronExpr: row.cronExpr,
    timezone: row.timezone,
    misfirePolicy: row.misfirePolicy,
    enabled: row.enabled,
    provider: row.provider,
    model: row.model,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    lastStatus: row.lastStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRunDto(row: {
  id: string;
  scheduleId: string;
  taskId: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  error: string;
  result: string;
}): AutomationRunDto {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    taskId: row.taskId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    status: row.status as AutomationRunDto['status'],
    error: row.error,
    result: row.result,
  };
}

export async function listSchedules(): Promise<AutomationScheduleDto[]> {
  const rows = await db.automationSchedule.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toDto);
}

export async function getSchedule(id: string): Promise<AutomationScheduleDto | null> {
  const row = await db.automationSchedule.findUnique({ where: { id } });
  return row ? toDto(row) : null;
}

export async function listRuns(scheduleId?: string): Promise<AutomationRunDto[]> {
  const rows = await db.automationRun.findMany({
    where: scheduleId ? { scheduleId } : undefined,
    orderBy: { startedAt: 'desc' },
    take: 100,
  });
  return rows.map(toRunDto);
}

/** Create a schedule. It starts DISABLED — the user enables it explicitly. */
export async function createSchedule(input: {
  name: string;
  prompt: string;
  intervalMs?: number;
  cronExpr?: string;
  timezone?: string;
  misfirePolicy?: string;
  enabled?: boolean;
  provider?: string;
  model?: string;
}): Promise<AutomationScheduleDto> {
  const name = String(input.name ?? '').trim();
  const prompt = String(input.prompt ?? '').trim();
  if (!name || name.length > 120) {
    throw new AutomationError('name', 'name is required (max 120 characters)');
  }
  if (!prompt || prompt.length < 8) {
    throw new AutomationError('prompt', 'prompt must be at least 8 characters');
  }
  const intervalMs = Math.min(
    MAX_INTERVAL_MS,
    Math.max(MIN_INTERVAL_MS, Math.floor(input.intervalMs ?? 60 * 60 * 1000))
  );
  const cronExpr = String(input.cronExpr ?? '').trim();
  const timezone = String(input.timezone ?? '').trim();
  const misfirePolicy = MISFIRE_POLICIES.includes(
    (input.misfirePolicy ?? 'skip') as (typeof MISFIRE_POLICIES)[number]
  )
    ? (input.misfirePolicy ?? 'skip')
    : 'skip';
  validateCronFields(cronExpr, timezone);
  const enabled = input.enabled === true;
  const row = await db.automationSchedule.create({
    data: {
      name,
      prompt,
      intervalMs,
      cronExpr,
      timezone,
      misfirePolicy,
      enabled,
      provider: (input.provider ?? 'zai').trim(),
      model: (input.model ?? '').trim(),
      nextRunAt: enabled
        ? computeNextRun({ cronExpr, timezone, intervalMs })
        : null,
    },
  });
  await recordAudit({
    actor: 'user',
    action: 'automation.create',
    category: 'automation',
    details: { scheduleId: row.id, name, intervalMs, cronExpr, timezone, enabled },
  });
  return toDto(row);
}

export async function updateSchedule(
  id: string,
  patch: {
    name?: string;
    prompt?: string;
    intervalMs?: number;
    cronExpr?: string;
    timezone?: string;
    misfirePolicy?: string;
    enabled?: boolean;
    provider?: string;
    model?: string;
  }
): Promise<AutomationScheduleDto> {
  const existing = await db.automationSchedule.findUnique({ where: { id } });
  if (!existing) throw new AutomationError('id', 'Schedule not found');

  const data: Record<string, unknown> = {};
  if (typeof patch.name === 'string' && patch.name.trim()) {
    data.name = patch.name.trim().slice(0, 120);
  }
  if (typeof patch.prompt === 'string' && patch.prompt.trim().length >= 8) {
    data.prompt = patch.prompt.trim();
  }
  if (typeof patch.intervalMs === 'number') {
    data.intervalMs = Math.min(
      MAX_INTERVAL_MS,
      Math.max(MIN_INTERVAL_MS, Math.floor(patch.intervalMs))
    );
  }
  if (typeof patch.cronExpr === 'string') {
    data.cronExpr = patch.cronExpr.trim();
  }
  if (typeof patch.timezone === 'string') {
    data.timezone = patch.timezone.trim();
  }
  if (typeof patch.misfirePolicy === 'string' && MISFIRE_POLICIES.includes(patch.misfirePolicy as never)) {
    data.misfirePolicy = patch.misfirePolicy;
  }
  if (typeof patch.provider === 'string') data.provider = patch.provider.trim();
  if (typeof patch.model === 'string') data.model = patch.model.trim();

  validateCronFields(
    typeof data.cronExpr === 'string' ? data.cronExpr : existing.cronExpr,
    typeof data.timezone === 'string' ? data.timezone : existing.timezone
  );

  // enabling, or changing the timing fields, re-arms the next run
  const timingChanged =
    typeof patch.intervalMs === 'number' ||
    typeof patch.cronExpr === 'string' ||
    typeof patch.timezone === 'string';
  if (typeof patch.enabled === 'boolean') {
    data.enabled = patch.enabled;
  }
  if (typeof patch.enabled === 'boolean' || timingChanged) {
    const schedule = {
      cronExpr: (data.cronExpr as string) ?? existing.cronExpr,
      timezone: (data.timezone as string) ?? existing.timezone,
      intervalMs: (data.intervalMs as number) ?? existing.intervalMs,
    };
    const enabled = (data.enabled as boolean) ?? existing.enabled;
    data.nextRunAt = enabled ? computeNextRun(schedule) : null;
  }

  const row = await db.automationSchedule.update({ where: { id }, data });
  await recordAudit({
    actor: 'user',
    action: 'automation.update',
    category: 'automation',
    details: { scheduleId: id, ...patch },
  });
  return toDto(row);
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const res = await db.automationSchedule.deleteMany({ where: { id } });
  await recordAudit({
    actor: 'user',
    action: 'automation.delete',
    category: 'automation',
    details: { scheduleId: id, removed: res.count > 0 },
  });
  return res.count > 0;
}

/** Is this schedule already running? */
export async function isScheduleBusy(scheduleId: string): Promise<boolean> {
  if (starting.has(scheduleId)) return true;
  return dbBusy(scheduleId);
}

/** DB-only half of the busy check (the in-process claim lives in `starting`). */
async function dbBusy(scheduleId: string): Promise<boolean> {
  const run = await db.automationRun.findFirst({
    where: { scheduleId, status: 'running' },
    select: { id: true },
  });
  return Boolean(run);
}

/**
 * Start a run of a schedule.
 *
 * Returns the created run. When the schedule is already running, a `skipped`
 * run is recorded instead — the schedule is never executed twice at once.
 */
export async function startScheduleRun(
  scheduleId: string,
  opts: { trigger?: 'schedule' | 'manual' | 'catch_up' } = {}
): Promise<AutomationRunDto> {
  const schedule = await db.automationSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new AutomationError('id', 'Schedule not found');

  // M5 (TOCTOU): the old flow checked `isScheduleBusy` (an ASYNC db read) and
  // only THEN added the in-process claim — two overlapping ticks could both
  // pass the check during the await and both start a run. The claim is now
  // taken SYNCHRONOUSLY (check + add with no await in between) before any
  // database busy-check, which closes the race inside the process.
  //
  // H6: the claim is only released by the call that TOOK it. Releasing it in a
  // `finally` unconditionally meant a *skipped* duplicate deleted the in-flight
  // starter's claim, so the next tick saw an unclaimed schedule whose run row
  // had not been created yet — and started a second, concurrent run.
  const claimed = !starting.has(scheduleId);
  if (claimed) starting.add(scheduleId);
  try {
    if (!claimed || (await dbBusy(scheduleId))) {
      const skipped = await db.automationRun.create({
        data: {
          scheduleId,
          status: 'skipped',
          error: 'Schedule is already running — duplicate run prevented',
        },
      });
      await recordAudit({
        actor: 'system',
        action: 'automation.skip',
        category: 'automation',
        approval: 'auto',
        details: { scheduleId, reason: 'already_running' },
      });
      return toRunDto(skipped);
    }

    const run = await db.automationRun.create({
      data: { scheduleId, status: 'running' },
    });

    const task = await db.agenticTask.create({
      data: {
        prompt: schedule.prompt,
        provider: schedule.provider || 'zai',
        model: schedule.model || '',
        status: 'planning',
        conversationId: `conv_auto_${scheduleId}_${run.id}`,
      },
    });

    await db.automationRun.update({
      where: { id: run.id },
      data: { taskId: task.id },
    });

    try {
      await planTask(task.id, undefined, undefined, {});
      await db.automationRun.update({
        where: { id: run.id },
        data: {
          status: 'done',
          finishedAt: new Date(),
          result: `Task ${task.id} planned and awaiting approval`,
        },
      });
      await db.automationSchedule.update({
        where: { id: scheduleId },
        data: {
          lastRunAt: new Date(),
          lastStatus: 'done',
          nextRunAt: schedule.enabled
            ? computeNextRun(schedule)
            : null,
        },
      });
      await recordAudit({
        actor: 'system',
        action: 'automation.run',
        category: 'automation',
        approval: 'auto',
        details: {
          scheduleId,
          taskId: task.id,
          trigger: opts.trigger ?? 'schedule',
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Automation run failed';
      await db.automationRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), error: message },
      });
      await db.automationSchedule.update({
        where: { id: scheduleId },
        data: {
          lastRunAt: new Date(),
          lastStatus: 'failed',
          nextRunAt: schedule.enabled
            ? computeNextRun(schedule)
            : null,
        },
      });
      // a FAILED schedule alerts the user — silently swallowing failures is
      // how a broken nightly check goes unnoticed for weeks
      await createNotification({
        type: 'automation',
        title: `Automation "${schedule.name}" failed`,
        body: message.slice(0, 500),
        scheduleId,
        data: { taskId: task.id, runId: run.id, status: 'failed' },
      });
      await recordAudit({
        actor: 'system',
        action: 'automation.run',
        category: 'automation',
        result: 'error',
        errorCategory: 'planning_failed',
        error: message,
        details: { scheduleId, taskId: task.id },
      });
    }

    const finished = await db.automationRun.findUnique({ where: { id: run.id } });
    return toRunDto(finished!);
  } finally {
    // H6: only the caller that TOOK the claim may drop it
    if (claimed) starting.delete(scheduleId);
  }
}

/**
 * Run every schedule that is due.
 * Called by the background ticker (and manually from the UI).
 */
export async function runDueSchedules(now = new Date()): Promise<AutomationRunDto[]> {
  const due = await db.automationSchedule.findMany({
    where: {
      enabled: true,
      // an enabled schedule must have a concrete nextRunAt to be due. A null
      // nextRunAt (legacy row / unsatisfiable cron that predates validation)
      // is healed once by recoverMisfires — treating it as "due" here made it
      // fire a task + LLM plan on EVERY background tick, forever.
      nextRunAt: { lte: now },
    },
  });
  const runs: AutomationRunDto[] = [];
  for (const schedule of due) {
    if (await isScheduleBusy(schedule.id)) continue;
    try {
      runs.push(await startScheduleRun(schedule.id, { trigger: 'schedule' }));
    } catch (err) {
      await recordAudit({
        actor: 'system',
        action: 'automation.run',
        category: 'automation',
        result: 'error',
        errorCategory: 'exception',
        error: err instanceof Error ? err.message : 'unknown',
        details: { scheduleId: schedule.id },
      });
    }
  }
  return runs;
}

/**
 * MISFIRE RECOVERY — called once by the background runtime at startup.
 *
 * A schedule whose `nextRunAt` lies far in the past missed its runs while the
 * server was down. Depending on the schedule's `misfirePolicy`:
 *   - skip (default): the missed runs are skipped, nextRunAt advances to the
 *     next future firing;
 *   - run_once: one catch-up run fires now;
 *   - catch_up: up to MAX_CATCH_UP_RUNS missed firings fire now, back to back
 *     (still duplicate-guarded and approval-gated like any other run).
 */
export async function recoverMisfires(
  now = new Date(),
  /** a run this old counts as missed (default 5 minutes) */
  graceMs = 5 * 60 * 1000
): Promise<{ scheduleId: string; action: string; runs: number }[]> {
  const late = await db.automationSchedule.findMany({
    where: {
      enabled: true,
      OR: [
        // enabled with no next firing — re-arm below, never run (it cannot be
        // legitimately due; running it on every recovery would be a loop)
        { nextRunAt: null },
        { nextRunAt: { lt: new Date(now.getTime() - graceMs) } },
      ],
    },
  });
  const report: { scheduleId: string; action: string; runs: number }[] = [];
  for (const schedule of late) {
    if (schedule.nextRunAt === null) {
      await db.automationSchedule.update({
        where: { id: schedule.id },
        data: { nextRunAt: computeNextRun(schedule, now) },
      });
      report.push({ scheduleId: schedule.id, action: 'rearmed', runs: 0 });
      continue;
    }
    if (schedule.misfirePolicy === 'skip') {
      await db.automationSchedule.update({
        where: { id: schedule.id },
        data: { nextRunAt: computeNextRun(schedule, now) },
      });
      report.push({ scheduleId: schedule.id, action: 'skipped', runs: 0 });
      continue;
    }

    const missedBefore = schedule.lastRunAt ?? schedule.nextRunAt ?? now;
    // how many firings were missed between the last run and now (bounded)
    let missedCount = 1;
    if (schedule.misfirePolicy === 'catch_up') {
      missedCount = 0;
      let cursor = new Date(missedBefore);
      const limit = Math.min(
        now.getTime(),
        missedBefore.getTime() + MAX_CATCH_UP_RUNS * 24 * 60 * 60 * 1000
      );
      while (cursor.getTime() < limit && missedCount < MAX_CATCH_UP_RUNS) {
        const next = schedule.cronExpr
          ? nextCronRun(schedule.cronExpr, cursor, schedule.timezone)
          : new Date(cursor.getTime() + schedule.intervalMs);
        if (!next || next.getTime() > now.getTime()) break;
        cursor = next;
        missedCount++;
      }
      if (missedCount === 0) missedCount = 1;
    }

    let executed = 0;
    for (let i = 0; i < missedCount; i++) {
      if (await isScheduleBusy(schedule.id)) break;
      try {
        await startScheduleRun(schedule.id, { trigger: 'catch_up' });
        executed++;
      } catch {
        break;
      }
    }
    report.push({
      scheduleId: schedule.id,
      action: schedule.misfirePolicy,
      runs: executed,
    });
  }
  if (report.length) {
    await recordAudit({
      actor: 'system',
      action: 'automation.misfire_recovery',
      category: 'automation',
      approval: 'auto',
      details: { recovered: report },
    });
  }
  return report;
}

/** Cancel a run that is still in progress. */
export async function cancelRun(runId: string): Promise<boolean> {
  const run = await db.automationRun.findUnique({ where: { id: runId } });
  if (!run) return false;
  if (run.status !== 'running') return false;
  await db.automationRun.update({
    where: { id: runId },
    data: { status: 'cancelled', finishedAt: new Date() },
  });
  if (run.taskId) {
    await db.agenticTask
      .update({
        where: { id: run.taskId },
        data: { status: 'cancelled' },
      })
      .catch(() => {});
  }
  await recordAudit({
    actor: 'user',
    action: 'automation.cancel',
    category: 'automation',
    approval: 'auto',
    details: { runId, taskId: run.taskId },
  });
  return true;
}
