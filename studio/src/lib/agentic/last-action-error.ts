// last-action-error.ts — the "repeat/explain the last error" memory.
//
// Spec §7 requires JARVIS to be able to repeat the last error while offline.
// Keeping it in process memory (not the DB) is deliberate: it describes the
// CURRENT session, it must work when the database is unavailable, and it must
// never be written to disk with a provider body that could contain a key.

import { sanitizeProviderMessage } from '@/lib/provider-errors';

export interface LastActionError {
  at: string;
  /** what failed, e.g. "Google Gemini connection test" */
  what: string;
  category: string;
  /** sanitised message — safe to show and to speak */
  message: string;
  hint?: string;
}

type Store = { last?: LastActionError };
function store(): Store {
  const g = globalThis as unknown as { __agentscopeLastError?: Store };
  return (g.__agentscopeLastError ??= {});
}

/** Remember the most recent REAL failure (already classified). */
export function recordLastError(input: {
  what: string;
  category: string;
  message: string;
  hint?: string;
  secrets?: string[];
}): LastActionError {
  const entry: LastActionError = {
    at: new Date().toISOString(),
    what: String(input.what ?? 'action').slice(0, 120),
    category: String(input.category ?? 'unknown').slice(0, 40),
    message: sanitizeProviderMessage(input.message ?? '', input.secrets ?? []).slice(0, 300),
    hint: input.hint ? sanitizeProviderMessage(input.hint).slice(0, 200) : undefined,
  };
  store().last = entry;
  return entry;
}

export function readLastError(): LastActionError | undefined {
  return store().last;
}

export function clearLastError(): void {
  store().last = undefined;
}
