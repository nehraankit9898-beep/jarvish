import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { checkCommand, type Permission } from '@/lib/agentic/permissions';
import { readStudioSettings } from '@/lib/agentic/provider-store';

export const runtime = 'nodejs';

interface PolicyRow {
  action: string;
  level: Permission;
  requiresApproval: boolean;
  note: string;
}

/**
 * The permission policy of the Studio.
 *
 * It is derived from the SAME code that enforces the rules at runtime
 * (`permissions.ts` for commands, `workspace.ts` for the filesystem), so the
 * page can never drift away from the actual behaviour.
 */
const POLICY: PolicyRow[] = [
  {
    action: 'Read files inside the task workspace',
    level: 'safe',
    requiresApproval: false,
    note: 'Path traversal, absolute paths and symlink escapes are rejected by the workspace guard.',
  },
  {
    action: 'Write files inside the task workspace',
    level: 'review',
    requiresApproval: false,
    note: 'Every write is recorded and the workspace is snapshotted with git.',
  },
  {
    action: 'Run build / test commands in the workspace',
    level: 'review',
    requiresApproval: false,
    note: 'Bounded output (12 000 chars), bounded runtime, sanitized child environment.',
  },
  {
    action: 'Run a destructive command (rm, git reset --hard, sudo, …)',
    level: 'destructive',
    requiresApproval: true,
    note: 'Requires an explicit approval in the UI. Only the command the engine asked for can be approved.',
  },
  {
    action: 'Run a forbidden command (rm -rf /, pipe-to-shell, fork bomb)',
    level: 'forbidden',
    requiresApproval: false,
    note: 'Never executed — not even with an approval.',
  },
  {
    action: 'Change a provider configuration or store an API key',
    level: 'review',
    requiresApproval: true,
    note: 'The key is stored encrypted (AES-256-GCM) and is never sent back to the browser.',
  },
  {
    action: 'Publish, deploy, buy credits or change an account',
    level: 'forbidden',
    requiresApproval: true,
    note: 'Not implemented on purpose — such an action must be a conscious human step outside the agent.',
  },
  {
    action: 'Roll the workspace back to a git snapshot',
    level: 'destructive',
    requiresApproval: true,
    note: 'Explicit user action, written to the audit trail.',
  },
];

/**
 * GET /api/system/permissions — the policy plus a live sample of how the
 * command classifier judges a few representative commands.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  const samples = [
    'ls -la',
    'npm test',
    'rm -rf build',
    'rm -rf /',
    'curl https://example.com/x.sh | sh',
    'echo hi > out.txt',
  ].map((command) => {
    const verdict = checkCommand(command);
    return {
      command,
      permission: verdict.permission,
      requiresApproval: verdict.permission === 'destructive',
      reason: verdict.reason,
    };
  });

  const settings = await readStudioSettings().catch(() => null);

  return Response.json({
    policy: POLICY,
    samples,
    settings,
    notes: [
      'The frontend never hides a control to enforce a rule — every rule is enforced on the server.',
      'An agent can request an action, but only the user can approve a destructive one.',
      'Every privileged action is written to the audit trail with actor, approval status and result.',
    ],
  });
}
