// telegram-connector.ts — control the laptop from the PHONE (Roadmap #9).
//
// A minimal Telegram Bot long-poll client (plain fetch — no new dependency):
//
//   AGENTSCOPE_TELEGRAM_BOT_TOKEN   the bot token from @BotFather
//   AGENTSCOPE_TELEGRAM_ALLOWED_IDS comma-separated numeric user IDs —
//                                   messages from ANYONE else are ignored
//                                   (and audit-logged as refused)
//
// Commands (only from an allowed user):
//   /help                    what the bot can do
//   /status                  modes, kill switch, bridge, pending approvals
//   /pending                 the approval queue
//   /approve <id|prefix>     approve a pending laptop action from the phone
//   /deny <id|prefix>        deny it
//   /kill                    engage the KILL SWITCH immediately
//   /resume                  release the kill switch (you are the user)
//   any other text           becomes a NEW agentic task (plan only — the
//                            actual run still waits for your approval in
//                            the UI, exactly like scheduled automations)
//
// Security invariants:
//   - the bot NEVER gets a tool of its own — approvals flow through the
//     same single-use queue the UI uses (resolveHostApproval);
//   - /approve executes the EXACT stored action, never a new one;
//   - every interaction is audit-logged.

import { db } from '@/lib/db';
import { planTask } from './orchestrator';
import { recordAudit } from './audit';
import { createNotification } from './notifications';
import { resolveHostApproval, listPendingHostActions } from './host-control';
import { engageKill, releaseKill, getKillState, safetyStatus } from './safety';
import { bridgeStatus } from './desktop-bridge';

const API = 'https://api.telegram.org';
const POLL_TIMEOUT_SEC = 25;
const TELEGRAM_TEXT_LIMIT = 3800;
const MIN_TASK_GAP_MS = 30_000;

export class TelegramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramError';
  }
}

// ---------- configuration ----------

export function telegramToken(): string {
  return (process.env.AGENTSCOPE_TELEGRAM_BOT_TOKEN ?? '').trim();
}

export function telegramAllowedIds(): number[] {
  return (process.env.AGENTSCOPE_TELEGRAM_ALLOWED_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function telegramConfigured(): boolean {
  return telegramToken().length > 0 && telegramAllowedIds().length > 0;
}

// ---------- low-level API ----------

async function tgApi<T = unknown>(method: string, body?: Record<string, unknown>): Promise<T> {
  const token = telegramToken();
  if (!token) throw new TelegramError('AGENTSCOPE_TELEGRAM_BOT_TOKEN is not set');
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(40_000),
    });
  } catch (err) {
    throw new TelegramError(`Telegram API unreachable: ${err instanceof Error ? err.message : 'network error'}`);
  }
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!res.ok || json.ok !== true) {
    throw new TelegramError(json.description || `Telegram API HTTP ${res.status}`);
  }
  return json.result as T;
}

