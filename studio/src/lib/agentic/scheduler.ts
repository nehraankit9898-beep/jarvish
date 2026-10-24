// scheduler.ts — dependency-aware scheduling + workspace conflict control.
//
// The planner is told it may declare dependencies between steps, but the
// previous orchestrator executed every step strictly sequentially and its
// dependency check was a no-op (a `continue` inside the inner dependency loop
// never skipped the step, and the planner's dependency field was dropped by
// the plan parser — so the feature never actually worked).
//
// This module implements the scheduling rules:
//
//   1. a step runs only when every step that BLOCKS it has completed
//      successfully (passed / skipped);
//   2. steps that are independent AND read-only may run concurrently;
//   3. any step that can write to the workspace is serialized through the
//      workspace lock, so two agents can never write the same file at the
//      same time;
//   4. a dependency cycle is detected and reported instead of dead-locking.

import type { PlanStep, StepDependency, StepKind } from './types';

export type SchedulerStepStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'passed'
  | 'failed'
  | 'denied'
  | 'skipped'
  | 'paused';

export const DONE_STATUSES: readonly SchedulerStepStatus[] = [
  'passed',
  'skipped',
];

/** Step kinds that must not touch the workspace (read-only analysis). */
const READ_ONLY_KINDS: readonly StepKind[] = ['analyze', 'research'];

export function isReadOnlyKind(kind: StepKind | string): boolean {
  return READ_ONLY_KINDS.includes(kind as StepKind);
}

/** The steps that block this step (1-based indexes). */
export function blockingDependencies(step: PlanStep): number[] {
  if (!step.dependencies?.length) return [];
  return step.dependencies
    .filter((d) => d.type === 'blocks')
    .map((d) => d.stepIndex)
    // a step can never wait for ITSELF — that is a no-op edge, not a real
    // dependency (and treating it as one would flag a "cycle" and skip it)
    .filter((n) => Number.isFinite(n) && n > 0 && n !== step.index);
}

