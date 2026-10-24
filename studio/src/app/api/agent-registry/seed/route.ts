import { NextRequest } from 'next/server';
import { seedDefaultAgents } from '@/lib/agentic/agent-registry';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'agent.seed',
      category: 'security',
      result: 'error',
      errorCategory: 'unauthorized',
      error: 'Access denied',
      ip: clientIp(req.headers),
    });
    return denied;
  }
  try {
    await seedDefaultAgents();
    const { listAgents } = await import('@/lib/agentic/agent-registry');
    const agents = await listAgents();
    await recordAudit({
      actor: 'user',
      action: 'agent.seed',
      category: 'task',
      details: { count: agents.length },
      ip: clientIp(req.headers),
    });
    return Response.json({ ok: true, agents, count: agents.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to seed agents';
    return Response.json({ error: message }, { status: 500 });
  }
}
