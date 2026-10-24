// goals.ts — long-running goals (Feature 2).
//
// A GOAL is an objective too big for a single task ("make my software
// production-ready"). At creation the PLANNER decomposes it into a queue of
// small TASK PROMPTS with dependencies; each task is then created and run
// through the normal engine (workspace, approvals, test gate) ONE AT A TIME,
// in dependency order. Progress is persisted, so a goal survives restarts
// and resumes exactly where it stopped — the user never re-explains the
// goal.
//
// Goal tasks get higher limits (they are expected to be long-running), but
// every other guarantee is identical: no auto-run without the user starting
// the task, destructive commands still need approval.

import { db } from '@/lib/db';
import { recordAudit } from './audit';
import { createNotification } from './notifications';
import type { TaskConfig } from './types';

export interface GoalTaskSpec {
  index: number;
  title: string;
  prompt: string;
  /** 1-based indexes of tasks that must complete before this one */
  dependsOn: number[];
}

export interface GoalDto {
  id: string;
  title: string;
  description: string;
  status: string;
  tasks: {
    index: number;
    title: string;
    dependsOn: number[];
    taskId: string;
    taskStatus: string | null;
  }[];
  progress: { total: number; done: number; active: boolean };
  createdAt: string;
  updatedAt: string;
}

/** Higher limits for goal tasks (they are expected to run long). */
export function goalTaskConfig(): Partial<TaskConfig> {
  return {
    timeoutMs: 4 * 60 * 60 * 1000, // 4 hours
    retryBudget: 30,
    maxSteps: 10,
    maxFixAttempts: 4,
    autoPauseOnFailure: true,
    retryDelayMs: 90_000,
    longRunning: true,
  };
}

function toDto(row: {
  id: string;
  title: string;
  description: string;
  status: string;
  config: string;
  createdAt: Date;
  updatedAt: Date;
}, tasks: {
  index: number;
  title: string;
  dependsOn: number[];
  taskId: string;
  taskStatus: string | null;
}[]): GoalDto {
  const done = tasks.filter((t) => t.taskStatus === 'done').length;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    tasks,
    progress: { total: tasks.length, done, active: row.status === 'active' },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function goalTasks(goalId: string) {
  const rows = await db.agenticTask.findMany({
    where: { goalId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, prompt: true },
  });
  return rows;
}

/** Parse the planner's goal decomposition (defensive). */
export function parseGoalDecomposition(reply: string): { title: string; tasks: GoalTaskSpec[] } {
  const cleaned = reply.replace(/```json/gi, '```').replace(/^```[a-z]*\s*/gm, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Goal decomposition me JSON nahi mila');
  const json = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(json.tasks) || json.tasks.length === 0) {
    throw new Error('Goal decomposition empty hai');
  }
  // H3: validate/dedupe FIRST, then assign indexes. The previous code numbered
  // every raw task BEFORE the validity filter, so a dropped task left DANGLING
  // dependsOn indexes behind — nextRunnableSpec then found no runnable spec
  // forever and the goal stalled silently.
  const valid = json.tasks.slice(0, 12)
    .map((t: Record<string, unknown>, i: number) => ({
      oldIndex: i + 1,
      title: String(t.title ?? `Task ${i + 1}`).slice(0, 160),
      prompt: String(t.prompt ?? '').slice(0, 4000),
      rawDeps: Array.isArray(t.dependsOn)
        ? (t.dependsOn as unknown[]).map((d) => Number(d))
        : [],
    }))
    .filter((t) => t.prompt.trim().length >= 8);
  if (!valid.length) throw new Error('Goal decomposition me koi valid task nahi mila');

  // Tasks are matched back to created rows BY PROMPT (see getGoal/listGoals),
  // so two identical prompts would bind two specs to the same task row —
  // dedupe them (keep the first).
  const seenPrompts = new Set<string>();
  const kept = valid.filter((t) => {
    const key = t.prompt.trim();
    if (seenPrompts.has(key)) return false;
    seenPrompts.add(key);
    return true;
  });

  // old index → new sequential index
  const remap = new Map<number, number>();
  kept.forEach((t, i) => remap.set(t.oldIndex, i + 1));

  const tasks: GoalTaskSpec[] = kept.map((t, i) => {
    const deps: number[] = [];
    for (const d of t.rawDeps) {
      // drop self refs, out-of-range refs and refs to dropped tasks —
      // anything else would park this spec behind a dependency that can
      // never complete
      const mapped = remap.get(d);
      if (mapped === undefined || mapped === i + 1) continue;
      if (!deps.includes(mapped)) deps.push(mapped);
    }
    return {
      index: i + 1,
      title: t.title,
      prompt: t.prompt,
      dependsOn: deps,
    };
  });

  // a dependency CYCLE in the decomposition would also stall the goal —
  // fall back to plain sequential execution (drop all edges) when one exists
  if (hasDependencyCycle(tasks)) {
    for (const t of tasks) t.dependsOn = [];
  }

  return { title: String(json.title ?? 'Goal').slice(0, 200), tasks };
}

