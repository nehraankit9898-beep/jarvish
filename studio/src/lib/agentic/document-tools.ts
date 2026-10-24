// document-tools.ts — the agent-facing tools for real files on the machine.
//
// Three gaps this closes (see docs/CAPABILITY_MATRIX.md):
//   document-read   read a pdf/docx/xlsx/pptx/odt/rtf/epub as TEXT
//   file-search     find a file by NAME or by CONTENT, with line numbers
//   document-index  import a document into the knowledge base (RAG)
//
// Every path is resolved through one of the two existing guards — the task
// workspace (`resolveSafe`) or the allowed laptop roots (`resolveInsideRoots`)
// — so a tool can never reach a credential file or escape the sandbox.
// All three tools are READ-ONLY (`permission: 'safe'`).

import fs from 'fs/promises';
import path from 'path';
import type { ToolResult } from './tool-registry';
import { registerTool } from './tool-registry';
import { isSafeTaskId, resolveSafe, taskWorkspace } from './workspace';
import { allowedRoots, resolveInsideRoots } from './allowed-roots';
import { isSensitivePath } from './host-control';
import { extractDocumentText, isExtractableExtension, sniffKind, DocumentError } from './documents';
import { importDocument } from './knowledge';

let registered = false;

const MAX_READ_BYTES = 25_000_000;
const MAX_SEARCH_FILES = 5_000;
const MAX_SEARCH_DEPTH = 8;
const MAX_SCAN_BYTES = 2_000_000;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '__pycache__', '.venv', 'venv', '.cache', 'target', '.turbo',
]);

/** Resolve a tool path: inside a task workspace when taskId is given, otherwise inside the allowed roots. */
async function resolveToolPath(
  rawPath: string,
  taskId: string
): Promise<{ ok: true; abs: string; label: string } | { ok: false; error: string }> {
  // An ABSOLUTE (or ~) path addresses the real laptop, so it is checked
  // against the allowed roots. A relative path belongs to the task workspace.
  const looksAbsolute = path.isAbsolute(rawPath) || rawPath.startsWith('~');
  if (!looksAbsolute && taskId && isSafeTaskId(taskId)) {
    try {
      const abs = await resolveSafe(taskId, rawPath);
      return { ok: true, abs, label: rawPath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Invalid path' };
    }
  }
  const resolved = resolveInsideRoots(rawPath);
  if (!resolved.ok) return { ok: false, error: resolved.error ?? 'Path is not allowed' };
  return { ok: true, abs: resolved.path, label: rawPath };
}

function toolResult(ok: boolean, data: unknown, error?: string): ToolResult {
  return { ok, data, error, permission: 'safe', at: new Date().toISOString() };
}

export interface ExtractedFile {
  path: string;
  kind: string;
  units: number;
  warnings: string[];
  text: string;
  truncated: boolean;
}

/**
 * Read a file as text: real documents go through the extractor, plain text
 * files are read directly. Exported for the API routes and for tests.
 */
export async function readFileAsText(
  absPath: string,
  opts: { maxChars?: number } = {}
): Promise<ExtractedFile> {
  const maxChars = Math.min(Math.max(200, opts.maxChars ?? 20_000), 200_000);
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    throw new Error(`File not found: ${absPath}`);
  }
  if (!stat.isFile()) throw new Error('Only files can be read');
  if (stat.size > MAX_READ_BYTES) throw new Error(`File is too large (max ${MAX_READ_BYTES / 1_000_000} MB)`);

  const buffer = await fs.readFile(absPath);
  const ext = path.extname(absPath).toLowerCase();
  let kind = 'text';
  let text = '';
  let units = 0;
  const warnings: string[] = [];

  const sniffed = ext && isExtractableExtension(ext) ? null : sniffKind(buffer);
  const documentExt = isExtractableExtension(ext) && ext !== '.txt' ? ext : sniffed ? `.${sniffed}` : '';
  if (documentExt) {
    try {
      const extracted = extractDocumentText(buffer, documentExt);
      kind = extracted.kind;
      text = extracted.text;
      units = extracted.units;
      warnings.push(...extracted.warnings);
    } catch (err) {
      if (!(err instanceof DocumentError)) throw err;
      // fall back to a plain read when the format claim was wrong but the
      // bytes are still text (e.g. a .docx renamed to .txt)
      const head = buffer.subarray(0, 4096);
      if (head.includes(0)) throw err;
      text = buffer.toString('utf8');
      warnings.push(err.message);
    }
  } else {
    const head = buffer.subarray(0, 4096);
    if (head.includes(0)) {
      throw new Error(
        'This file is binary and its format is not supported (images, archives and legacy .doc/.xls/.ppt are not readable).'
      );
    }
    text = buffer.toString('utf8');
  }

  const truncated = text.length > maxChars;
  return { path: absPath, kind, units, warnings, text: truncated ? text.slice(0, maxChars) : text, truncated };
}

export interface FileMatch {
  path: string;
  /** line number (1-based) for a content match, 0 for a name match */
  line: number;
  /** why it matched */
  matchedOn: 'name' | 'content';
  preview: string;
}

