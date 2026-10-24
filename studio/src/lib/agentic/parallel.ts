// parallel.ts — wave planning for the multi-agent executor.
//
// The engine used to run every step one after another, and the only
// concurrency it had was a read-only "swarm" running in the background while
// the serial loop walked the writers. That left the expensive part — the LLM
// thinking time of two independent `implement` steps — strictly serialized.
//
// This module answers one question, deterministically and without any LLM
// call: *which steps may run at the same time right now?* The rules are:
//
//   1. a step is a candidate only when every `blocks` dependency is already
//      passed/skipped (and nothing of the plan is running for it);
//   2. read-only steps (analyze / research) are always safe to run together;
//   3. a WRITING step may share a wave only when the planner declared the
//      files it will touch (`files: [...]`) AND those scopes are pairwise
//      disjoint — overlapping or undeclared scopes run alone;
//   4. the wave is bounded by `limit` (agent count) and by a smaller writer
//      cap, so a laptop with 12 GB RAM never runs 4 heavy writers at once.
//
// Everything here is pure: same input → same wave. That makes the scheduler
// unit-testable and keeps the orchestrator's job simple (execute, re-plan).
//
// Writes are still serialized *inside* a wave at the workspace level: the
// workspace lock is taken only around the file-apply / command / snapshot
// sections, so two writers overlap in their thinking time but never in their
// writes.

import {
  DONE_STATUSES,
  checkDependencies,
  isReadOnlyKind,
  type SchedulerStepStatus,
} from './scheduler';
import type { PlanStep } from './types';

/** how many agents may work at the same time by default */
export const DEFAULT_PARALLELISM = 3;
/** hard ceiling — more agents than this on a laptop just thrashes */
export const MAX_PARALLELISM = 4;
/** writers that may overlap inside one wave (their writes are still locked) */
export const DEFAULT_MAX_PARALLEL_WRITERS = 2;

/** Clamp an arbitrary caller value into a usable agent count. */
export function clampParallelism(value: unknown, fallback: number = DEFAULT_PARALLELISM): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.floor(n);
  if (int < 1) return 1;
  return Math.min(int, MAX_PARALLELISM);
}

/**
 * Normalize a workspace-relative path for conflict comparison.
 * Case-insensitive (Windows/macOS), forward slashes, no `./`, no duplicate or
 * trailing separators, no leading `/`.
 */
export function normalizeScopePath(raw: unknown): string {
  let p = String(raw ?? '').trim();
  if (!p) return '';
  p = p.replace(/\\/g, '/');
  p = p.replace(/^\.\/+/, '');
  p = p.replace(/^\/+/, '');
  p = p.replace(/\/{2,}/g, '/');
  p = p.replace(/\/+$/, '');
  return p.toLowerCase();
}

/**
 * Do two declared scopes overlap?
 * A scope may be a file (`src/app.ts`) or a folder (`src/lib`), so a shared
 * prefix at a path boundary counts as a conflict. An EMPTY scope means
 * "unknown" and therefore conflicts with everything.
 */
export function pathsConflict(a: string, b: string): boolean {
  const left = normalizeScopePath(a);
  const right = normalizeScopePath(b);
  if (!left || !right) return true;
  if (left === right) return true;
  if (right.startsWith(`${left}/`)) return true;
  if (left.startsWith(`${right}/`)) return true;
  return false;
}

