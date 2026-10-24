// audit.ts — append-only audit trail for privileged actions.
//
// Every privileged operation (task run, approval decision, provider change,
// tool invocation, automation run, memory/knowledge mutation) is recorded
// with: actor, agent id, task id, action type, timestamp, approval status,
// result + error category and artifact references.
//
// SECRET SAFETY: details are passed through the secret masker before they are
// stored, so an API key can never reach the audit table. The writer NEVER
// throws — a failing audit write must not break the action it describes (but
// the failure is reported on stderr so it is not silently swallowed).

import { db } from '@/lib/db';
import { redactUnknown } from './secrets';

export type AuditCategory =
  | 'security'
  | 'provider'
  | 'task'
  | 'tool'
  | 'automation'
  | 'memory'
  | 'knowledge'
  | 'general';

export type AuditApproval = 'auto' | 'approved' | 'denied' | 'n/a' | '';

export interface AuditInput {
  actor?: string;
  agentId?: string;
  taskId?: string;
  action: string;
  category?: AuditCategory;
  approval?: AuditApproval;
  result?: 'ok' | 'error';
  errorCategory?: string;
  error?: string;
  artifact?: unknown;
  details?: Record<string, unknown>;
  ip?: string;
}

export interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  agentId: string;
  taskId: string;
  action: string;
  category: string;
  approval: string;
  result: string;
  errorCategory: string;
  artifact: string;
  details: string;
  ip: string;
}

function redactDetails(details: Record<string, unknown> | undefined): string {
  if (!details) return '{}';
  try {
    const safe = redactUnknown(details) as Record<string, unknown>;
    for (const [key, value] of Object.entries(safe)) {
      if (typeof value === 'string') safe[key] = value.slice(0, 2000);
    }
    return JSON.stringify(safe);
  } catch {
    return '{}';
  }
}

/**
 * Write one audit row. Never throws — the caller keeps working even when the
 * audit write fails.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actor: (input.actor ?? 'user').slice(0, 120),
        agentId: (input.agentId ?? '').slice(0, 120),
        taskId: (input.taskId ?? '').slice(0, 64),
        action: (input.action ?? 'unknown').slice(0, 120),
        category: (input.category ?? 'general').slice(0, 40),
        approval: (input.approval ?? '').slice(0, 20),
        result: input.result ?? 'ok',
        errorCategory: (input.errorCategory ?? '').slice(0, 60),
        // H20: `details` are secret-masked, `artifact` was not — and an
        // artifact is exactly where a caller dumps "the thing I touched" (a
        // tool payload, a provider row, a request body). Mask it the same way.
        artifact: input.artifact
          ? JSON.stringify(redactUnknown(input.artifact)).slice(0, 4000)
          : '',
        details: redactDetails(input.details),
        ip: (input.ip ?? '').slice(0, 64),
      },
    });
  } catch (err) {
    console.error('[audit] failed to persist audit entry:', (err as Error)?.message);
  }
}

export interface AuditQuery {
  taskId?: string;
  category?: string;
  action?: string;
  limit?: number;
}

/** Read audit rows, newest first. */
export async function listAudit(query: AuditQuery = {}): Promise<AuditRecord[]> {
  const rows = await db.auditLog.findMany({
    where: {
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.action ? { action: query.action } : {}),
    },
    orderBy: { at: 'desc' },
    take: Math.min(500, Math.max(1, query.limit ?? 100)),
  });
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    actor: r.actor,
    agentId: r.agentId,
    taskId: r.taskId,
    action: r.action,
    category: r.category,
    approval: r.approval,
    result: r.result,
    errorCategory: r.errorCategory,
    artifact: r.artifact,
    details: r.details,
    ip: r.ip,
  }));
}

/** Remove audit rows (user-driven "clear log" action). */
export async function clearAudit(filter: { taskId?: string } = {}): Promise<number> {
  const res = await db.auditLog.deleteMany({
    where: filter.taskId ? { taskId: filter.taskId } : {},
  });
  return res.count;
}

/** Best-effort client IP for an audit entry. */
export function clientIp(headers: {
  get(name: string): string | null;
}): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim().slice(0, 64);
  return (headers.get('x-real-ip') ?? '').slice(0, 64);
}
