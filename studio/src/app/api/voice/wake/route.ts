import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { voiceCall, voiceBridgeStatus } from '@/lib/agentic/voice-bridge';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Jarvis #1 — wake word ("Hey Jarvis").
 *
 * GET            → bridge + wake engine status (hands-free panel)
 * POST {op}      → start | stop | pause | resume | status | consume
 *
 * The engine runs INSIDE the Python voice bridge (openWakeWord, offline,
 * mic frames never stored). The Studio polls `status` ~2 s while Hands-free
 * is on; `pending: true` means "Jarvis" fired → the UI opens the mic and
 * acknowledges with `consume`.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  const bridge = voiceBridgeStatus();
  const status = await voiceCall('/wake', { op: 'status' }, { timeoutMs: 8_000 });
  return Response.json({
    bridge,
    wake: status.ok ? status.data : null,
    error: status.ok ? undefined : status.error,
    hint: status.ok ? undefined : status.hint,
  });
}

export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  let body: { op?: string; sensitivity?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const op = String(body.op ?? '');

  // ops that change listening state are audit-logged
  const audit = async (ok: boolean, error?: string) =>
    recordAudit({
      actor: 'user',
      action: `voice.wake_${op}`,
      category: 'security',
      approval: 'auto',
      result: ok ? 'ok' : 'error',
      error,
      details: { sensitivity: body.sensitivity },
      ip: clientIp(req.headers),
    }).catch(() => undefined);

  const result = await voiceCall('/wake', { op, sensitivity: body.sensitivity }, { timeoutMs: 15_000 });
  if (op === 'start' || op === 'stop') {
    await audit(result.ok, result.ok ? undefined : result.error);
  }

  if (!result.ok) {
    return Response.json(
      { error: result.error || `wake ${op} failed`, hint: result.hint, killed: result.killed },
      { status: result.killed ? 423 : 502 }
    );
  }
  return Response.json(result.data ?? { ok: true });
}
