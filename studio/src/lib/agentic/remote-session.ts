// remote-session.ts — Stonic Remote: talk to this PC's JARVIS from a phone.
//
// THREAT MODEL (why this file is careful)
//   The remote page exposes a conversational agent that can, through the
//   normal task engine, touch files and apps. So the phone must never get in
//   with a guessable secret:
//
//   * Pairing needs a 6-digit code that the PC displays while the user is
//     looking at it. The code is short (people read it off a screen) so it is
//     defended by TTL (3 min), a single active code at a time, a hard cap of
//     wrong guesses, and a per-client attempt throttle.
//   * The code is redeemed exactly ONCE, for a 256-bit session token that is
//     compared in constant time and never written to logs or the audit trail.
//   * Sessions idle out (2 h), a device can be revoked from the PC at any
//     moment, and the kill switch refuses new pairings and new messages.
//
// State is deliberately IN MEMORY: a restart drops every session, which is the
// safe default for a remote control channel (no token survives a reboot).

import crypto from 'crypto';
import { isKilled } from './safety';

export interface RemoteDevice {
  /** short, user-supplied label ("Ankit ka phone") */
  label: string;
  userAgent: string;
  ip: string;
}

export interface RemoteSession {
  id: string;
  token: string;
  device: RemoteDevice;
  createdAt: number;
  lastSeenAt: number;
  /** number of exchanges so far */
  messages: number;
  /** conversation row used to persist the transcript on the PC */
  conversationId: string;
}

export interface RemoteEvent {
  at: number;
  type: 'paired' | 'connected' | 'message' | 'reply' | 'ended' | 'rejected' | 'error';
  detail: string;
}

export interface PairingView {
  code: string;
  expiresAt: number;
  /** seconds left */
  remainingSec: number;
  /** how many wrong guesses remain before the code dies */
  attemptsLeft: number;
}

export class RemoteError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.status = status;
  }
}

const CODE_TTL_MS = 3 * 60 * 1000;
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 3;
const MAX_CODES_ATTEMPTS = 5;
const MAX_EVENTS = 60;

/** per-client throttle: 10 attempts / minute (brute force of 6 digits) */
const ATTEMPT_WINDOW_MS = 60 * 1000;
const ATTEMPT_LIMIT = 10;

interface Pairing {
  code: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  used: boolean;
}

interface RateBucket {
  windowStart: number;
  count: number;
}

interface RemoteState {
  pairing: Pairing | null;
  sessions: Map<string, RemoteSession>;
  events: RemoteEvent[];
  attempts: Map<string, RateBucket>;
  /** injected clock for tests */
  now: () => number;
}

/**
 * The state lives on `globalThis`, NOT in a module variable.
 *
 * Next.js compiles every route handler into its own bundle, so a module-level
 * `Map` would be a DIFFERENT Map in `/api/remote/pair`, `/api/remote/connect`
 * and `/api/remote/message` — the code created by the PC would be invisible to
 * the phone (it silently looked like "code expired"). One object on
 * globalThis is shared by every bundle in the server process, and it also
 * survives the dev server's hot reloads. This is the same pattern as the
 * Prisma client singleton.
 */
const GLOBAL_KEY = '__agentscope_remote_state__';

function freshState(): RemoteState {
  return {
    pairing: null,
    sessions: new Map(),
    events: [],
    attempts: new Map(),
    now: () => Date.now(),
  };
}

const state: RemoteState =
  ((globalThis as unknown as Record<string, RemoteState | undefined>)[GLOBAL_KEY] ??= freshState());

function now(): number {
  return state.now();
}

