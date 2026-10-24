import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { screenWatcher } from '@/lib/agentic/screen-awareness';

export const runtime = 'nodejs';

/**
 * GET /api/screen/watch — is JARVIS watching the screen right now?
 * Read-only status: frames, changes, paused reason, the last few hashes.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  return Response.json(screenWatcher().status());
}

/**
 * POST /api/screen/watch — start or stop continuous screen awareness.
 * Body: { action: 'start' | 'stop', intervalMs?, threshold? }
 *
 * Starting is an EXPLICIT user action (it captures the screen periodically),
 * it is audited, and it self-stops after 30 minutes.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'screen.watch',
      category: 'security',
      result: 'error',
      errorCategory: 'unauthorized',
      error: 'Access denied',
      ip: clientIp(req.headers),
    });
    return denied;
  }
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? '').toLowerCase();
    const watcher = screenWatcher();

    if (action === 'start') {
      const status = watcher.start();
      await recordAudit({
        actor: 'user',
        action: 'screen.watch.start',
        category: 'security',
        details: { intervalMs: status.settings.intervalMs, threshold: status.settings.threshold },
        ip: clientIp(req.headers),
      });
      return Response.json(status);
    }
    if (action === 'stop') {
      const status = watcher.stop();
      await recordAudit({
        actor: 'user',
        action: 'screen.watch.stop',
        category: 'security',
        details: { frames: status.frames, changes: status.changes },
        ip: clientIp(req.headers),
      });
      return Response.json(status);
    }
    return Response.json({ error: "action must be 'start' or 'stop'" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Screen watcher failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
