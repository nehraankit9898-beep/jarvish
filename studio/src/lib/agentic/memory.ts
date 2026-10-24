// memory.ts — persistent memory for the Studio.
//
// TWO SEPARATE STORES (this separation is the whole point of the module):
//
//   scope = 'user'  → durable preferences and facts the user wants to keep
//                     across tasks (e.g. "I prefer TypeScript over JavaScript").
//                     taskId is always ''.
//
//   scope = 'task'  → notes that belong to ONE task (e.g. "the API key is in
//                     the vault, not in the repo"). A task-scoped entry is
//                     ONLY ever returned for its own task — a task can never
//                     read another task's private notes.
//
// SAFETY: content that looks like a credential is REFUSED, not silently
// stored. The user is told to use the provider store for keys.

import { db } from '@/lib/db';
import { protect, scanAndMask } from './secrets';

export type MemoryScope = 'user' | 'task';
export type MemoryCategory = 'preference' | 'fact' | 'note';

export interface MemoryEntryDto {
  id: string;
  scope: MemoryScope;
  taskId: string;
  category: MemoryCategory;
  key: string;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export class MemoryValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'MemoryValidationError';
    this.field = field;
  }
}

const MAX_KEY_LEN = 120;
const MAX_CONTENT_LEN = 8_000;

const VALID_CATEGORIES: MemoryCategory[] = ['preference', 'fact', 'note'];

function toDto(row: {
  id: string;
  scope: string;
  taskId: string;
  category: string;
  key: string;
  content: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}): MemoryEntryDto {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    taskId: row.taskId,
    category: row.category as MemoryCategory,
    key: row.key,
    content: row.content,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Refuse content that carries a credential. `scanAndMask` reports the secret
 * patterns it found; a hit means the entry must not be persisted.
 */
export function assertNoCredential(content: string): void {
  const scan = scanAndMask(content);
  if (scan.found.length) {
    throw new MemoryValidationError(
      'content',
      `Refusing to store a credential (${scan.found
        .map((f) => f.name)
        .join(', ')}). Store API keys in the Providers panel instead.`
    );
  }
}

/**
 * Create or update a memory entry.
 * The (scope, taskId, key) triple is unique — writing the same key twice
 * updates the existing entry instead of duplicating it.
 */
export async function saveMemory(input: {
  scope?: MemoryScope;
  taskId?: string;
  category?: MemoryCategory;
  key: string;
  content: string;
  source?: string;
}): Promise<MemoryEntryDto> {
  const scope: MemoryScope = input.scope === 'task' ? 'task' : 'user';
  const key = String(input.key ?? '').trim();
  if (!key || key.length > MAX_KEY_LEN) {
    throw new MemoryValidationError('key', 'key is required (max 120 characters)');
  }
  const content = String(input.content ?? '');
  if (!content.trim()) {
    throw new MemoryValidationError('content', 'content is required');
  }
  if (content.length > MAX_CONTENT_LEN) {
    throw new MemoryValidationError(
      'content',
      `content is too long (max ${MAX_CONTENT_LEN} characters)`
    );
  }
  const category = VALID_CATEGORIES.includes(input.category as MemoryCategory)
    ? (input.category as MemoryCategory)
    : 'note';

  // A task-scoped entry MUST belong to a task; a user-scoped entry must not
  // be bound to one — otherwise the scopes would bleed into each other.
  const taskId = scope === 'task' ? String(input.taskId ?? '').trim() : '';
  if (scope === 'task' && !taskId) {
    throw new MemoryValidationError('taskId', 'taskId is required for task-scoped memory');
  }
  if (scope === 'task' && !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
    throw new MemoryValidationError('taskId', 'Invalid taskId');
  }

  assertNoCredential(content);
  const masked = protect(content).masked;

  const existing = await db.memoryEntry.findUnique({
    where: { scope_taskId_key: { scope, taskId, key } },
  });
  const row = existing
    ? await db.memoryEntry.update({
        where: { id: existing.id },
        data: { content: masked, category, source: input.source ?? existing.source },
      })
    : await db.memoryEntry.create({
        data: {
          scope,
          taskId,
          category,
          key,
          content: masked,
          source: input.source ?? 'user',
        },
      });
  return toDto(row);
}

export interface MemoryQuery {
  scope?: MemoryScope;
  taskId?: string;
  category?: MemoryCategory;
  search?: string;
  limit?: number;
}

/**
 * List memory entries.
 *
 * IMPORTANT: when `scope` is 'task' the taskId filter is MANDATORY — a
 * task-scoped listing without a task id is rejected, otherwise the private
 * notes of every task would be returned in one blob.
 */
export async function listMemory(query: MemoryQuery = {}): Promise<MemoryEntryDto[]> {
  const scope = query.scope;
  const where: Record<string, unknown> = {};
  if (scope === 'task') {
    if (!query.taskId) {
      throw new MemoryValidationError(
        'taskId',
        'taskId is required when listing task-scoped memory'
      );
    }
    where.scope = 'task';
    where.taskId = query.taskId;
  } else if (scope === 'user') {
    where.scope = 'user';
    where.taskId = '';
  }
  if (query.category) where.category = query.category;

  const rows = await db.memoryEntry.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: Math.min(500, Math.max(1, query.limit ?? 200)),
  });

  const search = query.search?.trim().toLowerCase();
  const filtered = search
    ? rows.filter(
        (r) =>
          r.key.toLowerCase().includes(search) ||
          r.content.toLowerCase().includes(search)
      )
    : rows;
  return filtered.map(toDto);
}

