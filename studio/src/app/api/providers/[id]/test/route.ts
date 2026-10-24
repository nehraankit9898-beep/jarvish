import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { getProvider } from '@/lib/providers';
import { testProviderConnection } from '@/lib/agentic/provider-connection';
import { effectiveCredential } from '@/lib/agentic/provider-store';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/providers/[id]/test — "Test connection" for ONE stored provider.
 *
 * The Providers panel (src/components/studio/providers-panel.tsx) posts the
 * key/baseUrl/model the user is currently editing here. This route previously
 * DID NOT EXIST: `/api/route.ts` advertised it and `provider-connection.ts`
 * claimed it shared its implementation with `/api/test-connection`, but the
 * request fell through to the 404 page, so the panel's Test button could never
 * succeed.
 *
 * Body (all optional): { apiKey?, baseUrl?, model? }
 *   - a value in the body wins (the user is testing UNSAVED settings);
 *   - otherwise the credential stored on the server is used, so "Test" also
 *     works without retyping the key.
 *
 * The response is exactly what the panel reads: { ok, message, error,
 * model, errorCategory }.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'provider.test',
      category: 'security',
      result: 'error',
      errorCategory: 'unauthorized',
      error: 'Access denied',
      ip: clientIp(req.headers),
    }).catch(() => undefined);
    return denied;
  }

  const { id: providerId } = await params;
  const info = getProvider(providerId);
  if (!info) {
    return Response.json(
      { ok: false, error: `Unknown provider "${providerId}"`, errorCategory: 'config' },
      { status: 404 }
    );
  }

  let body: { apiKey?: unknown; baseUrl?: unknown; model?: unknown } = {};
  const raw = await req.text().catch(() => '');
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as typeof body;
      }
    } catch {
      return Response.json(
        { ok: false, error: 'Invalid JSON body', errorCategory: 'config' },
        { status: 400 }
      );
    }
  }

  const asString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;

  // Fall back to the server-side credential for anything the caller omitted:
  // testing the SAVED configuration is the common case.
  let storedKey: string | undefined;
  let storedBaseUrl: string | undefined;
  try {
    const cred = await effectiveCredential(providerId);
    storedKey = cred.apiKey || undefined;
    storedBaseUrl = cred.baseUrl || undefined;
  } catch {
    // no stored credential — a request-supplied key is then the only option
  }

  try {
    const result = await testProviderConnection({
      provider: providerId,
      apiKey: asString(body.apiKey) ?? storedKey,
      baseUrl: asString(body.baseUrl) ?? storedBaseUrl,
      model: asString(body.model),
    });

    await recordAudit({
      actor: 'user',
      action: 'provider.test',
      category: 'provider',
      result: result.ok ? 'ok' : 'error',
      errorCategory: result.errorCategory ?? '',
      error: result.error,
      details: {
        provider: providerId,
        model: result.model ?? asString(body.model) ?? '',
        usedStoredKey: !asString(body.apiKey) && Boolean(storedKey),
      },
      ip: clientIp(req.headers),
    }).catch(() => undefined);

    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    await recordAudit({
      actor: 'user',
      action: 'provider.test',
      category: 'provider',
      result: 'error',
      errorCategory: 'unknown',
      error: message,
      details: { provider: providerId },
      ip: clientIp(req.headers),
    }).catch(() => undefined);
    return Response.json({ ok: false, error: message, errorCategory: 'unknown' });
  }
}
