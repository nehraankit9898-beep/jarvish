// allowed-roots.ts — the laptop folders the agent may work in (Roadmap #2).
//
// host-control.ts can already read/write ANY non-sensitive path with the
// user's approval. The allowed roots are the CONVENIENCE layer on top:
// a small, explicit list of user folders (Desktop, Documents, Downloads by
// default) that
//
//   - the UI and the agent can list as a tree,
//   - 'trusted' mode treats as the default working area,
//   - deletes go to the RECYCLE BIN instead of being destroyed outright.
//
// Configuration: AGENTSCOPE_ALLOWED_ROOTS — folders separated by `;` on
// Windows and `:` elsewhere, `~` allowed. The list is intersected with the
// host-control blocklist: a root that resolves into a sensitive location
// (e.g. the Chrome profile) is dropped at read time, never silently used.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSensitivePath, isSystemPath } from './host-control';

export interface AllowedRoot {
  /** absolute resolved path */
  path: string;
  /** the name shown in the UI ("Downloads") */
  label: string;
}

const MAX_TREE_DEPTH = 6;
const MAX_TREE_ENTRIES = 2000;
const MAX_LIST_ENTRIES_PER_DIR = 500;

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** The configured roots, resolved and filtered. Never throws. */
export function allowedRoots(): AllowedRoot[] {
  const raw = process.env.AGENTSCOPE_ALLOWED_ROOTS;
  const parts = raw
    ? raw.split(path.delimiter)
    : ['~/Desktop', '~/Documents', '~/Downloads'];

  const seen = new Set<string>();
  const roots: AllowedRoot[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const abs = path.resolve(expandHome(trimmed));
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    // a root inside a protected location is refused, never weakened
    if (isSensitivePath(abs) || isSystemPath(abs)) continue;
    roots.push({ path: abs, label: path.basename(abs) || abs });
  }
  return roots;
}

/** Resolve ~ / relative paths and check the target sits inside a root. */
export function resolveInsideRoots(target: string): {
  ok: boolean;
  path: string;
  error?: string;
} {
  const abs = path.resolve(expandHome(String(target ?? '').trim()));
  const roots = allowedRoots();
  if (!roots.length) {
    return { ok: false, path: abs, error: 'No allowed roots configured (AGENTSCOPE_ALLOWED_ROOTS)' };
  }
  const norm = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const inside = roots.some((r) => {
    const rp = process.platform === 'win32' ? r.path.toLowerCase() : r.path;
    return norm === rp || norm.startsWith(rp.endsWith(path.sep) ? rp : rp + path.sep);
  });
  if (!inside) {
    return {
      ok: false,
      path: abs,
      error: `Outside the allowed roots (${roots.map((r) => r.label).join(', ')}). Use host tools with approval instead.`,
    };
  }
  if (isSensitivePath(abs)) {
    return { ok: false, path: abs, error: 'Credential / protected location' };
  }
  return { ok: true, path: abs };
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'other';
  size: number | null;
  depth: number;
}

/**
 * List a directory tree under an allowed root. Sensitive children are
 * HIDDEN (not even advertised) — the same rule host-list applies.
 */
export function listTreeUnderRoot(target: string, maxDepth = 3): {
  ok: boolean;
  root?: string;
  entries?: TreeEntry[];
  error?: string;
} {
  const resolved = resolveInsideRoots(target);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const depth = Math.min(Math.max(1, Math.floor(maxDepth || 3)), MAX_TREE_DEPTH);
  const entries: TreeEntry[] = [];

  const walk = (dir: string, level: number): void => {
    if (entries.length >= MAX_TREE_ENTRIES) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_LIST_ENTRIES_PER_DIR);
    } catch {
      return;
    }
    for (const e of dirents) {
      const full = path.join(dir, e.name);
      // protected children disappear from the listing entirely
      if (isSensitivePath(full)) continue;
      const type: TreeEntry['type'] = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other';
      let size: number | null = null;
      if (type === 'file') {
        try {
          size = fs.statSync(full).size;
        } catch {
          size = null;
        }
      }
      entries.push({ name: e.name, path: full, type, size, depth: level });
      // NB: a symlink reports as `other` here (Dirent of a link is not
      // `isDirectory()`), so a link planted inside a root is listed but never
      // walked into — the tree cannot be used to roam outside the root.
      if (type === 'dir' && level + 1 < depth) walk(full, level + 1);
      if (entries.length >= MAX_TREE_ENTRIES) return;
    }
  };

  walk(resolved.path, 0);
  return { ok: true, root: resolved.path, entries };
}

/** The user's real Downloads folder (used by the download tools/watcher). */
export function downloadsDir(): string {
  const configured = (process.env.AGENTSCOPE_DOWNLOADS_DIR ?? '').trim();
  if (configured) return path.resolve(expandHome(configured));
  return path.join(os.homedir(), 'Downloads');
}
