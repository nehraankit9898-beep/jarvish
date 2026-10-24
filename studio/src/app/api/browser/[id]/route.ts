import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  navigate,
  click,
  fillForm,
  screenshot,
  readScreenshot,
  takeControl,
  releaseControl,
  closeSession,
  readPage,
  getSessionIntel,
  BrowserError,
} from '@/lib/agentic/browser/browser-service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GET /api/browser/[id] — the session state.
 *   ?include=screenshot — attach the latest screenshot as base64.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const row = await db.browserSession.findUnique({ where: { id } });
    if (!row) return Response.json({ error: 'Session not found' }, { status: 404 });
    const { searchParams } = new URL(req.url);
    const includeShot = searchParams.get('include') === 'screenshot';
    return Response.json({
      id: row.id,
      taskId: row.taskId,
      status: row.status,
      currentUrl: row.currentUrl,
      pageTitle: row.pageTitle,
      userHold: row.userHold,
      lastScreenshot: row.lastScreenshot,
      ...(includeShot ? { screenshotBase64: await readScreenshot(id) } : {}),
      intel: await getSessionIntel(id),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load session';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/browser/[id] — act on a session (user actions only; the agent
 * goes through the tool registry where takeover + payment guard apply).
 *
 *   { action: 'navigate', url }
 *   { action: 'read' }                        — re-analyse the page
 *   { action: 'screenshot' }                  — fresh screenshot (base64 back)
 *   { action: 'click', target, confirmPayment? } — confirmPayment is the
 *     USER's payment confirmation (the agent can never set it)
 *   { action: 'fill', fields: [{selector, value}] }
 *   { action: 'takeover' }                    — Feature 12: agent locked out
 *   { action: 'release' }                     — Resume Agent (page re-inspected)
 *   { action: 'close' }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      url?: string;
      target?: string;
      confirmPayment?: boolean;
      fields?: Array<{ selector?: string; value?: string }>;
    };
    const action = String(body.action ?? '');

    switch (action) {
      case 'navigate': {
        const intel = await navigate(id, String(body.url ?? ''), { actor: 'user' });
        return Response.json({ ok: true, intel });
      }
      case 'read': {
        const intel = await readPage(id);
        return Response.json({ ok: true, intel });
      }
      case 'screenshot': {
        const shot = await screenshot(id);
        return Response.json({ ok: true, path: shot.path, base64: shot.base64 });
      }
      case 'click': {
        const result = await click(id, String(body.target ?? ''), {
          actor: 'user',
          confirmPayment: body.confirmPayment === true,
        });
        return Response.json(result);
      }
      case 'fill': {
        const result = await fillForm(
          id,
          (body.fields ?? []).map((f) => ({
            selector: String(f.selector ?? ''),
            value: String(f.value ?? ''),
          })),
          { actor: 'user' }
        );
        return Response.json(result);
      }
      case 'takeover': {
        const result = await takeControl(id);
        await recordAudit({
          actor: 'user',
          action: 'browser.takeover',
          category: 'security',
          approval: 'auto',
          details: { sessionId: id },
          ip: clientIp(req.headers),
        });
        return Response.json(result);
      }
      case 'release': {
        const result = await releaseControl(id);
        return Response.json(result);
      }
      case 'close': {
        const result = await closeSession(id);
        return Response.json(result);
      }
      default:
        return Response.json(
          { error: 'action must be navigate | read | screenshot | click | fill | takeover | release | close' },
          { status: 400 }
        );
    }
  } catch (err) {
    if (err instanceof BrowserError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Action failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
