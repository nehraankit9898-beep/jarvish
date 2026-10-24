// voice-bridge.ts — Node-side manager for python-bridge/voice_bridge.py.
//
// The voice bridge is the Jarvis "ears + mouth":
//   - POST /tts       → edge-tts MP3 bytes (natural voice, Jarvis #3)
//   - POST /wake      → wake-word engine control (Jarvis #1, opt-in)
//
// It mirrors desktop-bridge.ts (token, spawn, readiness ping, kill flag)
// but is NOT gated by AGENTSCOPE_DESKTOP_MODE: speaking and listening do
// not touch the laptop's mouse/keyboard/files. The WAKE engine itself only
// starts when the user turns Hands-free ON in the UI (explicit opt-in).
//
// Env:
//   AGENTSCOPE_VOICE_BRIDGE=0     → never spawn (disable the whole thing)
//   AGENTSCOPE_VOICE_PORT         → default 8792
//   AGENTSCOPE_WAKE_MODEL_DIR     → where the hey_jarvis model is stored

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { desktopToken } from './desktop-bridge';

export class VoiceBridgeError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'VoiceBridgeError';
    this.hint = hint;
  }
}

export const VOICE_PORT_DEFAULT = 8792;

function voiceEnabled(): boolean {
  return process.env.AGENTSCOPE_VOICE_BRIDGE !== '0';
}

function voicePort(): number {
  const n = Number(process.env.AGENTSCOPE_VOICE_PORT ?? VOICE_PORT_DEFAULT);
  return Number.isFinite(n) && n > 1024 && n < 65536 ? Math.floor(n) : VOICE_PORT_DEFAULT;
}

function voiceScript(): string {
  return path.join(process.cwd(), 'python-bridge', 'voice_bridge.py');
}

function killFlagFile(): string {
  return path.join(process.cwd(), '.agentic-workspace', 'kill-flag.json');
}

/** Tray/panel mute + pause flags live next to the db. */
export function micMutedFlag(): string {
  return path.join(process.cwd(), 'db', '.mic-muted');
}
export function jarvisPausedFlag(): string {
  return path.join(process.cwd(), 'db', '.jarvis-paused');
}

function bridgeEnv(): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL)/i.test(k)) continue;
    env[k] = v;
  }
  env.AGENTSCOPE_VOICE_PORT = String(voicePort());
  // the voice bridge reuses the SAME token as the desktop bridge (one file)
  env.AGENTSCOPE_DESKTOP_TOKEN = desktopToken();
  env.AGENTSCOPE_KILL_FLAG = killFlagFile();
  if (process.env.AGENTSCOPE_WAKE_MODEL_DIR) {
    env.AGENTSCOPE_WAKE_MODEL_DIR = process.env.AGENTSCOPE_WAKE_MODEL_DIR;
  }
  // the Porcupine access key (optional) must survive the secret filter
  if (process.env.AGENTSCOPE_PORCUPINE_KEY) {
    env.AGENTSCOPE_PORCUPINE_KEY = process.env.AGENTSCOPE_PORCUPINE_KEY;
  }
  return env;
}

// ---------- process management ----------

interface VoiceProc {
  child: ChildProcess;
  startedAt: number;
  ready: boolean;
  lastError: string;
  info: { wake_engine?: string; tts?: boolean; tts_error?: string };
}

function store(): {
  proc: VoiceProc | null;
  starting: Promise<VoiceProc | null> | null;
} {
  const g = globalThis as unknown as {
    __voiceBridge?: { proc: VoiceProc | null; starting: Promise<VoiceProc | null> | null };
  };
  return (g.__voiceBridge ??= { proc: null, starting: null });
}

/**
 * TRUE when the child is gone. BUGFIX: a signal-killed bridge (crash, pkill,
 * OOM) keeps `exitCode === null` forever — Node stores `signalCode` instead —
 * so the old check treated a DEAD bridge as running and never respawned it;
 * every voice call then failed with "Voice bridge is not ready" until the
 * whole Studio was restarted.
 */
