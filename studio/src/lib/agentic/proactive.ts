// proactive.ts — Jarvis #5: the "bina bole kaam batana" engine.
//
// Two halves:
//   1. MORNING SUMMARY — roz ek fixed time (AGENTSCOPE_MORNING_SUMMARY,
//      default 09:00) pe ek chhota digest: pending approvals, kal ke tasks,
//      naye downloads, aaj due schedules. Notification + Telegram dono pe.
//   2. GUARD-RAILS that keep Jarvis from becoming spam (the spec is explicit:
//      "Bahut zyada na bole… warna aap use band kar doge"):
//        - QUIET HOURS (AGENTSCOPE_QUIET_HOURS, default "23:00-07:30") —
//          proactive NOTIFICATIONS are suppressed inside the window
//        - DAILY CAP — max N proactive notifications/day (default 5)
//        - PER-KIND MUTE ("aage se mat batao") — ProactiveState muted:<kind>
//
// The guard-rails deliberately live in ONE place (proactiveNotify) so every
// proactive path (suggestions, morning summary, event triggers) behaves the
// same. Approval-required notifications NEVER pass through here — those must
// always reach the user.

import { db } from '@/lib/db';
import { createNotification } from './notifications';
import { recordAudit } from './audit';
import { recentDownloads } from './downloads';
import { listSchedules } from './automation';
import { sendTelegramMessage, telegramConfigured, telegramAllowedIds } from './telegram-connector';

// ---------- state helpers (ProactiveState key/value) ----------

async function getState(key: string): Promise<string> {
  try {
    const row = await db.proactiveState.findUnique({ where: { key } });
    return row?.value ?? '';
  } catch {
    return '';
  }
}

async function setState(key: string, value: string): Promise<void> {
  try {
    await db.proactiveState.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  } catch {
    /* never break the run for a state write */
  }
}

/** Is suggestion `kind` muted ("aage se mat batao")? */
export async function isKindMuted(kind: string): Promise<boolean> {
  return (await getState(`muted:${kind}`)) === '1';
}

export async function muteKind(kind: string): Promise<void> {
  await setState(`muted:${kind}`, '1');
}

export async function unmuteKind(kind: string): Promise<void> {
  await setState(`muted:${kind}`, '0');
}

export async function mutedKinds(): Promise<string[]> {
  try {
    const rows = await db.proactiveState.findMany({
      where: { key: { startsWith: 'muted:' } },
    });
    return rows.filter((r) => r.value === '1').map((r) => r.key.slice(6));
  } catch {
    return [];
  }
}

// ---------- quiet hours + daily cap ----------

/** Number from env that actually behaves: '' / 'abc' / 0 / negative all fall
 * back to the default (an empty var would otherwise mean cap 0 → silence
 * everything, garbage would mean NaN → unlimited spam). */
function envPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** The LOCAL calendar date of `d` (YYYY-MM-DD). Never use toISOString() for
 * once-a-day keys: east of UTC+9:30 the UTC date flips mid-afternoon and a
 * "daily" action fires twice. */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function parseQuietHours(): { start: number; end: number } | null {
  const raw = (process.env.AGENTSCOPE_QUIET_HOURS ?? '23:00-07:30').trim();
  if (!raw || raw.toLowerCase() === 'off' || raw.toLowerCase() === 'none') return null;
  const m = raw.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return {
    start: Number(m[1]) * 60 + Number(m[2]),
    end: Number(m[3]) * 60 + Number(m[4]),
  };
}

/** Inside the quiet window? ("raat ko ya meeting ke time" — the meeting part
 * comes free: approvals still ring, only proactive chatter is silenced.) */
export function inQuietHours(now = new Date()): boolean {
  const q = parseQuietHours();
  if (!q) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (q.start <= q.end) return minutes >= q.start && minutes < q.end;
  // window crosses midnight (e.g. 23:00-07:30)
  return minutes >= q.start || minutes < q.end;
}

const DAILY_PROACTIVE_CAP = envPositiveInt(process.env.AGENTSCOPE_PROACTIVE_DAILY_CAP, 5);

async function proactiveCountToday(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  try {
    return await db.notification.count({
      where: {
        type: 'suggestion',
        createdAt: { gte: startOfDay },
        OR: [
          { data: { contains: '"proactive":1' } },
          { data: { contains: '"kind":"morning_summary"' } },
        ],
      },
    });
  } catch {
    return 0;
  }
}

/**
 * The ONE door every proactive notification goes through. Returns the
 * created notification, or null when suppressed (quiet hours / cap / mute).
 */
