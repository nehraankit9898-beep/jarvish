import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { readStudioSettings, writeStudioSettings } from '@/lib/agentic/provider-store';

export const runtime = 'nodejs';

/**
 * GET /api/settings — studio settings (free-only mode, auto fallback,
 * default provider/model).
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    return Response.json(await readStudioSettings());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read settings';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** POST /api/settings — update the studio settings. */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'settings.update',
      category: 'security',
      result: 'error',
      errorCategory: 'unauthorized',
      error: 'Access denied',
      ip: clientIp(req.headers),
    });
    return denied;
  }
  try {
    const body = await req.json();
    const settings = await writeStudioSettings({
      freeOnly: typeof body.freeOnly === 'boolean' ? body.freeOnly : undefined,
      preferFree: typeof body.preferFree === 'boolean' ? body.preferFree : undefined,
      autoFallback: typeof body.autoFallback === 'boolean' ? body.autoFallback : undefined,
      defaultProvider:
        typeof body.defaultProvider === 'string' ? body.defaultProvider : undefined,
      defaultModel: typeof body.defaultModel === 'string' ? body.defaultModel : undefined,
    });
    await recordAudit({
      actor: 'user',
      action: 'settings.update',
      category: 'provider',
      details: { ...settings },
      ip: clientIp(req.headers),
    });
    return Response.json(settings);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save settings';
    return Response.json({ error: message }, { status: 500 });
  }
}
