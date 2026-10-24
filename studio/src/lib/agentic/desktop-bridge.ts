// desktop-bridge.ts — Node-side manager for python-bridge/desktop_bridge.py.
//
// The Python bridge is the actual hand on the laptop's mouse, keyboard and
// screen (pyautogui + mss). This module:
//   - generates/loads the bridge token (db/.desktop-token, same pattern as
//     the secret-key file — the token NEVER leaves the server except in the
//     bridge's argv/env),
//   - spawns the bridge as a child process bound to 127.0.0.1 (opt-in:
//     desktopMode() !== 'locked'),
//   - exposes desktopCall(endpoint, payload) with token auth, kill-switch
//     handling and a hard local-only URL check,
//   - reports status for the UI.
//
// It deliberately knows NOTHING about approvals/audit — that is host-control's
// job (the `desktop` action kind flows through requestHostAction like every
// other laptop action).

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertNotKilled, desktopMode, killHotkey } from './safety';

export class DesktopBridgeError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'DesktopBridgeError';
    this.hint = hint;
  }
}

// ---------- configuration ----------

export const DESKTOP_PORT_DEFAULT = 8791;

function desktopPort(): number {
  const n = Number(process.env.AGENTSCOPE_DESKTOP_PORT ?? DESKTOP_PORT_DEFAULT);
  return Number.isFinite(n) && n > 1024 && n < 65536 ? Math.floor(n) : DESKTOP_PORT_DEFAULT;
}

/** The bridge token — generated once, persisted next to the database. */
export function desktopToken(): string {
  const fromEnv = (process.env.AGENTSCOPE_DESKTOP_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  const file = path.join(process.cwd(), 'db', '.desktop-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32,128}$/i.test(existing)) return existing;
  } catch {
    /* generate below */
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* in-memory token still works for this session */
  }
  return token;
}

function bridgeScript(): string {
  return path.join(process.cwd(), 'python-bridge', 'desktop_bridge.py');
}

function killFlagFile(): string {
  return path.join(process.cwd(), '.agentic-workspace', 'kill-flag.json');
}

/** The env keys the child may keep (same hygiene as host-control.hostEnv). */
function bridgeEnv(): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL)/i.test(k)) continue;
    env[k] = v;
  }
  env.AGENTSCOPE_DESKTOP_PORT = String(desktopPort());
  env.AGENTSCOPE_DESKTOP_TOKEN = desktopToken();
  env.AGENTSCOPE_KILL_FLAG = killFlagFile();
  // the generic secret filter above strips anything matching /KEY/ — the
  // kill HOTKEY is not a secret, pass it explicitly so a custom
  // AGENTSCOPE_KILL_HOTKEY actually reaches the Python bridge
  env.AGENTSCOPE_KILL_HOTKEY = killHotkey();
  return env;
}

// ---------- process management ----------

interface BridgeProc {
  child: ChildProcess;
  startedAt: number;
  ready: boolean;
  lastError: string;
}

function store(): {
  proc: BridgeProc | null;
  starting: Promise<BridgeProc | null> | null;
} {
  const g = globalThis as unknown as {
    __desktopBridge?: { proc: BridgeProc | null; starting: Promise<BridgeProc | null> | null };
  };
  return (g.__desktopBridge ??= { proc: null, starting: null });
}

async function findPython(): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  const candidates = process.env.AGENTSCOPE_PYTHON
    ? [process.env.AGENTSCOPE_PYTHON]
    : process.platform === 'win32'
      ? ['python', 'python3', 'py']
      : ['python3', 'python'];
  for (const bin of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      execFile(bin, ['--version'], { timeout: 10_000 }, (err) => resolve(!err));
    });
    if (ok) return bin;
  }
  return null;
}

/**
 * Start the bridge if the desktop gate is open and it is not already up.
 * Idempotent, never throws — the caller gets null when it cannot start
 * (with the reason in bridgeStatus()).
 */