/** Dependencies explicitly declared as parallel-safe. */
export function parallelSafeDependencies(step: PlanStep): number[] {
  if (!step.dependencies?.length) return [];
  return step.dependencies
    .filter((d) => d.type === 'parallel_safe')
    .map((d) => d.stepIndex)
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function dependencyMap(steps: PlanStep[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const step of steps) {
    map.set(step.index, blockingDependencies(step));
  }
  return map;
}

/**
 * Detect dependency cycles. Returns the set of step indexes that take part in
 * a cycle (so the caller can skip them instead of waiting forever).
 */
export function detectCycles(steps: PlanStep[]): Set<number> {
  const deps = dependencyMap(steps);
  const inCycle = new Set<number>();
  const state = new Map<number, 'visiting' | 'done'>();

  const visit = (index: number, path: number[]): void => {
    const current = state.get(index);
    if (current === 'done') return;
    if (current === 'visiting') {
      // everything from the first occurrence of `index` on the path is cyclic
      const start = path.indexOf(index);
      for (const p of path.slice(start >= 0 ? start : 0)) inCycle.add(p);
      inCycle.add(index);
      return;
    }
    state.set(index, 'visiting');
    const next = path.concat(index);
    for (const dep of deps.get(index) ?? []) {
      if (deps.has(dep)) visit(dep, next);
    }
    state.set(index, 'done');
  };

  for (const step of steps) visit(step.index, []);
  return inCycle;
}

export interface DependencyStatus {
  /** every blocking dependency is satisfied */
  satisfied: boolean;
  /** blocking dependencies that are not satisfied yet */
  pending: number[];
  /** blocking dependencies that failed → the step can never run */
  broken: number[];
}

export function checkDependencies(
  step: PlanStep,
  statuses: Map<number, SchedulerStepStatus>,
  /**
   * The step indexes that actually exist in this plan. A dependency that
   * points at anything else (a step the planner never produced, or one that
   * was dropped when the plan was truncated to `maxSteps`) can NEVER reach a
   * done status — without this set the dependent step would be parked behind
   * it forever and silently skipped. Pass the plan's indexes to have such
   * dangling references ignored instead.
   */
  knownIndexes?: Set<number>
): DependencyStatus {
  const pending: number[] = [];
  const broken: number[] = [];
  for (const dep of blockingDependencies(step)) {
    // dangling reference → ignore it (the step it points at does not exist)
    if (knownIndexes && !knownIndexes.has(dep)) continue;
    const status = statuses.get(dep);
    if (status && DONE_STATUSES.includes(status)) continue;
    if (status === 'failed' || status === 'denied') broken.push(dep);
    else pending.push(dep);
  }
  return {
    satisfied: pending.length === 0 && broken.length === 0,
    pending,
    broken,
  };
}

/** The set of step indexes a plan actually contains. */
export function planIndexes(steps: PlanStep[]): Set<number> {
  return new Set(steps.map((s) => s.index));
}

/**
 * Drop dependency edges that point at a step which is not part of (this) plan
 * — and self edges. The planner validates its references against its OWN step
 * count, but the caller may still truncate the plan afterwards (maxSteps),
 * which would leave references to dropped steps behind. A dangling reference
 * parks the dependent step behind something that can never complete, so the
 * step is silently skipped and the task still reports done.
 *
 * Mutates and returns the same list.
 */
export function sanitizeStepDependencies(steps: PlanStep[]): PlanStep[] {
  const known = planIndexes(steps);
  for (const step of steps) {
    const deps = step.dependencies;
    if (!deps?.length) continue;
    const kept = deps.filter(
      (d) => d.stepIndex !== step.index && known.has(d.stepIndex)
    );
    if (kept.length !== deps.length) step.dependencies = kept;
  }
  return steps;
}

/** Steps whose dependencies are satisfied and that can start now. */
export function readySteps(
  steps: PlanStep[],
  statuses: Map<number, SchedulerStepStatus>
): PlanStep[] {
  // the plan itself defines which indexes exist: a dependency on anything
  // else is dangling and must not park the step forever
  const known = planIndexes(steps);
  return steps.filter((step) => {
    const status = statuses.get(step.index);
    if (status && status !== 'pending') return false;
    return checkDependencies(step, statuses, known).satisfied;
  });
}

export interface ParallelPlan {
  /** steps that may run concurrently (read-only, independent) */
  parallel: PlanStep[];
  /** steps that must run one at a time (they may write to the workspace) */
  serial: PlanStep[];
}

/**
 * Split the ready steps into a concurrent group and a serialized group.
 * Only READ-ONLY steps may run concurrently — everything that can touch the
 * workspace is serialized through the workspace lock.
 */
export function planParallelism(
  steps: PlanStep[],
  statuses: Map<number, SchedulerStepStatus>
): ParallelPlan {
  const ready = readySteps(steps, statuses);
  const parallel = ready.filter((s) => isReadOnlyKind(s.kind));
  const serial = ready.filter((s) => !isReadOnlyKind(s.kind));
  return { parallel, serial };
}

/**
 * Thrown when two agents would write the same file concurrently.
 */
export class WriteConflictError extends Error {
  path: string;
  holder: string;
  constructor(path: string, holder: string) {
    super(
      `Write conflict: "${path}" is already being written by "${holder}" - refusing a concurrent write`
    );
    this.name = 'WriteConflictError';
    this.path = path;
    this.holder = holder;
  }
}

/**
 * Per-task workspace lock.
 *
 * - writers are exclusive: only one agent may write/execute in the shared
 *   workspace at a time;
 * - readers may run concurrently with each other;
 * - every write records the touched paths, so a conflicting write is
 *   DETECTED (not just prevented) and reported.
 */
export class WorkspaceLock {
  private taskId: string;
  private writer: { holder: string; paths: Set<string> } | null = null;
  private waiters: {
    holder: string;
    paths: Set<string>;
    resolve: () => void;
  }[] = [];
  private writtenPaths = new Map<string, string>();

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  /** Currently written path → holder. */
  get written(): Map<string, string> {
    return new Map(this.writtenPaths);
  }

  get activeWriter(): string | null {
    return this.writer?.holder ?? null;
  }

  /**
   * Acquire the exclusive write lock. Resolves with a release function.
   */
  async acquireWrite(
    holder: string,
    paths: string[] = []
  ): Promise<() => void> {
    if (this.writer) {
      await new Promise<void>((resolve) => {
        this.waiters.push({ holder, paths: new Set(paths), resolve });
      });
    }
    this.writer = { holder, paths: new Set(paths) };
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.writer?.holder === holder) {
        for (const p of this.writer.paths) this.writtenPaths.delete(p);
        this.writer = null;
        const next = this.waiters.shift();
        if (next) {
          // hand the lock over directly to the next waiter
          this.writer = { holder: next.holder, paths: next.paths };
          next.resolve();
        }
      }
    };
  }

  /**
   * Register the paths a step is about to write. Throws WriteConflictError
   * when another agent already owns one of those paths.
   */
  claimPaths(holder: string, paths: string[]): void {
    for (const p of paths) {
      const other = this.writtenPaths.get(p);
      if (other && other !== holder) {
        throw new WriteConflictError(p, other);
      }
    }
    for (const p of paths) this.writtenPaths.set(p, holder);
    if (this.writer?.holder === holder) {
      for (const p of paths) this.writer.paths.add(p);
    }
  }

  /** Release every path claimed by a holder (used when a step fails). */
  releasePaths(holder: string): void {
    for (const [p, h] of Array.from(this.writtenPaths.entries())) {
      if (h === holder) this.writtenPaths.delete(p);
    }
  }

  get id(): string {
    return this.taskId;
  }
}

/**
 * Does this step declare itself as depending on `other`?
 */
export function dependsOn(step: PlanStep, otherIndex: number): boolean {
  return blockingDependencies(step).includes(otherIndex);
}

/**
 * Order the plan so every step runs AFTER the steps that block it.
 * Steps without dependencies keep their original relative order, so a plan
 * without dependencies is executed exactly as before.
 *
 * The second return value contains the steps that take part in a dependency
 * cycle — they can never become ready and must be skipped.
 */
export function topologicalOrder(steps: PlanStep[]): {
  order: PlanStep[];
  cyclic: Set<number>;
} {
  const cyclic = detectCycles(steps);
  const byIndex = new Map(steps.map((s) => [s.index, s]));
  const deps = dependencyMap(steps);
  const visited = new Set<number>();
  const order: PlanStep[] = [];

  const visit = (step: PlanStep, stack: Set<number>) => {
    if (visited.has(step.index)) return;
    if (stack.has(step.index)) return; // cycle — handled by `cyclic`
    visited.add(step.index);
    const nextStack = new Set(stack).add(step.index);
    for (const dep of (deps.get(step.index) ?? []).slice().sort((a, b) => a - b)) {
      const depStep = byIndex.get(dep);
      if (depStep && !cyclic.has(dep)) visit(depStep, nextStack);
    }
    order.push(step);
  };

  for (const step of [...steps].sort((a, b) => a.index - b.index)) {
    if (cyclic.has(step.index)) continue;
    visit(step, new Set());
  }

  return { order, cyclic };
}

/**
 * Convenience: dependency map as a plain object for the UI.
 */
export function describeDependencies(
  steps: PlanStep[]
): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const step of steps) {
    const deps = blockingDependencies(step);
    if (deps.length) out[step.index] = deps;
  }
  return out;
}

export type { StepDependency };
