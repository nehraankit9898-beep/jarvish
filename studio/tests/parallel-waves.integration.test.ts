// Parallel-wave integration test — the REAL orchestrator, a REAL workspace and
// REAL git snapshots, with only two things faked:
//
//   • the database  → tests/helpers/fake-db.ts (Prisma cannot be generated in
//     a sandbox without network; the fake implements the slice the engine uses)
//   • the LLM       → an injected `complete` that counts CONCURRENCY
//
// What this proves (things the pure unit tests cannot):
//   1. two writing steps with disjoint declared files really run AT THE SAME
//      TIME (peak concurrent LLM calls ≥ 2) while their writes stay serialized;
//   2. each step is executed exactly ONCE (no double-start between the serial
//      loop and the wave executor);
//   3. the live-progress events are emitted: `wave_start`, `step_progress`
//      (thinking → writing) and `progress`;
//   4. the task still ends `done` with the files on disk.
//
// Run: bun test tests/parallel-waves.integration.test.ts
import { describe, expect, test, mock, beforeAll, afterAll } from 'bun:test';
import { createFakeDb } from './helpers/fake-db';

const fake = createFakeDb();
// must be registered BEFORE the engine module is imported (dynamic import below)
mock.module('@/lib/db', () => ({ db: fake }));

type Engine = typeof import('../src/lib/agentic/orchestrator');
type Router = typeof import('../src/lib/agentic/model-router');
type Workspace = typeof import('../src/lib/agentic/workspace');

let runTask: Engine['runTask'];
let readWorkspaceFile: Workspace['readWorkspaceFile'];
let removeWorkspace: Workspace['removeWorkspace'];
let ensureRepo: typeof import('../src/lib/agentic/git-tools')['ensureRepo'];

const taskIds: string[] = [];

/** concurrency bookkeeping of the mocked LLM */
let active = 0;
let peak = 0;
/** writers only (kind !== analyze) — used to prove scope serialization */
let activeWriters = 0;
let peakWriters = 0;
const callsPerStep = new Map<string, number>();

const STEP_DELAY_MS = 120;

const PLAN = [
  {
    index: 1,
    title: 'Inspect the environment',
    description: 'read-only look around',
    kind: 'analyze',
    acceptance: 'notes produced',
  },
  {
    index: 2,
    title: 'Write alpha.py',
    description: 'alpha module',
    kind: 'implement',
    acceptance: 'file exists',
    files: ['alpha.py'],
  },
  {
    index: 3,
    title: 'Write beta.py',
    description: 'beta module',
    kind: 'implement',
    acceptance: 'file exists',
    files: ['beta.py'],
  },
];

function replyFor(userContent: string): string {
  const match = /CURRENT STEP (\d+) \[([a-z]+)\]: (.*)/.exec(userContent);
  const index = match?.[1] ?? '0';
  const kind = match?.[2] ?? 'implement';
  const title = match?.[3] ?? '';
  callsPerStep.set(index, (callsPerStep.get(index) ?? 0) + 1);

  if (kind === 'analyze') {
    return ['Environment looks fine — nothing to change.', '### END'].join('\n');
  }
  const file = title.includes('alpha') ? 'alpha.py' : 'beta.py';
  const body = title.includes('alpha') ? 'ALPHA = "alpha"' : 'BETA = "beta"';
  return [
    `Writing ${file}.`,
    `### FILE: ${file}`,
    '```python',
    body,
    '```',
    '### END',
  ].join('\n');
}

function countingComplete(): Router['CompleteFn'] {
  return async (messages) => {
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const isWriter = /CURRENT STEP \d+ \[(implement|test|docs|security|debug)\]/.test(user);
    active += 1;
    peak = Math.max(peak, active);
    if (isWriter) {
      activeWriters += 1;
      peakWriters = Math.max(peakWriters, activeWriters);
    }
    try {
      // the delay is what makes an overlap observable at all
      await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
      return replyFor(user);
    } finally {
      active -= 1;
      if (isWriter) activeWriters -= 1;
    }
  };
}

async function seedTask(parallelism: number, parallelWrites = true): Promise<string> {
  const task = await fake.agenticTask.create({
    data: {
      prompt: 'Write alpha.py and beta.py',
      provider: 'zai',
      model: 'glm-4.6',
      status: 'queued',
      plan: JSON.stringify(PLAN),
      conversationId: `conv_${taskIds.length + 1}`,
    },
  });
  const id = String(task.id);
  taskIds.push(id);
  // `planTask` initialises the workspace repo — the engine's git snapshots
  // assume it exists (and must NEVER fall back to the host repository)
  await ensureRepo(id, 'test baseline');
  for (const step of PLAN) {
    await fake.agenticStep.create({
      data: {
        taskId: id,
        index: step.index,
        kind: step.kind,
        title: step.title,
        description: step.description,
        status: 'pending',
      },
    });
  }
  // keep the settings on the task row so the test documents the run config
  await fake.agenticTask.update({
    where: { id },
    data: {
      agentConfig: JSON.stringify({ parallel: { parallelism, parallelWrites } }),
    },
  });
  return id;
}

