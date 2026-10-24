import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';

export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const conversations = await db.conversation.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { messages: true } } },
    });
    return Response.json(conversations);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load conversations';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => ({}));
    const conversation = await db.conversation.create({
      data: {
        title: body.title || 'New Chat',
        agentId: body.agentId || null,
      },
    });
    return Response.json(conversation, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create conversation';
    return Response.json({ error: message }, { status: 500 });
  }
}
