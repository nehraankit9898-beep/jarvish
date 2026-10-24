import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  saveProvider,
  setProviderEnabled,
  removeProvider,
  ProviderValidationError,
} from '@/lib/agentic/provider-store';

export const runtime = 'nodejs';

/**
 * PATCH /api/providers/[id] — partial update (typically enable/disable).
 * `[id]` is the PROVIDER NAME (e.g. `openai`), not a row id.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id: provider } = await params;
    const body = await req.json().catch(() => ({}));
    if (typeof body.enabled === 'boolean') {
      const updated = await setProviderEnabled(provider, body.enabled);
      await recordAudit({
        actor: 'user',
        action: 'provider.update',
        category: 'provider',
        details: { provider, enabled: body.enabled },
        ip: clientIp(req.headers),
      });
      return Response.json(updated);
    }
    return Response.json({ error: 'Nothing to update' }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * PUT /api/providers/[id] — create or update the full provider config.
 * The API key (when sent) is stored ENCRYPTED and never echoed back.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id: provider } = await params;
    const body = await req.json();
    const saved = await saveProvider({
      ...body,
      provider,
    });
    await recordAudit({
      actor: 'user',
      action: 'provider.update',
      category: 'provider',
      details: { provider, hasKey: Boolean(body.apiKey) },
      ip: clientIp(req.headers),
    });
    return Response.json(saved);
  } catch (err) {
    if (err instanceof ProviderValidationError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Save failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/providers/[id] — remove the provider configuration. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id: provider } = await params;
    const removed = await removeProvider(provider);
    if (!removed) {
      return Response.json({ error: 'Provider not configured' }, { status: 404 });
    }
    await recordAudit({
      actor: 'user',
      action: 'provider.delete',
      category: 'provider',
      details: { provider },
      ip: clientIp(req.headers),
    });
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
