import { NextRequest } from 'next/server';
import { exchangeGoogleCode } from '@/lib/agentic/connectors/google';
import { recordAudit, clientIp } from '@/lib/agentic/audit';

export const runtime = 'nodejs';
export const maxDuration = 60;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]!);
}

function page(title: string, body: string, ok: boolean): Response {
  const color = ok ? '#10b981' : '#ef4444';
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>body{font-family:system-ui,sans-serif;background:#09090b;color:#e4e4e7;display:grid;place-items:center;height:100vh;margin:0}
.card{max-width:520px;padding:32px;border:1px solid #27272a;border-radius:16px;background:#18181b}
h1{color:${color};font-size:18px;margin:0 0 12px}p{font-size:14px;line-height:1.6;color:#a1a1aa}</style></head>
<body><div class="card"><h1>${safeTitle}</h1><p>${safeBody}</p></div>
<script>setTimeout(()=>{window.close()},2500)</script></body></html>`,
    {
      status: ok ? 200 : 400,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    }
  );
}

/**
 * GET /api/connectors/google/callback — the OAuth redirect lands here.
 * Exchanges the code, stores the tokens encrypted, shows a small success
 * page that closes itself.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';

  // OAuth CSRF check (single-use): the code may only be exchanged by the
  // browser that started THIS connect flow. Consumed/absent/mismatched →
  // refuse BEFORE any token exchange.
  const expectedState = req.cookies.get('agentscope_oauth_state')?.value ?? '';
  const clearStateCookie =
    'agentscope_oauth_state=; HttpOnly; SameSite=Lax; Path=/api/connectors/google/callback; Max-Age=0';
  const stateOk = Boolean(expectedState) && expectedState === state;

  if (error) {
    const res = page(
      'Google connect failed',
      `Consent screen returned: ${error}. Dobara try karo (System panel → Connectors).`,
      false
    );
    res.headers.append('Set-Cookie', clearStateCookie);
    await recordAudit({
      actor: 'user',
      action: 'connectors.google.auth_error',
      category: 'security',
      approval: 'auto',
      result: 'error',
      error,
      details: {},
      ip: clientIp(req.headers),
    }).catch(() => undefined);
    return res;
  }
  if (!code) {
    const res = page('Google connect failed', 'No authorization code in the redirect.', false);
    res.headers.append('Set-Cookie', clearStateCookie);
    return res;
  }
  if (!stateOk) {
    const res = page(
      'Google connect failed',
      'OAuth state mismatch — flow adhura/purana hai. System panel se Connect dobara dabao.',
      false
    );
    res.headers.append('Set-Cookie', clearStateCookie);
    await recordAudit({
      actor: 'user',
      action: 'connectors.google.auth_error',
      category: 'security',
      approval: 'auto',
      result: 'error',
      error: 'oauth state mismatch',
      details: {},
      ip: clientIp(req.headers),
    }).catch(() => undefined);
    return res;
  }

  try {
    const { email } = await exchangeGoogleCode(code, req.nextUrl.origin);
    await recordAudit({
      actor: 'user',
      action: 'connectors.google.connected',
      category: 'security',
      approval: 'auto',
      result: 'ok',
      details: { account: email },
      ip: clientIp(req.headers),
    }).catch(() => undefined);
    const res = page(
      'Google connected ✓',
      `${email || 'Account'} connect ho gaya. Ye tab band ho jayegi — Studio ke System panel me status dikh raha hoga.`,
      true
    );
    res.headers.append('Set-Cookie', clearStateCookie);
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'token exchange failed';
    await recordAudit({
      actor: 'user',
      action: 'connectors.google.auth_error',
      category: 'security',
      approval: 'auto',
      result: 'error',
      error: msg,
      details: {},
      ip: clientIp(req.headers),
    }).catch(() => undefined);
    const res = page('Google connect failed', msg, false);
    res.headers.append('Set-Cookie', clearStateCookie);
    return res;
  }
}