export async function proactiveNotify(input: {
  kind: string;
  title: string;
  body?: string;
  taskId?: string;
  data?: Record<string, unknown>;
}): Promise<{ created: boolean; reason?: string }> {
  if (await isKindMuted(input.kind)) {
    return { created: false, reason: `kind "${input.kind}" is muted` };
  }
  if (inQuietHours()) {
    return { created: false, reason: 'quiet hours' };
  }
  if ((await proactiveCountToday()) >= DAILY_PROACTIVE_CAP) {
    return { created: false, reason: `daily cap (${DAILY_PROACTIVE_CAP}) reached` };
  }
  await createNotification({
    type: 'suggestion',
    title: input.title,
    body: input.body,
    taskId: input.taskId,
    data: { proactive: 1, kind: input.kind, ...input.data },
  });
  return { created: true };
}

// ---------- morning summary ----------

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

/**
 * Build + deliver the morning digest. Cheap when nothing is configured:
 * reads a handful of rows, sends at most one notification + one Telegram
 * message. Called from the background tick (idempotent per day).
 */
export async function buildMorningSummary(now = new Date()): Promise<string> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);

  const [doneYesterday, failed, unread, approvals, downloads, schedules] =
    await Promise.all([
      db.agenticTask.count({
        where: { status: 'done', updatedAt: { gte: since } },
      }).catch(() => 0),
      db.agenticTask.count({
        where: { status: 'failed', updatedAt: { gte: since } },
      }).catch(() => 0),
      db.notification.count({ where: { read: false } }).catch(() => 0),
      db.notification.count({
        where: { type: 'approval_required', read: false },
      }).catch(() => 0),
      Promise.resolve(recentDownloads(50)).catch(() => []),
      listSchedules().catch(() => []),
    ]);

  const newDownloads = downloads.filter(
    (d) => new Date(d.modifiedAt).getTime() >= since.getTime()
  ).length;
  const dueToday = schedules.filter((s) => s.enabled && s.nextRunAt).length;

  const lines: string[] = ['Good morning! Aaj ka chhota sa summary:'];
  if (approvals > 0) lines.push(`- ${approvals} approval(s) aapka intezaar kar rahe hain`);
  if (doneYesterday > 0) lines.push(`- Kal ${doneYesterday} task(s) complete hue${failed ? `, ${failed} fail hue` : ''}`);
  else if (failed > 0) lines.push(`- Kal ${failed} task(s) fail hue — dekh lo`);
  if (newDownloads > 0) lines.push(`- Downloads me ${newDownloads} nayi file(s) aayi`);
  if (dueToday > 0) lines.push(`- ${dueToday} automation schedule(s) active hain`);
  if (unread > 0) lines.push(`- ${unread} unread notification(s)`);
  if (lines.length === 1) lines.push('- Sab shaant hai, koi pending kaam nahi.');

  return lines.join('\n');
}

/**
 * Fire the morning summary if:
 *   - it is at/after the configured time,
 *   - it has not been sent today,
 *   - quiet hours are over (a 09:00 summary never fires inside quiet hours).
 * Telegram gets the digest even when the browser notification is suppressed
 * by the daily cap (once-a-day is not spam).
 */
export async function maybeMorningSummary(now = new Date()): Promise<{ sent: boolean; reason?: string }> {
  const hhmm = (process.env.AGENTSCOPE_MORNING_SUMMARY ?? '09:00').trim().toLowerCase();
  if (hhmm === 'off' || hhmm === '0') return { sent: false, reason: 'disabled' };
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { sent: false, reason: 'bad AGENTSCOPE_MORNING_SUMMARY' };

  const targetMin = Number(m[1]) * 60 + Number(m[2]);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (nowMin < targetMin) return { sent: false, reason: 'too early' };

  const todayKey = `morning_summary:${localDateKey(now)}`;
  if ((await getState(todayKey)) === '1') return { sent: false, reason: 'already sent today' };

  const digest = await buildMorningSummary(now);
  await proactiveNotify({
    kind: 'morning_summary',
    title: 'Good morning — aaj ka summary',
    body: digest,
    data: { kind: 'morning_summary', date: todayKey },
  });

  if (telegramConfigured()) {
    const ids = telegramAllowedIds();
    if (ids.length) {
      await sendTelegramMessage(ids[0], digest).catch(() => undefined);
    }
  }

  await setState(todayKey, '1');
  // keep the state table small: drop yesterday's key
  try {
    const yesterday = `morning_summary:${localDateKey(new Date(now.getTime() - 86_400_000))}`;
    await db.proactiveState.deleteMany({ where: { key: yesterday } });
  } catch {
    /* cosmetic */
  }
  await recordAudit({
    actor: 'system',
    action: 'proactive.morning_summary',
    category: 'automation',
    approval: 'auto',
    result: 'ok',
    details: { chars: digest.length },
  }).catch(() => undefined);
  return { sent: true };
}
