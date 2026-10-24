import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  getPersona,
  listPersonas,
  personaCatalog,
  personaVoiceGender,
  readPersonaSettings,
  writePersonaSettings,
  PersonaError,
} from '@/lib/agentic/persona';

export const runtime = 'nodejs';

/**
 * GET /api/persona — the character catalog plus the user's current choice.
 * The UI uses this to render the persona cards and the avatar.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const settings = await readPersonaSettings();
    const persona = getPersona(settings.personaId);
    return Response.json({
      ...personaCatalog(),
      settings,
      persona,
      voiceGender: personaVoiceGender(persona),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read the character settings';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/persona — save the character settings (persona, nickname, humour,
 * verbosity, language). Every change is audited; nothing else is touched.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'persona.update',
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
    const settings = await writePersonaSettings({
      personaId: typeof body.personaId === 'string' ? body.personaId : undefined,
      userTitle: typeof body.userTitle === 'string' ? body.userTitle : undefined,
      humor: typeof body.humor === 'number' ? body.humor : undefined,
      verbosity: typeof body.verbosity === 'number' ? body.verbosity : undefined,
      language: typeof body.language === 'string' ? body.language : undefined,
    });
    const persona = getPersona(settings.personaId);
    await recordAudit({
      actor: 'user',
      action: 'persona.update',
      category: 'general',
      details: { ...settings },
      ip: clientIp(req.headers),
    });
    return Response.json({ settings, persona, voiceGender: personaVoiceGender(persona), personas: listPersonas() });
  } catch (err) {
    if (err instanceof PersonaError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to save the character settings';
    return Response.json({ error: message }, { status: 500 });
  }
}
