// Realtime event tests — persisted events, replay/reconnect, SSE framing and
// the access control on the agentic routes.
// Run: bun test tests/realtime-events.test.ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { NextRequest } from 'next/server';
import { db } from '../src/lib/db';
import { appendEvent, listEvents, lastEventSeq } from '../src/lib/agentic/event-store';
import { GET as streamGet } from '../src/app/api/agentic/tasks/[id]/stream/route';
import { GET as runGet } from '../src/app/api/agentic/tasks/[id]/run/route';
import { checkAgenticAccess } from '../src/lib/agentic/api-auth';
import type { AgenticEvent } from '../src/lib/agentic/types';

let taskId = '';

beforeAll(async () => {
  const task = await db.agenticTask.create({
    data: { prompt: 'realtime events test task', status: 'planning' },
  });
  taskId = task.id;
});

afterAll(async () => {
  await db.agenticTask.deleteMany({ where: { id: taskId } });
});

describe('event store', () => {
  test('events get a monotonic sequence number', async () => {
    const first = await appendEvent(taskId, {
      type: 'log',
      taskId,
      at: new Date().toISOString(),
      data: { text: 'one' },
    });
    const second = await appendEvent(taskId, {
      type: 'log',
      taskId,
      at: new Date().toISOString(),
      data: { text: 'two' },
    });
    expect(first).not.toBeNull();
    expect(second!.seq).toBeGreaterThan(first!.seq);
  });

  test('events are replayed from a given sequence number', async () => {
    const all = await listEvents(taskId, 0);
    expect(all.length).toBeGreaterThan(0);
    const mid = all[Math.floor(all.length / 2)].seq;
    const tail = await listEvents(taskId, mid);
    expect(tail.length).toBe(all.length - 1 - all.findIndex((e) => e.seq === mid));
    expect(tail.every((e) => e.seq > mid)).toBe(true);
  });

  test('concurrent appends never lose an event', async () => {
    const before = await lastEventSeq(taskId);
    const events: AgenticEvent[] = Array.from({ length: 12 }, (_, i) => ({
      type: 'log' as const,
      taskId,
      at: new Date().toISOString(),
      data: { text: `parallel-${i}` },
    }));
    await Promise.all(events.map((e) => appendEvent(taskId, e)));
    const after = await lastEventSeq(taskId);
    expect(after - before).toBe(12);
    const stored = await listEvents(taskId, before);
    expect(stored.length).toBe(12);
    // every sequence number is unique
    expect(new Set(stored.map((e) => e.seq)).size).toBe(12);
  });

  test('the payload of an event survives the round trip', async () => {
    await appendEvent(taskId, {
      type: 'model_routed',
      taskId,
      at: new Date().toISOString(),
      data: { role: 'planner', provider: 'gemini', model: 'gemini-3.8-flash' },
    });
    const stored = await listEvents(taskId, 0);
    const routed = stored.find((e) => e.type === 'model_routed');
    expect(routed).toBeDefined();
    expect((routed!.data as { role: string }).role).toBe('planner');
  });
});

describe('SSE stream endpoint', () => {
  test('the stream replays the persisted events and closes on a terminal task', async () => {
    await appendEvent(taskId, {
      type: 'log',
      taskId,
      at: new Date().toISOString(),
      data: { text: 'before-stream' },
    });
    await db.agenticTask.update({
      where: { id: taskId },
      data: { status: 'done' },
    });

    const req = new NextRequest(`http://localhost:3000/api/agentic/tasks/${taskId}/stream?after=0`);
    const res = await streamGet(req, { params: Promise.resolve({ id: taskId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const body = await res.text();
    expect(body).toContain('before-stream');
    // every frame carries the SSE id field so a client can resume
    expect(body).toMatch(/id: \d+\ndata: \{/);
    // the stream ends with an explicit terminal frame
    expect(body).toContain('"type":"stream_status"');
    expect(body).toContain('"terminal":true');
  });

  test('reconnecting with ?after= skips the events the client already has', async () => {
    const all = await listEvents(taskId, 0);
    const last = all[all.length - 1].seq;
    const req = new NextRequest(
      `http://localhost:3000/api/agentic/tasks/${taskId}/stream?after=${last}`
    );
    const res = await streamGet(req, { params: Promise.resolve({ id: taskId }) });
    const body = await res.text();
    expect(body).not.toContain('before-stream');
    expect(body).toContain('stream_status');
  });
});

describe('run status endpoint', () => {
  test('the client can tell a finished task from a dropped stream', async () => {
    const req = new NextRequest(`http://localhost:3000/api/agentic/tasks/${taskId}/run`);
    const res = await runGet(req, { params: Promise.resolve({ id: taskId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('done');
    expect(data.terminal).toBe(true);
    expect(data.running).toBe(false);
    expect(typeof data.lastEventSeq).toBe('number');
  });
});

describe('agentic route access control', () => {
  test('a cross-origin mutating request is rejected', () => {
    const req = new NextRequest('http://localhost:3000/api/agentic/tasks', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    const check = checkAgenticAccess(req);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(403);
  });

  test('a same-origin mutating request is allowed', () => {
    const req = new NextRequest('http://localhost:3000/api/agentic/tasks', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(checkAgenticAccess(req).ok).toBe(true);
  });

  test('when a token is configured every request must present it', () => {
    const previous = process.env.AGENTSCOPE_API_TOKEN;
    process.env.AGENTSCOPE_API_TOKEN = 'secret-token';
    try {
      const withoutToken = new NextRequest('http://localhost:3000/api/agentic/tasks');
      expect(checkAgenticAccess(withoutToken).status).toBe(401);

      const withHeader = new NextRequest('http://localhost:3000/api/agentic/tasks', {
        headers: { 'x-agentscope-token': 'secret-token' },
      });
      expect(checkAgenticAccess(withHeader).ok).toBe(true);

      const withBearer = new NextRequest('http://localhost:3000/api/agentic/tasks', {
        headers: { authorization: 'Bearer secret-token' },
      });
      expect(checkAgenticAccess(withBearer).ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.AGENTSCOPE_API_TOKEN;
      else process.env.AGENTSCOPE_API_TOKEN = previous;
    }
  });
});