/** The files a step DECLARED it will write (normalized, deduplicated). */
export function stepWriteScope(step: PlanStep): string[] {
  const files = Array.isArray(step.files) ? step.files : [];
  const out: string[] = [];
  for (const f of files) {
    const p = normalizeScopePath(f);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** true when a step may write to the workspace */
export function isWriterStep(step: PlanStep): boolean {
  return !isReadOnlyKind(step.kind);
}

export type WaveReason = 'read-only' | 'disjoint-writes' | 'serialized-write' | 'mixed' | 'single';

export interface PlannedWave {
  /** steps of this wave, ascending plan index */
  steps: PlanStep[];
  /** more than one step runs at the same time */
  concurrent: boolean;
  /** why this wave looks like it does — shown in the UI/audit log */
  reason: WaveReason;
  /** how many WRITING steps are in the wave (their writes stay locked) */
  writers: number;
  /** writers of the wave whose declared scopes do not overlap */
  disjointWriters: boolean;
}

export interface PlanWaveOptions {
  /** max agents in a wave (1 = fully serial) */
  limit?: number;
  /** allow two writers with disjoint declared scopes in one wave */
  allowParallelWrites?: boolean;
  /** max writers inside a wave */
  maxWriters?: number;
}

/** Ready steps (pending + dependencies satisfied), ascending index. */
export function readyForWave(
  steps: PlanStep[],
  statuses: Map<number, SchedulerStepStatus>
): PlanStep[] {
  return steps
    .filter((step) => {
      const status = statuses.get(step.index);
      if (status && status !== 'pending') return false;
      return checkDependencies(step, statuses).satisfied;
    })
    .sort((a, b) => a.index - b.index);
}

/**
 * Choose the next wave of work.
 * Returns `null` when nothing is runnable right now.
 */
export function planWave(
  steps: PlanStep[],
  statuses: Map<number, SchedulerStepStatus>,
  opts: PlanWaveOptions = {}
): PlannedWave | null {
  const limit = clampParallelism(opts.limit);
  const allowParallelWrites = opts.allowParallelWrites ?? true;
  const maxWriters = Math.max(
    1,
    Math.min(opts.maxWriters ?? DEFAULT_MAX_PARALLEL_WRITERS, limit)
  );

  const ready = readyForWave(steps, statuses);
  if (!ready.length) return null;

  const byIndex = [...steps].sort((a, b) => a.index - b.index);

  /**
   * Plan ORDER is part of the safety contract: a writer may only start when
   * every writer BEFORE it is finished (or is part of this very wave). Without
   * this, a `test` step whose `blocks` dependency the planner forgot could run
   * while the file it verifies is still being written.
   */
  const earlierWritersSettled = (step: PlanStep, chosenIndexes: Set<number>): boolean => {
    for (const other of byIndex) {
      if (other.index >= step.index) break;
      if (!isWriterStep(other)) continue;
      if (chosenIndexes.has(other.index)) continue;
      const status = statuses.get(other.index);
      if (!status || !DONE_STATUSES.includes(status)) return false;
    }
    return true;
  };

  const chosen: PlanStep[] = [];
  const chosenIndexes = new Set<number>();
  const usedScopes: string[] = [];
  let writerCount = 0;
  /** set once a writer could not be scheduled — no later writer may overtake it */
  let barrierClosed = false;

  for (const step of ready) {
    if (chosen.length >= limit) break;

    if (!isWriterStep(step)) {
      // read-only agents never write, so they may always share a wave
      chosen.push(step);
      chosenIndexes.add(step.index);
      continue;
    }

    if (barrierClosed) continue;
    if (!earlierWritersSettled(step, chosenIndexes)) continue;

    const scope = stepWriteScope(step);
    if (!allowParallelWrites || !scope.length) {
      // undeclared scope (or parallel writes disabled): this step runs ALONE
      // and blocks every later writer of this wave
      if (writerCount > 0) {
        barrierClosed = true;
        continue;
      }
      chosen.push(step);
      chosenIndexes.add(step.index);
      writerCount++;
      barrierClosed = true;
      continue;
    }

    if (writerCount >= maxWriters) {
      barrierClosed = true;
      continue;
    }
    if (scope.some((p) => usedScopes.some((u) => pathsConflict(p, u)))) {
      // overlapping scope: it must wait for the other writer
      barrierClosed = true;
      continue;
    }
    chosen.push(step);
    chosenIndexes.add(step.index);
    writerCount++;
    usedScopes.push(...scope);
  }

  if (!chosen.length) return null;
  const wave = chosen.sort((a, b) => a.index - b.index);
  const chosenWriters = wave.filter(isWriterStep);
  const chosenReaders = wave.filter((s) => !isWriterStep(s));

  const writersInWave = chosenWriters.length;
  const disjointWriters = writersInWave > 1;
  let reason: WaveReason;
  if (wave.length === 1) reason = 'single';
  else if (writersInWave === 0) reason = 'read-only';
  else if (writersInWave > 1) reason = 'disjoint-writes';
  else if (chosenReaders.length) reason = 'mixed';
  else reason = 'serialized-write';

  return {
    steps: wave,
    concurrent: wave.length > 1,
    reason,
    writers: writersInWave,
    disjointWriters,
  };
}

/** Human readable one-liner for the run log / UI. */
export function describeWave(wave: PlannedWave): string {
  const indexes = wave.steps.map((s) => `#${s.index}`).join(', ');
  if (!wave.concurrent) return `▶ step ${indexes} (serial)`;
  const label =
    wave.reason === 'read-only'
      ? 'independent read-only agents'
      : wave.reason === 'disjoint-writes'
        ? 'disjoint-scope writers (writes locked)'
        : wave.reason === 'mixed'
          ? 'reader + writer agents'
          : 'agents';
  return `🧩 ${wave.steps.length} ${label} in parallel: ${indexes}`;
}

/**
 * Run `worker` over `items` with at most `limit` promises in flight.
 * Results keep the input order (like Promise.all, but bounded).
 */
export async function boundedMap<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const size = Math.max(1, Math.min(clampParallelism(limit), items.length || 1));
  const results = new Array<R>(items.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => runner()));
  return results;
}