/** true when the dependsOn graph of the specs contains a cycle. */
function hasDependencyCycle(tasks: GoalTaskSpec[]): boolean {
  const byIndex = new Map(tasks.map((t) => [t.index, t]));
  const state = new Map<number, 'visiting' | 'done'>();
  const visit = (index: number): boolean => {
    const cur = state.get(index);
    if (cur === 'done') return false;
    if (cur === 'visiting') return true; // back-edge → cycle
    state.set(index, 'visiting');
    for (const dep of byIndex.get(index)?.dependsOn ?? []) {
      if (byIndex.has(dep) && visit(dep)) return true;
    }
    state.set(index, 'done');
    return false;
  };
  return tasks.some((t) => visit(t.index));
}

export async function createGoal(input: {
  title: string;
  description: string;
  /** the decomposition produced by the planner (see parseGoalDecomposition) */
  tasks: GoalTaskSpec[];
}): Promise<GoalDto> {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new Error('Goal title is required');
  const row = await db.goal.create({
    data: {
      title,
      description: input.description.slice(0, 4000),
      status: 'active',
      config: JSON.stringify({ tasks: input.tasks }),
    },
  });
  await recordAudit({
    actor: 'user',
    action: 'goal.create',
    category: 'task',
    details: { goalId: row.id, title, tasks: input.tasks.length },
  });
  return toDto(row, input.tasks.map((t) => ({
    index: t.index,
    title: t.title,
    dependsOn: t.dependsOn,
    taskId: '',
    taskStatus: null,
  })));
}

export async function listGoals(): Promise<GoalDto[]> {
  const rows = await db.goal.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  const out: GoalDto[] = [];
  for (const row of rows) {
    const specs = (JSON.parse(row.config || '{}') as { tasks?: GoalTaskSpec[] }).tasks ?? [];
    const created = await goalTasks(row.id);
    const byPrompt = new Map(created.map((t) => [t.prompt, t]));
    const tasks = specs.map((spec) => {
      const match = byPrompt.get(spec.prompt) ?? created.find((t) => t.prompt === spec.prompt);
      return {
        index: spec.index,
        title: spec.title,
        dependsOn: spec.dependsOn,
        taskId: match?.id ?? '',
        taskStatus: match?.status ?? null,
      };
    });
    out.push(toDto(row, tasks));
  }
  return out;
}

export async function getGoal(id: string): Promise<GoalDto | null> {
  const row = await db.goal.findUnique({ where: { id } });
  if (!row) return null;
  const specs = (JSON.parse(row.config || '{}') as { tasks?: GoalTaskSpec[] }).tasks ?? [];
  const created = await goalTasks(id);
  const tasks = specs.map((spec) => {
    const match = created.find((t) => t.prompt === spec.prompt);
    return {
      index: spec.index,
      title: spec.title,
      dependsOn: spec.dependsOn,
      taskId: match?.id ?? '',
      taskStatus: match?.status ?? null,
    };
  });
  return toDto(row, tasks);
}

