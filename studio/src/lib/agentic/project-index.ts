// project-index.ts — a searchable index of a PROJECT DIRECTORY.
//
// WHY THIS EXISTS
//   The agent has to answer questions about the code it is working on. The
//   knowledge module indexes documents that are imported one by one; this
//   module indexes a whole project directory at once and keeps the index in
//   sync with the files on disk.
//
// WHAT IT GUARANTEES
//   * every indexed file is INSIDE the project root (no symlink escape),
//   * secret-looking files are NEVER indexed (.env, *.pem, id_rsa, …),
//   * secret-looking CONTENT is redacted before it is stored,
//   * the index can be rebuilt, refreshed and reset,
//   * a file that changed on disk is detected as STALE and can be refreshed.
//
// The index is stored in the same KnowledgeDoc/KnowledgeChunk tables as the
// imported documents, with `source = 'project'` and `sourceRoot = <root>`, so
// the existing lexical retriever works on it without a second code path.

import fs from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';
import { chunkText, searchKnowledge, type KnowledgeHit } from './knowledge';
import { protect } from './secrets';

export interface ProjectIndexStats {
  root: string;
  files: number;
  chunks: number;
  symbols: number;
  skipped: number;
  unsupported: number;
  bytes: number;
  /** true when the run stopped early because of a size limit */
  truncated: boolean;
  durationMs: number;
}

export interface StaleFile {
  path: string;
  name: string;
  reason: 'modified' | 'deleted' | 'size-changed';
  indexedAt: string;
  expectedMtime: number;
  actualMtime: number | null;
}

export interface ProjectIndexStatus {
  root: string;
  documents: number;
  chunks: number;
  symbols: number;
  bytes: number;
  lastIndexedAt: string | null;
  stale: StaleFile[];
  exists: boolean;
}

export interface ProjectSymbol {
  name: string;
  kind: 'function' | 'class' | 'type' | 'interface' | 'const' | 'method' | 'component';
  line: number;
  path: string;
  file: string;
}

export class ProjectIndexError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'ProjectIndexError';
    this.field = field;
  }
}

/** Directories that are never indexed (huge, generated or private). */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.agentic-workspace',
  '.vscode',
  '.idea',
  'target',
  'vendor',
  '.gradle',
  '.mypy_cache',
  '.pytest_cache',
  '.roo',
  'db',
]);

/**
 * Files that must NEVER be indexed — they usually hold credentials.
 * The pattern is matched against the file name (lowercase) and the path.
 */
const SECRET_FILE_RE =
  /(^|[\\/])(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials(\.json)?|secrets?(\.(ya?ml|json|toml))?|.*\.keystore|\.npmrc|\.pypirc|netrc)$/i;

/** Text files that are worth indexing. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.json', '.jsonc', '.jsonl', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.csv', '.tsv', '.xml', '.html', '.htm', '.css', '.scss',
  '.less', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py', '.rb',
  '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs',
  '.swift', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.graphql',
  '.gql', '.vue', '.svelte', '.tf', '.proto', '.dockerfile', '.makefile',
]);

/** Files that are never indexed even though they look like text. */
const IGNORED_FILES = new Set([
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
]);

const MAX_FILE_BYTES = 512_000;
const MAX_FILES = 5_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/**
 * The file limits above bound the INPUT, but not the OUTPUT: a handful of
 * large files can still produce hundreds of thousands of chunks (a 512 KB
 * file → ~320 chunks), which fills the database without warning. This cap
 * bounds the stored chunks; when it is reached the indexing stops and the
 * result reports `truncated: true` instead of silently indexing everything.
 */
const MAX_TOTAL_CHUNKS = 40_000;

/**
 * Normalize and validate a project root.
 *
 * The root has to be an existing directory. Everything else is read through
 * `safeJoin`, which keeps every read inside the root.
 */
