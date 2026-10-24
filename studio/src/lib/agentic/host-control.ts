// host-control.ts — the agent's hands on the REAL laptop (outside the task sandbox).
//
// Everything else in the engine runs inside `.agentic-workspace/<taskId>/`.
// This module is the deliberate, separate door to the user's own machine:
// run commands, read/write/list/delete files anywhere, open apps and URLs.
//
// "Full control" here means full CAPABILITY, with the user holding the gate:
//
//   mode 'locked'  — nothing runs except `host.info`.
//   mode 'ask'     — (default) reads run automatically; every write, command,
//                    delete or app launch waits for the user's approval.
//   mode 'trusted' — like 'ask', but review-class actions that stay inside
//                    AGENTSCOPE_HOST_TRUSTED_DIRS run without a prompt.
//
// In EVERY mode:
//   - `forbidden` actions (rm -rf /, curl|sh, formatting disks, system dirs,
//     credential stores) never run, approval or not;
//   - `destructive` actions (delete, overwrite, risky commands) always need a
//     fresh approval — 'trusted' never skips it;
//   - an approval executes the EXACT action stored by the server. The caller
//     cannot swap the command/path after the fact (same rule as approvals.ts);
//   - secrets are masked in output and the child env has no API keys.
//
// The pending queue is in memory on purpose: an approval is a live decision
// by a person at the keyboard, and a restart must not leave authority behind.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCommand, type Permission } from './permissions';
import { normalizeCommand } from './terminal';
import { protect } from './secrets';
import { validateEmail, type MeetingInvite } from './email-connector';
import { assertNotKilled, desktopMode, isKilled } from './safety';
import { desktopCall, isReadOnlyEndpoint } from './desktop-bridge';
import { downloadsDir } from './allowed-roots';

// ---------- types ----------

export type HostMode = 'locked' | 'ask' | 'trusted';

export type HostAction =
  | { kind: 'info' }
  | { kind: 'list'; path: string }
  | { kind: 'read'; path: string; maxBytes?: number }
  | { kind: 'write'; path: string; content: string; append?: boolean }
  | { kind: 'delete'; path: string }
  | { kind: 'open'; target: string }
  | { kind: 'exec'; command: string; cwd?: string; timeoutMs?: number }
  | { kind: 'email'; to: string[]; subject: string; body: string; meeting?: MeetingInvite }
  // ---- laptop-control additions (Roadmap #2/#3/#7/#8) — all additive ----
  /** mouse / keyboard / screen via the Python desktop bridge */
  | { kind: 'desktop'; endpoint: string; payload: Record<string, unknown> }
  /** delete to the RECYCLE BIN via send2trash — never a permanent rm */
  | { kind: 'trash'; path: string }
  /** download a URL into the user's Downloads folder */
  | { kind: 'download'; url: string; filename?: string };

export interface HostClassification {
  permission: Permission;
  reason: string;
  /** every resolved path the action touches (for the trusted-dir check) */
  paths: string[];
  /** read-only desktop actions may auto-run in trusted mode (never in ask) */
  autoRunInTrusted?: boolean;
}

export type HostDecision = 'run' | 'approval' | 'refuse';

export interface HostResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  exitCode?: number | null;
  durationMs?: number;
}

export type HostOutcome =
  | { status: 'done'; permission: Permission; result: HostResult }
  | {
      status: 'approval_required';
      id: string;
      permission: Permission;
      reason: string;
      summary: string;
      expiresAt: string;
    }
  | { status: 'refused'; permission: Permission; reason: string };

export interface PendingHostAction {
  id: string;
  action: HostAction;
  actor: string;
  permission: Permission;
  reason: string;
  summary: string;
  createdAt: string;
  expiresAt: string;
  /** set by the screen-task loop — lets task cancellation drop its approvals */
  taskId?: string;
}

// ---------- configuration ----------

const MAX_OUTPUT = 12_000;
const MAX_READ_BYTES_DEFAULT = 200_000;
const MAX_READ_BYTES_HARD = 2_000_000;
const MAX_WRITE_BYTES = 2_000_000;
const MAX_LIST_ENTRIES = 500;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_PENDING = 50;

