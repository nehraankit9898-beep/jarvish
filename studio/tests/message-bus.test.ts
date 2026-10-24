// Message bus tests — agent-to-agent messaging, routing rules, persistence
// and conversation visibility.
// Run: bun test tests/message-bus.test.ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { db } from '../src/lib/db';
import { MessageBus, MessageBusError } from '../src/lib/agentic/message-bus';

let taskA = '';
let taskB = '';

beforeAll(async () => {
  const a = await db.agenticTask.create({
    data: { prompt: 'message bus test task A', conversationId: 'conv_test_a' },
  });
  const b = await db.agenticTask.create({
    data: { prompt: 'message bus test task B', conversationId: 'conv_test_b' },
  });
  taskA = a.id;
  taskB = b.id;
});

afterAll(async () => {
  await db.agenticTask.deleteMany({
    where: { id: { in: [taskA, taskB].filter(Boolean) } },
  });
});

function busFor(taskId: string, visibility: 'none' | 'participants' = 'none') {
  return new MessageBus({
    taskId,
    conversationId: `conv_${taskId}`,
    participants: ['planner', 'coder', 'tester', 'reviewer', 'orchestrator'],
    visibility,
  });
}

describe('message bus — delivery rules', () => {
  test('a message between two participants is accepted', async () => {
    const bus = busFor(taskA);
    const message = await bus.publish({
      fromAgent: 'planner',
      toAgent: 'coder',
      type: 'task',
      content: 'Implement the calculator',
      correlationId: 'corr-1',
    });
    expect(message.fromAgent).toBe('planner');
    expect(message.toAgent).toBe('coder');
    expect(message.type).toBe('task');
    expect(message.correlationId).toBe('corr-1');
    expect(message.taskId).toBe(taskA);
    expect(message.conversationId).toBe(`conv_${taskA}`);
    expect(message.id).toBeTruthy();
    expect(message.createdAt).toBeTruthy();
  });

  test('a message to a non-participant is rejected', async () => {
    const bus = busFor(taskA);
    let error: unknown = null;
    try {
      await bus.publish({
        fromAgent: 'coder',
        toAgent: 'stranger' as never,
        type: 'task',
        content: 'hello',
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MessageBusError);
  });

  test('an agent cannot send a message to itself', async () => {
    const bus = busFor(taskA);
    let error: unknown = null;
    try {
      await bus.publish({
        fromAgent: 'coder',
        toAgent: 'coder',
        type: 'task',
        content: 'hello',
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MessageBusError);
  });

  test('a message of another task is never delivered into this conversation', async () => {
    const busA = busFor(taskA);
    const busB = busFor(taskB);
    await busA.publish({
      fromAgent: 'planner',
      toAgent: 'coder',
      type: 'task',
      content: 'secret for task A',
    });
    const historyB = await busB.persistedHistory();
    expect(historyB.length).toBe(0);
    const historyA = await busA.persistedHistory();
    expect(historyA.some((m) => m.content.includes('secret for task A'))).toBe(true);
  });
});

describe('message bus — persistence', () => {
  test('sender, receiver, task id and correlation id are persisted', async () => {
    const bus = busFor(taskA);
    const published = await bus.publish({
      fromAgent: 'coder',
      toAgent: 'tester',
      type: 'result',
      content: 'files written',
      correlationId: 'corr-step-1',
      provider: 'ollama',
      model: 'qwen2.5',
    });
    const rows = await db.agentMessage.findMany({
      where: { taskId: taskA, id: published.id },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].fromAgent).toBe('coder');
    expect(rows[0].toAgent).toBe('tester');
    expect(rows[0].taskId).toBe(taskA);
    expect(rows[0].correlationId).toBe('corr-step-1');
    expect(rows[0].type).toBe('result');
    expect(rows[0].provider).toBe('ollama');
  });

  test('messages get a monotonic sequence number', async () => {
    const bus = busFor(taskA);
    const first = await bus.publish({
      fromAgent: 'planner',
      toAgent: 'coder',
      type: 'task',
      content: 'one',
    });
    const second = await bus.publish({
      fromAgent: 'planner',
      toAgent: 'coder',
      type: 'task',
      content: 'two',
    });
    expect(typeof first.seq).toBe('number');
    expect(second.seq!).toBeGreaterThan(first.seq!);
  });

  test('secrets are masked before a message is stored', async () => {
    const bus = busFor(taskA);
    const message = await bus.publish({
      fromAgent: 'coder',
      toAgent: 'reviewer',
      type: 'result',
      content: 'here is the key sk-abcdefghijklmnopqrstuvwx123456',
    });
    expect(message.content).not.toContain('sk-abcdefghijklmnopqrstuvwx123456');
    expect(message.content).toContain('REDACTED');
    const row = await db.agentMessage.findUnique({ where: { id: message.id } });
    expect(row?.content).not.toContain('sk-abcdefghijklmnopqrstuvwx123456');
  });
});

describe('message bus — visibility policy', () => {
  test('with visibility "none" an agent only sees its own messages', async () => {
    const bus = busFor(taskA, 'none');
    await bus.publish({
      fromAgent: 'planner',
      toAgent: 'coder',
      type: 'task',
      content: 'planner to coder',
    });
    await bus.publish({
      fromAgent: 'reviewer',
      toAgent: 'orchestrator',
      type: 'review',
      content: 'reviewer to orchestrator',
    });
    const coderView = bus.historyFor('coder');
    expect(coderView.length).toBe(1);
    expect(coderView[0].content).toBe('planner to coder');

    const reviewerView = bus.historyFor('reviewer');
    expect(reviewerView.length).toBe(1);
    expect(reviewerView[0].content).toBe('reviewer to orchestrator');
  });

  test('with visibility "participants" an agent sees the whole conversation', async () => {
    const bus = busFor(taskA, 'participants');
    await bus.publish({
      fromAgent: 'planner',
      toAgent: 'coder',
      type: 'task',
      content: 'visible to all',
    });
    const view = bus.historyFor('coder');
    expect(view.length).toBe(1);
    expect(view[0].content).toBe('visible to all');
  });

  test('persisted history honours the same visibility rules', async () => {
    const bus = busFor(taskA, 'none');
    await bus.publish({
      fromAgent: 'tester',
      toAgent: 'coder',
      type: 'error',
      content: 'test failed for coder',
    });
    const coderHistory = await bus.persistedHistory('coder');
    expect(
      coderHistory.some((m) => m.content === 'test failed for coder')
    ).toBe(true);
    const plannerHistory = await bus.persistedHistory('planner');
    expect(
      plannerHistory.some((m) => m.content === 'test failed for coder')
    ).toBe(false);
  });
});

describe('message bus — subscribers', () => {
  test('the recipient is notified when a message is published', async () => {
    const bus = busFor(taskA);
    const received: string[] = [];
    const unsubscribe = bus.subscribe('tester', (m) => {
      received.push(m.content);
    });
    await bus.publish({
      fromAgent: 'coder',
      toAgent: 'tester',
      type: 'result',
      content: 'code ready',
    });
    expect(received.length).toBe(1);
    expect(received[0]).toBe('code ready');

    unsubscribe();
    await bus.publish({
      fromAgent: 'coder',
      toAgent: 'tester',
      type: 'result',
      content: 'second message',
    });
    expect(received.length).toBe(1);
  });
});
