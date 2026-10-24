import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { revoke, revokeAll, revokeById } from '@/lib/agentic/remote-session';
import { clearRemoteHistory } from '@/lib/agentic/remote-chat';

export const runtime = 'nodejs';

/**
 * POST /api/remote/revoke — the PC hangs up.
 * Body: { token, sessionId } to drop one device, or { all: true } to drop all.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));

  if (body?.all === true) {
    const count = revokeAll();
    await recordAudit({
      actor: 'user',
      action: 'remote.revoke.all',
      category: 'security',
      details: { count },
      ip: clientIp(req.headers),
    });
    return Response.json({ revoked: count });
  }

  const sessionId = String(body?.sessionId ?? '').trim();
  if (sessionId) {
    const ok = revokeById(sessionId);
    if (ok) clearRemoteHistory(sessionId);
    await recordAudit({
      actor: 'user',
      action: 'remote.revoke',
      category: 'security',
      result: ok ? 'ok' : 'error',
      details: { sessionId, revoked: ok },
      ip: clientIp(req.headers),
    });
    return Response.json({ revoked: ok ? 1 : 0 });
  }

  const token = String(body?.token ?? '');
  if (!token) return Response.json({ error: 'sessionId or token is required (or { all: true })' }, { status: 400 });
  const ok = revoke(token);
  if (ok) clearRemoteHistory(String(body?.sessionId ?? ''));
  await recordAudit({
    actor: 'user',
    action: 'remote.revoke',
    category: 'security',
    result: ok ? 'ok' : 'error',
    details: { revoked: ok },
    ip: clientIp(req.headers),
  });
  return Response.json({ revoked: ok ? 1 : 0 });
}
