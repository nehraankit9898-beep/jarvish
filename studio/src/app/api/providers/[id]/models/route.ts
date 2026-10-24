import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { db } from '@/lib/db';
import { getProvider } from '@/lib/providers';
import {
  listProviderModels,
  type ProviderModel,
} from '@/lib/agentic/provider-connection';
import { effectiveCredential } from '@/lib/agentic/provider-store';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/providers/[id]/models — the models a provider offers.
 *
 * Tries the provider's LIVE model list first (using the stored key or the
 * request-supplied one); when the provider does not expose a model list the
 * static catalog is returned with `source: 'catalog'`.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id: provider } = await params;
    const info = getProvider(provider);
    if (!info) {
      return Response.json({ error: 'Unknown provider' }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const apiKey = searchParams.get('apiKey') ?? undefined;
    const baseUrl = searchParams.get('baseUrl') ?? undefined;

    let storedKey = '';
    let storedBaseUrl = '';
    try {
      const cred = await effectiveCredential(provider);
      storedKey = cred.apiKey ?? '';
      storedBaseUrl = cred.baseUrl ?? '';
    } catch {
      // no stored credential — the live list simply is not attempted
    }

    const live = await listProviderModels({
      provider,
      apiKey: apiKey ?? (storedKey || undefined),
      baseUrl: baseUrl ?? (storedBaseUrl || undefined),
    });

    if (live && live.models.length && !live.error) {
      return Response.json({ models: live.models, source: 'provider' });
    }

    // fall back to the static catalog
    const models: ProviderModel[] = info.models.map((m) => ({
      id: m,
      free: info.free,
    }));
    return Response.json({
      models,
      source: 'catalog',
      ...(live?.error ? { note: live.error } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not list models';
    return Response.json({ error: message }, { status: 500 });
  }
}
