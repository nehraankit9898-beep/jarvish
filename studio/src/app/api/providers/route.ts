import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  listProviderConfigs,
  listModelPreferences,
  providerRoutingOrder,
  readStudioSettings,
  saveProvider,
  ProviderValidationError,
} from '@/lib/agentic/provider-store';

export const runtime = 'nodejs';

/**
 * GET /api/providers
 *
 * The provider management view: every provider with its server-side
 * configuration. API keys are NEVER included — only `hasKey` and a
 * `keyHint` (last 4 characters).
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  try {
    const [providers, order, preferences, settings] = await Promise.all([
      listProviderConfigs(),
      providerRoutingOrder(),
      listModelPreferences(),
      readStudioSettings(),
    ]);
    return Response.json({ providers, order, preferences, settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list providers';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/providers — create or update a provider configuration.
 *
 * Body: { provider, label?, enabled?, priority?, baseUrl?, model?,
 *         timeoutMs?, maxRetries?, costClass?, apiKey?, clearKey? }
 *
 * The API key is stored ENCRYPTED and is never echoed back.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'provider.update',
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
    const dto = await saveProvider({
      provider: body.provider,
      label: body.label,
      enabled: body.enabled,
      priority: body.priority,
      baseUrl: body.baseUrl,
      model: body.model,
      timeoutMs: body.timeoutMs,
      maxRetries: body.maxRetries,
      costClass: body.costClass,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
      clearKey: body.clearKey === true,
    });
    await recordAudit({
      actor: 'user',
      action: 'provider.update',
      category: 'provider',
      approval: 'auto',
      details: {
        provider: dto.provider,
        enabled: dto.enabled,
        priority: dto.priority,
        keyChanged: Boolean(body.apiKey),
        keyCleared: body.clearKey === true,
      },
      ip: clientIp(req.headers),
    });
    return Response.json(dto);
  } catch (err) {
    if (err instanceof ProviderValidationError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to save provider';
    await recordAudit({
      actor: 'user',
      action: 'provider.update',
      category: 'provider',
      result: 'error',
      errorCategory: 'exception',
      error: message,
      ip: clientIp(req.headers),
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
