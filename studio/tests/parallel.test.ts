// Parallel multi-agent execution — scheduling, scope safety and progress tests.
//
// These tests are pure (no DB, no network, no LLM): the wave planner must be
// deterministic, because it decides which agents may run at the same time.
//
// Run: bun test tests/parallel.test.ts
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_PARALLEL_WRITERS,
  MAX_PARALLELISM,
  boundedMap,
  clampParallelism,
  computeProgress,
  describeWave,
  normalizeScopePath,
  parallelConfigFromBody,
  pathsConflict,
  planWave,
  readyForWave,
  statusMap,
  stepWriteScope,
} from '../src/lib/agentic/parallel';
import { buildPlanParse } from '../src/lib/agentic/roles';
import type { PlanStep } from '../src/lib/agentic/types';

function step(partial: Partial<PlanStep> & { index: number }): PlanStep {
  return {
    index: partial.index,
    title: partial.title ?? `Step ${partial.index}`,
    description: partial.description ?? '',
    kind: partial.kind ?? 'implement',
    acceptance: partial.acceptance ?? '',
    ...(partial.files ? { files: partial.files } : {}),
    ...(partial.dependencies ? { dependencies: partial.dependencies } : {}),
  };
}

function statuses(entries: Record<number, string>) {
  return statusMap(
    Object.entries(entries).map(([index, status]) => ({ index: Number(index), status }))
  );
}

describe('clampParallelism', () => {
  test('defaults and clamps into the supported range', () => {
    expect(clampParallelism(undefined)).toBe(3);
    expect(clampParallelism(undefined, 2)).toBe(2);
    expect(clampParallelism(0)).toBe(1);
    expect(clampParallelism(-5)).toBe(1);
    expect(clampParallelism(9)).toBe(MAX_PARALLELISM);
    expect(clampParallelism(2.7)).toBe(2);
    expect(clampParallelism('4')).toBe(4);
    expect(clampParallelism('abc')).toBe(3);
  });
});

describe('path scopes', () => {
  test('normalizeScopePath is separator/case safe', () => {
    expect(normalizeScopePath('./src\\\\app.ts')).toBe('src/app.ts');
    expect(normalizeScopePath('/src//lib/')).toBe('src/lib');
    expect(normalizeScopePath('   ')).toBe('');
  });

  test('same file conflicts', () => {
    expect(pathsConflict('src/app.ts', 'src/app.ts')).toBe(true);
    expect(pathsConflict('SRC/App.TS', './src/app.ts')).toBe(true);
  });

  test('folder scope conflicts with its children', () => {
    expect(pathsConflict('src/lib', 'src/lib/agentic/parallel.ts')).toBe(true);
    expect(pathsConflict('src/lib/', 'src/lib')).toBe(true);
  });

  test('sibling files do not conflict', () => {
    expect(pathsConflict('src/a.ts', 'src/b.ts')).toBe(false);
    expect(pathsConflict('src/lib/a.ts', 'src/libx/a.ts')).toBe(false);
  });

  test('empty scope is unknown → conflicts with everything', () => {
    expect(pathsConflict('', 'src/a.ts')).toBe(true);
    expect(pathsConflict('src/a.ts', '')).toBe(true);
  });

  test('stepWriteScope normalizes + deduplicates', () => {
    expect(stepWriteScope(step({ index: 1, files: ['./a.ts', 'a.ts', 'b/c.py'] }))).toEqual([
      'a.ts',
      'b/c.py',
    ]);
    expect(stepWriteScope(step({ index: 1 }))).toEqual([]);
  });
});