export async function sendTelegramMessage(chatId: number | string, text: string): Promise<void> {
  const chunks: string[] = [];
  let rest = String(text ?? '');
  while (rest.length > 0) {
    chunks.push(rest.slice(0, TELEGRAM_TEXT_LIMIT));
    rest = rest.slice(TELEGRAM_TEXT_LIMIT);
    if (chunks.length >= 4) break; // never spam more than 4 messages
  }
  if (rest.length > 0) chunks[chunks.length - 1] += '\n…[truncated]';
  for (const chunk of chunks) {
    await tgApi('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true });
  }
}

// ---------- polling loop ----------

interface PollState {
  timer: ReturnType<typeof setInterval> | null;
  offset: number;
  lastTaskAt: number;
  polling: boolean;
  lastError: string;
  startedAt: number | null;
  /** a getUpdates round-trip is in flight — interval ticks must not overlap */
  inFlight?: boolean;
}

function pollStore(): PollState {
  const g = globalThis as unknown as { __telegramPoll?: PollState };
  return (g.__telegramPoll ??= { timer: null, offset: 0, lastTaskAt: 0, polling: false, lastError: '', startedAt: null });
}

export function telegramStatus(): {
  configured: boolean;
  polling: boolean;
  uptimeSec: number;
  lastError: string;
  allowedIds: number;
} {
  const st = pollStore();
  return {
    configured: telegramConfigured(),
    polling: Boolean(st.timer && st.polling),
    uptimeSec: st.startedAt ? Math.floor((Date.now() - st.startedAt) / 1000) : 0,
    lastError: st.lastError,
    allowedIds: telegramAllowedIds().length,
  };
}

/** Start the long-poll loop (idempotent). Called by the background runtime. */
export function startTelegramBot(): boolean {
  if (!telegramConfigured()) return false;
  const st = pollStore();
  if (st.timer) return false;
  st.polling = true;
  st.startedAt = Date.now();
  // the poll itself runs serially; the interval only nudges it
  st.timer = setInterval(() => void pollOnce(), 1_500);
  void pollOnce();
  return true;
}

export function stopTelegramBot(): void {
  const st = pollStore();
  if (st.timer) clearInterval(st.timer);
  st.timer = null;
  st.polling = false;
  st.startedAt = null;
}

async function pollOnce(): Promise<void> {
  const st = pollStore();
  if (!st.polling || st.lastTaskAt === -1) return;
  // serialize polls: a marker trick — while a network poll is in flight the
  // interval ticks are no-ops (polling stays true but inFlight guards it)
  if (st.inFlight) return;
  st.inFlight = true;
  try {
    // FIRST poll after (re)start: drop the backlog. Telegram replays every
    // unconfirmed update of the last 24h — replaying a stale "/approve" or
    // an old plain-text prompt would re-run commands the user sent while
    // the Studio was offline. offset=-1 confirms everything and returns the
    // newest update only; we skip even that one and continue fresh.
    if (st.offset === 0) {
      const latest = await tgApi<Array<{ update_id: number }>>('getUpdates', {
        offset: -1,
        timeout: 0,
        allowed_updates: ['message'],
      });
      st.offset = latest?.length ? latest[latest.length - 1].update_id + 1 : 1;
      st.lastError = '';
      return;
    }
    const updates = await tgApi<Array<{ update_id: number; message?: TgMessage; edited_message?: TgMessage }>>(
      'getUpdates',
      {
        offset: st.offset || undefined,
        timeout: POLL_TIMEOUT_SEC,
        allowed_updates: ['message'],
      }
    );
    for (const u of updates ?? []) {
      st.offset = Math.max(st.offset, u.update_id + 1);
      const msg = u.message ?? u.edited_message;
      if (msg?.text) await handleTelegramMessage(msg);
    }
    st.lastError = '';
  } catch (err) {
    st.lastError = err instanceof Error ? err.message : String(err);
    // a 409 (another poller) or 401 (bad token) should not spin hot — back off
    await new Promise((r) => setTimeout(r, 5_000)).catch(() => undefined);
  } finally {
    st.inFlight = false;
  }
}

interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string };
  text?: string;
}

// ---------- the command router ----------

async function auditTg(action: string, ok: boolean, details: Record<string, unknown>, error?: string): Promise<void> {
  await recordAudit({
    actor: 'telegram',
    action,
    category: 'security',
    approval: 'auto',
    result: ok ? 'ok' : 'error',
    error,
    details,
  });
}

function fmtPending(): string {
  const pending = listPendingHostActions();
  if (!pending.length) return 'Kuch approve nahi hua abhi. ✅';
  return pending
    .slice(0, 10)
    .map((p) => `• [${p.id.slice(0, 8)}] ${p.permission.toUpperCase()} — ${p.summary}`)
    .join('\n');
}

