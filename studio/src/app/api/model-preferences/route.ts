import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  listModelPreferences,
  removeModelPreference,
  saveModelPreference,
  ProviderValidationError,
} from '@/lib/agentic/provider-store';

export const runtime = 'nodejs';

/** GET /api/model-preferences — per-agent-role model preferences. */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    return Response.json(await listModelPreferences());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list preferences';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** POST /api/model-preferences — set the model of one agent role. */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'model.preference.set',
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
    const pref = await saveModelPreference({
      role: body.role,
      provider: body.provider,
      model: body.model,
      enabled: body.enabled,
    });
    await recordAudit({
      actor: 'user',
      action: 'model.preference.set',
      category: 'provider',
      details: { role: pref.role, provider: pref.provider, model: pref.model },
      ip: clientIp(req.headers),
    });
    return Response.json(pref);
  } catch (err) {
    if (err instanceof ProviderValidationError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to save preference';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/model-preferences?role=planner — remove a role preference. */
export async function DELETE(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const role = searchParams.get('role') ?? '';
    const removed = await removeModelPreference(role);
    await recordAudit({
      actor: 'user',
      action: 'model.preference.remove',
      category: 'provider',
      details: { role, removed },
      ip: clientIp(req.headers),
    });
    return Response.json({ ok: true, removed });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to remove preference';
    return Response.json({ error: message }, { status: 500 });
  }
}
