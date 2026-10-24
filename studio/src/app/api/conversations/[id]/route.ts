import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';

export const runtime = 'nodejs';

/** GET /api/conversations/[id] — one conversation with its messages. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const conversation = await db.conversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) {
      return Response.json({ error: 'Conversation not found' }, { status: 404 });
    }
    return Response.json(conversation);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load conversation';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/conversations/[id] — remove a conversation and its messages. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const existing = await db.conversation.findUnique({ where: { id } });
    if (!existing) {
      return Response.json({ error: 'Conversation not found' }, { status: 404 });
    }
    await db.conversation.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete conversation';
    return Response.json({ error: message }, { status: 500 });
  }
}
