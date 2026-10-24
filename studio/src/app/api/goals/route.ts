import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { listGoals, createGoal } from '@/lib/agentic/goals';
import { decomposeGoal } from '@/lib/agentic/orchestrator';
import type { CredentialMap, AgentRoutingConfig } from '@/lib/agentic/agent-config';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** GET /api/goals — all goals with their task progress. */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const goals = await listGoals();
    return Response.json({ goals });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load goals';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/goals — create a long-running goal.
 *
 * Body: { title, description, agentConfig?, credentials? }
 *
 * The PLANNER decomposes the goal into task prompts (one LLM call); the
 * tasks are then started one by one via POST /api/goals/[id] {action:'next'}.
 * Nothing runs automatically at creation time.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as {
      title?: string;
      description?: string;
      agentConfig?: AgentRoutingConfig;
      credentials?: CredentialMap;
    };
    const title = String(body.title ?? '').trim();
    const description = String(body.description ?? '').trim();
    if (title.length < 4) {
      return Response.json({ error: 'Title must be at least 4 characters' }, { status: 400 });
    }
    if (description.length < 8) {
      return Response.json(
        { error: 'Description must be at least 8 characters (ye hi goal prompt hai)' },
        { status: 400 }
      );
    }

    const decomposition = await decomposeGoal(description, {
      routing: body.agentConfig,
      credentials: body.credentials,
    });

    const goal = await createGoal({
      title: title || decomposition.title,
      description,
      tasks: decomposition.tasks,
    });
    await recordAudit({
      actor: 'user',
      action: 'goal.create',
      category: 'task',
      details: { goalId: goal.id, tasks: decomposition.tasks.length },
      ip: clientIp(req.headers),
    });
    return Response.json(goal, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create goal';
    return Response.json({ error: message }, { status: 500 });
  }
}