function childDead(child: ChildProcess | null | undefined): boolean {
  if (!child) return true;
  return child.exitCode !== null || child.signalCode !== null;
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
 * Start the voice bridge if enabled and not already up. Idempotent, never
 * throws — the caller gets null when it cannot start (reason in status()).
 */
export async function ensureVoiceBridge(): Promise<VoiceProc | null> {
  if (!voiceEnabled()) return null;
  const s = store();
  if (s.proc?.child && !childDead(s.proc.child)) return s.proc;
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
        info: {},
      };
      return st.proc;
    }
    return await new Promise<VoiceProc>((resolve) => {
      let settled = false;
      const finish = (proc: VoiceProc) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(proc);
      };
      let child: ChildProcess;
      try {
        child = spawn(python, [
          voiceScript(),
          '--port', String(voicePort()),
          '--token', desktopToken(),
          '--kill-flag', killFlagFile(),
          '--state-dir', path.join(process.cwd(), 'db'),
        ], { env: bridgeEnv(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        const proc: VoiceProc = {
          child: null as unknown as ChildProcess,
          startedAt: Date.now(),
          ready: false,
          lastError: `spawn failed: ${(e as Error).message}`,
          info: {},
        };
        store().proc = proc;
        finish(proc);
        return;
      }
      const proc: VoiceProc = { child, startedAt: Date.now(), ready: false, lastError: '', info: {} };
      store().proc = proc;

      // the bridge prints one readiness JSON line when it is listening
      const timer = setTimeout(() => {
        proc.lastError = proc.lastError || 'voice bridge did not report ready within 12s';
        finish(proc);
      }, 12_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        let sawPing = false;
        for (const line of chunk.toString().split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            const ping = JSON.parse(trimmed) as {
              ok?: boolean; service?: string; error?: string;
              wake_engine?: string; tts?: boolean; tts_error?: string;
              event?: string;
            };
            if (ping.service === 'voice-bridge' && !proc.ready) {
              proc.ready = ping.ok === true;
              proc.info = ping;
              // surface the bridge's own reason (e.g. "port already in use")
              if (!proc.ready) {
                proc.lastError = ping.error
                  ? `voice bridge failed to start: ${ping.error}`
                  : 'voice bridge failed to start';
              }
              sawPing = true;
            }
            // wake trigger lines are read via /wake/status polling
          } catch {
            /* partial line */
          }
        }
        // the readiness ping settles the wait — ready OR failed fast
        if (sawPing) finish(proc);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        proc.lastError = String(chunk).slice(0, 400);
      });
      child.on('error', (e) => {
        proc.lastError = e.message;
        finish(proc);
      });
      child.on('exit', (code, signal) => {
        proc.ready = false;
        if (!proc.lastError) {
          proc.lastError = signal
            ? `voice bridge stopped (signal ${signal})`
            : code
              ? `voice bridge exited with code ${code}`
              : '';
        }
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

/** Stop the voice bridge (tests / kill switch UI). */
export function stopVoiceBridge(): void {
  const proc = store().proc;
  if (proc?.child && !childDead(proc.child)) {
    try {
      proc.child.kill();
    } catch {
      /* ignore */
    }
  }
  store().proc = null;
}

export interface VoiceBridgeStatus {
  enabled: boolean;
  desired: 'running' | 'stopped';
  running: boolean;
  ready: boolean;
  port: number;
  pid: number | null;
  uptimeSec: number;
  lastError: string;
  wakeEngine: string;
  ttsAvailable: boolean;
  installHint: string;
}

export function voiceBridgeStatus(): VoiceBridgeStatus {
  const proc = store().proc;
  const alive = Boolean(proc?.child && !childDead(proc.child));
  return {
    enabled: voiceEnabled(),
    desired: voiceEnabled() ? 'running' : 'stopped',
    running: alive,
    ready: Boolean(alive && proc?.ready),
    port: voicePort(),
    pid: alive ? proc!.child.pid ?? null : null,
    uptimeSec: alive ? Math.floor((Date.now() - proc!.startedAt) / 1000) : 0,
    lastError: proc?.lastError ?? '',
    wakeEngine: proc?.info?.wake_engine ?? 'unknown',
    ttsAvailable: proc?.info?.tts === true,
    installHint: 'pip install -r python-bridge/requirements-voice.txt',
  };
}

// ---------- the call ----------

export interface VoiceCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  hint?: string;
  killed?: boolean;
  /** raw response bytes when the caller asked for raw (TTS audio) */
  buffer?: Buffer;
  contentType?: string;
}

/**
 * Call one voice-bridge endpoint. 127.0.0.1 only, token always attached,
 * kill switch checked BEFORE the request (the bridge re-checks itself).
 */
export async function voiceCall(
  endpoint: '/ping' | '/status' | '/tts' | '/wake',
  payload: Record<string, unknown> = {},
  opts: { raw?: boolean; timeoutMs?: number } = {}
): Promise<VoiceCallResult> {
  if (!voiceEnabled()) {
    return { ok: false, error: 'Voice bridge disabled (AGENTSCOPE_VOICE_BRIDGE=0)' };
  }
  const started = await ensureVoiceBridge();
  if (!started?.ready) {
    const st = voiceBridgeStatus();
    return {
      ok: false,
      error: st.lastError || 'Voice bridge is not ready',
      hint: st.lastError.includes('Python not found')
        ? 'Install Python 3 or set AGENTSCOPE_PYTHON in .env'
        : st.installHint,
    };
  }

  const url = `http://127.0.0.1:${voicePort()}${endpoint}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    const res = await fetch(url, {
      method: endpoint === '/ping' || endpoint === '/status' ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Desktop-Token': desktopToken(),
      },
      body: endpoint === '/ping' || endpoint === '/status' ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (opts.raw && res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, buffer: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
    }

    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean; data?: unknown; error?: string; killed?: boolean;
    };
    if (!res.ok) {
      if (res.status === 423 || body.killed) {
        return { ok: false, error: body.error || 'Kill switch engaged on the voice bridge', killed: true };
      }
      return { ok: false, error: body.error || `voice bridge returned HTTP ${res.status}` };
    }
    return { ok: body.ok !== false, data: body.data, error: body.ok === false ? body.error : undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'voice bridge call failed';
    return { ok: false, error: `Voice bridge unreachable: ${message}` };
  }
}

/**
 * TRUE when the server can synthesise speech right now (bridge up AND
 * edge-tts importable). Used by /api/voice/speak to decide the fallback.
 */
export async function ttsAvailable(): Promise<boolean> {
  const st = voiceBridgeStatus();
  if (st.ready && st.ttsAvailable) return true;
  const ping = await voiceCall('/status', {}, { timeoutMs: 5000 });
  if (ping.ok) return true; // bridge reachable — /tts may still fail per call
  return false;
}
