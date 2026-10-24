import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  googleConnectorStatus,
  googleOAuthConfigured,
  buildGoogleAuthUrl,
  disconnectGoogle,
} from '@/lib/agentic/connectors/google';

export const runtime = 'nodejs';

/** GET /api/connectors — connector status for the System panel. */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  const google = await googleConnectorStatus();
  return Response.json({ google });
}

/**
 * POST /api/connectors — user actions from the System panel.
 *   {op:'auth-url'}       → the Google consent URL (opened in a new tab)
 *   {op:'disconnect'}     → delete stored tokens
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  let body: { op?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const op = String(body.op ?? '');

  if (op === 'auth-url') {
    if (!googleOAuthConfigured()) {
      return Response.json(
        {
          error:
            'Google OAuth configured nahi hai. .env me AGENTSCOPE_GOOGLE_CLIENT_ID aur AGENTSCOPE_GOOGLE_CLIENT_SECRET bharo (docs/GOOGLE_CONNECTOR_SETUP.md).',
        },
        { status: 400 }
      );
    }
    // CSRF state — bound to THIS browser via an httpOnly cookie; the callback
    // refuses to exchange a code whose `state` does not match it. Without the
    // check an attacker could bind the victim's Studio to the ATTACKER's
    // Google account (login CSRF → prompt-injection into the agent's reads).
    const state = crypto.randomUUID();
    await recordAudit({
      actor: 'user',
      action: 'connectors.google.auth_start',
      category: 'security',
      approval: 'auto',
      result: 'ok',
      details: {},
      ip: clientIp(req.headers),
    }).catch(() => undefined);
    const res = Response.json({ url: buildGoogleAuthUrl(req.nextUrl.origin, state), state });
    res.headers.append(
      'Set-Cookie',
      `agentscope_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/api/connectors/google/callback; Max-Age=600`
    );
    return res;
  }

  if (op === 'disconnect') {
    await disconnectGoogle();
    await recordAudit({
      actor: 'user',
      action: 'connectors.google.disconnect',
      category: 'security',
      approval: 'auto',
      result: 'ok',
      details: {},
      ip: clientIp(req.headers),
    }).catch(() => undefined);
    return Response.json({ ok: true });
  }

  return Response.json({ error: `unknown op: ${op}` }, { status: 400 });
}