export interface StepProgressRow {
  index: number;
  status: string;
}

export interface ProgressCounts {
  total: number;
  passed: number;
  failed: number;
  denied: number;
  skipped: number;
  running: number;
  pending: number;
  /** finished (terminal) steps */
  done: number;
  /** 0-100, integer */
  percent: number;
}

/**
 * Overall task progress from the step rows.
 * `percent` counts terminal steps only — a running step is not "done".
 */
export function computeProgress(rows: readonly StepProgressRow[]): ProgressCounts {
  const counts: ProgressCounts = {
    total: rows.length,
    passed: 0,
    failed: 0,
    denied: 0,
    skipped: 0,
    running: 0,
    pending: 0,
    done: 0,
    percent: 0,
  };
  for (const row of rows) {
    switch (row.status) {
      case 'passed':
        counts.passed++;
        break;
      case 'failed':
        counts.failed++;
        break;
      case 'denied':
        counts.denied++;
        break;
      case 'skipped':
        counts.skipped++;
        break;
      case 'running':
      case 'awaiting_approval':
        counts.running++;
        break;
      default:
        counts.pending++;
        break;
    }
  }
  counts.done = counts.passed + counts.failed + counts.denied + counts.skipped;
  counts.percent = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
  return counts;
}

/**
 * Validated parallelism settings from an API request body.
 * Unknown/invalid values are dropped instead of trusted — the engine falls
 * back to its own defaults.
 */
export function parallelConfigFromBody(body: unknown): {
  parallelism?: number;
  parallelWrites?: boolean;
} {
  const source = (body ?? {}) as Record<string, unknown>;
  const out: { parallelism?: number; parallelWrites?: boolean } = {};
  if (source.parallelism !== undefined && source.parallelism !== null) {
    out.parallelism = clampParallelism(source.parallelism);
  }
  if (typeof source.parallelWrites === 'boolean') {
    out.parallelWrites = source.parallelWrites;
  }
  return out;
}

/** Build the status map the scheduler expects from the persisted rows. */
export function statusMap(
  rows: readonly { index: number; status: string }[]
): Map<number, SchedulerStepStatus> {
  return new Map(rows.map((r) => [r.index, r.status as SchedulerStepStatus]));
}
