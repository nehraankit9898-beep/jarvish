// browser-history.ts — search the REAL browser history (Roadmap #4).
//
// OpenClaw has no equivalent — this was built from scratch. The design is
// deliberately paranoid:
//   - the History SQLite file is LOCKED while the browser runs, so the
//     Python bridge copies it to a temp file and opens THAT read-only
//     (mode=ro). The original is never touched.
//   - ONLY the `urls`/`visits` tables are read. Cookies, Login Data and
//     form history stay inside the host-control blocklist and are
//     unreachable through this path.
//   - results are wrapped with the prompt-injection guard: a page TITLE is
//     attacker-controlled text, never an instruction.
//   - the whole thing flows through the desktop bridge (kill switch, token,
//     127.0.0.1) and every search is audit-logged.

import { desktopCall, DesktopBridgeError } from './desktop-bridge';
import { markUntrusted } from './safety';
import { recordAudit } from './audit';

export interface HistoryEntry {
  url: string;
  title: string;
  visitCount: number;
  lastVisitAt: string | null;
  browser: string;
}

export interface HistorySearchResult {
  entries: HistoryEntry[];
  /** injection-guard verdict for the merged titles */
  untrusted: { suspicious: boolean; markers: string[]; wrapped: string };
  sources: Array<{ path: string; error?: string; read_only?: boolean }>;
  note?: string;
}

const MAX_DAYS = 365;
const MAX_LIMIT = 200;

export async function searchBrowserHistory(
  opts: { query?: string; days?: number; limit?: number; actor?: string; taskId?: string } = {}
): Promise<HistorySearchResult> {
  const query = String(opts.query ?? '').slice(0, 200);
  const days = Math.min(Math.max(Math.floor(opts.days ?? 30), 1), MAX_DAYS);
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), MAX_LIMIT);

  const raw = await desktopCall('chrome_history', { query, days, limit });
  if (!raw.ok) {
    throw new DesktopBridgeError(raw.error || 'History search failed', raw.hint);
  }
  const data = (raw.data ?? {}) as {
    entries?: Array<Record<string, unknown>>;
    sources?: Array<{ path: string; error?: string; read_only?: boolean }>;
    note?: string;
  };

  const entries: HistoryEntry[] = (data.entries ?? []).slice(0, limit).map((e) => ({
    url: String(e.url ?? '').slice(0, 2000),
    title: String(e.title ?? '').slice(0, 300),
    visitCount: Number(e.visitCount ?? 0),
    lastVisitAt: e.lastVisitAt ? String(e.lastVisitAt) : null,
    browser: String(e.browser ?? 'chrome'),
  }));

  // titles/URLs are untrusted DATA — mark them so a crafted page title can
  // never steer the agent afterwards
  const merged = entries.map((e) => `${e.title} ${e.url}`).join('\n');
  const guard = markUntrusted('browser-history', merged || '(no entries)');

  await recordAudit({
    actor: opts.actor ?? 'agent',
    action: 'history.search',
    category: 'security',
    approval: 'auto',
    taskId: opts.taskId ?? '',
    details: { query: query.slice(0, 100), days, limit, results: entries.length },
  });

  return {
    entries,
    untrusted: { suspicious: guard.suspicious, markers: guard.markers, wrapped: guard.wrapped },
    sources: data.sources ?? [],
    note: data.note,
  };
}
