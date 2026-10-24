import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  approvePromptVersion,
  rejectPromptVersion,
  rollbackPromptVersion,
} from '@/lib/agentic/prompt-versions';

export const runtime = 'nodejs';

/**
 * POST /api/prompt-versions/[id] — act on a prompt version (Feature 7).
 *
 *   { action: 'approve' } — activate (USER-ONLY decision, audited)
 *   { action: 'reject' }  — reject the pending proposal
 *   { action: 'rollback' } — deactivate the active version → built-in prompt
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const action = body.action as 'approve' | 'reject' | 'rollback' | undefined;
    if (!action || !['approve', 'reject', 'rollback'].includes(action)) {
      return Response.json({ error: 'action must be approve | reject | rollback' }, { status: 400 });
    }

    let result;
    if (action === 'approve') result = await approvePromptVersion(id);
    else if (action === 'reject') result = await rejectPromptVersion(id);
    else result = await rollbackPromptVersion(id);

    await recordAudit({
      actor: 'user',
      action: `prompt.${action}`,
      category: 'security',
      approval: action === 'approve' ? 'approved' : action === 'reject' ? 'denied' : 'auto',
      details: { promptVersionId: id },
      ip: clientIp(req.headers),
    });
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    return Response.json({ error: message }, { status: 400 });
  }
}
