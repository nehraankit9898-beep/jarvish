import { NextRequest } from 'next/server';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { redeemCode, REMOTE_LIMITS, RemoteError } from '@/lib/agentic/remote-session';
import { getPersona, readPersonaSettings } from '@/lib/agentic/persona';

export const runtime = 'nodejs';

/** A stable-ish key for the attempt throttle (no cookies needed). */
function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || req.headers.get('x-real-ip') || 'unknown-client';
}

/**
 * POST /api/remote/connect — the PHONE redeems the pairing code and gets a
 * session token.
 *
 * Deliberately NOT behind the Studio API token: a phone cannot carry it. The
 * pairing code + the attempt throttle + the TTL are the gate here.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  try {
    const body = await req.json().catch(() => ({}));
    const code = String(body?.code ?? '');
    if (!code) return Response.json({ error: 'Pairing code is required' }, { status: 400 });

    const { session } = redeemCode(
      code,
      {
        label: String(body?.label ?? 'Phone'),
        userAgent: req.headers.get('user-agent') ?? '',
        ip: clientKey(req),
      },
      clientKey(req)
    );

    const settings = await readPersonaSettings().catch(() => null);
    const persona = settings ? getPersona(settings.personaId) : getPersona('jarvis');

    await recordAudit({
      actor: 'remote',
      action: 'remote.connect',
      category: 'security',
      approval: 'approved',
      details: { sessionId: session.id, device: session.device.label, ip },
      ip,
    });

    return Response.json({
      token: session.token,
      sessionId: session.id,
      device: session.device.label,
      expiresInSec: Math.round(REMOTE_LIMITS.sessionIdleMs / 1000),
      persona: { id: persona.id, name: persona.name, emoji: persona.emoji, greeting: persona.greeting },
    });
  } catch (err) {
    if (err instanceof RemoteError) {
      await recordAudit({
        actor: 'remote',
        action: 'remote.connect',
        category: 'security',
        result: 'error',
        errorCategory: err.code,
        error: err.message,
        ip,
      }).catch(() => undefined);
      return Response.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return Response.json({ error: 'Pairing failed' }, { status: 500 });
  }
}
