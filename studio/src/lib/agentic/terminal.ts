// terminal.ts — REAL command execution inside the isolated workspace
// Every command passes checkCommand(); destructive ones require prior
// explicit approval (approvedCommands set filled from the UI decision).

import { spawn } from 'child_process';
import { taskWorkspace } from './workspace';
import { checkCommand, type Permission } from './permissions';
import { protect } from './secrets';
import type { CommandRecord } from './types';

const MAX_OUTPUT = 12_000; // chars kept per command
const DEFAULT_TIMEOUT_MS = 120_000;

export class CommandDeniedError extends Error {
  permission: Permission;
  constructor(command: string, reason: string, permission: Permission) {
    super(
      `Command blocked (${permission}): ${command}\nReason: ${reason}`
    );
    this.permission = permission;
  }
}

export interface ExecResult extends CommandRecord {
  permission: Permission;
  reason: string;
}

/**
 * Canonical form of a command used for CLASSIFICATION and approval matching.
 * The executed command keeps its original whitespace (collapsing it would
 * corrupt quoted arguments); only the comparison key is normalized.
 */
export function normalizeCommand(rawCommand: string): string {
  return String(rawCommand ?? '').trim().replace(/\s+/g, ' ');
}

function shellCmd(command: string): string[] {
  // Use bash on Unix-like systems; fall back to cmd.exe on Windows.
  // The workspace is isolated so shell choice only affects the sandbox.
  if (process.platform === 'win32') {
    return ['cmd', '/c', command];
  }
  return ['bash', '-c', command];
}

/** Minimal, sanitized env for every spawned child process. */
function sanitizedEnv(cwd: string): NodeJS.ProcessEnv {
  return {
    // minimal, sanitized env — secrets from the host do NOT leak in
    PATH: process.env.PATH,
    HOME: cwd,
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    ...(process.env.NODE_ENV ? { NODE_ENV: process.env.NODE_ENV } : {}),
  } as NodeJS.ProcessEnv;
}

/**
 * Execute a command with cwd = workspace.
 * @param approvedCommands commands the user explicitly approved via UI
 */
export async function executeCommand(
  taskId: string,
  rawCommand: string,
  opts: {
    approvedCommands?: string[];
    timeoutMs?: number;
    autoApproveDestructive?: boolean; // ONLY used by explicit user action endpoints
  } = {}
): Promise<ExecResult> {
  // Execute the command EXACTLY as given (trimmed) — collapsing whitespace
  // would corrupt quoted arguments like echo "a   b".
  const command = String(rawCommand ?? '').trim();
  const key = normalizeCommand(command);
  // H7: CLASSIFY THE RAW COMMAND. `normalizeCommand` folds every newline into
  // a space, so classifying the normalized form hid the fact that
  // "echo hi\nrm -rf x" is TWO shell commands — the classifier (and the audit
  // record it feeds) reported the whole payload as the first, harmless line.
  // The normalized form is still the right key for APPROVAL MATCHING, where
  // whitespace differences between the LLM and the UI must not matter.
  const check = checkCommand(command);
  const approved = new Set((opts.approvedCommands ?? []).map(normalizeCommand));
  const approvedRaw = new Set((opts.approvedCommands ?? []).map((c) => String(c ?? '').trim()));

  if (check.permission === 'forbidden') {
    throw new CommandDeniedError(command, check.reason, 'forbidden');
  }
  // Defense in depth: any command that uses shell metacharacters (pipes,
  // redirects, command substitution, backgrounding) is executed through a real
  // shell, so a classifier bypass could lead to arbitrary command execution.
  // Require explicit approval for those even when classified safe/review.
  // (forbidden commands already threw above, so check.permission is safe here.)
  // C1: a NEWLINE is a command separator exactly like `;` — bash executes
  // every line of a multi-line payload, so it must escalate the same way.
  const HAS_SHELL_META = /[;|&$`()<>\n\r]/.test(command);
  const effectivePermission = HAS_SHELL_META ? 'destructive' : check.permission;
  if (effectivePermission === 'destructive' && !opts.autoApproveDestructive) {
    if (!approved.has(key) && !approvedRaw.has(command)) {
      throw new CommandDeniedError(
        command,
        (effectivePermission === 'destructive' && check.permission !== 'destructive'
          ? 'Shell metacharacters used — '
          : '') + check.reason + ' - user approval required',
        'destructive'
      );
    }
  }

  const started = Date.now();
  const cwd = taskWorkspace(taskId);
  const [shell, shellFlag] = shellCmd(command);

  const result = await spawnCapture(
    shell,
    [shellFlag, command],
    cwd,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  return buildExecResult(command, check, result, started);
}

/**
 * Execute a binary DIRECTLY (no shell) with an explicit argv list.
 *
 * Used for engine-internal binaries (git) where arguments come from user
 * input: without a shell there is no way to smuggle in `;`, `&&`, `$(...)`
 * or redirection, so no escaping/quoting is required.
 *
 * @param logical command string used for permission classification/logging
 */
export async function executeArgv(
  taskId: string,
  bin: string,
  args: string[],
  opts: {
    logical?: string;
    approvedCommands?: string[];
    timeoutMs?: number;
    autoApproveDestructive?: boolean;
  } = {}
): Promise<ExecResult> {
  const logical = normalizeCommand(opts.logical ?? [bin, ...args].join(' '));
  const check = checkCommand(logical);
  const approved = new Set((opts.approvedCommands ?? []).map(normalizeCommand));

  if (check.permission === 'forbidden') {
    throw new CommandDeniedError(logical, check.reason, 'forbidden');
  }
  if (check.permission === 'destructive' && !opts.autoApproveDestructive) {
    if (!approved.has(logical)) {
      throw new CommandDeniedError(
        logical,
        check.reason + ' - user approval required',
        'destructive'
      );
    }
  }

  const started = Date.now();
  const cwd = taskWorkspace(taskId);
  const result = await spawnCapture(
    bin,
    args,
    cwd,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  return buildExecResult(logical, check, result, started);
}

function spawnCapture(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { exitCode: number | null; output: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(bin, args, {
      cwd,
      env: sanitizedEnv(cwd),
      timeout: timeoutMs,
      detached: false,
      shell: false,
    });

    let output = '';
    const collect = (chunk: Buffer | string) => {
      if (output.length < MAX_OUTPUT * 2) output += String(chunk);
    };
    if (child.stdout) child.stdout.on('data', collect);
    if (child.stderr) child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ exitCode: -1, output: output + '\n[timeout]' });
    }, timeoutMs);

    child.on('error', (err) => {
      finish({ exitCode: -1, output: `\n[spawn error] ${err.message}` });
    });
    child.on('close', (code) => {
      finish({ exitCode: code, output });
    });
  });
}

function buildExecResult(
  command: string,
  check: { permission: Permission; reason: string },
  result: { exitCode: number | null; output: string },
  started: number
): ExecResult {
  const durationMs = Date.now() - started;
  let trimmed = result.output.slice(0, MAX_OUTPUT);
  if (result.output.length > MAX_OUTPUT) trimmed += `\n...[output truncated ${result.output.length} chars]`;
  const guarded = protect(trimmed);

  return {
    command,
    exitCode: result.exitCode,
    output: guarded.masked,
    durationMs,
    permission: check.permission,
    reason: check.reason,
    approval:
      check.permission === 'destructive'
        ? 'approved'
        : check.permission === 'safe'
          ? 'auto'
          : undefined,
    at: new Date().toISOString(),
  };
}

