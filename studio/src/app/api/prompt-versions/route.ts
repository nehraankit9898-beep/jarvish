import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  listPromptVersions,
  proposePromptVersion,
} from '@/lib/agentic/prompt-versions';

export const runtime = 'nodejs';

/**
 * GET /api/prompt-versions — the prompt version history.
 *   ?role=planner — one role;  empty = every role.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const role = searchParams.get('role') ?? undefined;
    const versions = await listPromptVersions(role || undefined);
    return Response.json({ versions });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load prompt versions';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/prompt-versions — propose a prompt change (Feature 7).
 *
 * Body: { role, content, rationale, createdBy? }
 * The version is stored PENDING — it becomes active only through the
 * explicit user approval on POST /api/prompt-versions/[id] {action:'approve'}.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const version = await proposePromptVersion({
      role: body.role,
      content: body.content,
      rationale: body.rationale,
      createdBy: body.createdBy === 'agent' ? 'agent' : 'user',
    });
    await recordAudit({
      actor: body.createdBy === 'agent' ? 'agent:reviewer' : 'user',
      action: 'prompt.propose',
      category: 'security',
      details: { promptVersionId: version.id, role: version.role },
      ip: clientIp(req.headers),
    });
    return Response.json(version, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proposal failed';
    return Response.json({ error: message }, { status: 400 });
  }
}
