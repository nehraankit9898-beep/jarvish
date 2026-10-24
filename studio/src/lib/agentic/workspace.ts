// workspace.ts — isolated per-task workspace under <projectRoot>/.agentic-workspace/<taskId>/
// Every file operation MUST go through resolveSafe() so nothing outside the
// workspace can be touched (path traversal protection).

import fs from 'fs/promises';
import path from 'path';

export const WORKSPACE_ROOT = path.join(process.cwd(), '.agentic-workspace');

/**
 * Task ids are used as a directory name, so they must be plain identifiers.
 * Without this check a caller could pass `../../..` and escape the sandbox
 * (taskId reaches the API layer as user input).
 */
const SAFE_TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeTaskId(taskId: string): boolean {
  return typeof taskId === 'string' && SAFE_TASK_ID_RE.test(taskId);
}

export function taskWorkspace(taskId: string): string {
  if (!isSafeTaskId(taskId)) {
    throw new Error(`Invalid task id: ${String(taskId)}`);
  }
  const ws = path.join(WORKSPACE_ROOT, taskId);
  // belt & braces: the resolved path must stay directly under the root
  const root = path.resolve(WORKSPACE_ROOT);
  const resolved = path.resolve(ws);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Invalid task id: ${String(taskId)}`);
  }
  return ws;
}

export async function createWorkspace(taskId: string): Promise<string> {
  const ws = taskWorkspace(taskId);
  await fs.mkdir(ws, { recursive: true });
  return ws;
}

/**
 * Remove a workspace directory.
 *
 * On Windows a just-exited child process (git — which may still run an
 * auto-gc in the background) can keep the directory handle busy for a moment,
 * so fs.rm fails with EBUSY. Retrying briefly avoids leaking the workspace
 * when a task is deleted.
 */
async function removeDir(ws: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.rm(ws, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function resetWorkspace(taskId: string): Promise<void> {
  const ws = taskWorkspace(taskId);
  await removeDir(ws);
  await fs.mkdir(ws, { recursive: true });
}

export async function removeWorkspace(taskId: string): Promise<void> {
  const ws = taskWorkspace(taskId);
  await removeDir(ws);
}

/**
 * Resolve the real path of the closest existing ancestor of `target`.
 * Used so a symlinked *directory* in the middle of the path cannot be used
 * to escape the workspace even when the final file does not exist yet.
 */
async function realpathOfNearestExisting(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Resolve a relative path inside the workspace and GUARANTEE it cannot
 * escape (no ../, no absolute paths, no symlinks pointing outside).
 */
export async function resolveSafe(
  taskId: string,
  relativePath: string
): Promise<string> {
  const ws = taskWorkspace(taskId);
  if (path.isAbsolute(String(relativePath ?? ''))) {
    throw new Error(`Absolute path not allowed inside workspace: ${relativePath}`);
  }
  const cleaned = String(relativePath ?? '').replace(/^[/\\]+/, '');
  if (!cleaned) {
    throw new Error('Empty path not allowed inside workspace');
  }
  // only a real ".." PATH SEGMENT is a traversal attempt — a name like
  // "a..b" is a perfectly legal file name
  const segments = cleaned.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new Error(`Path not allowed inside workspace: ${relativePath}`);
  }
  const abs = path.resolve(ws, cleaned);
  const wsResolved = path.resolve(ws);
  if (abs !== wsResolved && !abs.startsWith(wsResolved + path.sep)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  // symlink escape check — compare against the REAL workspace root (the
  // project path itself may sit behind a symlink/junction) and resolve the
  // closest existing ancestor so a symlinked parent dir cannot be used to
  // write outside the workspace.
  let wsReal: string | null = null;
  try {
    wsReal = await fs.realpath(ws);
  } catch {
    // workspace does not exist yet → nothing inside it can be a symlink
    wsReal = null;
  }
  if (wsReal) {
    const real = await realpathOfNearestExisting(abs);
    if (real !== wsReal && !real.startsWith(wsReal + path.sep)) {
      throw new Error(`Symlink escapes workspace: ${relativePath}`);
    }
  }
  return abs;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  isDir: boolean;
}

const IGNORED = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  'dist',
  'build',
]);

/** Recursively list workspace files (ignoring heavy dirs), relative paths. */
export async function listTree(
  taskId: string,
  maxDepth = 6
): Promise<WorkspaceFile[]> {
  const ws = taskWorkspace(taskId);
  const out: WorkspaceFile[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(ws, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        out.push({ path: rel, size: 0, isDir: true });
        await walk(abs, depth + 1);
      } else {
        try {
          const st = await fs.stat(abs);
          out.push({ path: rel, size: st.size, isDir: false });
        } catch {
          // raced delete — skip
        }
      }
    }
  }

  await walk(ws, 0);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Read a file from the workspace (safe path). */
export async function readWorkspaceFile(
  taskId: string,
  relPath: string
): Promise<string> {
  const abs = await resolveSafe(taskId, relPath);
  return fs.readFile(abs, 'utf-8');
}

/** Write a file inside the workspace (safe path), creating dirs as needed. */
export async function writeWorkspaceFile(
  taskId: string,
  relPath: string,
  content: string
): Promise<{ bytes: number; absPath: string }> {
  const ws = taskWorkspace(taskId);
  await fs.mkdir(ws, { recursive: true });
  const abs = await resolveSafe(taskId, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
  return { bytes: Buffer.byteLength(content, 'utf-8'), absPath: abs };
}

/** Delete a file inside the workspace (safe path). */
export async function deleteWorkspaceFile(
  taskId: string,
  relPath: string
): Promise<void> {
  const abs = await resolveSafe(taskId, relPath);
  await fs.rm(abs, { force: true });
}
