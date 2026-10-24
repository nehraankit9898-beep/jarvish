import { NextRequest } from 'next/server';
import { voiceCall } from '@/lib/agentic/voice-bridge';
import { authenticate, RemoteError } from '@/lib/agentic/remote-session';
import { speechReady } from '@/lib/agentic/remote-chat';

export const runtime = 'nodejs';
export const maxDuration = 60;

function bearer(req: NextRequest): string {
  const auth = req.headers.get('authorization') ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers.get('x-remote-token')?.trim() ?? '';
}

/**
 * POST /api/remote/speak — TTS for the phone, authenticated by the REMOTE
 * session token (the phone cannot carry the Studio API token).
 *
 * Body: { text }  → audio/mpeg. When the voice bridge is unavailable the
 * phone falls back to its own speechSynthesis (the client checks the type).
 */
export async function POST(req: NextRequest) {
  try {
    authenticate(bearer(req));
  } catch (err) {
    if (err instanceof RemoteError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { text?: string; voice?: string };
  const text = speechReady(String(body?.text ?? ''), 800);
  if (!text) return Response.json({ error: 'text is required' }, { status: 400 });

  const result = await voiceCall('/tts', { text, voice: body?.voice }, { raw: true, timeoutMs: 45_000, signal: req.signal });
  if (!result.ok || !result.buffer) {
    // the phone speaks the text itself; this is not an error the user must fix
    return Response.json({ fallback: 'browser', error: result.error }, { status: 503 });
  }
  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'Content-Length': String(result.buffer.length),
    },
  });
}