export async function ensureBridge(): Promise<BridgeProc | null> {
  if (desktopMode() === 'locked') return null;
  const s = store();
  // guard against the failed-start proc whose `child` is null (e.g. Python
  // not found) — touching .exitCode on null used to crash every later call
  if (s.proc?.child && s.proc.child.exitCode === null) return s.proc;
  if (s.starting) return s.starting;

  s.starting = (async () => {
    const python = await findPython();
    if (!python) {
      const st = store();
      st.proc = {
        child: null as unknown as ChildProcess,
        startedAt: Date.now(),
        ready: false,
        lastError: 'Python not found — install Python 3 or set AGENTSCOPE_PYTHON',
      };
      return st.proc;
    }
    return await new Promise<BridgeProc>((resolve) => {
      let settled = false;
      const finish = (proc: BridgeProc) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(proc);
      };
      let child: ChildProcess;
      try {
        child = spawn(python, [
          bridgeScript(),
          '--port', String(desktopPort()),
          // H33: the token is deliberately NOT passed on the command line any
          // more — argv of a running process is world-readable (`ps -ef`,
          // /proc/<pid>/cmdline), so every local user could read the bridge
          // token and drive the mouse and keyboard. bridgeEnv() already hands it
          // over in AGENTSCOPE_DESKTOP_TOKEN, which only the owner can read, and
          // both bridges default --token from exactly that variable.
          '--kill-flag', killFlagFile(),
        ], { env: bridgeEnv(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        const proc: BridgeProc = {
          child: null as unknown as ChildProcess,
          startedAt: Date.now(),
          ready: false,
          lastError: `spawn failed: ${(e as Error).message}`,
        };
        store().proc = proc;
        finish(proc);
        return;
      }
      const proc: BridgeProc = { child, startedAt: Date.now(), ready: false, lastError: '' };
      store().proc = proc;

      // the bridge prints one ping JSON line when it is listening
      const timer = setTimeout(() => {
        proc.lastError = proc.lastError || 'bridge did not report ready within 12s';
        finish(proc);
      }, 12_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().split('\n').find((l) => l.trim().startsWith('{'));
        if (line && !proc.ready) {
          try {
            const ping = JSON.parse(line);
            proc.ready = ping.ok === true;
            if (!proc.ready) proc.lastError = ping.error || 'bridge failed to start';
          } catch {
            /* partial line */
          }
          finish(proc);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        proc.lastError = String(chunk).slice(0, 400);
      });
      child.on('error', (e) => {
        proc.lastError = e.message;
        finish(proc);
      });
      child.on('exit', (code) => {
        proc.ready = false;
        if (code && code !== 0 && !proc.lastError) proc.lastError = `bridge exited with code ${code}`;
        // fail FAST when the bridge dies before it ever reported ready
        // (bad python, port already in use, missing module) — waiting for
        // the 12s readiness timer made every caller hang for no reason
        if (!proc.ready) finish(proc);
      });
    });
  })();

  try {
    return await s.starting;
  } finally {
    store().starting = null;
  }
}

/** Stop the bridge (tests / kill switch UI). */
export function stopBridge(): void {
  const proc = store().proc;
  if (proc?.child && proc.child.exitCode === null) {
    try {
      proc.child.kill();
    } catch {
      /* ignore */
    }
  }
  store().proc = null;
}

export interface DesktopBridgeStatus {
  mode: string;
  desired: 'running' | 'stopped';
  running: boolean;
  ready: boolean;
  port: number;
  pid: number | null;
  uptimeSec: number;
  lastError: string;
  script: string;
  installHint: string;
}

export function bridgeStatus(): DesktopBridgeStatus {
  const proc = store().proc;
  const alive = Boolean(proc?.child && proc.child.exitCode === null);
  return {
    mode: desktopMode(),
    desired: desktopMode() === 'locked' ? 'stopped' : 'running',
    running: alive,
    ready: Boolean(alive && proc?.ready),
    port: desktopPort(),
    pid: alive ? proc!.child.pid ?? null : null,
    uptimeSec: alive ? Math.floor((Date.now() - proc!.startedAt) / 1000) : 0,
    lastError: proc?.lastError ?? '',
    script: bridgeScript(),
    installHint: 'pip install -r python-bridge/requirements-desktop.txt',
  };
}

// ---------- the call ----------

const READONLY_ENDPOINTS = new Set(['screenshot', 'list_windows', 'chrome_history', 'ping', 'status', 'wifi_status', 'system_info']);
const MUTATING_ENDPOINTS = new Set([
  'mouse_move', 'click', 'type_text', 'hotkey', 'scroll', 'focus_window',
  'clipboard_get', 'clipboard_set', 'open_app', 'volume', 'lock_screen', 'recycle_delete', 'kill',
  // Jarvis extras — all approval-gated (never in the read-only set)
  'close_window', 'window_state', 'brightness', 'wifi_set', 'power', 'webcam_capture', 'screen_record',
]);
// clipboard_get sits in MUTATING on purpose: reading the clipboard never
// mutates the machine, but the clipboard may contain SECRETS (copied
// passwords, tokens) — so it keeps the approval gate in every mode instead
// of auto-running like the read-only set. Without it here the
// desktop-clipboard-get tool was refused with "unknown endpoint" before it
// ever reached the bridge.

/** screen_record can legitimately run up to 60 s; everything else stays short. */
function endpointTimeoutMs(endpoint: string): number {
  if (endpoint === 'screen_record') return 90_000;
  if (endpoint === 'chrome_history') return 30_000;
  return 20_000;
}

export function isReadOnlyEndpoint(endpoint: string): boolean {
  return READONLY_ENDPOINTS.has(endpoint);
}

export function isValidEndpoint(endpoint: string): boolean {
  return READONLY_ENDPOINTS.has(endpoint) || MUTATING_ENDPOINTS.has(endpoint);
}

export interface DesktopCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  hint?: string;
  killed?: boolean;
  /** raw PNG when endpoint === 'screenshot' */
  imageBase64?: string;
}

/**
 * Call one bridge endpoint. 127.0.0.1 only, token always attached, the kill
 * switch is checked BEFORE the request (and the bridge re-checks itself).
 */
export async function desktopCall(endpoint: string, payload: Record<string, unknown> = {}): Promise<DesktopCallResult> {
  if (!isValidEndpoint(endpoint)) {
    return { ok: false, error: `Unknown desktop endpoint: ${endpoint}` };
  }
  try {
    assertNotKilled();
  } catch {
    return { ok: false, error: 'KILL SWITCH is engaged — desktop action refused', killed: true };
  }
  if (desktopMode() === 'locked') {
    return {
      ok: false,
      error: 'Desktop tools are locked (AGENTSCOPE_DESKTOP_MODE=locked)',
      hint: 'Set AGENTSCOPE_DESKTOP_MODE=ask in .env and restart to enable mouse/keyboard control.',
    };
  }

  const started = await ensureBridge();
  if (!started?.ready) {
    const st = bridgeStatus();
    return {
      ok: false,
      error: st.lastError || 'Desktop bridge is not ready',
      hint: st.lastError.includes('Python not found')
        ? 'Install Python 3 or set AGENTSCOPE_PYTHON in .env'
        : st.installHint,
    };
  }

  const url = `http://127.0.0.1:${desktopPort()}/${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), endpointTimeoutMs(endpoint));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Desktop-Token': desktopToken(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (endpoint === 'screenshot' && res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, data: { format: 'png', bytes: buf.length }, imageBase64: buf.toString('base64') };
    }

    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: string; killed?: boolean };
    if (!res.ok) {
      if (res.status === 423 || body.killed) {
        return { ok: false, error: body.error || 'Kill switch engaged on the bridge', killed: true };
      }
      return { ok: false, error: body.error || `bridge returned HTTP ${res.status}` };
    }
    return { ok: body.ok !== false, data: body.data, error: body.ok === false ? body.error : undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'bridge call failed';
    return { ok: false, error: `Desktop bridge unreachable: ${message}` };
  } finally {
    // H34: the timeout is cancelled only once the WHOLE exchange is over.
    // It used to be cancelled right after the response arrived, so a bridge
    // that answered and then stalled mid-body (a screenshot stream that never
    // ends) left this promise — and the task awaiting it — hanging forever.
    clearTimeout(timeout);
  }
}
