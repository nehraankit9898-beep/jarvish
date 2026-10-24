// Multi-agent integration test — the WHOLE workflow runs against MOCK
// providers: no network, no API keys.
// plan → coder → tester → reviewer, with per-role routing, agent-to-agent
// messages, persisted events and a real test command executed in the sandbox.
// Run: bun test tests/multi-agent.integration.test.ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { db } from '../src/lib/db';
import { planTask, runTask } from '../src/lib/agentic/orchestrator';
import { listEvents } from '../src/lib/agentic/event-store';
import { readWorkspaceFile, removeWorkspace } from '../src/lib/agentic/workspace';
import type { CompleteFn } from '../src/lib/agentic/model-router';

const TASK_PROMPT = 'Build a tiny calculator script and verify it';

const PLAN_REPLY = JSON.stringify({
  title: 'Calculator',
  steps: [
    {
      index: 1,
      title: 'Write calc.js',
      description: 'create the calculator',
      kind: 'implement',
      acceptance: 'file exists',
    },
    {
      index: 2,
      title: 'Verify calc.js',
      description: 'run it for real',
      kind: 'test',
      acceptance: 'exit 0',
    },
    {
      index: 3,
      title: 'Final review',
      description: 'check the diff',
      kind: 'review',
      acceptance: 'verdict',
    },
  ],
});

const CODER_REPLY = [
  'Calculator likh raha hoon.',
  '### FILE: calc.js',
  '```js',
  'const add = (a, b) => a + b;',
  'console.log("sum=" + add(2, 3));',
  '```',
  '### RUN: node calc.js',
  '### END',
].join('\n');

const TESTER_REPLY = ['### RUN: node calc.js', '### END'].join('\n');

const REVIEWER_REPLY = JSON.stringify({
  verdict: 'pass',
  issues: [],
  summary: 'Calculator implemented and verified.',
});

let taskId = '';
const calls: string[] = [];

function mockComplete(): CompleteFn {
  return async (messages) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    if (system.includes('PLANNER')) {
      calls.push('planner');
      return PLAN_REPLY;
    }
    if (system.includes('TESTER')) {
      calls.push('tester');
      return TESTER_REPLY;
    }
    if (system.includes('REVIEWER')) {
      calls.push('reviewer');
      return REVIEWER_REPLY;
    }
    calls.push('coder');
    return CODER_REPLY;
  };
}

beforeAll(async () => {
  const task = await db.agenticTask.create({
    data: {
      prompt: TASK_PROMPT,
      provider: 'zai',
      model: 'glm-4.6',
      status: 'planning',
      conversationId: 'conv_integration',
    },
  });
  taskId = task.id;
});

afterAll(async () => {
  await db.agenticTask.deleteMany({ where: { id: taskId } });
  await removeWorkspace(taskId).catch(() => undefined);
});

