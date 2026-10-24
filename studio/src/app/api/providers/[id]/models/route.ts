import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import {
  getProvider,
  modelNote,
  isLegacyModel,
  resolveModelWithNotice,
} from '@/lib/providers';
import {
  catalogModels,
  listProviderModels,
  providerNeedsKey,
  type ProviderModel,
} from '@/lib/agentic/provider-connection';
import { effectiveCredential } from '@/lib/agentic/provider-store';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/providers/[id]/models — the chat-capable models a provider offers.
 *
 * The list comes from the PROVIDER (live) whenever possible; the static
 * catalog is only a labelled fallback. The response always says where the
 * list came from, so the UI can never present a cached/offline list as a live
 * result (spec §5):
 *
 *   { models, source: 'provider' | 'cache' | 'catalog', fetchedAt, cached,
 *     chatOnly, filteredOut, note?, error?, selected, selectedNotice? }
 *
 * Query: ?refresh=1 bypasses the 10-minute cache, ?all=1 includes non-chat
 * models (embeddings, TTS, image) for power users.
 */
interface ModelQuery {
  refresh?: boolean;
  includeAll?: boolean;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

async function respond(provider: string, query: ModelQuery) {
  const info = getProvider(provider);
  if (!info) {
    return Response.json({ error: 'Unknown provider' }, { status: 404 });
  }

  const refresh = query.refresh === true;
  const includeAll = query.includeAll === true;
  const requestedModel = query.model;
  const selected = resolveModelWithNotice(info, requestedModel);

  // A request-supplied key is only for the CURRENT edit; otherwise the stored
  // (encrypted) credential is used so refresh works without retyping.
  let apiKey = query.apiKey ?? '';
  let baseUrl = query.baseUrl ?? '';
  if (!apiKey || !baseUrl) {
    try {
      const cred = await effectiveCredential(provider, {
        apiKey: apiKey || undefined,
        baseUrl: baseUrl || undefined,
      });
      apiKey = apiKey || cred.apiKey;
      baseUrl = baseUrl || cred.baseUrl;
    } catch {
      // no stored credential — the live list is simply not attempted
    }
  }

  const live = await listProviderModels({
    provider,
    apiKey: apiKey || undefined,
    baseUrl: baseUrl || undefined,
    refresh,
    includeNonChat: includeAll,
  });

  const decorate = (m: ProviderModel) => ({
    ...m,
    note: modelNote(info, m.id),
    legacy: isLegacyModel(info, m.id),
  });

  if (live && live.models.length && !live.error) {
    const chatOnly = live.models.filter((m) => m.chat !== false);
    const offered = includeAll ? live.models : chatOnly;
    return Response.json({
      models: offered.map(decorate),
      source: live.source, // 'provider' (fresh) or 'cache' (10-min cached copy)
      cached: live.source === 'cache',
      fetchedAt: live.fetchedAt,
      chatOnly: !includeAll,
      filteredOut: live.models.length - chatOnly.length,
      provider: provider,
      selected: selected.model,
      ...(selected.notice ? { selectedNotice: selected.notice } : {}),
      ...(providerNeedsKey(provider) && !apiKey
        ? { note: 'A live list needs an API key — showing the saved/static catalog instead.' }
        : {}),
    });
  }

  // Fallback: the static catalogue. Explicitly labelled — never "live".
  const catalog = catalogModels(provider).map(decorate);
  return Response.json({
    models: includeAll ? catalog : catalog.filter((m) => m.chat !== false),
    source: 'catalog',
    cached: false,
    fetchedAt: null,
    chatOnly: !includeAll,
    filteredOut: 0,
    provider,
    selected: selected.model,
    ...(selected.notice ? { selectedNotice: selected.notice } : {}),
    note:
      live?.error ??
      (providerNeedsKey(provider) && !apiKey
        ? 'No API key saved — this is the built-in catalog, not a live list.'
        : 'The provider did not return a live model list — this is the built-in catalog.'),
    error: live?.error,
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  return respond(id, {
    refresh: searchParams.get('refresh') === '1',
    includeAll: searchParams.get('all') === '1',
    model: searchParams.get('model') ?? undefined,
    apiKey: searchParams.get('apiKey') ?? undefined,
    baseUrl: searchParams.get('baseUrl') ?? undefined,
  });
}

/**
 * POST — same discovery, but the UNSAVED key/baseUrl travel in the body.
 * A key must never be put in a URL: query strings end up in server logs,
 * proxy logs and browser history.
 *
 * Body: { apiKey?, baseUrl?, model?, refresh?, all? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  const { id } = await params;
  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // an empty body is fine — the stored credential is used
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return respond(id, {
    refresh: body.refresh === true,
    includeAll: body.all === true,
    model: str(body.model),
    apiKey: str(body.apiKey),
    baseUrl: str(body.baseUrl),
  });
}