export function hostMode(): HostMode {
  const raw = (process.env.AGENTSCOPE_HOST_MODE ?? 'ask').trim().toLowerCase();
  return raw === 'locked' || raw === 'trusted' ? raw : 'ask';
}

export function trustedDirs(): string[] {
  const raw = process.env.AGENTSCOPE_HOST_TRUSTED_DIRS ?? '';
  return raw
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => canonical(expandHome(p)));
}

// ---------- path guards ----------

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Absolute, symlink-resolved (as far as the path exists) and case-folded on Windows. */
function canonical(p: string): string {
  let abs = path.resolve(expandHome(p));
  // resolve symlinks of the deepest existing ancestor, so a link cannot
  // smuggle a write out of a trusted dir or into a system dir
  let tail = '';
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail = path.join(path.basename(probe), tail);
    probe = parent;
  }
  try {
    probe = fs.realpathSync.native(probe);
  } catch {
    /* keep the unresolved path */
  }
  abs = tail ? path.join(probe, tail) : probe;
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** Locations an agent must never READ or WRITE: credential stores & key material. */
const SENSITIVE_PATHS: RegExp[] = [
  /[\\/]\.ssh([\\/]|$)/i,
  /[\\/]\.gnupg([\\/]|$)/i,
  /[\\/]\.aws([\\/]|$)/i,
  /[\\/]\.azure([\\/]|$)/i,
  /[\\/]\.kube([\\/]|$)/i,
  /[\\/]\.config[\\/]gcloud([\\/]|$)/i,
  /[\\/]\.docker[\\/]config\.json$/i,
  /[\\/]\.netrc$/i,
  /[\\/]\.git-credentials$/i,
  /[\\/]\.npmrc$/i,
  /[\\/]\.pypirc$/i,
  /[\\/]\.env(\.[\w.-]+)?$/i,
  /[\\/]id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|kdbx|keystore)$/i,
  /[\\/]\.agentscope-secret$/i,
  // browsers: saved passwords, cookies, session tokens
  /[\\/]Google[\\/]Chrome[\\/]User Data([\\/]|$)/i,
  /[\\/]Microsoft[\\/]Edge[\\/]User Data([\\/]|$)/i,
  /[\\/]BraveSoftware([\\/]|$)/i,
  /[\\/]Mozilla[\\/]Firefox[\\/]Profiles([\\/]|$)/i,
  /[\\/]Login Data$/i,
  /[\\/]Cookies$/i,
  // windows credential material
  /[\\/]Windows[\\/]System32[\\/]config([\\/]|$)/i,
  /[\\/]Microsoft[\\/]Credentials([\\/]|$)/i,
  /[\\/]Microsoft[\\/]Protect([\\/]|$)/i,
  /[\\/]etc[\\/](shadow|gshadow|sudoers)/i,
  // crypto wallets
  /[\\/](Exodus|Electrum|MetaMask|Bitcoin)[\\/]/i,
  /wallet\.dat$/i,
];

/** System locations that may be READ but never WRITTEN or DELETED. */
const SYSTEM_WRITE_PATHS: RegExp[] = [
  /^\/(etc|usr|bin|sbin|boot|dev|proc|sys|root|lib|lib64|opt|var\/lib)(\/|$)/i,
  /^[a-z]:[\\/](windows|program files|program files \(x86\)|programdata)([\\/]|$)/i,
  /^[a-z]:[\\/]$/i,
  /^\/$/,
];

export function isSensitivePath(p: string): boolean {
  const c = canonical(p);
  return SENSITIVE_PATHS.some((re) => re.test(c)) || SENSITIVE_PATHS.some((re) => re.test(p));
}

export function isSystemPath(p: string): boolean {
  const c = canonical(p);
  return SYSTEM_WRITE_PATHS.some((re) => re.test(c));
}

