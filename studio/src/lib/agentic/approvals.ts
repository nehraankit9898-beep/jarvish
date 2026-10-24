// approvals.ts — the approval gate for destructive commands.
//
// SECURITY MODEL
// --------------
// The engine stores the EXACT command it wants to run in
// `AgenticTask.pendingCommand`. Only that command may be approved by the
// user. A client that sends an arbitrary `approvedCommands` list must not be
// able to pre-authorise a destructive command the agent has not asked for —
// that would turn the approval gate into a no-op for anyone who can call the
// API.
//
// The comparison is exact (after trimming) because the approved command is
// executed verbatim: `rm -rf build` must not approve `rm -rf /`.

export interface PendingApproval {
  stepIndex: number;
  command: string;
  commandIndex: number;
  reason: string;
}

/**
 * The commands that may actually run.
 *
 * Returns the pending command when — and only when — it is part of the
 * requested list. Everything else is dropped.
 */
export function resolveApprovedCommands(
  pending: PendingApproval | null | undefined,
  requested: string[] | undefined | null
): string[] {
  const command = pending?.command?.trim();
  if (!command) return [];
  if (!Array.isArray(requested)) return [];
  const match = requested.some((c) => typeof c === 'string' && c.trim() === command);
  return match ? [command] : [];
}

/** Did the user approve the pending command? */
export function isApprovalGranted(
  pending: PendingApproval | null | undefined,
  requested: string[] | undefined | null
): boolean {
  return resolveApprovedCommands(pending, requested).length > 0;
}