describe('multi-agent workflow (mock providers)', () => {
  test('the planner produces a plan with persisted steps', async () => {
    const plan = await planTask(taskId, undefined, undefined, {
      routing: {
        agents: {
          planner: { provider: 'gemini', model: 'gemini-3.8-flash' },
        },
      },
      complete: mockComplete(),
    });
    expect(plan.steps.length).toBe(3);
    expect(calls).toContain('planner');

    const steps = await db.agenticStep.findMany({
      where: { taskId },
      orderBy: { index: 'asc' },
    });
    expect(steps.length).toBe(3);
    expect(steps.map((s) => s.kind)).toEqual(['implement', 'test', 'review']);
  }, 60000);

  test('the whole plan executes: coder → tester → reviewer', async () => {
    await runTask(taskId, {
      routing: {
        agents: {
          planner: { provider: 'gemini', model: 'gemini-3.8-flash' },
          coder: { provider: 'ollama', model: 'qwen2.5' },
          tester: { provider: 'openai', model: 'gpt-4o-mini' },
          reviewer: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
        },
      },
      complete: mockComplete(),
    });

    // every role was actually used
    expect(calls).toContain('coder');
    expect(calls).toContain('tester');
    expect(calls).toContain('reviewer');

    const task = await db.agenticTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('done');
    expect(task?.error).toBeNull();

    const steps = await db.agenticStep.findMany({
      where: { taskId },
      orderBy: { index: 'asc' },
    });
    expect(steps.every((s) => s.status === 'passed')).toBe(true);

    // the file the coder produced is really in the workspace
    const content = await readWorkspaceFile(taskId, 'calc.js');
    expect(content).toContain('const add');

    // the tester really executed a command
    const testStep = steps.find((s) => s.kind === 'test');
    const commands = JSON.parse(testStep?.commands || '[]') as {
      command: string;
      exitCode: number | null;
    }[];
    expect(commands.length).toBeGreaterThan(0);
    expect(commands[0].exitCode).toBe(0);

    // the final report contains the real test results
    const report = JSON.parse(task?.report || '{}') as {
      testResults: { passed: number; failed: number }[];
      changedFiles: string[];
    };
    expect(report.testResults.length).toBeGreaterThan(0);
    expect(report.testResults[0].failed).toBe(0);
    expect(report.testResults[0].passed).toBeGreaterThan(0);
    expect(report.changedFiles).toContain('calc.js');
  }, 60000);

  test('every role is routed to its own model and the decision is streamed', async () => {
    const events = await listEvents(taskId, 0);
    const routed = events.filter((e) => e.type === 'model_routed');
    const byRole = new Map<string, { provider: string; model: string }>();
    for (const e of routed) {
      const d = e.data as { role?: string; provider?: string; model?: string; ok?: boolean };
      if (d?.role && d?.provider && d.ok !== false) {
        byRole.set(d.role, { provider: d.provider, model: d.model ?? '' });
      }
    }
    expect(byRole.get('planner')?.provider).toBe('gemini');
    expect(byRole.get('coder')?.provider).toBe('ollama');
    expect(byRole.get('tester')?.provider).toBe('openai');
    expect(byRole.get('reviewer')?.provider).toBe('anthropic');
  });

  test('the agents talk to each other through the message bus', async () => {
    const messages = await db.agentMessage.findMany({
      where: { taskId },
      orderBy: { seq: 'asc' },
    });
    expect(messages.length).toBeGreaterThanOrEqual(3);

    const plan = messages.find((m) => m.fromAgent === 'planner' && m.toAgent === 'coder');
    expect(plan).toBeDefined();
    expect(plan?.type).toBe('task');
    expect(plan?.content).toContain('Calculator');

    const handoff = messages.find((m) => m.fromAgent === 'coder' && m.toAgent === 'tester');
    expect(handoff).toBeDefined();
    expect(handoff?.type).toBe('result');

    const review = messages.find((m) => m.fromAgent === 'reviewer');
    expect(review).toBeDefined();
    expect(review?.type).toBe('review');
    expect(review?.correlationId).toBe(`${taskId}:review`);

    // every message belongs to this task and carries sender + receiver
    for (const m of messages) {
      expect(m.taskId).toBe(taskId);
      expect(m.fromAgent).toBeTruthy();
      expect(m.toAgent).toBeTruthy();
    }
  });

  test('the events are persisted with a monotonic sequence number', async () => {
    const events = await listEvents(taskId, 0);
    expect(events.length).toBeGreaterThan(5);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
    expect(events.some((e) => e.type === 'plan')).toBe(true);
    expect(events.some((e) => e.type === 'command')).toBe(true);
    expect(events.some((e) => e.type === 'review')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  test('the engine status text is ASCII (cp1252 console safe)', async () => {
    const events = await listEvents(taskId, 0);
    const notes = events
      .filter((e) => e.type === 'llm')
      .map((e) => String((e.data as { note?: string })?.note ?? ''));
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      // a non-ASCII character here would be rendered as "ð§ …" in a
      // cp1252 console — the engine's own text must never contain one
      expect(/^[\x00-\x7F]*$/.test(note)).toBe(true);
    }
  });
});
