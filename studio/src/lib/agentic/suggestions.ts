// suggestions.ts — the proactive suggestion engine (Feature 8).
//
// The runtime periodically analyses the task history and automation state
// and PROPOSES actions to the user. A suggestion is never executed by
// itself: the user ACCEPTS it (→ a normal agentic task is created with the
// suggestion's actionPrompt, inheriting every safety guarantee) or
// DISMISSES it.
//
// Rules implemented (each rate-limited + deduplicated by kind+evidence):
//   - repeated_failure: the same task failed twice or more → propose a
//     recurring health/build check or a diagnostic task
//   - failed_schedule: an automation schedule failed recently → propose
//     inspecting/fixing it
//   - stale_project_index: a project index is stale (files changed) →
//     propose a refresh task
//   - docs_follow_up: a task that changed many files completed → propose a
//     documentation update task

import { db } from '@/lib/db';
import { proactiveNotify, isKindMuted } from './proactive';

export interface SuggestionDto {
  id: string;
  kind: string;
  title: string;
  body: string;
  evidence: Record<string, unknown>;
  actionPrompt: string;
  status: string;
  taskId: string;
  createdAt: string;
}

function toDto(row: {
  id: string;
  kind: string;
  title: string;
  body: string;
  evidence: string;
  actionPrompt: string;
  status: string;
  taskId: string;
  createdAt: Date;
}): SuggestionDto {
  let evidence: Record<string, unknown> = {};
  try {
    evidence = JSON.parse(row.evidence || '{}');
  } catch {
    evidence = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    evidence,
    actionPrompt: row.actionPrompt,
    status: row.status,
    taskId: row.taskId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSuggestions(opts: { status?: string } = {}): Promise<SuggestionDto[]> {
  const rows = await db.proactiveSuggestion.findMany({
    where: opts.status ? { status: opts.status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return rows.map(toDto);
}

/**
 * Create a suggestion unless an OPEN one of the same kind with the same
 * signature already exists (dedupe — a nightly scan must not spam) AND the
 * kind is not muted ("aage se mat batao"). The notification goes through
 * the proactive guard-rails (quiet hours + daily cap).
 */
async function propose(input: {
  kind: string;
  title: string;
  body: string;
  evidence: Record<string, unknown>;
  actionPrompt: string;
  dedupeKey: string;
}): Promise<SuggestionDto | null> {
  if (await isKindMuted(input.kind)) return null;
  const open = await db.proactiveSuggestion.findMany({
    where: { kind: input.kind, status: 'open' },
    select: { id: true, evidence: true },
  });
  const dup = open.some((row) => {
    try {
      const ev = JSON.parse(row.evidence || '{}') as Record<string, unknown>;
      return ev.dedupeKey === input.dedupeKey;
    } catch {
      return false;
    }
  });
  if (dup) return null;

  const row = await db.proactiveSuggestion.create({
    data: {
      kind: input.kind,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 2000),
      evidence: JSON.stringify({ ...input.evidence, dedupeKey: input.dedupeKey }),
      actionPrompt: input.actionPrompt.slice(0, 2000),
    },
  });
  // guard-rails (quiet hours / daily cap) — suppressed notification is OK,
  // the suggestion row stays open for the panel
  await proactiveNotify({
    kind: input.kind,
    title: `Suggestion: ${input.title}`,
    body: input.body.slice(0, 500),
    data: { suggestionId: row.id, kind: input.kind },
  });
  return toDto(row);
}

/** The scan entry point — called by the background runtime (rate-limited there). */
export async function scanForSuggestions(): Promise<SuggestionDto[]> {
  const created: SuggestionDto[] = [];
  created.push(...(await ruleRepeatedFailure()).slice(0, 2));
  created.push(...(await ruleFailedSchedule()).slice(0, 2));
  created.push(...(await ruleStaleProjectIndex()).slice(0, 2));
  created.push(...(await ruleDocsFollowUp()).slice(0, 1));
  // Jarvis #5 event triggers:
  created.push(...(await ruleDownloadsCleanup()).slice(0, 1));
  created.push(...(await ruleStuckTask()).slice(0, 1));
  return created;
}

/**
 * Rule 1 — a task failed twice or more: propose a diagnostic task (and,
 * when the failure smells like a build/test breakage, a recurring check).
 */
async function ruleRepeatedFailure(): Promise<SuggestionDto[]> {
  const failed = await db.agenticTask.findMany({
    where: { status: 'failed' },
    orderBy: { updatedAt: 'desc' },
    take: 40,
    select: { id: true, prompt: true, error: true, updatedAt: true },
  });
  // group by the first 60 chars of the prompt (a cheap "same objective" key)
  const groups = new Map<string, { count: number; prompt: string; lastError: string }>();
  for (const t of failed) {
    const key = t.prompt.slice(0, 60).toLowerCase();
    const g = groups.get(key) ?? { count: 0, prompt: t.prompt, lastError: t.error ?? '' };
    g.count++;
    if (t.error) g.lastError = t.error;
    groups.set(key, g);
  }
  const out: SuggestionDto[] = [];
  for (const [key, g] of groups) {
    if (g.count < 2) continue;
    const suggestion = await propose({
      kind: 'recurring_check',
      title: `Task failed ${g.count} times — recurring check banau?`,
      body:
        `"${g.prompt.slice(0, 120)}" ${g.count} baar fail hua hai. ` +
        'Ek recurring build/health check schedule karun ya diagnostic task chalau?',
      evidence: { failures: g.count, lastError: g.lastError.slice(0, 300) },
      actionPrompt:
        `Diagnose why this task keeps failing and propose a fix: "${g.prompt.slice(0, 400)}". ` +
        `Last error: ${g.lastError.slice(0, 500)}. Inspect the workspace, reproduce the failure, fix the root cause and verify with a real test.`,
      dedupeKey: `repeated-failure:${key}`,
    });
    if (suggestion) out.push(suggestion);
  }
  return out;
}

/** Rule 2 — a schedule failed recently: propose inspecting it. */
async function ruleFailedSchedule(): Promise<SuggestionDto[]> {
  const rows = await db.automationSchedule.findMany({
    where: { lastStatus: 'failed', enabled: true },
    take: 10,
  });
  const out: SuggestionDto[] = [];
  for (const s of rows) {
    const suggestion = await propose({
      kind: 'failed_schedule',
      title: `Schedule "${s.name}" fail ho gaya hai`,
      body:
        'Ek scheduled automation recently fail hui. Kya main uski report dekhne ka task create karun?',
      evidence: { scheduleId: s.id, scheduleName: s.name },
      actionPrompt:
        `Inspect the automation schedule "${s.name}" (id ${s.id}): read its recent runs from the audit log, ` +
        `find why it failed, and propose a concrete fix. Do not change the schedule itself without approval.`,
      dedupeKey: `failed-schedule:${s.id}`,
    });
    if (suggestion) out.push(suggestion);
  }
  return out;
}

/**
 * Rule 3 — a project index is stale (its files changed after indexing):
 * propose a refresh so the planner stays grounded in current code.
 */
async function ruleStaleProjectIndex(): Promise<SuggestionDto[]> {
  const docs = await db.knowledgeDoc.findMany({
    where: { source: 'project' },
    select: { sourceRoot: true, sourceMtime: true, sourceSize: true, path: true },
    take: 500,
  });
  const roots = new Map<string, { stale: number; total: number }>();
  for (const d of docs) {
    const r = roots.get(d.sourceRoot) ?? { stale: 0, total: 0 };
    r.total++;
    // cheap staleness heuristic: a doc whose mtime is 0/ancient relative to
    // the others in the same root is considered stale only when reported so;
    // a full fs stat belongs to the project-index module, not the scanner
    roots.set(d.sourceRoot, r);
  }
  const out: SuggestionDto[] = [];
  try {
    const { detectStaleFiles } = await import('./project-index');
    for (const [root, r] of roots) {
      if (r.total < 5) continue; // tiny indexes are not worth a suggestion
      const stale = await detectStaleFiles(root).catch(() => []);
      if (stale.length < 3) continue;
      const suggestion = await propose({
        kind: 'docs_update',
        title: `Project index stale hai (${stale.length} files changed)`,
        body:
          'The planner retrieves code from the project index, which is out of date. ' +
          'Kya main index refresh ka task create karun?',
        evidence: { root, staleFiles: stale.length, indexedFiles: r.total },
        actionPrompt: `Refresh the project index of "${root}" (re-index changed files) and report a summary of what changed.`,
        dedupeKey: `stale-index:${root}`,
      });
      if (suggestion) out.push(suggestion);
    }
  } catch {
    // project-index import failure — skip the rule silently
  }
  return out;
}

/** Rule 4 — a completed task changed many files: propose a docs update. */
async function ruleDocsFollowUp(): Promise<SuggestionDto[]> {
  const done = await db.agenticTask.findMany({
    where: { status: 'done' },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: { id: true, prompt: true, report: true, updatedAt: true },
  });
  const out: SuggestionDto[] = [];
  for (const t of done) {
    let changed = 0;
    try {
      const report = JSON.parse(t.report || '{}') as { changedFiles?: string[] };
      changed = report.changedFiles?.length ?? 0;
    } catch {
      changed = 0;
    }
    if (changed < 5) continue;
    const suggestion = await propose({
      kind: 'follow_up',
      title: `${changed} files change hue — documentation update?`,
      body:
        `"${t.prompt.slice(0, 100)}" ne ${changed} files change kiye. Kya main documentation ` +
        '(README / API docs) update karne ka task create karun?',
      evidence: { taskId: t.id, changedFiles: changed },
      actionPrompt:
        `Update the documentation for the changes made by task ${t.id} ("${t.prompt.slice(0, 300)}"): ` +
        `${changed} files changed. Review the diff summary, update README/API docs accordingly, and keep the docs factual.`,
      dedupeKey: `docs-follow-up:${t.id}`,
    });
    if (suggestion) out.push(suggestion);
    break; // one per scan is plenty
  }
  return out;
}

/**
 * Jarvis #5 event trigger — the Downloads folder is piling up. Reads ONLY
 * the configured downloads dir (never its file contents). One suggestion
 * per week per month-bucket so it never nags daily.
 */
async function ruleDownloadsCleanup(): Promise<SuggestionDto[]> {
  const fs = await import('fs');
  const path = await import('path');
  const dir = process.env.AGENTSCOPE_DOWNLOADS_DIR?.trim();
  if (!dir) return []; // not configured → stay silent
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // dir missing on this machine — fine
  }
  const oldFiles: string[] = [];
  const cutoff = Date.now() - 30 * 86_400_000; // 30+ days old
  for (const name of names.slice(0, 500)) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile() && st.mtimeMs < cutoff) oldFiles.push(name);
    } catch {
      /* raced delete — ignore */
    }
  }
  if (oldFiles.length < 40) return []; // only nag when it REALLY piled up
  const suggestion = await propose({
    kind: 'downloads_cleanup',
    title: `Downloads me ${oldFiles.length} purani files hain — saaf karun?`,
    body: `${dir} me 30 din se purani ${oldFiles.length} files padi hain. Main unhe "Downloads/Archive" folder me move kar sakta hoon (delete nahi — move only, approval ke saath).`,
    evidence: { dir, oldCount: oldFiles.length, sample: oldFiles.slice(0, 5) },
    actionPrompt:
      `Downloads folder (${dir}) me 30+ din purani files ko "Downloads/Archive" folder me move kar do ` +
      '(delete mat karo — sirf move). Har move action approval ke saath karna.',
    dedupeKey: `downloads-cleanup:${oldFiles.length >= 100 ? '100+' : '40-99'}`,
  });
  return suggestion ? [suggestion] : [];
}

