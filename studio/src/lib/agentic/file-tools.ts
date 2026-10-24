// file-tools.ts — LLM output protocol parsing + guarded file writes
// Coder/Tester output protocol:
//   ### FILE: relative/path.ext
//   ```lang
//   ...content...
//   ```
//   ### RUN: command
//   ### END
// Deterministic parsing (no JSON fragility), files written via workspace guard.

import {
  FILE_MARKER,
  RUN_MARKER,
  REMEMBER_MARKER,
  type ParsedAction,
} from './types';
import {
  writeWorkspaceFile,
  deleteWorkspaceFile,
  resolveSafe,
} from './workspace';
import type { FileChangeRecord } from './types';

/**
 * Parse FILE/RUN/REMEMBER actions from an LLM reply. Lenient: accepts fenced
 * or raw content after FILE marker, stops at next marker or END.
 */
export function parseActions(reply: string): ParsedAction {
  const files: { path: string; content: string }[] = [];
  const commands: string[] = [];
  const memories: { key: string; content: string }[] = [];
  const notesParts: string[] = [];

  const lines = reply.split('\n');
  let i = 0;

  // A raw (unfenced) FILE block ends at the next marker. The documented
  // terminator is "### END" (no colon) — it has to stop the content scan too,
  // otherwise the block swallows the terminator and everything after it.
  const RAW_BLOCK_END = /^#{2,4}\s*(?:FILE\s*:|RUN\s*:|REMEMBER\s*:|END\s*:?\s*$)/;

  while (i < lines.length) {
    const line = lines[i];
    const fileMatch = line.match(
      /^#{2,4}\s*FILE:\s*(.+?)\s*$/
    );
    const runMatch = line.match(/^#{2,4}\s*RUN:\s*(.+?)\s*$/);
    // ### REMEMBER: key :: content  — the agent's "yaad rakho" instruction.
    // "::" separates key from content so the content itself may contain
    // colons (times, URLs...).
    const rememberMatch = line.match(/^#{2,4}\s*REMEMBER:\s*(.+?)\s*$/);
    const endMatch = line.match(/^#{2,4}\s*END\s*$/);

    if (fileMatch) {
      const filePath = fileMatch[1].trim().replace(/^["'`]|["'`]$/g, '');
      // content = fenced block if present, else raw lines till next marker
      let j = i + 1;
      let content = '';
      const fenceOpen = lines[j]?.match(/^\s*```[\w.+-]*\s*$/);
      if (fenceOpen) {
        j++;
        const buf: string[] = [];
        while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) {
          buf.push(lines[j]);
          j++;
        }
        content = buf.join('\n');
        j++; // past closing fence
      } else {
        const buf: string[] = [];
        while (j < lines.length && !RAW_BLOCK_END.test(lines[j])) {
          buf.push(lines[j]);
          j++;
        }
        content = buf.join('\n').trimEnd();
      }
      files.push({ path: filePath, content });
      i = j;
      continue;
    }

    if (runMatch) {
      const cmd = runMatch[1].trim().replace(/^["'`]|["'`]$/g, '');
      commands.push(cmd);
      i++;
      continue;
    }

    if (rememberMatch) {
      const raw = rememberMatch[1].trim().replace(/^"'`|"'`$/g, '');
      const sep = raw.indexOf('::');
      if (sep > 0) {
        const key = raw.slice(0, sep).trim().slice(0, 120);
        const content = raw.slice(sep + 2).trim().slice(0, 2000);
        if (key && content) memories.push({ key, content });
      } else if (raw) {
        // no key given — derive one from the first words so nothing is lost
        const key = raw.split(/\s+/).slice(0, 4).join(' ').slice(0, 60) || 'fact';
        memories.push({ key, content: raw.slice(0, 2000) });
      }
      i++;
      continue;
    }

    if (endMatch) {
      i++;
      continue;
    }

    notesParts.push(line);
    i++;
  }

  return {
    files,
    commands,
    memories,
    notes: notesParts.join('\n').replace(/```[a-z]*\n?/g, '').trim(),
  };
}

/** Apply parsed file actions inside the workspace; returns change records. */
export async function applyFileActions(
  taskId: string,
  files: { path: string; content: string; delete?: boolean }[]
): Promise<FileChangeRecord[]> {
  const changes: FileChangeRecord[] = [];
  for (const f of files) {
    if (f.delete) {
      await deleteWorkspaceFile(taskId, f.path);
      changes.push({ path: f.path, action: 'delete', bytes: 0 });
      continue;
    }
    // pre-flight: path must resolve inside workspace
    const abs = await resolveSafe(taskId, f.path);
    const fs = await import('fs/promises');
    let action: 'create' | 'edit' | 'delete' = 'create';
    try {
      await fs.access(abs);
      action = 'edit';
    } catch {
      action = 'create';
    }
    const { bytes } = await writeWorkspaceFile(taskId, f.path, f.content);
    changes.push({ path: f.path, action, bytes });
  }
  return changes;
}

export { writeWorkspaceFile, readWorkspaceFile, listTree } from './workspace';
