import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import {
  hostMode,
  trustedDirs,
  listPendingHostActions,
  requestHostAction,
  resolveHostApproval,
  type HostAction,
} from '@/lib/agentic/host-control';

export const runtime = 'nodejs';
export const maxDuration = 130;

/** GET — control mode, trusted folders and the approvals waiting for the user. */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  return Response.json({
    mode: hostMode(),
    trustedDirs: trustedDirs(),
    pending: listPendingHostActions(),
  });
}

/**
 * POST — the USER's door.
 *   { op: 'request', action }   run / queue / refuse a laptop action
 *   { op: 'approve', id }       execute the stored action verbatim
 *   { op: 'deny', id }          drop it
 * `approve` is only reachable here (same-origin + optional token), never as an agent tool.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  let body: { op?: string; action?: HostAction; id?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  if (body.op === 'request') {
    if (!body.action || typeof body.action !== 'object' || typeof (body.action as { kind?: unknown }).kind !== 'string') {
      return Response.json({ error: 'action is required' }, { status: 400 });
    }
    return Response.json(await requestHostAction(body.action, 'user'));
  }

  if (body.op === 'approve' || body.op === 'deny') {
    if (!body.id || typeof body.id !== 'string') {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }
    const out = await resolveHostApproval(body.id, body.op === 'approve', 'user');
    return Response.json(out, { status: out.ok ? 200 : 404 });
  }

  return Response.json({ error: "op must be 'request', 'approve' or 'deny'" }, { status: 400 });
}
