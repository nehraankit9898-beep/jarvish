import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { listSessions, createSession, BrowserError } from '@/lib/agentic/browser/browser-service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** GET /api/browser — the live sessions. */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const sessions = await listSessions();
    return Response.json({ sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list sessions';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** POST /api/browser — open a new isolated browser session. Body: { taskId? } */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => ({}));
    const session = await createSession(String(body.taskId ?? ''));
    await recordAudit({
      actor: 'user',
      action: 'browser.session_create',
      category: 'tool',
      approval: 'auto',
      details: { sessionId: session.id },
      ip: clientIp(req.headers),
    });
    return Response.json(session, { status: 201 });
  } catch (err) {
    if (err instanceof BrowserError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to open session';
    return Response.json({ error: message }, { status: 500 });
  }
}
