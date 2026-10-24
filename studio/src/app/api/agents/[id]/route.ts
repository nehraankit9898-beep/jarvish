import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';

export const runtime = 'nodejs';

/** PUT /api/agents/[id] — update a chat persona. */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await req.json();
    const existing = await db.agent.findUnique({ where: { id } });
    if (!existing) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }
    const agent = await db.agent.update({
      where: { id },
      data: {
        ...(typeof body.name === 'string' && body.name.trim()
          ? { name: body.name.trim() }
          : {}),
        ...(typeof body.emoji === 'string' ? { emoji: body.emoji } : {}),
        ...(typeof body.systemPrompt === 'string' ? { systemPrompt: body.systemPrompt } : {}),
        ...(typeof body.provider === 'string' ? { provider: body.provider } : {}),
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        ...(typeof body.temperature === 'number'
          ? { temperature: Math.min(2, Math.max(0, body.temperature)) }
          : {}),
        ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
      },
    });
    return Response.json(agent);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update agent';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/agents/[id] — remove a persona (conversations keep running). */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const existing = await db.agent.findUnique({ where: { id } });
    if (!existing) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }
    await db.agent.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete agent';
    return Response.json({ error: message }, { status: 500 });
  }
}