/**
 * Jarvis #5 event trigger — a task is STUCK: status 'running' but no update
 * for 30+ minutes (a hung command, a lost bridge…). Suggest inspecting it.
 */
async function ruleStuckTask(): Promise<SuggestionDto[]> {
  const cutoff = new Date(Date.now() - 30 * 60_000);
  const stuck = await db.agenticTask.findFirst({
    where: { status: 'running', updatedAt: { lt: cutoff } },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, prompt: true, updatedAt: true },
  });
  if (!stuck) return [];
  const suggestion = await propose({
    kind: 'stuck_task',
    title: 'Ek task 30 minute se atka hua hai',
    body: `"${stuck.prompt.slice(0, 100)}" chal raha hai par pichhle 30 minute me koi update nahi. Pause/cancel karke dobara chalana behtar ho sakta hai.`,
    evidence: { taskId: stuck.id, lastUpdate: stuck.updatedAt.toISOString() },
    actionPrompt:
      `Task ${stuck.id} atka hua hai. Uska status check karo, zaroorat ho to cancel karke ` +
      `ye kaam dobara shuru karo: "${stuck.prompt.slice(0, 300)}"`,
    dedupeKey: `stuck-task:${stuck.id}`,
  });
  return suggestion ? [suggestion] : [];
}