export async function resolveProjectRoot(raw: string): Promise<string> {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw new ProjectIndexError('root', 'A project root is required');
  }
  const resolved = path.resolve(value);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new ProjectIndexError('root', `Directory not found: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new ProjectIndexError('root', `Not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Join a relative path to the root and make sure the result cannot escape it
 * (path traversal AND symlink escape are both rejected).
 */
async function safeJoin(root: string, relative: string): Promise<string> {
  const abs = path.resolve(root, relative);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new ProjectIndexError('path', `Path escapes the project root: ${relative}`);
  }
  // symlink check: the real path of the closest existing ancestor must stay
  // inside the real path of the root
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return abs;
  }
  let current = abs;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      const realRootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
      if (real !== rootReal && !real.startsWith(realRootWithSep)) {
        throw new ProjectIndexError('path', `Symlink escapes the project root: ${relative}`);
      }
      return abs;
    } catch (err) {
      if (err instanceof ProjectIndexError) throw err;
      const parent = path.dirname(current);
      if (parent === current) return abs;
      current = parent;
    }
  }
}

/** Should this file be skipped because it looks like it holds a secret? */
export function isSecretFile(relativePath: string): boolean {
  const name = path.basename(relativePath);
  if (IGNORED_FILES.has(name)) return true;
  return SECRET_FILE_RE.test(relativePath);
}

/**
 * A lightweight SYMBOL index.
 *
 * This is a lexical scan, not a parser: it recognises the declaration forms
 * that dominate TypeScript/JavaScript/Python/Go-style sources. It is used to
 * answer "where is X defined?" — the answer always points at a real file and
 * line, so the caller can cite it.
 */