/** Read a single entry by id. */
export async function getMemory(id: string): Promise<MemoryEntryDto | null> {
  const row = await db.memoryEntry.findUnique({ where: { id } });
  return row ? toDto(row) : null;
}

/**
 * Delete memory entries.
 * Without an id the whole scope is cleared (the user asked for it).
 */
export async function deleteMemory(
  filter: { id?: string; scope?: MemoryScope; taskId?: string }
): Promise<number> {
  if (filter.id) {
    const res = await db.memoryEntry.deleteMany({ where: { id: filter.id } });
    return res.count;
  }
  const where: Record<string, unknown> = {};
  if (filter.scope === 'task') {
    if (!filter.taskId) {
      throw new MemoryValidationError(
        'taskId',
        'taskId is required when deleting task-scoped memory'
      );
    }
    where.scope = 'task';
    where.taskId = filter.taskId;
  } else if (filter.scope === 'user') {
    where.scope = 'user';
    where.taskId = '';
  }
  const res = await db.memoryEntry.deleteMany({ where });
  return res.count;
}

/**
 * The memory an agent may read for a task:
 *   * the user preferences (scope 'user'),
 *   * the notes of THIS task (scope 'task', taskId = taskId).
 *
 * Notes of OTHER tasks are never included.
 */
export async function memoryContextForTask(taskId: string): Promise<string> {
  const user = await listMemory({ scope: 'user', limit: 50 });
  const task = await listMemory({ scope: 'task', taskId, limit: 50 });
  const parts: string[] = [];
  if (user.length) {
    parts.push(
      `USER PREFERENCES:\n${user
        .map((m) => `- [${m.category}] ${m.key}: ${m.content.slice(0, 500)}`)
        .join('\n')}`
    );
  }
  if (task.length) {
    parts.push(
      `NOTES FOR THIS TASK:\n${task
        .map((m) => `- [${m.category}] ${m.key}: ${m.content.slice(0, 500)}`)
        .join('\n')}`
    );
  }
  return parts.join('\n\n');
}

// ---------- relevant retrieval (Jarvis #4) ----------
//
// The full memory list can grow large; stuffing ALL of it into every prompt
// wastes tokens and confuses small models. `relevantMemoryContext` scores the
// user memories against the words of the current request and injects only the
// top matches (plus a small recency boost), capped by `limit`.

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'was', 'were', 'be', 'do', 'does', 'did', 'my', 'me', 'i', 'you',
  'kya', 'hai', 'ho', 'ka', 'ki', 'ke', 'ko', 'me', 'se', 'par', 'aur', 'ya',
  'mujhe', 'mera', 'meri', 'karo', 'kardo', 'karna', 'batao', 'dikha', 'please',
]);

function tokenize(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

export interface RelevantMemory {
  id: string;
  key: string;
  content: string;
  category: MemoryCategory;
  score: number;
}

/**
 * Score user-scope memories against `query` (keyword overlap + recency) and
 * return the best matches. Pure retrieval — never writes. Bounded work:
 * reads at most 200 entries, returns at most `limit` (default 8, max 10).
 */
export async function findRelevantMemories(
  query: string,
  limit = 8
): Promise<RelevantMemory[]> {
  const rows = await listMemory({ scope: 'user', limit: 200 });
  if (!rows.length) return [];
  const want = new Set(tokenize(query));
  const now = Date.now();
  const scored = rows.map((m) => {
    const hay = tokenize(`${m.key} ${m.content}`);
    let overlap = 0;
    for (const w of new Set(hay)) if (want.has(w)) overlap++;
    // exact key phrase hit is a strong signal ("naam", "birthday" ...)
    const keyHit = want.has(m.key.toLowerCase()) ? 2 : 0;
    // gentle recency boost (updated in the last 7 days +1, 30 days +0.5)
    const ageDays = (now - new Date(m.updatedAt).getTime()) / 86_400_000;
    const recency = ageDays <= 7 ? 1 : ageDays <= 30 ? 0.5 : 0;
    const score = overlap * 2 + keyHit + recency;
    return {
      id: m.id,
      key: m.key,
      content: m.content,
      category: m.category,
      score,
    };
  });
  return scored
    // recency alone (score 1) is NOT relevance — a memory must actually
    // share a word with the query (overlap ≥ 1 → score ≥ 2) or hit the key
    .filter((m) => m.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(10, Math.max(1, limit)));
}

/**
 * The prompt block for Chat / tasks: only RELEVANT memories (spec: "sirf
 * relevant 5-10, sab nahi, warna prompt lamba hoga"). Empty string when
 * nothing matches — callers just skip the injection.
 */
export async function relevantMemoryContext(
  query: string,
  limit = 8
): Promise<string> {
  const hits = await findRelevantMemories(query, limit).catch(() => []);
  if (!hits.length) return '';
  return (
    `WHAT YOU REMEMBER ABOUT THE USER (only facts below are known — do not invent more):\n` +
    hits.map((m) => `- ${m.key}: ${m.content.slice(0, 300)}`).join('\n')
  );
}
