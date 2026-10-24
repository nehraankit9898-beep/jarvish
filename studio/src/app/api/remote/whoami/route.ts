import { NextRequest } from 'next/server';
import { authenticate, RemoteError } from '@/lib/agentic/remote-session';
import { getPersona, readPersonaSettings } from '@/lib/agentic/persona';

export const runtime = 'nodejs';

function bearer(req: NextRequest): string {
  const auth = req.headers.get('authorization') ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers.get('x-remote-token')?.trim() ?? '';
}

/**
 * GET /api/remote/whoami — the phone checks whether its saved token is still
 * valid (after a reload / a PC restart) and gets the current character.
 */
export async function GET(req: NextRequest) {
  try {
    const session = authenticate(bearer(req));
    const settings = await readPersonaSettings().catch(() => null);
    const persona = settings ? getPersona(settings.personaId) : getPersona('jarvis');
    return Response.json({
      ok: true,
      session: { id: session.id, device: session.device.label, messages: session.messages },
      persona: { id: persona.id, name: persona.name, emoji: persona.emoji, greeting: persona.greeting },
    });
  } catch (err) {
    if (err instanceof RemoteError) {
      return Response.json({ ok: false, error: err.message, code: err.code }, { status: err.status });
    }
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
