// poller.test.ts — visibility-aware, non-overlapping polling schedule.
// DB-free — run: bun test tests/poller.test.ts
import { describe, expect, test } from 'bun:test';
import { Poller } from '../src/hooks/use-polling';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

interface FakeEnv {
  hidden: boolean;
  fireScheduled: () => void;
  fireVisible: () => void;
  runs: number;
  lastSignal: AbortSignal | null;
  release: () => void;
  blockNext: () => void;
}

function makeEnv(): FakeEnv & {
  schedule: (cb: () => void) => () => void;
  onVisible: (cb: () => void) => () => void;
  run: (signal: AbortSignal) => Promise<void>;
} {
  const env = {
    hidden: false,
    runs: 0,
    lastSignal: null as AbortSignal | null,
    scheduled: [] as Array<() => void>,
    visibleCbs: [] as Array<() => void>,
    gates: [] as Array<() => void>,
  };
  return {
    get hidden() {
      return env.hidden;
    },
    set hidden(v: boolean) {
      env.hidden = v;
    },
    get runs() {
      return env.runs;
    },
    get lastSignal() {
      return env.lastSignal;
    },
    fireScheduled: () => {
      for (const cb of [...env.scheduled]) cb();
    },
    fireVisible: () => {
      for (const cb of [...env.visibleCbs]) cb();
    },
    release: () => {
      const gates = env.gates.splice(0);
      for (const g of gates) g();
    },
    blockNext: () => {
      env.gates.push(() => undefined);
    },
    schedule: (cb: () => void) => {
      env.scheduled.push(cb);
      return () => {
        env.scheduled = env.scheduled.filter((c) => c !== cb);
      };
    },
    onVisible: (cb: () => void) => {
      env.visibleCbs.push(cb);
      return () => {
        env.visibleCbs = env.visibleCbs.filter((c) => c !== cb);
      };
    },
    run: async (signal: AbortSignal) => {
      env.runs++;
      env.lastSignal = signal;
      if (env.gates.length) {
        await new Promise<void>((r) => {
          env.gates.push(r);
        });
      }
    },
  } as unknown as FakeEnv & {
    schedule: (cb: () => void) => () => void;
    onVisible: (cb: () => void) => () => void;
    run: (signal: AbortSignal) => Promise<void>;
  };
}

function makePoller(env: ReturnType<typeof makeEnv>, intervalMs = 1000): Poller {
  return new Poller({
    intervalMs,
    run: env.run,
    isHidden: () => env.hidden,
    onVisible: env.onVisible,
    schedule: env.schedule,
  });
}

describe('Poller — visibility-aware non-overlapping schedule', () => {
  test('runs immediately on start, then on every tick', async () => {
    const env = makeEnv();
    const p = makePoller(env);
    p.start(true);
    await tick();
    expect(env.runs).toBe(1);
    env.fireScheduled();
    await tick();
    expect(env.runs).toBe(2);
    p.stop();
  });

  test('ticks are skipped while hidden', async () => {
    const env = makeEnv();
    const p = makePoller(env);
    p.start(false);
    env.hidden = true;
    env.fireScheduled();
    env.fireScheduled();
    await tick();
    expect(env.runs).toBe(0);
    p.stop();
  });

  test('returning to the tab triggers one fresh refresh', async () => {
    const env = makeEnv();
    const p = makePoller(env);
    p.start(false);
    env.hidden = true;
    env.fireScheduled();
    await tick();
    expect(env.runs).toBe(0);
    env.hidden = false;
    env.fireVisible();
    await tick();
    expect(env.runs).toBe(1);
    p.stop();
  });

  test('a tick never overlaps an in-flight run (dedup, no pile-up)', async () => {
    const env = makeEnv();
    const p = makePoller(env);
    p.start(false);
    env.blockNext(); // first run parks until released
    env.fireScheduled();
    await tick();
    expect(env.runs).toBe(1);
    expect(p.busy).toBe(true);
    // slow server: three more ticks arrive while run #1 is still going
    env.fireScheduled();
    env.fireScheduled();
    env.fireScheduled();
    await tick();
    expect(env.runs).toBe(1);
    env.release();
    await tick();
    expect(p.busy).toBe(false);
    env.fireScheduled();
    await tick();
    expect(env.runs).toBe(2);
    p.stop();
  });

  test('stop() aborts the in-flight run and ends the schedule', async () => {
    const env = makeEnv();
    const p = makePoller(env);
    p.start(false);
    env.blockNext();
    env.fireScheduled();
    await tick();
    expect(p.busy).toBe(true);
    p.stop();
    expect(env.lastSignal?.aborted).toBe(true);
    env.release();
    await tick();
    expect(p.running).toBe(false);
    env.fireScheduled();
    await tick();
    expect(env.runs).toBe(1); // no run after stop
  });

  test('a throwing run never breaks the schedule', async () => {
    const env = makeEnv();
    let calls = 0;
    const p = new Poller({
      intervalMs: 1000,
      run: () => {
        calls++;
        if (calls === 1) throw new Error('boom');
      },
      isHidden: () => false,
      onVisible: env.onVisible,
      schedule: env.schedule,
    });
    p.start(true);
    await tick();
    env.fireScheduled();
    await tick();
    expect(calls).toBe(2);
    p.stop();
  });
});
