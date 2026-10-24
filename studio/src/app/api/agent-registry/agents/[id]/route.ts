import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  getAgent,
  updateAgent,
  setAgentHealth,
  deleteAgent,
  type AgentHealthStatus,
} from '@/lib/agentic/agent-registry';

export const runtime = 'nodejs';

/** GET /api/agent-registry/agents/[id] — one registered runtime agent. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const agent = await getAgent(id);
    if (!agent) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }
    return Response.json(agent);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load agent';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** PUT /api/agent-registry/agents/[id] — update an agent (version bumped). */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'agent.update',
      category: 'security',
      result: 'error',
      errorCategory: 'unauthorized',
      error: 'Access denied',
      ip: clientIp(req.headers),
    });
    return denied;
  }
  try {
    const { id } = await params;
    const updates = await req.json();
    const result = await updateAgent(id, updates);
    if (!result.success) {
      return Response.json(
        { error: result.errors?.join(', ') ?? 'Update failed' },
        { status: 400 }
      );
    }
    await recordAudit({
      actor: 'user',
      action: 'agent.update',
      category: 'task',
      details: { agentId: id },
      ip: clientIp(req.headers),
    });
    return Response.json(result.agent);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** PATCH /api/agent-registry/agents/[id] — set the health status. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'agent.health',
      category: 'security',
      result: 'error',
      errorCategory: 'unauthorized',
      error: 'Access denied',
      ip: clientIp(req.headers),
    });
    return denied;
  }
  try {
    const { id } = await params;
    const body = await req.json();
    const health = String(body.healthStatus ?? '') as AgentHealthStatus;
    const ok = await setAgentHealth(id, health);
    if (!ok) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }
    return Response.json({ ok: true, healthStatus: health });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Health update failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/agent-registry/agents/[id] — remove an agent from the registry. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'agent.delete',
      category: 'security',
      result: 'error',
      errorCategory: 'unauthorized',
      error: 'Access denied',
      ip: clientIp(req.headers),
    });
    return denied;
  }
  try {
    const { id } = await params;
    const result = await deleteAgent(id);
    if (!result.success) {
      return Response.json(
        { error: result.errors?.join(', ') ?? 'Delete failed' },
        { status: 400 }
      );
    }
    await recordAudit({
      actor: 'user',
      action: 'agent.delete',
      category: 'task',
      details: { agentId: id },
      ip: clientIp(req.headers),
    });
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
