// The standalone background worker — `bun run worker`.
//
// Runs the persistent runtime (cron schedules, startup recovery, retry /
// unblock scans, proactive suggestions) in its OWN process, so closing the
// Studio window — or restarting the Studio server — never stops scheduled
// work. The Studio server yields to this process while it is alive
// (see worker-lock.ts).
//
// It shares the SQLite database with the Studio, so everything the worker
// does (task state, notifications, audit rows) shows up in the UI.

import { acquireWorkerLock } from '../lib/agentic/worker-lock';

// background.ts uses this to know it IS the worker (and must not yield to itself)
process.env.AGENTSCOPE_WORKER_PROCESS = '1';

async function main(): Promise<void> {
  const lock = acquireWorkerLock();
  if (!lock) {
    console.error('[worker] another worker is already running — exiting.');
    process.exit(2);
  }

  const { startBackgroundRuntime, stopBackgroundRuntime } = await import('../lib/agentic/background');
  startBackgroundRuntime();
  console.log(`[worker] started (pid ${process.pid}). Press Ctrl+C to stop.`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received — shutting down gracefully…`);
    stopBackgroundRuntime();
    lock.release();
    // let in-flight DB writes of the current tick finish
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK')); // Ctrl+Break / console close on Windows
  process.on('exit', () => lock.release());
  process.on('uncaughtException', (e) => console.error('[worker] uncaught exception:', e));
  process.on('unhandledRejection', (e) => console.error('[worker] unhandled rejection:', e));
}

void main();
