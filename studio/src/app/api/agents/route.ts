import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';

export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const agents = await db.agent.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return Response.json(agents);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load agents';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    if (!body.name?.trim()) {
      return Response.json({ error: 'Name is required' }, { status: 400 });
    }
    const agent = await db.agent.create({
      data: {
        name: body.name.trim(),
        emoji: body.emoji || '🤖',
        systemPrompt: body.systemPrompt || 'You are a helpful AI assistant.',
        provider: body.provider || 'zai',
        model: body.model || '',
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
      },
    });
    return Response.json(agent, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create agent';
    return Response.json({ error: message }, { status: 500 });
  }
}
