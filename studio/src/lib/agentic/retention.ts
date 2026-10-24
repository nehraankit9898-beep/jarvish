// retention.ts — bounded growth for the audit trail and the agent transcript.
//
// The audit log and the per-task agent-message / event history are append-only
// by design (they are the evidence trail). Nothing ever removed them, so a
// long-running Studio grew the SQLite file without limit — `AgentMessage`
// stores the full text of every agent hand-off and `AgentEvent` stores every
// streamed event.
//
// This module adds an OPT-IN, deliberately conservative cleanup:
//
//   * DISABLED BY DEFAULT (`AGENTSCOPE_RETENTION_DAYS` unset or 0). Deleting a
//     user's history must be a decision, never a surprise.
//   * SECURITY AUDIT ROWS ARE NEVER PRUNED. Approval decisions, denials,
//     kill-switch events and unauthorised-access attempts are exactly what an
//     audit trail exists for; the path that removes "app" noise must not touch
//     them.
//   * ACTIVE TASK STATE IS NEVER PRUNED. Rows belonging to a task that is
//     still queued/running/paused/blocked/awaiting approval are kept, whatever
//     their age — a cleanup pass must not delete the records of a run that is
//     still in flight, nor anything the user may still resume.
//   * The cut-off is computed from `createdAt`, and the policy is reported by
//     `retentionStatus()` so the UI/status endpoint can show what is active.

import { db } from '@/lib/db';

/** Task statuses whose records may be pruned. */
const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];

export interface RetentionPolicy {
  /** delete records older than this many days; 0 = retention disabled */
  days: number;
  /** keep every audit row in the `security` category (always true in practice) */
  keepSecurityAudit: boolean;
  /** keep the audit row of every approval/denial, whatever the category */
  keepApprovalDecisions: boolean;
}

export interface RetentionResult {
  enabled: boolean;
  cutoff: string | null;
  auditRemoved: number;
  agentMessagesRemoved: number;
  agentEventsRemoved: number;
}

const MIN_DAYS = 1;
const MAX_DAYS = 3650;

/**
 * Read the policy from the environment.
 *
 * `AGENTSCOPE_RETENTION_DAYS`  days to keep (0/unset = disabled).
 *
 * Security-category audit rows and every approval/denial decision are always
 * kept, whatever the value.
 */
export function retentionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const raw = Number((env.AGENTSCOPE_RETENTION_DAYS ?? '').trim());
  const days = Number.isFinite(raw) && raw >= MIN_DAYS ? Math.min(MAX_DAYS, Math.floor(raw)) : 0;
  return {
    days,
    keepSecurityAudit: true,
    keepApprovalDecisions: true,
  };
}

export function retentionStatus(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  days: number;
  keepSecurityAudit: boolean;
  keepApprovalDecisions: boolean;
} {
  const policy = retentionPolicyFromEnv(env);
  return {
    enabled: policy.days > 0,
    days: policy.days,
    keepSecurityAudit: policy.keepSecurityAudit,
    keepApprovalDecisions: policy.keepApprovalDecisions,
  };
}

/**
 * Delete records older than the policy allows.
 *
 * Safe to call repeatedly and concurrently (every statement is a bounded
 * `deleteMany` on a date range). Returns what it removed — never assumes.
 */
export async function pruneOldRecords(
  policy: RetentionPolicy = retentionPolicyFromEnv(),
  now: Date = new Date()
): Promise<RetentionResult> {
  if (policy.days < MIN_DAYS) {
    return {
      enabled: false,
      cutoff: null,
      auditRemoved: 0,
      agentMessagesRemoved: 0,
      agentEventsRemoved: 0,
    };
  }

  const cutoffDate = new Date(now.getTime() - policy.days * 24 * 60 * 60 * 1000);
  const cutoff = cutoffDate.toISOString();

  // Which tasks may lose their transcript? Only finished ones. The inverse
  // (NOT IN terminal) also covers a brand-new row, so a task that starts just
  // as the sweep runs can never be caught in the middle.
  const activeTasks = await db.agenticTask.findMany({
    where: { status: { notIn: TERMINAL_TASK_STATUSES } },
    select: { id: true },
  });
  const protectedTaskIds = activeTasks.map((t) => t.id);

  const auditWhere: Record<string, unknown> = { at: { lt: cutoffDate } };
  if (policy.keepSecurityAudit) auditWhere.category = { not: 'security' };
  if (policy.keepApprovalDecisions) {
    // `approval` != 'n/a' marks a human decision (approved/denied)
    auditWhere.approval = 'n/a';
  }
  const audit = await db.auditLog.deleteMany({ where: auditWhere });

  const messageWhere: Record<string, unknown> = { createdAt: { lt: cutoffDate } };
  if (protectedTaskIds.length) messageWhere.taskId = { notIn: protectedTaskIds };
  const agentMessages = await db.agentMessage.deleteMany({ where: messageWhere });

  const eventWhere: Record<string, unknown> = { createdAt: { lt: cutoffDate } };
  if (protectedTaskIds.length) eventWhere.taskId = { notIn: protectedTaskIds };
  const agentEvents = await db.agentEvent.deleteMany({ where: eventWhere });

  return {
    enabled: true,
    cutoff,
    auditRemoved: audit.count,
    agentMessagesRemoved: agentMessages.count,
    agentEventsRemoved: agentEvents.count,
  };
}
