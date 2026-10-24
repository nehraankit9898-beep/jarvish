// Task lifecycle + the BOUNDED REPAIR CYCLE.
//
// Regression coverage for three defects that were found in the audit:
//
//  1. the per-step repair loop returned `failed` instead of asking the agent
//     for a fix, so `maxFixAttempts` was dead configuration and a single
//     failing command failed the whole task immediately;
//  2. the retry budget was derived from the per-step attempt counters, which
//     a pause/resume cycle reset — the engine could therefore loop forever;
//  3. `autoPauseOnFailure` was declared in the task config but never read.
//
// All LLM traffic is mocked — no network and no API keys needed.
// Run: bun test tests/task-lifecycle.test.ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { db } from '../src/lib/db';
import { planTask, runTask } from '../src/lib/agentic/orchestrator';
import { listEvents } from '../src/lib/agentic/event-store';
import { removeWorkspace, readWorkspaceFile } from '../src/lib/agentic/workspace';
import {
  ACTIVE_TASK_STATUSES,
  TASK_LIFECYCLE,
  TASK_STATUS_LABELS,
  TERMINAL_TASK_STATUSES,
  isActiveStatus,
  isTerminalStatus,
  normalizeTaskStatus,
  type TaskStatus,
} from '../src/lib/agentic/types';
import { ModelRouter, type CompleteFn } from '../src/lib/agentic/model-router';
import type { AgentRoutingConfig } from '../src/lib/agentic/agent-config';

// ---------------------------------------------------------------------------
// 1. the lifecycle itself
// ---------------------------------------------------------------------------

