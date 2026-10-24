// background.ts — the persistent background runtime (Feature 3, 5).
//
// Everything here runs INSIDE the Next.js server process but OUTSIDE any
// request: a single interval ticker that
//
//   1. fires the due automation schedules (cron + interval, timezone-aware,
//      misfire-recovered — see automation.ts),
//   2. recovers tasks the server lost when it restarted (running → paused,
//      resumable from the UI),
//   3. re-queues RETRY_WAIT tasks whose retry delay has elapsed,
//   4. unblocks BLOCKED tasks whose blocker disappeared,
//   5. scans for proactive suggestions (rate-limited, see suggestions.ts),
//   6. prunes old read notifications.
//
// The ticker is idempotent (started once per process), failures are logged
// and never crash the loop, and every action is audit-logged / notified so
// the user can see WHAT the runtime did while they were away.
//
// NOTE on "app band hone ke baad bhi kaam": closing the BROWSER does not
// stop this runtime (the server process keeps running). Closing the SERVER
// (shutdown/sleep) stops it — on the next start, startupRecovery() picks up
// exactly where things left off (missed cron runs follow the misfire policy,
// orphaned tasks are paused-resumable). For 24/7 operation the studio server
// itself must run on an always-on machine.

import { db } from '@/lib/db';
import { runDueSchedules, recoverMisfires } from './automation';
import { createNotification } from './notifications';
import { recordAudit } from './audit';
import { isWorkerAlive } from './worker-lock';
import { startDownloadsWatcher, stopDownloadsWatcher } from './downloads';
import { startTelegramBot, stopTelegramBot, telegramConfigured } from './telegram-connector';
import { maybeMorningSummary } from './proactive';

const TICK_MS = 30_000; // main loop — every 30 s
const SUGGESTION_SCAN_MS = 10 * 60_000; // suggestions — every 10 min
const NOTIFICATION_PRUNE_MS = 24 * 60 * 60_000; // prune — daily
const RETENTION_SWEEP_MS = 24 * 60 * 60_000; // audit/message retention — daily
const RETRY_DELAY_DEFAULT_MS = 60_000; // default retry_wait delay
const ORPHAN_GRACE_MS = 2 * 60_000; // running task with no updates = orphan

let ticker: ReturnType<typeof setInterval> | null = null;
let suggestionTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let retentionTimer: ReturnType<typeof setInterval> | null = null;
let startedAt: number | null = null;
/** guards against overlapping ticks (a slow DB call must never pile up) */
let ticking = false;
let lastSuggestionScan = 0;

export function isBackgroundRunning(): boolean {
  return ticker !== null;
}

export function backgroundUptimeSec(): number {
  return startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
}

