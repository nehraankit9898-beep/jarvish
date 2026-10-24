// Worker lock tests — exactly one background runtime may tick at a time.
// Run: bun test tests/worker-lock.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireWorkerLock, isWorkerAlive, STALE_MS } from '../src/lib/agentic/worker-lock';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-lock-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('worker lock', () => {
  test('a free lock can be acquired and shows as alive', () => {
    const file = path.join(dir, 'a.lock');
    expect(isWorkerAlive(Date.now(), file)).toBe(false);
    const h = acquireWorkerLock(file);
    expect(h).not.toBeNull();
    expect(isWorkerAlive(Date.now(), file)).toBe(true);
    h!.release();
    expect(fs.existsSync(file)).toBe(false);
    expect(isWorkerAlive(Date.now(), file)).toBe(false);
  });

  test('a second worker is refused while the first is alive (no double cron)', () => {
    const file = path.join(dir, 'b.lock');
    const first = acquireWorkerLock(file);
    expect(first).not.toBeNull();
    expect(acquireWorkerLock(file)).toBeNull();
    first!.release();
    const again = acquireWorkerLock(file);
    expect(again).not.toBeNull();
    again!.release();
  });

  test('a lock whose process is dead is taken over', () => {
    const file = path.join(dir, 'c.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: 2_000_000_000, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
    expect(isWorkerAlive(Date.now(), file)).toBe(false);
    const h = acquireWorkerLock(file);
    expect(h).not.toBeNull();
    h!.release();
  });

  test('a stale heartbeat means the worker is considered dead, even with a live pid', () => {
    const file = path.join(dir, 'd.lock');
    const old = new Date(Date.now() - STALE_MS - 5_000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: old, heartbeatAt: old }));
    expect(isWorkerAlive(Date.now(), file)).toBe(false);
    const h = acquireWorkerLock(file);
    expect(h).not.toBeNull();
    h!.release();
  });

  test('a corrupt lock file does not wedge the system', () => {
    const file = path.join(dir, 'e.lock');
    fs.writeFileSync(file, '{not json');
    expect(isWorkerAlive(Date.now(), file)).toBe(false);
    const h = acquireWorkerLock(file);
    expect(h).not.toBeNull();
    h!.release();
  });

  test('release never deletes a lock owned by another process', () => {
    const file = path.join(dir, 'f.lock');
    const h = acquireWorkerLock(file)!;
    const now = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid + 1, startedAt: now, heartbeatAt: now }));
    h.release();
    expect(fs.existsSync(file)).toBe(true);
  });
});
