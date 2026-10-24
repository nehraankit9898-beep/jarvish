import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { voiceCall } from '@/lib/agentic/voice-bridge';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Jarvis #3 — natural voice. POST {text, voice?, rate?} → audio/mpeg.
 *
 * The text is sanitised SERVER-SIDE before synthesis (code blocks / tables
 * / markdown are never spoken — they are shown, not read). If the voice
 * bridge or edge-tts is unavailable the caller falls back to the browser's
 * built-in speechSynthesis (the client checks the response content type).
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  let body: { text?: string; voice?: string; rate?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const raw = String(body.text ?? '').trim();
  if (!raw) {
    return Response.json({ error: 'text is required' }, { status: 400 });
  }
  // hard cap — a whole essay is not a voice reply (the bridge re-caps at 3000)
  const text = raw.slice(0, 3000);

  const result = await voiceCall('/tts', {
    text,
    voice: body.voice,
    rate: body.rate,
  }, { raw: true, timeoutMs: 45_000 });

  if (!result.ok || !result.buffer) {
    await recordAudit({
      actor: 'system',
      action: 'voice.speak',
      category: 'general',
      approval: 'auto',
      result: 'error',
      error: result.error,
      details: { chars: text.length },
      ip: clientIp(req.headers),
    }).catch(() => undefined);
    return Response.json(
      {
        error: result.error || 'TTS synthesis failed',
        hint: result.hint,
        fallback: 'browser',
      },
      { status: 503 }
    );
  }

  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      'Content-Type': result.contentType ?? 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  });
}
