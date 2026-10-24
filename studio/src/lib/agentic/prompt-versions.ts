// prompt-versions.ts — SAFE self-editing / self-improvement (Feature 7).
//
// The agent may PROPOSE a change to a role's system prompt when it observes
// a repeated failure pattern. The safe workflow is enforced by design:
//
//   observe failure → propose (PENDING) → USER APPROVES → active
//   → rollback any time (the previous version is one click away)
//
// What the agent can NEVER do:
//   - activate its own prompt change (approval is user-only, via the API);
//   - edit anything except the ROLE PROMPTS — the safety policy lives in
//     permissions.ts / workspace.ts / terminal.ts, which have no version
//     override path at all;
//   - see or change the provider credentials.
//
// Every version is persisted with its rationale, so the user can review WHY
// the agent wanted the change before approving it.

import { db } from '@/lib/db';
import { ROLES, type RoleName } from './roles';
import { recordAudit } from './audit';
import { createNotification } from './notifications';

const EDITABLE_ROLES = new Set(Object.keys(ROLES) as string[]);

export interface PromptVersionDto {
  id: string;
  role: string;
  content: string;
  version: number;
  status: string;
  rationale: string;
  createdBy: string;
  approvedBy: string;
  createdAt: string;
}

function toDto(row: {
  id: string;
  role: string;
  content: string;
  version: number;
  status: string;
  rationale: string;
  createdBy: string;
  approvedBy: string;
  createdAt: Date;
}): PromptVersionDto {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    version: row.version,
    status: row.status,
    rationale: row.rationale,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The effective system prompt for a role: the ACTIVE version when one
 * exists, otherwise the built-in prompt. This is the ONLY read path the
 * engine uses, so an approved change takes effect on the next call without
 * a restart.
 */
export async function activePromptFor(role: string): Promise<string> {
  if (!EDITABLE_ROLES.has(role)) return ROLES[role as RoleName]?.systemPrompt ?? '';
  try {
    const row = await db.promptVersion.findFirst({
      where: { role, status: 'active' },
      orderBy: { version: 'desc' },
    });
    return row?.content ?? ROLES[role as RoleName].systemPrompt;
  } catch {
    // a DB hiccup must never break an LLM call — fall back to built-in
    return ROLES[role as RoleName].systemPrompt;
  }
}

/** Propose a prompt change (agent or user). Stored PENDING — never active by itself. */
export async function proposePromptVersion(input: {
  role: string;
  content: string;
  rationale: string;
  createdBy?: 'agent' | 'user';
}): Promise<PromptVersionDto> {
  const role = String(input.role ?? '').trim();
  if (!EDITABLE_ROLES.has(role)) {
    throw new Error(`Role "${role}" has no editable prompt (known: ${[...EDITABLE_ROLES].join(', ')})`);
  }
  const content = String(input.content ?? '').trim();
  if (content.length < 40) throw new Error('Prompt content must be at least 40 characters');
  if (content.length > 20_000) throw new Error('Prompt content is too long (max 20000 characters)');

  const active = await db.promptVersion.findFirst({
    where: { role, status: 'active' },
    orderBy: { version: 'desc' },
  });
  if (active && active.content === content) {
    throw new Error('This content is already the active prompt for this role');
  }
  const baseline = ROLES[role as RoleName].systemPrompt;
  if (!active && content === baseline) {
    throw new Error('This content is already the built-in prompt for this role');
  }

  const last = await db.promptVersion.findFirst({
    where: { role },
    orderBy: { version: 'desc' },
  });
  const row = await db.promptVersion.create({
    data: {
      role,
      content,
      version: (last?.version ?? 0) + 1,
      status: 'pending',
      rationale: String(input.rationale ?? '').slice(0, 2000),
      createdBy: input.createdBy ?? 'agent',
    },
  });
  await createNotification({
    type: 'system',
    title: `Prompt change proposed for "${role}"`,
    body:
      (input.rationale ?? '').slice(0, 300) +
      ' — Review and approve it in the Agent Registry (Prompt Versions).',
    data: { promptVersionId: row.id, role },
  });
  await recordAudit({
    actor: input.createdBy === 'agent' ? 'agent:reviewer' : 'user',
    action: 'prompt.propose',
    category: 'security',
    details: { promptVersionId: row.id, role, version: row.version },
  });
  return toDto(row);
}

export async function listPromptVersions(role?: string): Promise<PromptVersionDto[]> {
  const rows = await db.promptVersion.findMany({
    where: role ? { role } : undefined,
    orderBy: [{ role: 'asc' }, { version: 'desc' }],
    take: 200,
  });
  return rows.map(toDto);
}

/** Approve a PENDING version → it becomes the active prompt for the role. */
export async function approvePromptVersion(id: string): Promise<PromptVersionDto> {
  const row = await db.promptVersion.findUnique({ where: { id } });
  if (!row) throw new Error('Version not found');
  if (row.status !== 'pending') throw new Error(`Version is ${row.status}, not pending`);

  // deactivate the current active version of this role
  await db.promptVersion.updateMany({
    where: { role: row.role, status: 'active' },
    data: { status: 'rolled_back' },
  });
  const updated = await db.promptVersion.update({
    where: { id },
    data: { status: 'active', approvedBy: 'user', decidedAt: new Date() },
  });
  await recordAudit({
    actor: 'user',
    action: 'prompt.approve',
    category: 'security',
    approval: 'approved',
    details: { promptVersionId: id, role: row.role, version: row.version },
  });
  return toDto(updated);
}

/** Reject a PENDING version. */
export async function rejectPromptVersion(id: string): Promise<PromptVersionDto> {
  const updated = await db.promptVersion.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'rejected', decidedAt: new Date() },
  });
  if (!updated.count) throw new Error('Version not found or not pending');
  await recordAudit({
    actor: 'user',
    action: 'prompt.reject',
    category: 'security',
    approval: 'denied',
    details: { promptVersionId: id },
  });
  const row = await db.promptVersion.findUnique({ where: { id } });
  return toDto(row!);
}

/** Roll the role back to its BUILT-IN prompt (deactivates any active version). */
export async function rollbackPromptVersion(id: string): Promise<{ ok: boolean; toBuiltIn: boolean }> {
  const row = await db.promptVersion.findUnique({ where: { id } });
  if (!row) throw new Error('Version not found');
  if (row.status !== 'active') throw new Error('Only the active version can be rolled back');

  await db.promptVersion.update({
    where: { id },
    data: { status: 'rolled_back', decidedAt: new Date() },
  });
  await recordAudit({
    actor: 'user',
    action: 'prompt.rollback',
    category: 'security',
    details: { promptVersionId: id, role: row.role, toBuiltIn: true },
  });
  return { ok: true, toBuiltIn: true };
}
