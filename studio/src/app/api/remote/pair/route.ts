import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { cancelPairing, pairingView, startPairing, RemoteError } from '@/lib/agentic/remote-session';

export const runtime = 'nodejs';

/**
 * POST /api/remote/pair — the PC generates the 6-digit code the phone types.
 * Body (optional): { action: 'start' | 'cancel' }
 *
 * This route is PC-only: it needs the Studio's normal agentic auth, because
 * whoever can read this code can control the machine from a phone.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'remote.pair',
      category: 'security',
      result: 'error',
      errorCategory: 'unauthorized',
      error: 'Access denied',
      ip: clientIp(req.headers),
    }).catch(() => undefined);
    return denied;
  }
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? 'start').toLowerCase();
    if (action === 'cancel') {
      cancelPairing();
      await recordAudit({
        actor: 'user',
        action: 'remote.pair.cancel',
        category: 'security',
        ip: clientIp(req.headers),
      });
      return Response.json({ pairing: null });
    }
    const pairing = startPairing();
    await recordAudit({
      actor: 'user',
      action: 'remote.pair.start',
      category: 'security',
      details: { expiresAt: new Date(pairing.expiresAt).toISOString() },
      ip: clientIp(req.headers),
    });
    return Response.json({ pairing });
  } catch (err) {
    if (err instanceof RemoteError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Pairing failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** GET /api/remote/pair — the current code (the panel polls this). */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    return Response.json({ pairing: pairingView() });
  } catch (err) {
    if (err instanceof RemoteError) return Response.json({ pairing: null, reason: err.message });
    return Response.json({ pairing: null }, { status: 500 });
  }
}
