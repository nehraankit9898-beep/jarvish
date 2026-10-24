// memory-tools.ts — agent-facing memory tools (Jarvis #4).
//
// The orchestrator's step agents save memories through the
// `### REMEMBER:` protocol, but the Tools panel / /api/tools/invoke path
// also needs direct memory access (the same way browser/host tools are
// exposed). Three tools, mirroring the memory module:
//
//   memory-remember  — save/refresh a user-scope fact (credential-refusing)
//   memory-recall    — keyword-scored retrieval (what the agent can "know")
//   memory-forget    — delete by key (the user's "bhool jao" door)
//
// Everything is audit-friendly: the tool layer already redacts results.

import { registerTool, type ToolResult } from './tool-registry';
import {
  saveMemory,
  deleteMemory,
  findRelevantMemories,
  MemoryValidationError,
} from './memory';

let registered = false;

const at = () => new Date().toISOString();

/** Register the memory tools once (idempotent). */
export function registerMemoryTools(): void {
  if (registered) return;
  registered = true;

  registerTool(
    {
      name: 'memory-remember',
      description:
        'Save a durable fact about the user (preference, routine, project) into long-term memory. Passwords/API keys/OTPs are REFUSED. Same key overwrites (update).',
      category: 'adapter',
      parameters: {
        key: { type: 'string', description: 'Short unique label, e.g. "work start time"', required: true },
        content: { type: 'string', description: 'The fact to remember (max 8000 chars)', required: true },
        category: { type: 'string', description: 'preference | fact | note (default fact)', required: false },
      },
      required: ['key', 'content'],
      permission: 'review',
      timeoutMs: 10_000,
    },
    async (inv): Promise<ToolResult> => {
      try {
        const saved = await saveMemory({
          scope: 'user',
          key: String(inv.parameters.key ?? ''),
          content: String(inv.parameters.content ?? ''),
          category: inv.parameters.category as 'preference' | 'fact' | 'note' | undefined,
          source: 'agent',
        });
        return { ok: true, data: { id: saved.id, key: saved.key, masked: true }, at: at() };
      } catch (err) {
        const why =
          err instanceof MemoryValidationError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'memory save failed';
        return { ok: false, error: why, at: at() };
      }
    }
  );

  registerTool(
    {
      name: 'memory-recall',
      description:
        'Search the user\'s long-term memory. Returns the most relevant entries (keyword-scored) — NOT the whole list. Read-only.',
      category: 'adapter',
      parameters: {
        query: { type: 'string', description: 'What to look up, e.g. "work schedule"', required: true },
        limit: { type: 'number', description: 'Max entries 1-10 (default 5)', required: false },
      },
      required: ['query'],
      permission: 'safe',
      timeoutMs: 10_000,
    },
    async (inv): Promise<ToolResult> => {
      try {
        const hits = await findRelevantMemories(
          String(inv.parameters.query ?? ''),
          Number(inv.parameters.limit ?? 5)
        );
        return { ok: true, data: { count: hits.length, memories: hits }, at: at() };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'memory recall failed',
          at: at(),
        };
      }
    }
  );

  registerTool(
    {
      name: 'memory-forget',
      description:
        'Delete a stored memory by its key (the user asked to forget it). Fails softly when the key does not exist.',
      category: 'adapter',
      parameters: {
        key: { type: 'string', description: 'Exact memory key to delete', required: true },
      },
      required: ['key'],
      permission: 'review',
      timeoutMs: 10_000,
    },
    async (inv): Promise<ToolResult> => {
      try {
        const key = String(inv.parameters.key ?? '').trim();
        const rows = await import('./memory').then((m) => m.listMemory({ scope: 'user', limit: 500 }));
        const hit = rows.find((r) => r.key.toLowerCase() === key.toLowerCase());
        if (!hit) {
          return { ok: false, error: `No memory stored under key "${key.slice(0, 80)}"`, at: at() };
        }
        const deleted = await deleteMemory({ id: hit.id });
        return { ok: deleted > 0, data: { deleted, key: hit.key }, at: at() };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'memory forget failed',
          at: at(),
        };
      }
    }
  );
}