describe('task lifecycle', () => {
  test('every state of the required lifecycle exists', () => {
    for (const status of [
      'queued',
      'planning',
      'running',
      'awaiting_approval',
      'verifying',
      'done',
      'failed',
      'cancelled',
    ] as TaskStatus[]) {
      expect(TASK_LIFECYCLE).toContain(status);
      expect(TASK_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  test('the terminal states are done, failed and cancelled', () => {
    expect([...TERMINAL_TASK_STATUSES].sort()).toEqual(['cancelled', 'done', 'failed']);
    expect(isTerminalStatus('done')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isActiveStatus('running')).toBe(true);
    expect(isActiveStatus('done')).toBe(false);
  });

  test('an alias is normalized, an unknown status is never "done"', () => {
    expect(normalizeTaskStatus('completed')).toBe('done');
    expect(normalizeTaskStatus('COMPLETED')).toBe('done');
    expect(normalizeTaskStatus('canceled')).toBe('cancelled');
    expect(normalizeTaskStatus('running')).toBe('running');
    expect(normalizeTaskStatus('something-else')).toBe('failed');
    expect(normalizeTaskStatus(undefined)).toBe('failed');
    expect(normalizeTaskStatus(null)).toBe('failed');
  });

  test('every active state is one the engine can resume from', () => {
    expect(ACTIVE_TASK_STATUSES).toContain('paused');
    expect(ACTIVE_TASK_STATUSES).toContain('queued');
    expect(ACTIVE_TASK_STATUSES).toContain('verifying');
  });
});

// ---------------------------------------------------------------------------
// 2. the bounded repair cycle
// ---------------------------------------------------------------------------

const PLAN_REPLY = JSON.stringify({
  title: 'Broken script',
  steps: [
    {
      index: 1,
      title: 'Write and verify the script',
      description: 'the script fails the first time',
      kind: 'implement',
      acceptance: 'node check.js exits 0',
    },
  ],
});

/** First reply writes a script that exits 1, the second one fixes it. */
function repairingComplete(calls: string[]): CompleteFn {
  return async (messages) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    if (system.includes('PLANNER')) {
      calls.push('planner');
      return PLAN_REPLY;
    }
    calls.push('coder');
    if (calls.filter((c) => c === 'coder').length === 1) {
      return [
        '### FILE: check.js',
        '```js',
        'console.log("still broken");',
        'process.exit(1);',
        '```',
        '### RUN: node check.js',
        '### END',
      ].join('\n');
    }
    return [
      '### FILE: check.js',
      '```js',
      'console.log("fixed");',
      '```',
      '### RUN: node check.js',
      '### END',
    ].join('\n');
  };
}

let taskId = '';

beforeAll(async () => {
  const task = await db.agenticTask.create({
    data: {
      prompt: 'Write a script that fails first and is then repaired',
      provider: 'zai',
      model: 'glm-4.6',
      status: 'queued',
      conversationId: 'conv_lifecycle',
    },
  });
  taskId = task.id;
});

afterAll(async () => {
  await db.agenticTask.deleteMany({ where: { id: taskId } });
  await removeWorkspace(taskId).catch(() => undefined);
});

describe('bounded repair cycle', () => {
  test('a failing command triggers a targeted fix instead of failing the task', async () => {
    const calls: string[] = [];
    const routing: AgentRoutingConfig = {
      agents: { planner: { provider: 'zai', model: 'glm-4.6' } },
    };

    await planTask(taskId, undefined, undefined, {
      routing,
      complete: repairingComplete(calls),
    });

    await runTask(taskId, {
      routing,
      complete: repairingComplete(calls),
    });

    // the agent was asked a SECOND time — the repair cycle really ran
    expect(calls.filter((c) => c === 'coder').length).toBeGreaterThanOrEqual(2);

    const task = await db.agenticTask.findUnique({ where: { id: taskId } });
    // the task COMPLETED instead of failing on the first error
    expect(task?.status).toBe('done');
    expect(task?.error).toBeNull();

    const steps = await db.agenticStep.findMany({
      where: { taskId },
      orderBy: { index: 'asc' },
    });
    expect(steps[0].status).toBe('passed');
    // the step really recorded the failed attempt
    expect(steps[0].attempts).toBeGreaterThanOrEqual(1);

    // the repaired file is what ended up in the workspace
    const content = await readWorkspaceFile(taskId, 'check.js');
    expect(content).toContain('fixed');
    expect(content).not.toContain('still broken');

    // the retry counter on the task grew — the budget is task-wide
    expect(task?.retriesUsed ?? 0).toBeGreaterThanOrEqual(1);
  }, 60000);

  test('the repair attempt is visible in the event stream', async () => {
    const events = await listEvents(taskId, 0);
    const repair = events.find(
      (e) =>
        e.type === 'step_start' &&
        Boolean((e.data as { repair?: boolean })?.repair)
    );
    expect(repair).toBeDefined();
  });

  test('a task that never succeeds is PAUSED (resumable), not silently dropped', async () => {
    const failingId = `repair_fail_${Date.now()}`;
    const task = await db.agenticTask.create({
      data: {
        prompt: 'A script that never works',
        provider: 'zai',
        model: 'glm-4.6',
        status: 'queued',
        conversationId: 'conv_lifecycle_fail',
      },
    });

    const alwaysFails: CompleteFn = async (messages) => {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      if (system.includes('PLANNER')) return PLAN_REPLY;
      return [
        '### FILE: broken.js',
        '```js',
        'process.exit(1);',
        '```',
        '### RUN: node broken.js',
        '### END',
      ].join('\n');
    };

    try {
      await planTask(task.id, undefined, undefined, { complete: alwaysFails });
      await runTask(task.id, { complete: alwaysFails });

      const after = await db.agenticTask.findUnique({ where: { id: task.id } });
      // autoPauseOnFailure is on by default → the task is paused, not failed,
      // and it keeps its state so the user can resume it
      expect(after?.status).toBe('paused');
      expect(after?.error).toBeTruthy();
      expect(after?.report).toBeTruthy();
      // the retry counter is bounded by maxFixAttempts
      expect(after?.retriesUsed ?? 0).toBeLessThanOrEqual(3);
    } finally {
      await db.agenticTask.deleteMany({ where: { id: task.id } });
      await removeWorkspace(task.id).catch(() => undefined);
      void failingId;
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// 3. free-tier-first routing
// ---------------------------------------------------------------------------

describe('free-tier-first routing', () => {
  test('a free provider is tried BEFORE a paid one', async () => {
    const called: string[] = [];
    const complete: CompleteFn = async (_m, config) => {
      called.push(config.provider);
      return 'ok';
    };
    const router = new ModelRouter({
      routing: {
        agents: {
          coder: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            fallback: { provider: 'ollama', model: 'qwen2.5' },
          },
        },
      },
      taskFallback: { provider: 'zai', model: 'glm-4.6' },
      complete,
      policy: {
        preferFree: true,
        autoFallback: true,
        providerOrder: ['openai', 'ollama'],
        costClassOf: (provider) => (provider === 'ollama' ? 'free' : 'paid'),
      },
      retryBackoffMs: 1,
    });

    await router.complete('coder', [{ role: 'user', content: 'hi' }]);
    expect(called[0]).toBe('ollama');
  });

  test('the paid provider is STILL used when the free one fails', async () => {
    const called: string[] = [];
    const complete: CompleteFn = async (_m, config) => {
      called.push(config.provider);
      if (config.provider === 'ollama') {
        throw new Error('API error 503: upstream down');
      }
      return 'paid answer';
    };
    const router = new ModelRouter({
      routing: {
        agents: {
          coder: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            fallback: { provider: 'ollama', model: 'qwen2.5' },
          },
        },
      },
      taskFallback: { provider: 'zai', model: 'glm-4.6' },
      complete,
      policy: {
        preferFree: true,
        autoFallback: true,
        providerOrder: ['openai', 'ollama'],
        costClassOf: (provider) => (provider === 'ollama' ? 'free' : 'paid'),
      },
      retryBackoffMs: 1,
    });

    const res = await router.complete('coder', [{ role: 'user', content: 'hi' }]);
    expect(called[0]).toBe('ollama');
    expect(res.provider).toBe('openai');
    expect(res.text).toBe('paid answer');
  });

  test('without preferFree the configured priority decides the order', async () => {
    const called: string[] = [];
    const complete: CompleteFn = async (_m, config) => {
      called.push(config.provider);
      return 'ok';
    };
    const router = new ModelRouter({
      routing: {
        agents: {
          coder: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            fallback: { provider: 'ollama', model: 'qwen2.5' },
          },
        },
      },
      taskFallback: { provider: 'zai', model: 'glm-4.6' },
      complete,
      policy: {
        autoFallback: true,
        providerOrder: ['openai', 'ollama'],
        costClassOf: (provider) => (provider === 'ollama' ? 'free' : 'paid'),
      },
      retryBackoffMs: 1,
    });

    await router.complete('coder', [{ role: 'user', content: 'hi' }]);
    expect(called[0]).toBe('openai');
  });
});
