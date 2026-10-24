import { NextRequest } from 'next/server';
import {
  listAgents,
  registerAgent,
  seedDefaultAgents,
} from '@/lib/agentic/agent-registry';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    await seedDefaultAgents();
    const agents = await listAgents();
    return Response.json(agents);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list agents';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'agent.register',
      category: 'security',
      result: 'error',
      errorCategory: 'unauthorized',
      error: 'Access denied',
      ip: clientIp(req.headers),
    });
    return denied;
  }
  try {
    const body = await req.json();
    const result = await registerAgent(body);
    if (!result.success) {
      return Response.json({ error: result.errors?.join(', ') }, { status: 400 });
    }
    await recordAudit({
      actor: 'user',
      action: 'agent.register',
      category: 'task',
      approval: 'auto',
      details: { agentId: result.agent?.id, name: result.agent?.name, role: result.agent?.role },
      ip: clientIp(req.headers),
    });
    return Response.json(result.agent, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to register agent';
    await recordAudit({
      actor: 'user',
      action: 'agent.register',
      category: 'task',
      result: 'error',
      errorCategory: 'exception',
      error: message,
      ip: clientIp(req.headers),
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