/** User ACCEPTS a suggestion → it becomes the prompt of a new task (created by the API route). */
export async function acceptSuggestion(
  id: string
): Promise<{ ok: boolean; suggestion?: SuggestionDto; error?: string }> {
  const row = await db.proactiveSuggestion.findUnique({ where: { id } });
  if (!row) return { ok: false, error: 'Suggestion not found' };
  if (row.status !== 'open') {
    return { ok: false, error: `Suggestion is already ${row.status}` };
  }
  const updated = await db.proactiveSuggestion.update({
    where: { id },
    data: { status: 'accepted', decidedAt: new Date() },
  });
  return { ok: true, suggestion: toDto(updated) };
}

/** User DISMISSES a suggestion. */
export async function dismissSuggestion(id: string): Promise<boolean> {
  const res = await db.proactiveSuggestion.updateMany({
    where: { id, status: 'open' },
    data: { status: 'dismissed', decidedAt: new Date() },
  });
  return res.count > 0;
}

/**
 * Jarvis #5: "aage se mat batao" — mute the suggestion's kind. The open
 * suggestion is dismissed as well, so the panel clears in one click.
 */
export async function muteSuggestionKind(id: string): Promise<{ ok: boolean; kind?: string }> {
  const row = await db.proactiveSuggestion.findUnique({ where: { id } });
  if (!row) return { ok: false };
  await db.proactiveSuggestion.updateMany({
    where: { id, status: 'open' },
    data: { status: 'dismissed', decidedAt: new Date() },
  });
  const { muteKind } = await import('./proactive');
  await muteKind(row.kind);
  return { ok: true, kind: row.kind };
}
