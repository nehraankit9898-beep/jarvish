import { NextRequest } from 'next/server';
import { connectionRequestSchema } from '@/lib/connection-request';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { testProviderConnection } from '@/lib/agentic/provider-connection';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { recordConnectionResult } from '@/lib/agentic/provider-store';
import { recordLastError } from '@/lib/agentic/last-action-error';
import { getProvider } from '@/lib/providers';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Makes a REAL minimal request to the provider to verify the connection works.
// The implementation lives in `provider-connection.ts` so that this route and
// `/api/providers/[id]/test` behave identically.
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    let raw: unknown;
    try { raw = await req.json(); } catch {
      return Response.json({ ok: false, error: 'Invalid JSON body', errorCategory: 'config' }, { status: 400 });
    }
    const parsed = connectionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'A valid provider and string connection settings are required', errorCategory: 'config' }, { status: 400 });
    }
    const body = parsed.data;
    const result = await testProviderConnection({
      provider: body.provider,
      apiKey: body.apiKey,
      model: body.model,
      baseUrl: body.baseUrl,
    });
    // The test result must be PERSISTED (it was computed and thrown away
    // before, so the Providers panel could never show "verified").
    await recordConnectionResult(body.provider, result.ok, result.error ?? '').catch(
      () => undefined
    );
    if (!result.ok) {
      recordLastError({
        what: `${getProvider(body.provider)?.name ?? body.provider} connection test`,
        category: String(result.errorCategory ?? 'unknown'),
        message: result.error ?? '',
        hint: result.hint,
        secrets: body.apiKey ? [body.apiKey] : [],
      });
    }
    await recordAudit({
      actor: 'user',
      action: 'provider.test',
      category: 'provider',
      result: result.ok ? 'ok' : 'error',
      errorCategory: result.errorCategory ?? '',
      error: result.error,
      details: { provider: body.provider, model: body.model },
      ip: clientIp(req.headers),
    });
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    return Response.json({ ok: false, error: message, errorCategory: 'unknown' });
  }
}