/** Which task spec should run next (deps done, not yet created/running). */
export function nextRunnableSpec(
  specs: GoalTaskSpec[],
  tasks: { index: number; taskStatus: string | null; taskId: string }[]
): GoalTaskSpec | null {
  const statusOfSpec = new Map(tasks.map((t) => [t.index, t]));
  // H3 (defensive): a dependency that points at an index that does not exist
  // in the spec list can never become 'done' — ignore it instead of parking
  // the goal behind it forever.
  const known = new Set(specs.map((s) => s.index));
  for (const spec of specs) {
    const existing = statusOfSpec.get(spec.index);
    if (existing?.taskId) {
      // already created: if it is running-ish, nothing to start
      if (!['done', 'failed', 'cancelled'].includes(existing.taskStatus ?? '')) return null;
      continue;
    }
    const depsDone = spec.dependsOn
      .filter((dep) => known.has(dep))
      .every((dep) => {
        const st = statusOfSpec.get(dep)?.taskStatus;
        return st === 'done';
      });
    if (depsDone) return spec;
  }
  return null;
}

/**
 * Create (and PLAN — not run) the next task of a goal.
 * Returns the new taskId, or null when nothing is runnable.
 */
export async function startNextGoalTask(goalId: string): Promise<{
  taskId: string | null;
  reason?: string;
}> {
  const goal = await getGoal(goalId);
  if (!goal) throw new Error('Goal not found');
  if (goal.status !== 'active') return { taskId: null, reason: `Goal is ${goal.status}` };

  const row = await db.goal.findUnique({ where: { id: goalId } });
  const specs = (JSON.parse(row!.config || '{}') as { tasks?: GoalTaskSpec[] }).tasks ?? [];
  const spec = nextRunnableSpec(specs, goal.tasks);
  if (!spec) {
    const allDone = goal.tasks.every((t) => t.taskStatus === 'done');
    if (allDone && goal.tasks.length) {
      await db.goal.update({ where: { id: goalId }, data: { status: 'completed' } });
      await createNotification({
        type: 'goal',
        title: `Goal complete: ${goal.title}`,
        body: 'Saare tasks done ho gaye.',
        data: { goalId },
      });
      await recordAudit({
        actor: 'system',
        action: 'goal.complete',
        category: 'task',
        details: { goalId },
      });
      return { taskId: null, reason: 'Goal complete' };
    }
    return { taskId: null, reason: 'No runnable task (dependencies pending)' };
  }

  const { planTask } = await import('./orchestrator');
  const task = await db.agenticTask.create({
    data: {
      prompt: spec.prompt,
      status: 'queued',
      goalId,
      conversationId: `conv_goal_${goalId}_${crypto.randomUUID()}`,
    },
  });
  try {
    await planTask(task.id, undefined, goalTaskConfig(), {});
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Planning failed';
    await db.agenticTask
      .update({ where: { id: task.id }, data: { status: 'failed', error: message } })
      .catch(() => undefined);
    return { taskId: task.id, reason: `Planning failed: ${message}` };
  }
  await createNotification({
    type: 'goal',
    title: `Goal task planned: ${spec.title}`,
    body: 'Review the plan in the Agentic panel and start the run when ready.',
    taskId: task.id,
    data: { goalId, specIndex: spec.index },
  });
  await recordAudit({
    actor: 'user',
    action: 'goal.start_task',
    category: 'task',
    details: { goalId, specIndex: spec.index, taskId: task.id },
  });
  return { taskId: task.id };
}

export async function abandonGoal(id: string): Promise<boolean> {
  const res = await db.goal.updateMany({
    where: { id, status: 'active' },
    data: { status: 'abandoned' },
  });
  if (res.count > 0) {
    await recordAudit({
      actor: 'user',
      action: 'goal.abandon',
      category: 'task',
      details: { goalId: id },
    });
  }
  return res.count > 0;
}