/** Walk a directory (bounded) and collect `FileMatch`es. Exported for tests. */
export async function searchFiles(
  root: string,
  query: string,
  opts: { mode?: 'name' | 'content' | 'both'; maxResults?: number; maxFiles?: number } = {}
): Promise<FileMatch[]> {
  const mode = opts.mode ?? 'both';
  const maxResults = Math.min(Math.max(1, opts.maxResults ?? 30), 200);
  const maxFiles = Math.min(Math.max(1, opts.maxFiles ?? MAX_SEARCH_FILES), MAX_SEARCH_FILES);
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: FileMatch[] = [];
  let scanned = 0;
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

  while (queue.length && matches.length < maxResults && scanned < maxFiles) {
    const { dir, depth } = queue.shift()!;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirents) {
      if (matches.length >= maxResults || scanned >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (isSensitivePath(full)) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (depth + 1 <= MAX_SEARCH_DEPTH) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      scanned++;

      if ((mode === 'name' || mode === 'both') && entry.name.toLowerCase().includes(needle)) {
        matches.push({ path: full, line: 0, matchedOn: 'name', preview: entry.name });
        continue;
      }
      if (mode === 'content' || mode === 'both') {
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        if (stat.size > MAX_SCAN_BYTES || stat.size === 0) continue;
        let buffer: Buffer;
        try {
          buffer = await fs.readFile(full);
        } catch {
          continue;
        }
        if (buffer.subarray(0, 4096).includes(0)) continue; // binary — never search inside
        const lines = buffer.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push({
              path: full,
              line: i + 1,
              matchedOn: 'content',
              preview: lines[i].trim().slice(0, 240),
            });
            break; // one hit per file keeps the result readable
          }
        }
      }
    }
  }
  return matches;
}

/** Register the document/file tools once (idempotent). */
export function registerDocumentTools(): void {
  if (registered) return;
  registered = true;

  registerTool(
    {
      name: 'document-read',
      description:
        'Read the TEXT of a document — pdf, docx, xlsx, pptx, odt, ods, rtf, epub, csv or a plain text/source file. ' +
        'Use this instead of "file-read" for office documents. With a taskId the path is workspace-relative; ' +
        'without one it must sit inside the allowed laptop roots.',
      category: 'file',
      parameters: {
        path: { type: 'string', description: 'File path (workspace-relative with taskId, else inside an allowed root)', required: true },
        maxChars: { type: 'number', description: 'Maximum characters to return (default 20000)', required: false },
      },
      required: ['path'],
      permission: 'safe',
      timeoutMs: 30_000,
    },
    async ({ taskId, parameters }): Promise<ToolResult> => {
      const resolved = await resolveToolPath(String(parameters.path ?? ''), taskId);
      if (!resolved.ok) return toolResult(false, undefined, resolved.error);
      try {
        const file = await readFileAsText(resolved.abs, { maxChars: Number(parameters.maxChars) || undefined });
        return toolResult(true, {
          path: resolved.label,
          kind: file.kind,
          units: file.units,
          warnings: file.warnings,
          truncated: file.truncated,
          text: file.text,
        });
      } catch (err) {
        return toolResult(false, undefined, err instanceof Error ? err.message : 'Could not read the document');
      }
    }
  );

  registerTool(
    {
      name: 'file-search',
      description:
        'Search for files by NAME or by CONTENT (case-insensitive) and get the matching path, line number and a ' +
        'preview. Read-only. With a taskId it searches the task workspace, otherwise the configured allowed roots.',
      category: 'file',
      parameters: {
        query: { type: 'string', description: 'Text to look for (file name or file content)', required: true },
        path: { type: 'string', description: 'Folder to search in (default: the workspace / allowed roots)', required: false },
        mode: { type: 'string', description: 'name | content | both (default both)', required: false },
        maxResults: { type: 'number', description: 'Maximum matches (default 30)', required: false },
      },
      required: ['query'],
      permission: 'safe',
      timeoutMs: 60_000,
    },
    async ({ taskId, parameters }): Promise<ToolResult> => {
      const query = String(parameters.query ?? '').trim();
      if (!query) return toolResult(false, undefined, 'query is required');
      const modeRaw = String(parameters.mode ?? 'both');
      const mode = modeRaw === 'name' || modeRaw === 'content' ? modeRaw : 'both';

      let roots: string[] = [];
      if (parameters.path) {
        const resolved = await resolveToolPath(String(parameters.path), taskId);
        if (!resolved.ok) return toolResult(false, undefined, resolved.error);
        roots = [resolved.abs];
      } else if (taskId && isSafeTaskId(taskId)) {
        roots = [taskWorkspace(taskId)];
      } else {
        roots = allowedRoots().map((r) => r.path);
      }
      if (!roots.length) return toolResult(false, undefined, 'No allowed roots configured (AGENTSCOPE_ALLOWED_ROOTS)');

      const maxResults = Math.min(Math.max(1, Number(parameters.maxResults) || 30), 200);
      const all: FileMatch[] = [];
      for (const root of roots) {
        const found = await searchFiles(root, query, { mode, maxResults: maxResults - all.length });
        all.push(...found);
        if (all.length >= maxResults) break;
      }
      return toolResult(true, { query, mode, count: all.length, matches: all });
    }
  );

  registerTool(
    {
      name: 'document-index',
      description:
        'Import a document into the knowledge base so it can be searched later with knowledge-search. ' +
        'Accepts a workspace path (taskId required). Read-only for the file itself.',
      category: 'file',
      parameters: {
        path: { type: 'string', description: 'Workspace-relative path of the document', required: true },
      },
      required: ['path'],
      permission: 'safe',
      timeoutMs: 60_000,
    },
    async ({ taskId, parameters }): Promise<ToolResult> => {
      if (!taskId || !isSafeTaskId(taskId)) {
        return toolResult(false, undefined, 'document-index needs a taskId (documents are imported per workspace)');
      }
      try {
        const doc = await importDocument({ path: String(parameters.path ?? ''), taskId });
        return toolResult(doc.status === 'indexed', {
          id: doc.id,
          name: doc.name,
          status: doc.status,
          chunkCount: doc.chunkCount,
          error: doc.error,
        }, doc.status === 'indexed' ? undefined : doc.error || 'Document could not be indexed');
      } catch (err) {
        return toolResult(false, undefined, err instanceof Error ? err.message : 'Import failed');
      }
    }
  );
}