const SYMBOL_PATTERNS: { kind: ProjectSymbol['kind']; re: RegExp }[] = [
  { kind: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/ },
  { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/ },
  { kind: 'class', re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/ },
  { kind: 'method', re: /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/ },
  { kind: 'function', re: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/ },
  { kind: 'class', re: /^\s*class\s+([A-Za-z_][\w]*)\s*[:(]/ },
  { kind: 'const', re: /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
];

/** How many symbols does a stored symbol blob hold? */
function parseSymbolCount(blob: string | null | undefined): number {
  try {
    const parsed = JSON.parse(blob || '[]');
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** Extract the symbols of a source file. */
export function extractSymbols(
  text: string,
  relativePath: string
): { name: string; kind: ProjectSymbol['kind']; line: number }[] {
  const out: { name: string; kind: ProjectSymbol['kind']; line: number }[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const { kind, re } of SYMBOL_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const name = m[1];
      if (!name || name.length < 2) continue;
      // skip obvious noise (keywords, single letters, ALL_CAPS constants of
      // a language rather than a symbol)
      if (/^(if|for|while|switch|catch|return|await|new|typeof|import|export|from|as|else|do|try|throw)$/.test(name)) {
        continue;
      }
      const key = `${name}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, kind, line: i + 1 });
      break;
    }
    if (out.length >= 200) break;
  }
  return out;
}

/** Is this a file type the index can read as text? */
export function isIndexableFile(relativePath: string): boolean {
  const name = path.basename(relativePath).toLowerCase();
  if (name === 'dockerfile' || name === 'makefile') return true;
  const ext = path.extname(name);
  if (!ext) return false;
  return TEXT_EXTENSIONS.has(ext);
}

interface WalkEntry {
  relative: string;
  absolute: string;
  size: number;
  mtimeMs: number;
}

async function walkProject(root: string): Promise<{ entries: WalkEntry[]; skipped: number }> {
  const entries: WalkEntry[] = [];
  let skipped = 0;
  let totalBytes = 0;

  async function walk(dir: string, depth: number) {
    if (depth > 12 || entries.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      skipped++;
      return;
    }
    for (const dirent of dirents) {
      if (entries.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return;
      const abs = path.join(dir, dirent.name);
      const relative = path.relative(root, abs).split(path.sep).join('/');
      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(dirent.name) || dirent.name.startsWith('.')) {
          skipped++;
          continue;
        }
        await walk(abs, depth + 1);
        continue;
      }
      if (!dirent.isFile()) {
        skipped++;
        continue;
      }
      if (isSecretFile(relative) || !isIndexableFile(relative)) {
        skipped++;
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        skipped++;
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped++;
        continue;
      }
      totalBytes += stat.size;
      entries.push({ relative, absolute: abs, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  await walk(root, 0);
  return { entries, skipped };
}

/** Remove every project-index document of one root. */
export async function resetProjectIndex(root: string): Promise<number> {
  const docs = await db.knowledgeDoc.findMany({
    where: { source: 'project', sourceRoot: root },
    select: { id: true },
  });
  if (!docs.length) return 0;
  const ids = docs.map((d) => d.id);
  // H26: only the DOCUMENT rows were removed. The chunk rows — the actual text
  // of every indexed file — were left behind, expected to disappear through the
  // `onDelete: Cascade` relation. That cascade only fires on a connection with
  // `PRAGMA foreign_keys = ON`, so "Clear index" could leave the whole project's
  // source text sitting in SQLite, unreachable from the UI and unremovable by
  // the user. Delete them explicitly; indexOne() already did exactly that.
  await db.knowledgeChunk.deleteMany({ where: { docId: { in: ids } } });
  await db.knowledgeDoc.deleteMany({ where: { id: { in: ids } } });
  return docs.length;
}

/** Index (or re-index) a single file of a project. */
async function indexOne(
  root: string,
  entry: WalkEntry,
  /** max chunks this file may add (the remaining budget) — Infinity = no cap */
  budget: number = Infinity
): Promise<{ ok: boolean; chunks: number; skippedReason?: string }> {
  const existing = await db.knowledgeDoc.findFirst({
    where: { source: 'project', sourceRoot: root, path: entry.relative },
    select: { id: true },
  });

  // an exhausted budget must not silently DELETE a previously indexed doc
  if (budget <= 0) {
    return { ok: false, chunks: 0, skippedReason: 'budget' };
  }

  let text: string;
  try {
    const buffer = await fs.readFile(entry.absolute);
    if (buffer.subarray(0, 4096).includes(0)) {
      return { ok: false, chunks: 0, skippedReason: 'binary' };
    }
    text = buffer.toString('utf-8');
  } catch {
    return { ok: false, chunks: 0, skippedReason: 'unreadable' };
  }

  // never store credentials — the content is redacted before it is indexed
  const guarded = protect(text);
  const chunks = chunkText(guarded.masked).slice(0, budget);
  if (!chunks.length) {
    if (existing) {
      // H26: same as resetProjectIndex — the document AND its chunks must go
      // together, or the stale text of a file that is now empty stays indexed.
      await db.knowledgeChunk.deleteMany({ where: { docId: existing.id } });
      await db.knowledgeDoc.deleteMany({ where: { id: existing.id } });
    }
    return { ok: false, chunks: 0, skippedReason: 'empty' };
  }

  const data = {
    name: path.basename(entry.relative),
    path: entry.relative,
    mime: 'text/plain',
    size: entry.size,
    status: 'indexed',
    error: '',
    chunkCount: chunks.length,
    taskId: '',
    source: 'project',
    sourceRoot: root,
    sourceMtime: entry.mtimeMs,
    sourceSize: entry.size,
    symbols: JSON.stringify(extractSymbols(guarded.masked, entry.relative)),
  };

  if (existing) {
    await db.knowledgeChunk.deleteMany({ where: { docId: existing.id } });
    await db.knowledgeDoc.update({ where: { id: existing.id }, data });
  } else {
    const created = await db.knowledgeDoc.create({ data });
    await db.knowledgeChunk.createMany({
      data: chunks.map((content, seq) => ({ docId: created.id, seq, content })),
    });
    return { ok: true, chunks: chunks.length };
  }
  await db.knowledgeChunk.createMany({
    data: chunks.map((content, seq) => ({ docId: existing.id, seq, content })),
  });
  return { ok: true, chunks: chunks.length };
}

/**
 * Index a whole project directory.
 *
 * `mode`:
 *   - 'full'    (default) — index every file,
 *   - 'refresh' — only re-index the files that changed (or were deleted),
 *   - 'rebuild' — delete the whole index of this root and index it again.
 */
export async function indexProject(
  rawRoot: string,
  opts: { mode?: 'full' | 'refresh' | 'rebuild' } = {}
): Promise<ProjectIndexStats> {
  const started = Date.now();
  const root = await resolveProjectRoot(rawRoot);
  const mode = opts.mode ?? 'full';

  if (mode === 'rebuild') {
    await resetProjectIndex(root);
  }

  const { entries, skipped } = await walkProject(root);

  let files = 0;
  let chunks = 0;
  let symbols = 0;
  let unsupported = 0;
  let bytes = 0;
  let truncated = false;

  // stop as soon as the stored chunks would exceed the cap — the caller is
  // told about it instead of the database silently growing without bound
  const budgetLeft = () => MAX_TOTAL_CHUNKS - chunks;

  if (mode === 'refresh') {
    const stale = await detectStaleFiles(root);
    const stalePaths = new Map(stale.map((s) => [s.path, s]));
    for (const entry of entries) {
      if (!stalePaths.has(entry.relative)) continue;
      if (budgetLeft() <= 0) {
        truncated = true;
        break;
      }
      const res = await indexOne(root, entry, budgetLeft());
      if (res.ok) {
        files++;
        chunks += res.chunks;
        bytes += entry.size;
        if (budgetLeft() <= 0) truncated = true;
      } else if (res.skippedReason === 'budget') {
        truncated = true;
        break;
      } else {
        unsupported++;
      }
    }
    // files that vanished are removed from the index
    for (const s of stale) {
      if (s.reason === 'deleted') {
        const gone = await db.knowledgeDoc.findFirst({
          where: { source: 'project', sourceRoot: root, path: s.path },
          select: { id: true },
        });
        if (gone) {
          // H26: the document and its chunks are removed together (see
          // resetProjectIndex) — a deleted source file must not leave its text
          // behind in the index.
          await db.knowledgeChunk.deleteMany({ where: { docId: gone.id } });
          await db.knowledgeDoc.deleteMany({ where: { id: gone.id } });
        }
        files++;
      }
    }
  } else {
    for (const entry of entries) {
      if (budgetLeft() <= 0) {
        truncated = true;
        break;
      }
      const res = await indexOne(root, entry, budgetLeft());
      if (res.ok) {
        files++;
        chunks += res.chunks;
        bytes += entry.size;
        // a file cut short by the budget reports truncation even when the
        // loop then ends naturally (this was the last entry)
        if (budgetLeft() <= 0) truncated = true;
      } else if (res.skippedReason === 'budget') {
        truncated = true;
        break;
      } else {
        unsupported++;
      }
    }
  }

  const symbolDocs = await db.knowledgeDoc.findMany({
    where: { source: 'project', sourceRoot: root },
    select: { symbols: true },
  });
  let symbolTotal = 0;
  for (const d of symbolDocs) {
    symbolTotal += parseSymbolCount(d.symbols);
  }

  return {
    root,
    files,
    chunks,
    symbols: symbolTotal,
    skipped,
    unsupported,
    bytes,
    truncated,
    durationMs: Date.now() - started,
  };
}

/**
 * Find the indexed files that no longer match the file on disk.
 *
 * A file is stale when it was modified, when its size changed, or when it was
 * deleted from the project.
 */
export async function detectStaleFiles(root: string): Promise<StaleFile[]> {
  const docs = await db.knowledgeDoc.findMany({
    where: { source: 'project', sourceRoot: root },
    select: {
      path: true,
      name: true,
      sourceMtime: true,
      sourceSize: true,
      updatedAt: true,
    },
  });

  const stale: StaleFile[] = [];
  for (const doc of docs) {
    let stat;
    try {
      const abs = await safeJoin(root, doc.path);
      stat = await fs.stat(abs);
    } catch {
      stale.push({
        path: doc.path,
        name: doc.name,
        reason: 'deleted',
        indexedAt: doc.updatedAt.toISOString(),
        expectedMtime: doc.sourceMtime,
        actualMtime: null,
      });
      continue;
    }
    if (!stat.isFile()) {
      stale.push({
        path: doc.path,
        name: doc.name,
        reason: 'deleted',
        indexedAt: doc.updatedAt.toISOString(),
        expectedMtime: doc.sourceMtime,
        actualMtime: null,
      });
      continue;
    }
    if (stat.size !== doc.sourceSize) {
      stale.push({
        path: doc.path,
        name: doc.name,
        reason: 'size-changed',
        indexedAt: doc.updatedAt.toISOString(),
        expectedMtime: doc.sourceMtime,
        actualMtime: stat.mtimeMs,
      });
      continue;
    }
    if (Math.abs(stat.mtimeMs - doc.sourceMtime) > 1) {
      stale.push({
        path: doc.path,
        name: doc.name,
        reason: 'modified',
        indexedAt: doc.updatedAt.toISOString(),
        expectedMtime: doc.sourceMtime,
        actualMtime: stat.mtimeMs,
      });
    }
  }
  return stale;
}

/** The status of a project index (including its stale files). */
export async function projectIndexStatus(rawRoot: string): Promise<ProjectIndexStatus> {
  const root = await resolveProjectRoot(rawRoot);
  const docs = await db.knowledgeDoc.findMany({
    where: { source: 'project', sourceRoot: root },
    select: { chunkCount: true, size: true, updatedAt: true, symbols: true },
  });
  const stale = await detectStaleFiles(root);
  const lastIndexedAt = docs.length
    ? docs.reduce((max, d) => (d.updatedAt > max ? d.updatedAt : max), docs[0].updatedAt)
    : null;
  let symbols = 0;
  for (const d of docs) {
    symbols += parseSymbolCount(d.symbols);
  }
  return {
    root,
    documents: docs.length,
    chunks: docs.reduce((sum, d) => sum + d.chunkCount, 0),
    symbols,
    bytes: docs.reduce((sum, d) => sum + d.size, 0),
    lastIndexedAt: lastIndexedAt ? lastIndexedAt.toISOString() : null,
    stale,
    exists: true,
  };
}

/**
 * Search inside ONE project index.
 *
 * The result carries the source file of every hit, so a caller can cite
 * `path` — that is the "source-file reference" the retrieval must provide.
 */
export async function searchProject(
  rawRoot: string,
  query: string,
  opts: { limit?: number } = {}
): Promise<KnowledgeHit[]> {
  const root = await resolveProjectRoot(rawRoot);
  return searchKnowledge(query, {
    limit: Math.min(50, opts.limit ?? 8),
    source: 'project',
    sourceRoot: root,
  });
}

/** The documents of a project index (for the UI list). */
export async function listProjectDocuments(rawRoot: string) {
  const root = await resolveProjectRoot(rawRoot);
  return db.knowledgeDoc.findMany({
    where: { source: 'project', sourceRoot: root },
    orderBy: { path: 'asc' },
    select: {
      id: true,
      name: true,
      path: true,
      size: true,
      chunkCount: true,
      status: true,
      sourceMtime: true,
      updatedAt: true,
    },
  });
}

/**
 * Search the SYMBOL index of a project.
 *
 * The query is matched against the symbol name (case-insensitive, substring).
 * Every hit points at the file and the line where the symbol is declared.
 */
export async function searchProjectSymbols(
  rawRoot: string,
  query: string,
  opts: { limit?: number } = {}
): Promise<ProjectSymbol[]> {
  const root = await resolveProjectRoot(rawRoot);
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [];

  const docs = await db.knowledgeDoc.findMany({
    where: { source: 'project', sourceRoot: root },
    select: { path: true, name: true, symbols: true },
  });

  const out: ProjectSymbol[] = [];
  for (const doc of docs) {
    let symbols: { name?: string; kind?: string; line?: number }[] = [];
    try {
      const parsed = JSON.parse(doc.symbols || '[]');
      if (Array.isArray(parsed)) symbols = parsed;
    } catch {
      symbols = [];
    }
    for (const s of symbols) {
      if (!s?.name) continue;
      if (!s.name.toLowerCase().includes(needle)) continue;
      out.push({
        name: s.name,
        kind: (s.kind as ProjectSymbol['kind']) ?? 'const',
        line: s.line ?? 1,
        path: doc.path,
        file: doc.name,
      });
      if (out.length >= (opts.limit ?? 50)) return out;
    }
  }
  return out;
}