async function handleTelegramMessage(msg: TgMessage): Promise<void> {
  const userId = msg.from?.id ?? 0;
  const chatId = msg.chat.id;
  const text = String(msg.text ?? '').trim();

  // ALLOW-LIST: everyone else is invisible (but logged)
  if (!telegramAllowedIds().includes(userId)) {
    await auditTg('telegram.refused', false, { userId, chatId, kind: msg.chat.type }, 'sender not in allow-list');
    return;
  }

  if (!text) return;

  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().startsWith('/') ? rawCmd.toLowerCase() : '';
  const argText = text.slice(rawCmd.length).trim();

  try {
    if (!cmd) {
      await handleTaskPrompt(chatId, userId, text, msg.from?.username ?? msg.from?.first_name ?? String(userId));
      return;
    }
    switch (cmd) {
      case '/help':
      case '/start':
        await sendTelegramMessage(chatId, [
          '🤖 AgentScope Studio commands:',
          '/status — modes, kill switch, bridge, approvals',
          '/pending — waiting approvals',
          '/approve <id> — approve a pending action',
          '/deny <id> — deny it',
          '/kill — STOP everything (kill switch)',
          '/resume — release the kill switch',
          'Koi bhi plain text → naya agentic task ban jayega (plan only; run approval UI me).',
        ].join('\n'));
        return;

      case '/status': {
        const s = safetyStatus();
        const b = bridgeStatus();
        const pending = listPendingHostActions().length;
        await sendTelegramMessage(chatId, [
          `🖥 Host mode: ${s.hostMode} | Desktop: ${s.desktopMode}`,
          `🛑 Kill switch: ${s.killed ? `ENGAGED (${s.killSource})` : 'off'} | Hotkey: ${s.hotkey}`,
          `🖱 Desktop bridge: ${b.ready ? 'ready' : b.running ? 'starting' : 'stopped'}${b.lastError ? ` (${b.lastError.slice(0, 120)})` : ''}`,
          `⏳ Pending approvals: ${pending}`,
        ].join('\n'));
        return;
      }

      case '/pending':
        await sendTelegramMessage(chatId, fmtPending());
        return;

      case '/approve':
      case '/deny': {
        const prefix = args[0] ?? '';
        if (!prefix) {
          await sendTelegramMessage(chatId, 'ID chahiye: /approve <id-prefix> ( /pending se dekho )');
          return;
        }
        const pending = listPendingHostActions();
        const match = pending.find((p) => p.id.startsWith(prefix.toLowerCase()));
        if (!match) {
          await sendTelegramMessage(chatId, `Koi pending action "${prefix}" se match nahi hua.\n${fmtPending()}`);
          return;
        }
        const r = await resolveHostApproval(match.id, cmd === '/approve', 'telegram');
        await auditTg(`telegram.${cmd.slice(1)}`, true, { id: match.id, summary: match.summary });
        if (cmd === '/approve' && r.ok && r.result) {
          await sendTelegramMessage(chatId, `✅ Ran: ${match.summary}\n${r.result.ok ? 'OK' : `error: ${r.result.error ?? '?'}`}`);
        } else if (cmd === '/approve') {
          await sendTelegramMessage(chatId, `⚠️ Approve fail: ${r.error ?? 'unknown'}`);
        } else {
          await sendTelegramMessage(chatId, '🚫 Denied — kuch run nahi hua.');
        }
        return;
      }

      case '/kill': {
        const state = engageKill('telegram /kill', 'telegram');
        await auditTg('telegram.kill', true, { at: state.at });
        await createNotification({
          type: 'telegram',
          title: 'KILL SWITCH engaged from Telegram',
          body: 'Sab laptop actions rok diye gaye. UI ya /resume se release karo.',
          data: { source: 'telegram' },
        });
        await sendTelegramMessage(chatId, '🛑 KILL SWITCH engaged — har laptop action ab refused hai.');
        return;
      }

      case '/resume': {
        const state = getKillState();
        if (!state.killed) {
          await sendTelegramMessage(chatId, 'Kill switch already off hai.');
          return;
        }
        releaseKill('telegram');
        await auditTg('telegram.resume', true, {});
        await sendTelegramMessage(chatId, '▶️ Kill switch release. Actions dobara allow hue.');
        return;
      }

      default:
        await sendTelegramMessage(chatId, `Unknown command ${rawCmd} — /help dekho.`);
        return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed';
    await auditTg('telegram.error', false, { cmd, userId }, message);
    await sendTelegramMessage(chatId, `⚠️ ${message}`.slice(0, TELEGRAM_TEXT_LIMIT));
  }
}

/** Plain text from the phone → a NEW agentic task (plan only). */
async function handleTaskPrompt(chatId: number, userId: number, prompt: string, username: string): Promise<void> {
  const st = pollStore();
  if (Date.now() - st.lastTaskAt < MIN_TASK_GAP_MS) {
    await sendTelegramMessage(chatId, 'Thoda ruk jao — 30 second me ek task se zyada nahi.');
    return;
  }
  const clean = prompt.trim().slice(0, 4000);
  if (clean.length < 8) {
    await sendTelegramMessage(chatId, 'Thoda detail me likho (min 8 characters).');
    return;
  }
  st.lastTaskAt = Date.now();
  try {
    const task = await db.agenticTask.create({
      data: {
        prompt: `[Telegram: ${username}] ${clean}`,
        provider: 'zai',
        model: '',
        status: 'planning',
        conversationId: `conv_tg_${userId}_${Date.now()}`,
      },
    });
    await planTask(task.id, undefined, undefined, {});
    await auditTg('telegram.task_created', true, { taskId: task.id });
    await sendTelegramMessage(
      chatId,
      `📋 Task ban gaya: ${task.id}\nPlan ready hote hi UI me approval maangega — main phone se plan run nahi karta.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'task creation failed';
    await auditTg('telegram.task_failed', false, { userId }, message);
    await sendTelegramMessage(chatId, `⚠️ Task nahi ban paya: ${message}`.slice(0, TELEGRAM_TEXT_LIMIT));
  }
}
