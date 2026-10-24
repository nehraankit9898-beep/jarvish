// git-tools.ts — real git snapshots for diff & rollback (Req #8)
//
// SECURITY: every git invocation runs through executeArgv() — the binary is
// spawned DIRECTLY with an argv list, never through a shell. Refs/labels come
// from user input (query params, request bodies, LLM prompts), so they must
// never be interpolated into a shell command string.

import fs from 'fs/promises';
import path from 'path';
import { executeArgv } from './terminal';
import { taskWorkspace } from './workspace';

export interface Snapshot {
  hash: string;
  label: string;
  at: string;
}

export class InvalidGitRefError extends Error {
  constructor(ref: string) {
    super(`Invalid git reference: ${ref}`);
  }
}

/**
 * A git ref we are willing to pass to git:
 * - must start with an alphanumeric (no leading `-`, so git can never read it
 *   as an option such as `--upload-pack=...` or `--exec-path=...`)
 * - only ref-safe characters (no spaces, quotes, `;|&$()<>` or backticks)
 */
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/~^@-]{0,200}$/;

export function isSafeGitRef(ref: string): boolean {
  if (typeof ref !== 'string') return false;
  const trimmed = ref.trim();
  if (!trimmed || trimmed.length > 201) return false;
  if (trimmed.startsWith('-')) return false;
  return GIT_REF_RE.test(trimmed);
}

function assertSafeGitRef(ref: string): string {
  const trimmed = String(ref ?? '').trim();
  if (!isSafeGitRef(trimmed)) throw new InvalidGitRefError(String(ref));
  return trimmed;
}

/**
 * M6: run one git command and THROW when it fails. Every call site used to
 * ignore `exitCode`, so a failed `git commit` still "succeeded" and
 * `snapshot()` happily returned the PREVIOUS head hash as a fresh snapshot
 * (rollback to a state that was never saved). `git diff` exits 0 normally —
 * a non-zero exit is always a real failure.
 */
async function runGit(
  taskId: string,
  args: string[],
  opts: { logical: string; timeoutMs: number; autoApproveDestructive?: boolean }
): Promise<{ output: string }> {
  const res = await executeArgv(taskId, 'git', args, opts);
  if (res.exitCode !== 0) {
    const detail = (res.output || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300);
    throw new Error(
      `git ${args[0]} failed (exit ${res.exitCode ?? 'null'})${detail ? `: ${detail}` : ''}`
    );
  }
  return res;
}

/** git init + initial baseline commit (idempotent). */
export async function ensureRepo(taskId: string, taskLabel = 'baseline'): Promise<void> {
  await runGit(taskId, ['init', '-q'], { logical: 'git init -q', timeoutMs: 30_000 });
  await runGit(taskId, ['config', 'user.email', 'agentic@studio.local'], {
    logical: 'git config user.email "agentic@studio.local"',
    timeoutMs: 10_000,
  });
  await runGit(taskId, ['config', 'user.name', 'Agentic Engine'], {
    logical: 'git config user.name "Agentic Engine"',
    timeoutMs: 10_000,
  });
  // Disable background auto-gc: a lingering `git gc` process keeps the
  // workspace directory busy on Windows and blocks workspace cleanup.
  await runGit(taskId, ['config', 'gc.auto', '0'], {
    logical: 'git config gc.auto 0',
    timeoutMs: 10_000,
  });
  // .gitignore heavy dirs (written directly — no shell redirect needed)
  const ws = taskWorkspace(taskId);
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(
    path.join(ws, '.gitignore'),
    'node_modules/\n__pycache__/\n.venv/\nvenv/\n.next/\ndist/\n',
    'utf-8'
  );
  await runGit(taskId, ['add', '-A'], { logical: 'git add -A', timeoutMs: 30_000 });
  const label = sanitizeLabel(taskLabel);
  await runGit(
    taskId,
    ['commit', '-q', '-m', `baseline: ${label}`, '--allow-empty', '--'],
    { logical: 'git commit -qm "baseline" --allow-empty', timeoutMs: 30_000 }
  );
}

/** Strip anything that could break a commit message; keep it human readable. */
function sanitizeLabel(label: string): string {
  return String(label ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/["\\$`]/g, '')
    .slice(0, 80);
}

/** Commit current state; returns the snapshot hash. */
export async function snapshot(taskId: string, label: string): Promise<Snapshot> {
  await runGit(taskId, ['add', '-A'], { logical: 'git add -A', timeoutMs: 30_000 });
  const clean = sanitizeLabel(label);
  await runGit(taskId, ['commit', '-q', '-m', clean, '--allow-empty', '--'], {
    logical: 'git commit -qm "snapshot" --allow-empty',
    timeoutMs: 30_000,
  });
  const rev = await runGit(taskId, ['rev-parse', '--short', 'HEAD'], {
    logical: 'git rev-parse --short HEAD',
    timeoutMs: 10_000,
  });
  return {
    hash: rev.output.trim() || 'HEAD',
    label: clean,
    at: new Date().toISOString(),
  };
}

/** Unified git diff between two refs (empty string = no changes). */
export async function diffBetween(
  taskId: string,
  from: string,
  to: string
): Promise<string> {
  const safeFrom = assertSafeGitRef(from);
  const safeTo = assertSafeGitRef(to);
  const res = await runGit(
    taskId,
    ['diff', safeFrom, safeTo, '--stat', '--unified=3'],
    { logical: `git diff ${safeFrom} ${safeTo} --stat --unified=3`, timeoutMs: 30_000 }
  );
  const full = await runGit(
    taskId,
    ['diff', safeFrom, safeTo, '--unified=3'],
    { logical: `git diff ${safeFrom} ${safeTo} --unified=3`, timeoutMs: 30_000 }
  );
  return `${res.output}\n${full.output}`.trim();
}

/** Changed file names between two refs. */
export async function changedFiles(
  taskId: string,
  from: string,
  to: string
): Promise<string[]> {
  const safeFrom = assertSafeGitRef(from);
  const safeTo = assertSafeGitRef(to);
  const res = await runGit(
    taskId,
    ['diff', '--name-only', safeFrom, safeTo],
    { logical: `git diff --name-only ${safeFrom} ${safeTo}`, timeoutMs: 30_000 }
  );
  return res.output
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Resolve the baseline (first) commit hash. */
export async function baselineRef(taskId: string): Promise<string> {
  const res = await runGit(taskId, ['rev-list', '--max-parents=0', 'HEAD'], {
    logical: 'git rev-list --max-parents=0 HEAD',
    timeoutMs: 15_000,
  });
  return res.output.trim().split('\n')[0] || 'HEAD';
}

/** Rollback the working tree to a snapshot (git reset --hard inside ISOLATED workspace only). */
export async function rollbackTo(taskId: string, ref: string): Promise<void> {
  const safeRef = assertSafeGitRef(ref);
  await runGit(taskId, ['reset', '--hard', safeRef], {
    logical: `git reset --hard ${safeRef}`,
    timeoutMs: 30_000,
    autoApproveDestructive: true, // user explicitly requested rollback in UI; workspace is isolated
  });
  await runGit(taskId, ['clean', '-fdq'], {
    logical: 'git clean -fdq',
    timeoutMs: 30_000,
    autoApproveDestructive: true,
  });
}