export function isInsideTrusted(p: string, dirs: string[] = trustedDirs()): boolean {
  const c = canonical(p);
  return dirs.some((d) => c === d || c.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
}

// ---------- classification ----------

const URL_RE = /^https?:\/\/[^\s]+$/i;
// open/start/xdg-open are fine; opening an executable or script is not "open a document"
const RUNNABLE_EXT = /\.(exe|msi|bat|cmd|ps1|vbs|js|jse|wsf|scr|com|sh|command|app|jar|lnk|reg|dll)$/i;

/** Classify an action WITHOUT running it. */
export function classifyHostAction(action: HostAction): HostClassification {
  switch (action.kind) {
    case 'info':
      return { permission: 'safe', reason: 'system information', paths: [] };

    case 'list':
    case 'read': {
      const target = canonical(action.path);
      if (isSensitivePath(action.path)) {
        return { permission: 'forbidden', reason: 'credential / key / browser-profile location', paths: [target] };
      }
      return { permission: 'safe', reason: `${action.kind} a path`, paths: [target] };
    }

    case 'write': {
      const target = canonical(action.path);
      if (isSensitivePath(action.path)) {
        return { permission: 'forbidden', reason: 'credential / key / browser-profile location', paths: [target] };
      }
      if (isSystemPath(action.path)) {
        return { permission: 'forbidden', reason: 'system directory', paths: [target] };
      }
      if (Buffer.byteLength(action.content ?? '', 'utf8') > MAX_WRITE_BYTES) {
        return { permission: 'forbidden', reason: 'content larger than 2 MB', paths: [target] };
      }
      // replacing an existing file destroys its old content
      if (!action.append && fs.existsSync(action.path)) {
        return { permission: 'destructive', reason: 'overwrites an existing file', paths: [target] };
      }
      return { permission: 'review', reason: action.append ? 'append to a file' : 'create a new file', paths: [target] };
    }

    case 'delete': {
      const target = canonical(action.path);
      if (isSensitivePath(action.path) || isSystemPath(action.path)) {
        return { permission: 'forbidden', reason: 'protected location', paths: [target] };
      }
      return { permission: 'destructive', reason: 'deletes data', paths: [target] };
    }

    case 'open': {
      const t = String(action.target ?? '').trim();
      if (URL_RE.test(t)) {
        return { permission: 'review', reason: 'open a web page in the default browser', paths: [] };
      }
      if (!t || /[\r\n\0]/.test(t)) {
        return { permission: 'forbidden', reason: 'invalid target', paths: [] };
      }
      const target = canonical(t);
      if (isSensitivePath(t)) {
        return { permission: 'forbidden', reason: 'credential / key / browser-profile location', paths: [target] };
      }
      if (RUNNABLE_EXT.test(t)) {
        // launching a program is code execution, not "open a document"
        return { permission: 'destructive', reason: 'launches a program or script', paths: [target] };
      }
      return { permission: 'review', reason: 'open a file with its default app', paths: [target] };
    }

    case 'email': {
      const invalid = validateEmail(action);
      if (invalid) return { permission: 'forbidden', reason: invalid, paths: [] };
      // sending is irreversible and speaks in the user's name: always their call
      return { permission: 'destructive', reason: `sends an e-mail to ${action.to.length} recipient(s)`, paths: [] };
    }

    case 'exec': {
      const command = normalizeCommand(String(action.command ?? ''));
      if (!command) return { permission: 'forbidden', reason: 'empty command', paths: [] };
      const cwd = canonical(action.cwd ?? os.homedir());
      if (action.cwd && isSensitivePath(action.cwd)) {
        return { permission: 'forbidden', reason: 'working directory is a protected location', paths: [cwd] };
      }
      const check = checkCommand(command);
      if (check.permission === 'forbidden') {
        return { permission: 'forbidden', reason: check.reason, paths: [cwd] };
      }
      // a command on the real machine is never "safe": at best it is review-class,
      // and shell metacharacters (pipes, redirects, substitution) escalate it.
      // C1: a NEWLINE is a command separator like `;` — a multi-line payload
      // executes every line, so it escalates the same way.
      const meta = /[;|&$`()<>\n\r]/.test(command);
      if (check.permission === 'destructive' || meta) {
        return {
          permission: 'destructive',
          reason: (meta && check.permission !== 'destructive' ? 'shell metacharacters — ' : '') + check.reason,
          paths: [cwd],
        };
      }
      return { permission: 'review', reason: check.reason, paths: [cwd] };
    }

    // ---- laptop-control additions ----

    case 'desktop': {
      const endpoint = String(action.endpoint ?? '');
      // the endpoint list is validated AGAIN inside desktopCall — here only
      // the read-only set is allowed to skip the approval in trusted mode
      const readOnly = isReadOnlyEndpoint(endpoint);
      if (readOnly) {
        return {
          permission: 'review',
          reason: `desktop read: ${endpoint}`,
          paths: [],
          autoRunInTrusted: true,
        };
      }
      // every click / keystroke / scroll is a physical-world mutation:
      // ALWAYS the user's call, in every mode (Roadmap safety rule)
      return { permission: 'destructive', reason: `desktop action: ${endpoint}`, paths: [] };
    }

    case 'trash': {
      const target = canonical(action.path);
      if (isSensitivePath(action.path) || isSystemPath(action.path)) {
        return { permission: 'forbidden', reason: 'protected location', paths: [target] };
      }
      // recoverable (Recycle Bin) but still a delete: approval stays mandatory
      return { permission: 'destructive', reason: 'moves a file to the Recycle Bin', paths: [target] };
    }

    case 'download': {
      const url = String(action.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        return { permission: 'forbidden', reason: 'only http(s) downloads are allowed', paths: [] };
      }
      // a malformed URL ("http://", "http://[") must be REFUSED, not crash
      // the classifier with an unhandled Invalid URL exception
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        return { permission: 'forbidden', reason: 'malformed download URL', paths: [] };
      }
      // the destination (Downloads folder) counts as a touched path, so
      // trusted-mode users who trust Downloads get auto-runs
      const dest = downloadsDir();
      return {
        permission: 'review',
        reason: `downloads a file from ${host} into ${dest}`,
        paths: [dest],
      };
    }
  }
}

/** What happens to a classified action under the current mode. */
export function decideHostAction(
  cls: HostClassification,
  mode: HostMode = hostMode(),
  dirs: string[] = trustedDirs()
): HostDecision {
  if (cls.permission === 'forbidden') return 'refuse';
  if (mode === 'locked') return cls.reason === 'system information' ? 'run' : 'refuse';
  if (cls.permission === 'safe') return 'run';
  if (cls.permission === 'destructive') return 'approval';
  // review-class
  if (mode === 'trusted' && cls.autoRunInTrusted) return 'run';
  if (mode === 'trusted' && cls.paths.length > 0 && cls.paths.every((p) => isInsideTrusted(p, dirs))) {
    return 'run';
  }
  return 'approval';
}

export function summarizeHostAction(a: HostAction): string {
  switch (a.kind) {
    case 'info':
      return 'Read system information';
    case 'list':
      return `List folder ${a.path}`;
    case 'read':
      return `Read file ${a.path}`;
    case 'write':
      return `${a.append ? 'Append to' : 'Write'} file ${a.path} (${Buffer.byteLength(a.content ?? '', 'utf8')} bytes)`;
    case 'delete':
      return `Delete ${a.path}`;
    case 'open':
      return `Open ${a.target}`;
    case 'exec':
      return `Run: ${a.command}${a.cwd ? `  (in ${a.cwd})` : ''}`;
    case 'email':
      return `E-mail "${a.subject}" to ${a.to.join(', ')}${a.meeting ? ` with meeting invite "${a.meeting.title}" (${a.meeting.start})` : ''}`;
    case 'desktop':
      return `Desktop ${a.endpoint}${a.payload && Object.keys(a.payload).length ? ` ${safeDesktopSummary(a)}` : ''}`;
    case 'trash':
      return `Recycle-bin delete ${a.path}`;
    case 'download':
      return `Download ${a.url}${a.filename ? ` as ${a.filename}` : ''}`;
  }
}

/** A SHORT, secret-free payload echo for approval cards. */
function safeDesktopSummary(a: Extract<HostAction, { kind: 'desktop' }>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(a.payload ?? {}).slice(0, 4)) {
    const s = String(v ?? '');
    parts.push(`${k}=${/text|password|content/i.test(k) ? `${s.slice(0, 40)}${s.length > 40 ? '…' : ''}` : s.slice(0, 60)}`);
  }
  return parts.join(' ').trim();
}

// ---------- execution ----------

/** The child never inherits the studio's own credentials. */
function hostEnv(): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL)/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function mask(text: string): string {
  return protect(text).masked;
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + `\n…[truncated ${text.length - MAX_OUTPUT} chars]` : text;
}

function shellFor(command: string): [string, string[]] {
  if (process.platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]];
  }
  return ['/bin/bash', ['-c', command]];
}

function runProcess(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (r: { exitCode: number | null; output: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(bin, args, { cwd, env: hostEnv(), shell: false, windowsHide: true });
    } catch (e) {
      resolve({ exitCode: -1, output: `spawn failed: ${(e as Error).message}` });
      return;
    }
    const collect = (c: Buffer | string) => {
      if (output.length < MAX_OUTPUT * 2) output += String(c);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ exitCode: -1, output: output + '\n[timeout]' });
    }, timeoutMs);
    // a missing binary must resolve, never crash the server (audit defect D9)
    child.on('error', (e) => finish({ exitCode: -1, output: output + `\n[error] ${e.message}` }));
    child.on('close', (code) => finish({ exitCode: code, output }));
  });
}

/** Run an ALREADY-AUTHORISED action. Never call this without going through requestHostAction. */
async function execute(action: HostAction): Promise<HostResult> {
  const started = Date.now();
  const done = (r: HostResult): HostResult => ({ ...r, durationMs: Date.now() - started });
  try {
    switch (action.kind) {
      case 'info':
        return done({
          ok: true,
          data: {
            platform: process.platform,
            arch: process.arch,
            hostname: os.hostname(),
            user: os.userInfo().username,
            home: os.homedir(),
            cpus: os.cpus().length,
            totalMemMB: Math.round(os.totalmem() / 1048576),
            freeMemMB: Math.round(os.freemem() / 1048576),
            uptimeMin: Math.round(os.uptime() / 60),
            mode: hostMode(),
            trustedDirs: trustedDirs(),
          },
        });

      case 'list': {
        const dir = path.resolve(expandHome(action.path));
        const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_LIST_ENTRIES);
        return done({
          ok: true,
          data: entries
            // a sensitive child must not even be advertised
            .filter((e) => !isSensitivePath(path.join(dir, e.name)))
            .map((e) => {
              let size: number | null = null;
              try {
                if (e.isFile()) size = fs.statSync(path.join(dir, e.name)).size;
              } catch {
                /* unreadable */
              }
              return { name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size };
            }),
        });
      }

      case 'read': {
        const file = path.resolve(expandHome(action.path));
        const limit = Math.min(Math.max(action.maxBytes ?? MAX_READ_BYTES_DEFAULT, 1), MAX_READ_BYTES_HARD);
        const stat = fs.statSync(file);
        if (!stat.isFile()) return done({ ok: false, error: 'not a regular file' });
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(Math.min(stat.size, limit));
          fs.readSync(fd, buf, 0, buf.length, 0);
          if (buf.includes(0)) return done({ ok: false, error: 'binary file — refusing to return raw bytes' });
          return done({
            ok: true,
            data: { path: file, size: stat.size, truncated: stat.size > limit, content: mask(buf.toString('utf8')) },
          });
        } finally {
          fs.closeSync(fd);
        }
      }

      case 'write': {
        const file = path.resolve(expandHome(action.path));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (action.append) fs.appendFileSync(file, action.content, 'utf8');
        else fs.writeFileSync(file, action.content, 'utf8');
        return done({ ok: true, data: { path: file, bytes: Buffer.byteLength(action.content, 'utf8') } });
      }

      case 'delete': {
        const target = path.resolve(expandHome(action.path));
        fs.rmSync(target, { recursive: true, force: false });
        return done({ ok: true, data: { deleted: target } });
      }

      case 'open': {
        const t = action.target.trim();
        const cwd = os.homedir();
        let r: { exitCode: number | null; output: string };
        if (process.platform === 'win32') {
          // argv form: no shell parses the target
          r = await runProcess('rundll32.exe', ['url.dll,FileProtocolHandler', URL_RE.test(t) ? t : path.resolve(expandHome(t))], cwd, 15_000);
        } else if (process.platform === 'darwin') {
          r = await runProcess('open', [URL_RE.test(t) ? t : path.resolve(expandHome(t))], cwd, 15_000);
        } else {
          r = await runProcess('xdg-open', [URL_RE.test(t) ? t : path.resolve(expandHome(t))], cwd, 15_000);
        }
        return done({ ok: r.exitCode === 0, data: { target: t }, exitCode: r.exitCode, error: r.exitCode === 0 ? undefined : clip(mask(r.output)) });
      }

      case 'email': {
        const { sendEmail } = await import('./email-connector');
        const r = await sendEmail(action);
        return done({ ok: r.ok, error: r.error ? mask(r.error) : undefined, data: { messageId: r.messageId, accepted: r.accepted, rejected: r.rejected, response: r.response } });
      }

      case 'exec': {
        const cwd = path.resolve(expandHome(action.cwd ?? os.homedir()));
        const timeout = Math.min(Math.max(action.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
        const [bin, args] = shellFor(action.command);
        const r = await runProcess(bin, args, cwd, timeout);
        return done({ ok: r.exitCode === 0, exitCode: r.exitCode, data: { output: clip(mask(r.output)), cwd } });
      }

      // ---- laptop-control additions ----

      case 'desktop': {
        if (desktopMode() === 'locked') {
          return done({ ok: false, error: 'desktop tools are locked (AGENTSCOPE_DESKTOP_MODE=locked)' });
        }
        const call = await desktopCall(action.endpoint, action.payload);
        return done({
          ok: call.ok,
          error: call.hint ? `${call.error} (hint: ${call.hint})` : call.error,
          data: call.imageBase64
            ? { imageBase64: call.imageBase64, ...(typeof call.data === 'object' ? (call.data as object) : {}) }
            : call.data,
        });
      }

      case 'trash': {
        const call = await desktopCall('recycle_delete', { path: path.resolve(expandHome(action.path)) });
        return done({ ok: call.ok, error: call.hint ? `${call.error} (hint: ${call.hint})` : call.error, data: call.data });
      }

      case 'download': {
        const { downloadToDownloads, DownloadError } = await import('./downloads');
        try {
          const r = await downloadToDownloads(action.url, { filename: action.filename, actor: 'host' });
          return done({ ok: true, data: r });
        } catch (err) {
          if (err instanceof DownloadError) return done({ ok: false, error: err.message });
          return done({ ok: false, error: mask((err as Error).message) });
        }
      }
    }
  } catch (e) {
    return done({ ok: false, error: mask((e as Error).message) });
  }
}

// ---------- approval queue ----------

type Store = Map<string, PendingHostAction>;

// Jarvis #2: the vision loop blocks on ONE action at a time — this map lets
// resolveHostApproval wake the waiting screen-task loop.
type ApprovalWaiter = (approved: boolean) => void;

function approvalWaiters(): Map<string, ApprovalWaiter> {
  const g = globalThis as unknown as { __agentscopeApprovalWaiters?: Map<string, ApprovalWaiter> };
  return (g.__agentscopeApprovalWaiters ??= new Map());
}

/**
 * Block until the user answers a pending host approval (or it expires /
 * times out). Returns 'approved' | 'denied' | 'gone' (not found = expired or
 * already resolved) | 'timeout'. The screen-task loop uses this to pause
 * between screenshot steps while the user decides.
 */
export function waitForHostApproval(
  id: string,
  timeoutMs = 10 * 60_000
): Promise<'approved' | 'denied' | 'gone' | 'timeout'> {
  // already resolved / swept?
  if (!store().has(id)) return Promise.resolve('gone');
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: 'approved' | 'denied' | 'gone' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      approvalWaiters().delete(id);
      resolve(result);
    };
    const timer = setTimeout(() => done('timeout'), Math.max(1000, timeoutMs));
    approvalWaiters().set(id, (approved) => done(approved ? 'approved' : 'denied'));
  });
}

function store(): Store {
  const g = globalThis as unknown as { __hostPending?: Store };
  return (g.__hostPending ??= new Map());
}

function sweep(now = Date.now()): void {
  for (const [id, p] of store()) if (Date.parse(p.expiresAt) <= now) store().delete(id);
}

export function listPendingHostActions(): PendingHostAction[] {
  sweep();
  return [...store().values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Test hook. */
export function clearPendingHostActions(): void {
  store().clear();
}

/**
 * CANCEL INTEGRATION — a cancelled task must not leave authority behind:
 * every still-pending approval queued by `taskId` is dropped, and any loop
 * blocked on `waitForHostApproval` wakes immediately (as 'denied'). Without
 * this, a cancelled screen task could stay blocked for its full 10-minute
 * approval window — and a late approve click would EXECUTE a host action for
 * a task the user already cancelled.
 */
export async function cancelHostApprovalsForTask(taskId: string): Promise<number> {
  sweep();
  let dropped = 0;
  for (const [id, p] of store()) {
    if (p.taskId !== taskId) continue;
    store().delete(id);
    dropped++;
    const waiter = approvalWaiters().get(id);
    if (waiter) {
      approvalWaiters().delete(id);
      try {
        waiter(false); // wake the loop; finishScreenTask will see 'cancelled'
      } catch {
        /* waiter gone */
      }
    }
    await audit({
      actor: 'system',
      action: `host.${p.action.kind}`,
      approval: 'denied',
      ok: false,
      error: 'task cancelled while approval pending',
      details: { summary: p.summary, id, taskId },
    });
  }
  return dropped;
}

async function audit(
  entry: { actor: string; action: string; approval: 'auto' | 'approved' | 'denied' | 'n/a'; ok: boolean; details: Record<string, unknown>; error?: string }
): Promise<void> {
  try {
    const { recordAudit } = await import('./audit');
    await recordAudit({
      actor: entry.actor,
      action: entry.action,
      category: 'security',
      approval: entry.approval,
      result: entry.ok ? 'ok' : 'error',
      error: entry.error,
      details: entry.details,
    });
  } catch {
    /* auditing must never break the action */
  }
}

/**
 * The single entry point. Classifies the action, then runs it, queues it for
 * approval, or refuses it — according to the current mode.
 */
export async function requestHostAction(
  action: HostAction,
  actor = 'agent',
  taskId?: string
): Promise<HostOutcome> {
  // KILL SWITCH (Roadmap #1): when engaged NOTHING runs except `host.info`,
  // no matter what mode says. The flag file also survives restarts.
  if (isKilled() && action.kind !== 'info') {
    await audit({
      actor,
      action: `host.${action.kind}`,
      approval: 'denied',
      ok: false,
      error: 'kill switch engaged',
      details: { summary: summarizeHostAction(action), killSwitch: true },
    });
    return { status: 'refused', permission: 'forbidden', reason: 'KILL SWITCH engaged — every laptop action is stopped' };
  }

  // the desktop gate is checked BEFORE classification so a locked bridge is
  // never even queued for approval
  if (action.kind === 'desktop' && desktopMode() === 'locked') {
    await audit({ actor, action: 'host.desktop', approval: 'denied', ok: false, error: 'desktop mode locked', details: { endpoint: action.endpoint } });
    return {
      status: 'refused',
      permission: 'forbidden',
      reason: 'Desktop tools are locked (AGENTSCOPE_DESKTOP_MODE=locked)',
    };
  }

  if (action.kind !== 'info') {
    try {
      assertNotKilled();
    } catch {
      // raced between isKilled() and here — refuse anyway
      return { status: 'refused', permission: 'forbidden', reason: 'KILL SWITCH engaged' };
    }
  }

  const cls = classifyHostAction(action);
  // desktop actions follow the DESKTOP gate (locked/ask/trusted), everything
  // else follows the host gate — the two are independent by design
  const decision = decideHostAction(cls, action.kind === 'desktop' ? desktopMode() : hostMode());
  const summary = summarizeHostAction(action);

  if (decision === 'refuse') {
    const reason = hostMode() === 'locked' && cls.permission !== 'forbidden' ? 'host control is locked' : cls.reason;
    await audit({ actor, action: `host.${action.kind}`, approval: 'denied', ok: false, error: reason, details: { summary, permission: cls.permission } });
    return { status: 'refused', permission: cls.permission, reason };
  }

  if (decision === 'run') {
    const result = await execute(action);
    await audit({ actor, action: `host.${action.kind}`, approval: 'auto', ok: result.ok, error: result.error, details: { summary, permission: cls.permission } });
    return { status: 'done', permission: cls.permission, result };
  }

  sweep();
  if (store().size >= MAX_PENDING) {
    return { status: 'refused', permission: cls.permission, reason: 'too many pending approvals — resolve some first' };
  }
  const now = Date.now();
  const pending: PendingHostAction = {
    id: randomUUID(),
    // a frozen deep copy: later mutation by the caller must not change what gets approved
    action: JSON.parse(JSON.stringify(action)) as HostAction,
    actor,
    permission: cls.permission,
    reason: cls.reason,
    summary,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    taskId,
  };
  store().set(pending.id, pending);
  await audit({ actor, action: `host.${action.kind}`, approval: 'n/a', ok: true, details: { summary, permission: cls.permission, state: 'awaiting approval', id: pending.id } });
  return {
    status: 'approval_required',
    id: pending.id,
    permission: cls.permission,
    reason: cls.reason,
    summary,
    expiresAt: pending.expiresAt,
  };
}

/**
 * The USER's decision. Executes the stored action verbatim on approve.
 * Only the approval route may call this — it is not exposed as an agent tool.
 */
export async function resolveHostApproval(
  id: string,
  approve: boolean,
  actor = 'user'
): Promise<{ ok: boolean; error?: string; result?: HostResult }> {
  sweep();
  const pending = store().get(id);
  if (!pending) return { ok: false, error: 'approval not found or expired' };
  store().delete(id); // single use

  // Jarvis #2 (screen task): a waiter may be blocking on this decision —
  // signal it BEFORE executing so the loop resumes in parallel
  const waiter = approvalWaiters().get(id);
  if (waiter) {
    approvalWaiters().delete(id);
    try {
      waiter(approve);
    } catch {
      /* waiter gone */
    }
  }

  if (!approve) {
    await audit({ actor, action: `host.${pending.action.kind}`, approval: 'denied', ok: false, details: { summary: pending.summary, id } });
    return { ok: true };
  }

  // the kill switch may have been engaged AFTER this approval was queued —
  // an approve click must never resurrect an action the user killed meanwhile
  if (isKilled() && pending.action.kind !== 'info') {
    await audit({ actor, action: `host.${pending.action.kind}`, approval: 'denied', ok: false, error: 'kill switch engaged at approve time', details: { summary: pending.summary, id } });
    return { ok: false, error: 'KILL SWITCH is engaged — approve refused' };
  }

  // re-classify at execution time: the filesystem may have changed since the
  // request (a path may have become a symlink to a protected location)
  const cls = classifyHostAction(pending.action);
  if (cls.permission === 'forbidden') {
    await audit({ actor, action: `host.${pending.action.kind}`, approval: 'denied', ok: false, error: cls.reason, details: { summary: pending.summary, id } });
    return { ok: false, error: `blocked at execution time: ${cls.reason}` };
  }
  const result = await execute(pending.action);
  await audit({ actor, action: `host.${pending.action.kind}`, approval: 'approved', ok: result.ok, error: result.error, details: { summary: pending.summary, id } });
  return { ok: true, result };
}
