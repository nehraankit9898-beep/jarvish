import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
} from '@/lib/agentic/notifications';

export const runtime = 'nodejs';

/**
 * GET /api/notifications — the notification feed.
 *   ?unreadOnly=1 — only unread;  ?limit=50
 * Always includes the unread count.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const [notifications, unread] = await Promise.all([
      listNotifications({
        unreadOnly: searchParams.get('unreadOnly') === '1',
        limit: Number(searchParams.get('limit') ?? 50),
      }),
      unreadCount(),
    ]);
    return Response.json({ notifications, unread });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load notifications';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/notifications — mark read.
 *   { id }       — mark one notification read
 *   { all: true } — mark everything read
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => ({}));
    if (body.all === true) {
      const count = await markAllRead();
      return Response.json({ ok: true, marked: count });
    }
    if (typeof body.id === 'string' && body.id) {
      const ok = await markRead(body.id);
      if (!ok) return Response.json({ error: 'Notification not found' }, { status: 404 });
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'id or all is required' }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
