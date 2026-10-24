// worker-lock.ts — "exactly one background runtime at a time".
//
// The background runtime (schedules, recovery, suggestions) can live in the
// Studio server OR in the standalone worker process (src/worker/index.ts).
// Two tickers would fire every cron job twice, so the worker holds a lock
// file with a heartbeat. The server checks it and yields while a live worker
// owns the runtime; if the worker dies, the lock goes stale within
// STALE_MS and the server takes over again on its next tick.
//
// Pure fs + pid probing, no database — so it works before Prisma is ready.

import fs from 'node:fs';
import path from 'node:path';

export const HEARTBEAT_MS = 20_000;
export const STALE_MS = 90_000;

interface LockBody {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export function workerLockPath(): string {
  return process.env.AGENTSCOPE_WORKER_LOCK?.trim() || path.join(process.cwd(), 'db', '.worker.lock');
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but belongs to someone else
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file = workerLockPath()): LockBody | null {
  try {
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as LockBody;
    return typeof body.pid === 'number' && typeof body.heartbeatAt === 'string' ? body : null;
  } catch {
    return null;
  }
}

/** Is a worker process alive RIGHT NOW (fresh heartbeat AND a live pid)? */
export function isWorkerAlive(now = Date.now(), file = workerLockPath()): boolean {
  const lock = readLock(file);
  if (!lock) return false;
  // H12: an unparseable timestamp used to compare as `NaN > STALE_MS` = false,
  // i.e. "fresh" — a lock file with a corrupt heartbeat then depended on the
  // pid check alone, and a recycled pid could keep the whole background
  // runtime locked out forever. No usable heartbeat means the lock is stale.
  const beat = Date.parse(lock.heartbeatAt);
  if (!Number.isFinite(beat)) return false;
  if (now - beat > STALE_MS) return false;
  return pidAlive(lock.pid);
}

export function workerStatus(now = Date.now()): { alive: boolean; pid?: number; startedAt?: string; heartbeatAgeSec?: number } {
  const lock = readLock();
  if (!lock || !isWorkerAlive(now)) return { alive: false };
  return {
    alive: true,
    pid: lock.pid,
    startedAt: lock.startedAt,
    heartbeatAgeSec: Math.round((now - Date.parse(lock.heartbeatAt)) / 1000),
  };
}

export interface WorkerLockHandle {
  release: () => void;
}

/** Take the lock, or return null when another live worker owns it. */
export function acquireWorkerLock(file = workerLockPath()): WorkerLockHandle | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const startedAt = new Date().toISOString();
  const write = (flag: 'wx' | 'w') =>
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: new Date().toISOString() } satisfies LockBody), { flag });

  try {
    write('wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (isWorkerAlive(Date.now(), file)) return null;
    // stale or dead owner: take over atomically enough for a single machine
    fs.rmSync(file, { force: true });
    try {
      write('wx');
    } catch {
      return null; // someone else won the race
    }
  }

  const beat = setInterval(() => {
    try {
      const lock = readLock(file);
      if (lock && lock.pid !== process.pid) return; // lost the lock — never overwrite another owner
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: new Date().toISOString() } satisfies LockBody));
    } catch {
      /* a failed heartbeat just lets the lock go stale */
    }
  }, HEARTBEAT_MS);
  beat.unref?.();

  return {
    release: () => {
      clearInterval(beat);
      const lock = readLock(file);
      if (lock?.pid === process.pid) fs.rmSync(file, { force: true });
    },
  };
}