function record(type: RemoteEvent['type'], detail: string): void {
  state.events.push({ at: now(), type, detail });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

/** Constant-time comparison that also hides the length. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  const length = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  const equal = crypto.timingSafeEqual(paddedLeft, paddedRight);
  return equal && left.length === right.length;
}

function prune(): void {
  const at = now();
  for (const [token, session] of state.sessions) {
    if (at - session.lastSeenAt > SESSION_IDLE_MS) {
      state.sessions.delete(token);
      record('ended', `session ${session.id} expired after inactivity`);
    }
  }
  if (state.pairing && (state.pairing.used || at > state.pairing.expiresAt)) {
    state.pairing = null;
  }
  for (const [key, bucket] of state.attempts) {
    if (at - bucket.windowStart > ATTEMPT_WINDOW_MS) state.attempts.delete(key);
  }
}

function throttle(clientKey: string): void {
  const at = now();
  const bucket = state.attempts.get(clientKey);
  if (!bucket || at - bucket.windowStart > ATTEMPT_WINDOW_MS) {
    state.attempts.set(clientKey, { windowStart: at, count: 1 });
    return;
  }
  bucket.count++;
  if (bucket.count > ATTEMPT_LIMIT) {
    record('rejected', `rate limit hit by ${clientKey}`);
    throw new RemoteError('rate_limited', 'Too many attempts. Wait a minute and try again.', 429);
  }
}

/** Create (or replace) the pairing code shown on the PC. */
export function startPairing(): PairingView {
  if (isKilled()) {
    throw new RemoteError('killed', 'The kill switch is engaged — remote pairing is disabled.', 423);
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const at = now();
  state.pairing = { code, createdAt: at, expiresAt: at + CODE_TTL_MS, attempts: 0, used: false };
  record('paired', 'a new pairing code was generated on the PC');
  return pairingView();
}

export function pairingView(): PairingView {
  prune();
  const pairing = state.pairing;
  if (!pairing || pairing.used) {
    throw new RemoteError('no_pairing', 'No pairing code is active. Generate one on the PC.', 404);
  }
  return {
    code: pairing.code,
    expiresAt: pairing.expiresAt,
    remainingSec: Math.max(0, Math.round((pairing.expiresAt - now()) / 1000)),
    attemptsLeft: Math.max(0, MAX_CODES_ATTEMPTS - pairing.attempts),
  };
}

export function cancelPairing(): void {
  if (state.pairing) record('ended', 'pairing code cancelled on the PC');
  state.pairing = null;
}

/**
 * Redeem a pairing code from the phone. Returns the session (with its token).
 * The code is burned on success and after too many wrong guesses.
 */
export function redeemCode(
  code: string,
  device: Partial<RemoteDevice>,
  clientKey: string
): { session: RemoteSession } {
  if (isKilled()) {
    throw new RemoteError('killed', 'The kill switch is engaged — remote access is disabled.', 423);
  }
  prune();
  throttle(clientKey);
  const pairing = state.pairing;
  if (!pairing || pairing.used) {
    throw new RemoteError('no_pairing', 'This code is no longer valid. Generate a new one on the PC.', 404);
  }

  const entered = String(code ?? '').replace(/[^\d]/g, '');
  if (!safeEqual(entered, pairing.code)) {
    pairing.attempts++;
    if (pairing.attempts >= MAX_CODES_ATTEMPTS) {
      state.pairing = null;
      record('rejected', 'pairing code destroyed after too many wrong attempts');
      throw new RemoteError('code_destroyed', 'Too many wrong attempts — the code was cancelled.', 403);
    }
    record('rejected', 'a wrong pairing code was entered');
    throw new RemoteError(
      'bad_code',
      `Wrong code. ${MAX_CODES_ATTEMPTS - pairing.attempts} attempt(s) left.`,
      403
    );
  }

  // single use: burn it before creating the session
  pairing.used = true;
  state.pairing = null;

  if (state.sessions.size >= MAX_SESSIONS) {
    // drop the least recently used session, never silently keep an old one
    const oldest = Array.from(state.sessions.values()).sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (oldest) state.sessions.delete(oldest.token);
  }

  const session: RemoteSession = {
    id: crypto.randomBytes(6).toString('hex'),
    token: crypto.randomBytes(32).toString('hex'),
    device: {
      label: String(device.label ?? '').trim().slice(0, 40) || 'Phone',
      userAgent: String(device.userAgent ?? '').slice(0, 200),
      ip: String(device.ip ?? '').slice(0, 60),
    },
    createdAt: now(),
    lastSeenAt: now(),
    messages: 0,
    conversationId: '',
  };
  state.sessions.set(session.token, session);
  record('connected', `${session.device.label} paired (${session.id})`);
  return { session };
}

/** Validate a session token (constant-time) and refresh its idle timer. */
export function authenticate(token: string): RemoteSession {
  prune();
  const presented = String(token ?? '').trim();
  if (!presented) throw new RemoteError('no_token', 'A session token is required.', 401);

  let found: RemoteSession | null = null;
  for (const session of state.sessions.values()) {
    if (safeEqual(presented, session.token)) {
      found = session;
      break;
    }
  }
  if (!found) throw new RemoteError('bad_token', 'This session has ended. Pair again on the PC.', 401);
  if (isKilled()) throw new RemoteError('killed', 'The kill switch is engaged.', 423);

  found.lastSeenAt = now();
  return found;
}

export function touch(session: RemoteSession): void {
  const live = state.sessions.get(session.token);
  if (live) live.lastSeenAt = now();
}

export function setConversationId(session: RemoteSession, conversationId: string): void {
  const live = state.sessions.get(session.token);
  if (live) live.conversationId = conversationId;
}

export function countMessage(session: RemoteSession): void {
  const live = state.sessions.get(session.token);
  if (live) live.messages++;
}

export function revoke(token: string): boolean {
  const presented = String(token ?? '').trim();
  for (const [key, session] of state.sessions) {
    if (safeEqual(presented, key)) {
      state.sessions.delete(key);
      record('ended', `${session.device.label} was disconnected from the PC`);
      return true;
    }
  }
  return false;
}

/** Revoke by session id (the PC panel never sees the token). */
export function revokeById(sessionId: string): boolean {
  const wanted = String(sessionId ?? '').trim();
  if (!wanted) return false;
  for (const [token, session] of state.sessions) {
    if (session.id === wanted) {
      state.sessions.delete(token);
      record('ended', `${session.device.label} was disconnected from the PC`);
      return true;
    }
  }
  return false;
}

export function revokeAll(): number {
  const count = state.sessions.size;
  state.sessions.clear();
  record('ended', `${count} remote session(s) disconnected`);
  return count;
}

export function listSessions(): Omit<RemoteSession, 'token'>[] {
  prune();
  return Array.from(state.sessions.values())
    .map(({ token: _token, ...rest }) => rest)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function recentEvents(limit = 20): RemoteEvent[] {
  return state.events.slice(-Math.min(Math.max(1, limit), MAX_EVENTS));
}

/** A one-line "who is connected" summary for the audit trail / UI. */
export function sessionSummary(): string {
  const sessions = listSessions();
  if (!sessions.length) return 'no remote device connected';
  return sessions.map((s) => `${s.device.label} (${s.id})`).join(', ');
}

/** Test-only: reset every piece of state and optionally inject a clock. */
export function __resetRemoteState(clock?: () => number): void {
  state.pairing = null;
  state.sessions.clear();
  state.events = [];
  state.attempts.clear();
  state.now = clock ?? (() => Date.now());
}

export const REMOTE_LIMITS = {
  codeTtlMs: CODE_TTL_MS,
  sessionIdleMs: SESSION_IDLE_MS,
  maxSessions: MAX_SESSIONS,
  maxCodeAttempts: MAX_CODES_ATTEMPTS,
  attemptLimit: ATTEMPT_LIMIT,
  attemptWindowMs: ATTEMPT_WINDOW_MS,
};