/** The single main tick — exported for tests. */
export async function tick(): Promise<void> {
  if (ticking) return; // never overlap
  // a live standalone worker owns the runtime — two tickers would fire every
  // cron job twice. The server takes over again if the worker dies (stale lock).
  if (process.env.AGENTSCOPE_WORKER_PROCESS !== '1' && isWorkerAlive()) return;
  ticking = true;
  try {
    await fireDueSchedules();
    await recoverRetryWaitTasks();
    await unblockReadyTasks();
    await scanSuggestions(Date.now());
    // Jarvis #5: roz subah ka summary (andar hi idempotent-per-day hai)
    await maybeMorningSummary().catch(() => undefined);
  } catch (err) {
    console.error('[background] tick error:', err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}

/** 1) fire due schedules (duplicate-guarded inside automation.ts) */
async function fireDueSchedules(): Promise<void> {
  try {
    const runs = await runDueSchedules();
    for (const run of runs) {
      if (run.status === 'failed') {
        // the automation module already notified; nothing more to do here
        continue;
      }
      await createNotification({
        type: 'automation',
        title: `Automation run ${run.status}`,
        body: run.result || run.error || '',
        scheduleId: run.scheduleId,
        data: { taskId: run.taskId, runId: run.id, status: run.status },
      });
    }
  } catch (err) {
    console.error('[background] schedule tick failed:', err instanceof Error ? err.message : err);
  }
}

/** 3) re-queue retry_wait tasks whose delay elapsed */
async function recoverRetryWaitTasks(): Promise<void> {
  try {
    const waiting = await db.agenticTask.findMany({
      where: { status: 'retry_wait' },
      select: { id: true, updatedAt: true },
    });
    const now = Date.now();
    for (const task of waiting) {
      const waitedMs = now - new Date(task.updatedAt).getTime();
      if (waitedMs < RETRY_DELAY_DEFAULT_MS) continue;
      await db.agenticTask.update({
        where: { id: task.id },
        data: { status: 'paused' },
      });
      await createNotification({
        type: 'system',
        title: 'Task retry ready',
        body: 'The retry delay elapsed — resume the task from the Agentic panel.',
        taskId: task.id,
        data: { from: 'retry_wait', to: 'paused' },
      });
    }
  } catch (err) {
    console.error('[background] retry recovery failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * 4) unblock BLOCKED tasks whose blocker disappeared.
 *
 * The engine sets `blockedReason` when it parks a task as BLOCKED (missing
 * credential, missing dependency). A blocked task is unblocked automatically
 * only when the specific blocker is verifiably gone; today the runtime
 * checks the common case (a provider credential that has since been added).
 */
async function unblockReadyTasks(): Promise<void> {
  try {
    const blocked = await db.agenticTask.findMany({
      where: { status: 'blocked' },
      select: { id: true, blockedReason: true },
      take: 20,
    });
    if (!blocked.length) return;

    const credRows = await db.providerConfig.findMany({
      where: { enabled: true, apiKeyEnc: { not: '' } },
      select: { provider: true },
    });
    const providersWithKeys = new Set(credRows.map((r) => r.provider));

    for (const task of blocked) {
      const reason = task.blockedReason || '';
      const m = reason.match(/provider[:\s]+([a-z0-9_-]+)/i);
      if (m && providersWithKeys.has(m[1].toLowerCase())) {
        await db.agenticTask.update({
          where: { id: task.id },
          data: { status: 'paused', blockedReason: '' },
        });
        await createNotification({
          type: 'system',
          title: 'Task unblocked',
          body: `The missing credential for "${m[1]}" was added — the task can be resumed.`,
          taskId: task.id,
          data: { from: 'blocked', to: 'paused' },
        });
      }
    }
  } catch (err) {
    console.error('[background] unblock scan failed:', err instanceof Error ? err.message : err);
  }
}

/** 5) proactive suggestions — delegated to suggestions.ts (lazy import) */
async function scanSuggestions(now: number): Promise<void> {
  if (now - lastSuggestionScan < SUGGESTION_SCAN_MS) return;
  lastSuggestionScan = now;
  try {
    const { scanForSuggestions } = await import('./suggestions');
    await scanForSuggestions();
  } catch (err) {
    // the suggestions module is optional — never break the tick
    console.error('[background] suggestion scan failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * 2) STARTUP RECOVERY — run once when the runtime boots.
 *
 * - automation schedules that missed runs follow their misfire policy;
 * - tasks that were `running`/`planning`/`verifying` when the server died
 *   are marked PAUSED (resumable): a crashed run must never look alive.
 */
export async function startupRecovery(): Promise<void> {
  try {
    const misfires = await recoverMisfires();

    // find tasks that claim to be running but were orphaned by a restart.
    // A task whose updatedAt is recent MIGHT still be running in this very
    // process (a plan started milliseconds ago) — only long-untouched rows
    // are truly orphaned.
    const candidates = await db.agenticTask.findMany({
      where: { status: { in: ['running', 'planning', 'verifying'] } },
      select: { id: true, updatedAt: true, prompt: true },
    });
    const now = Date.now();
    const orphaned = candidates.filter(
      (t) => now - new Date(t.updatedAt).getTime() > ORPHAN_GRACE_MS
    );
    for (const task of orphaned) {
      await db.agenticTask
        .update({
          where: { id: task.id },
          data: { status: 'paused' },
        })
        .catch(() => undefined);
      await createNotification({
        type: 'system',
        title: 'Task paused after restart',
        body: 'The server restarted while this task was running. It kept its plan, workspace and retry budget — resume it from the Agentic panel.',
        taskId: task.id,
        data: { from: 'running', to: 'paused', reason: 'server_restart' },
      });
    }

    if (misfires.length || orphaned.length) {
      await recordAudit({
        actor: 'system',
        action: 'background.startup_recovery',
        category: 'automation',
        approval: 'auto',
        details: {
          misfiresRecovered: misfires.length,
          tasksPaused: orphaned.length,
        },
      });
    }
  } catch (err) {
    console.error('[background] startup recovery failed:', err instanceof Error ? err.message : err);
  }
}

async function pruneOldNotifications(): Promise<void> {
  try {
    const { clearNotifications } = await import('./notifications');
    await clearNotifications(30);
  } catch {
    // best effort
  }
}

/**
 * Daily retention sweep for the audit trail and the agent transcript.
 * A no-op unless AGENTSCOPE_RETENTION_DAYS is configured — and it never
 * touches security audit rows or the records of a task that is still active
 * (see retention.ts). The outcome is audit-logged so a cleanup is traceable.
 */
async function sweepRetention(): Promise<void> {
  try {
    const { pruneOldRecords, retentionPolicyFromEnv } = await import('./retention');
    const policy = retentionPolicyFromEnv();
    if (policy.days < 1) return;
    const result = await pruneOldRecords(policy);
    if (result.auditRemoved || result.agentMessagesRemoved || result.agentEventsRemoved) {
      await recordAudit({
        actor: 'system',
        action: 'background.retention_sweep',
        category: 'general',
        approval: 'auto',
        details: {
          days: policy.days,
          cutoff: result.cutoff ?? '',
          auditRemoved: result.auditRemoved,
          agentMessagesRemoved: result.agentMessagesRemoved,
          agentEventsRemoved: result.agentEventsRemoved,
        },
      });
    }
  } catch (err) {
    console.error('[background] retention sweep failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Start the background runtime. Idempotent — calling it twice is a no-op
 * (Next.js dev-mode hot reloads would otherwise stack tickers).
 */
export function startBackgroundRuntime(): void {
  if (ticker) return;
  startedAt = Date.now();
  console.log('[background] runtime starting (tick=%dms)', TICK_MS);

  // the first tick + startup recovery run immediately but never block boot
  void startupRecovery().then(() => tick());

  ticker = setInterval(() => {
    void tick();
  }, TICK_MS);

  suggestionTimer = setInterval(() => {
    void scanSuggestions(Date.now());
  }, SUGGESTION_SCAN_MS);

  pruneTimer = setInterval(() => {
    void pruneOldNotifications();
  }, NOTIFICATION_PRUNE_MS);

  retentionTimer = setInterval(() => {
    void sweepRetention();
  }, RETENTION_SWEEP_MS);

  // laptop-control (Roadmap #3/#9): Downloads watcher + Telegram bot.
  // Both are opt-in and fully optional — a failure here must never break
  // the schedules above.
  try {
    const watcherOn = startDownloadsWatcher();
    if (watcherOn) console.log('[background] Downloads watcher started');
  } catch (err) {
    console.error('[background] downloads watcher failed:', err instanceof Error ? err.message : err);
  }
  try {
    if (telegramConfigured()) {
      const botOn = startTelegramBot();
      if (botOn) console.log('[background] Telegram bot started');
    }
  } catch (err) {
    console.error('[background] telegram bot failed:', err instanceof Error ? err.message : err);
  }
}

/** Stop the runtime (used by graceful shutdown and tests). */
export function stopBackgroundRuntime(): void {
  if (ticker) clearInterval(ticker);
  if (suggestionTimer) clearInterval(suggestionTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  ticker = null;
  suggestionTimer = null;
  pruneTimer = null;
  retentionTimer = null;
  startedAt = null;
  stopDownloadsWatcher();
  stopTelegramBot();
}