describe('planWave', () => {
  test('nothing ready → null', () => {
    const steps = [step({ index: 1, kind: 'implement', files: ['a.ts'] })];
    expect(planWave(steps, statuses({ 1: 'passed' }))).toBeNull();
  });

  test('independent read-only steps share a wave (default limit 3)', () => {
    const steps = [
      step({ index: 1, kind: 'analyze' }),
      step({ index: 2, kind: 'research' }),
      step({ index: 3, kind: 'analyze' }),
      step({ index: 4, kind: 'analyze' }),
    ];
    const wave = planWave(steps, statuses({}));
    expect(wave?.steps.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(wave?.reason).toBe('read-only');
    expect(wave?.concurrent).toBe(true);
  });

  test('limit 1 serializes everything', () => {
    const steps = [step({ index: 1, kind: 'analyze' }), step({ index: 2, kind: 'analyze' })];
    const wave = planWave(steps, statuses({}), { limit: 1 });
    expect(wave?.steps.map((s) => s.index)).toEqual([1]);
    expect(wave?.reason).toBe('single');
  });

  test('a writer without declared files always runs alone', () => {
    const steps = [
      step({ index: 1, kind: 'implement' }),
      step({ index: 2, kind: 'analyze' }),
    ];
    const wave = planWave(steps, statuses({}));
    expect(wave?.steps.map((s) => s.index)).toEqual([1, 2]);
    expect(wave?.writers).toBe(1);
    // the reader still joins — it cannot write, so it is safe
    expect(wave?.reason).toBe('mixed');
  });

  test('two writers with disjoint scopes share a wave', () => {
    const steps = [
      step({ index: 1, kind: 'implement', files: ['src/a.py'] }),
      step({ index: 2, kind: 'implement', files: ['src/b.py'] }),
    ];
    const wave = planWave(steps, statuses({}));
    expect(wave?.steps.map((s) => s.index)).toEqual([1, 2]);
    expect(wave?.reason).toBe('disjoint-writes');
    expect(wave?.writers).toBe(2);
    expect(wave?.disjointWriters).toBe(true);
  });

  test('an undeclared writer never overlaps another writer (plan order wins)', () => {
    const steps = [step({ index: 1, kind: 'implement' }), step({ index: 2, kind: 'implement' })];
    expect(planWave(steps, statuses({}))?.steps.map((s) => s.index)).toEqual([1]);
    expect(planWave(steps, statuses({ 1: 'passed' }))?.steps.map((s) => s.index)).toEqual([2]);
  });

  test('an earlier RUNNING writer blocks a later one', () => {
    const steps = [step({ index: 1, kind: 'implement' }), step({ index: 2, kind: 'implement' })];
    expect(planWave(steps, statuses({ 1: 'running' }))).toBeNull();
  });

  test('a declared writer may not overtake an undeclared one', () => {
    const steps = [
      step({ index: 1, kind: 'implement' }),
      step({ index: 2, kind: 'implement', files: ['b.py'] }),
    ];
    expect(planWave(steps, statuses({ 1: 'running' }))).toBeNull();
    expect(planWave(steps, statuses({ 1: 'passed' }))?.steps.map((s) => s.index)).toEqual([2]);
  });

  test('a legacy plan (implement + test, no deps) stays strictly ordered', () => {
    const steps = [
      step({ index: 1, kind: 'implement', files: ['calc.js'] }),
      step({ index: 2, kind: 'test' }),
      step({ index: 3, kind: 'review' }),
    ];
    expect(planWave(steps, statuses({}))?.steps.map((s) => s.index)).toEqual([1]);
    expect(planWave(steps, statuses({ 1: 'running' }))).toBeNull();
    expect(planWave(steps, statuses({ 1: 'passed' }))?.steps.map((s) => s.index)).toEqual([2]);
  });

  test('overlapping scopes are serialized', () => {
    const steps = [
      step({ index: 1, kind: 'implement', files: ['src/app.py'] }),
      step({ index: 2, kind: 'implement', files: ['src/app.py'] }),
    ];
    const wave = planWave(steps, statuses({}));
    expect(wave?.steps.map((s) => s.index)).toEqual([1]);
    expect(wave?.reason).toBe('single');
  });

  test('folder scope overlaps its children', () => {
    const steps = [
      step({ index: 1, kind: 'implement', files: ['src'] }),
      step({ index: 2, kind: 'implement', files: ['src/app.py'] }),
    ];
    const wave = planWave(steps, statuses({}));
    expect(wave?.steps.map((s) => s.index)).toEqual([1]);
  });

  test('parallel writes can be switched off', () => {
    const steps = [
      step({ index: 1, kind: 'implement', files: ['a.py'] }),
      step({ index: 2, kind: 'implement', files: ['b.py'] }),
    ];
    const wave = planWave(steps, statuses({}), { allowParallelWrites: false });
    expect(wave?.steps.map((s) => s.index)).toEqual([1]);
    expect(wave?.reason).toBe('single');
  });

  test('writers are capped inside one wave', () => {
    const steps = [
      step({ index: 1, kind: 'implement', files: ['a.py'] }),
      step({ index: 2, kind: 'implement', files: ['b.py'] }),
      step({ index: 3, kind: 'implement', files: ['c.py'] }),
      step({ index: 4, kind: 'implement', files: ['d.py'] }),
    ];
    const wave = planWave(steps, statuses({}), { limit: 4 });
    expect(wave?.steps.length).toBe(DEFAULT_MAX_PARALLEL_WRITERS);
    expect(wave?.writers).toBe(DEFAULT_MAX_PARALLEL_WRITERS);
  });

  test('blocking dependencies keep a step out of the wave', () => {
    const steps = [
      step({ index: 1, kind: 'implement', files: ['a.py'] }),
      step({
        index: 2,
        kind: 'test',
        files: ['b.py'],
        dependencies: [{ stepIndex: 1, type: 'blocks' }],
      }),
    ];
    const wave = planWave(steps, statuses({}));
    expect(wave?.steps.map((s) => s.index)).toEqual([1]);

    const next = planWave(steps, statuses({ 1: 'passed' }));
    expect(next?.steps.map((s) => s.index)).toEqual([2]);
  });

  test('a failed dependency never becomes runnable', () => {
    const steps = [
      step({ index: 1, kind: 'implement', files: ['a.py'] }),
      step({
        index: 2,
        kind: 'test',
        dependencies: [{ stepIndex: 1, type: 'blocks' }],
      }),
    ];
    const wave = planWave(steps, statuses({ 1: 'failed' }));
    expect(wave).toBeNull();
  });

  test('running steps are not re-scheduled', () => {
    const steps = [step({ index: 1, kind: 'analyze' }), step({ index: 2, kind: 'analyze' })];
    const wave = planWave(steps, statuses({ 1: 'running' }));
    expect(wave?.steps.map((s) => s.index)).toEqual([2]);
  });

  test('readyForWave is ordered by plan index', () => {
    const steps = [
      step({ index: 3, kind: 'analyze' }),
      step({ index: 1, kind: 'analyze' }),
      step({ index: 2, kind: 'analyze' }),
    ];
    expect(readyForWave(steps, statuses({})).map((s) => s.index)).toEqual([1, 2, 3]);
  });

  test('describeWave explains the wave in one line', () => {
    const steps = [step({ index: 1, kind: 'analyze' }), step({ index: 2, kind: 'analyze' })];
    const wave = planWave(steps, statuses({}))!;
    expect(describeWave(wave)).toContain('parallel');
    expect(describeWave(wave)).toContain('#1, #2');
  });
});

describe('boundedMap', () => {
  test('respects the concurrency limit and keeps input order', async () => {
    let active = 0;
    let peak = 0;
    const out = await boundedMap([5, 1, 3, 2, 4], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  test('a limit above the item count still runs everything once', async () => {
    const calls: number[] = [];
    const out = await boundedMap([1, 2, 3], 9, async (n) => {
      calls.push(n);
      return n;
    });
    expect(out).toEqual([1, 2, 3]);
    expect(calls.sort()).toEqual([1, 2, 3]);
  });
});

describe('computeProgress', () => {
  test('counts each status and only terminal steps as done', () => {
    const progress = computeProgress([
      { index: 1, status: 'passed' },
      { index: 2, status: 'running' },
      { index: 3, status: 'pending' },
      { index: 4, status: 'failed' },
      { index: 5, status: 'skipped' },
    ]);
    expect(progress).toMatchObject({
      total: 5,
      passed: 1,
      failed: 1,
      skipped: 1,
      running: 1,
      pending: 1,
      done: 3,
      percent: 60,
    });
  });

  test('empty task reports 0%', () => {
    expect(computeProgress([]).percent).toBe(0);
  });

  test('awaiting_approval counts as running, not as done', () => {
    const progress = computeProgress([{ index: 1, status: 'awaiting_approval' }]);
    expect(progress.running).toBe(1);
    expect(progress.done).toBe(0);
    expect(progress.percent).toBe(0);
  });
});

describe('parallelConfigFromBody', () => {
  test('accepts valid values', () => {
    expect(parallelConfigFromBody({ parallelism: 2, parallelWrites: false })).toEqual({
      parallelism: 2,
      parallelWrites: false,
    });
  });

  test('drops junk instead of trusting it', () => {
    expect(parallelConfigFromBody({ parallelism: 99 })).toEqual({ parallelism: MAX_PARALLELISM });
    expect(parallelConfigFromBody({ parallelism: 'x' })).toEqual({ parallelism: 3 });
    expect(parallelConfigFromBody({ parallelWrites: 'yes' })).toEqual({});
    expect(parallelConfigFromBody(null)).toEqual({});
  });
});

describe('planner declarations', () => {
  test('files are parsed and sanitized', () => {
    const reply = JSON.stringify({
      title: 'demo',
      steps: [
        {
          index: 1,
          title: 'write api',
          kind: 'implement',
          acceptance: 'file exists',
          files: ['src/api.py', '/etc/passwd', '../escape.ts', 'C:\\\\win.ini', 'src/api.py'],
        },
      ],
    });
    const { steps } = buildPlanParse(reply);
    expect(steps[0].files).toEqual(['src/api.py']);
  });

  test('missing files stay undefined', () => {
    const reply = JSON.stringify({
      title: 'demo',
      steps: [{ index: 1, title: 'x', kind: 'analyze', acceptance: 'y' }],
    });
    const { steps } = buildPlanParse(reply);
    expect(steps[0].files).toBeUndefined();
  });

  test('a plan declaring disjoint files runs as one wave, overlapping ones serial', () => {
    const plan = buildPlanParse(
      JSON.stringify({
        title: 'demo',
        steps: [
          { index: 1, title: 'a', kind: 'implement', acceptance: 'a', files: ['a.py'] },
          { index: 2, title: 'b', kind: 'implement', acceptance: 'b', files: ['b.py'] },
          { index: 3, title: 'c', kind: 'implement', acceptance: 'c', files: ['b.py'] },
        ],
      })
    ).steps;

    const first = planWave(plan, statuses({}));
    expect(first?.steps.map((s) => s.index)).toEqual([1, 2]);
    const second = planWave(plan, statuses({ 1: 'passed', 2: 'passed' }));
    expect(second?.steps.map((s) => s.index)).toEqual([3]);
  });
});
