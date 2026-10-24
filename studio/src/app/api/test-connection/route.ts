import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { testProviderConnection } from '@/lib/agentic/provider-connection';
import { recordAudit, clientIp } from '@/lib/agentic/audit';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface TestBody {
  provider: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

// Makes a REAL minimal request to the provider to verify the connection works.
// The implementation lives in `provider-connection.ts` so that this route and
// `/api/providers/[id]/test` behave identically.
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as TestBody;
    const result = await testProviderConnection({
      provider: body.provider,
      apiKey: body.apiKey,
      model: body.model,
      baseUrl: body.baseUrl,
    });
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