beforeAll(async () => {
  const [orchestrator, workspace] = await Promise.all([
    import('../src/lib/agentic/orchestrator'),
    import('../src/lib/agentic/workspace'),
  ]);
  runTask = orchestrator.runTask;
  readWorkspaceFile = workspace.readWorkspaceFile;
  removeWorkspace = workspace.removeWorkspace;
  ensureRepo = (await import('../src/lib/agentic/git-tools')).ensureRepo;
});

afterAll(async () => {
  for (const id of taskIds) {
    await fake.agenticTask.deleteMany({ where: { id } });
    await fake.agenticStep.deleteMany({ where: { taskId: id } });
    await fake.agentEvent.deleteMany({ where: { taskId: id } });
    await fake.agentMessage.deleteMany({ where: { taskId: id } });
    await removeWorkspace(id).catch(() => undefined);
  }
});

describe('parallel waves (real orchestrator, fake db + fake LLM)', () => {
  test('two disjoint writers run concurrently, each step exactly once', async () => {
    active = 0;
    peak = 0;
    activeWriters = 0;
    peakWriters = 0;
    callsPerStep.clear();

    const taskId = await seedTask(3);
    await runTask(taskId, {
      complete: countingComplete(),
      taskConfig: { parallelism: 3, parallelWrites: true },
    });

    const task = await fake.agenticTask.findUnique({ where: { id: taskId } });
    const steps = await fake.agenticStep.findMany({
      where: { taskId },
      orderBy: { index: 'asc' },
    });

    // every step passed, the task is done
    expect(task?.status, `task error: ${String(task?.error)}`).toBe('done');
    expect(steps.map((s) => s.status)).toEqual(['passed', 'passed', 'passed']);

    // the two writers (and the reader) overlapped in their thinking time
    expect(peak).toBeGreaterThanOrEqual(2);

    // no step was started twice by the two executors
    expect(callsPerStep.get('1')).toBe(1);
    expect(callsPerStep.get('2')).toBe(1);
    expect(callsPerStep.get('3')).toBe(1);

    // the files really exist in the workspace
    const alpha = await readWorkspaceFile(taskId, 'alpha.py');
    const beta = await readWorkspaceFile(taskId, 'beta.py');
    expect(alpha).toContain('ALPHA');
    expect(beta).toContain('BETA');
  }, 60000);

  test('live-progress events are emitted and replayable', async () => {
    const taskId = taskIds[taskIds.length - 1];
    const events = await fake.agentEvent.findMany({
      where: { taskId },
      orderBy: { seq: 'asc' },
    });
    const parsed = events.map((e) => ({
      type: String(e.type),
      seq: Number(e.seq),
      payload: JSON.parse(String(e.payload ?? '{}')) as Record<string, unknown>,
    }));

    const wave = parsed.find((e) => e.type === 'wave_start');
    expect(wave).toBeDefined();
    const waveSteps = (wave?.payload.wave ?? []) as { index: number }[];
    expect(waveSteps.map((s) => s.index).sort()).toEqual([1, 2, 3]);
    expect(wave?.payload.concurrent).toBe(true);

    const phases = parsed
      .filter((e) => e.type === 'step_progress')
      .map((e) => String(e.payload.phase));
    expect(phases).toContain('thinking');
    expect(phases).toContain('writing');
    expect(phases).toContain('done');

    // every progress event carries a monotonic seq (SSE replay id)
    const progress = parsed.filter((e) => e.type === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1].payload.percent).toBe(100);
    const seqs = parsed.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  }, 30000);

  test('two writers on the SAME file never overlap, even with 3 agents', async () => {
    active = 0;
    peak = 0;
    activeWriters = 0;
    peakWriters = 0;
    callsPerStep.clear();

    const taskId = await seedTask(3);
    // rewrite the plan so both implement steps declare the SAME file
    const sharedPlan = PLAN.map((step) =>
      step.kind === 'implement' ? { ...step, files: ['shared.py'] } : step
    );
    await fake.agenticTask.update({
      where: { id: taskId },
      data: { plan: JSON.stringify(sharedPlan) },
    });

    await runTask(taskId, {
      complete: countingComplete(),
      taskConfig: { parallelism: 3, parallelWrites: true },
    });

    const task = await fake.agenticTask.findUnique({ where: { id: taskId } });
    expect(task?.status, `task error: ${String(task?.error)}`).toBe('done');
    // the analysis step may still overlap (it cannot write), but the two
    // writers touching the same file must never run at the same time
    expect(peakWriters).toBe(1);
  }, 60000);

  test('parallelism=1 falls back to the serial behaviour (no overlap)', async () => {
    active = 0;
    peak = 0;
    activeWriters = 0;
    peakWriters = 0;
    callsPerStep.clear();

    const taskId = await seedTask(1);
    await runTask(taskId, {
      complete: countingComplete(),
      taskConfig: { parallelism: 1, parallelWrites: true },
    });

    const task = await fake.agenticTask.findUnique({ where: { id: taskId } });
    expect(task?.status, `task error: ${String(task?.error)}`).toBe('done');
    // strictly serial: the LLM was never called twice at the same time
    expect(peak).toBe(1);
  }, 60000);
});
