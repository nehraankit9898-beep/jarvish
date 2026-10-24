import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { planTask } from '@/lib/agentic/orchestrator';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  normalizeAgentConfig,
  redactAgentConfig,
  validateAgentConfig,
  type AgentRoutingConfig,
  type CredentialMap,
} from '@/lib/agentic/agent-config';
import type { PlanStep, TaskConfig } from '@/lib/agentic/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  const tasks = await db.agenticTask.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: {
      id: true,
      prompt: true,
      status: true,
      currentStep: true,
      plan: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return Response.json(
    tasks.map((t) => ({
      ...t,
      plan: JSON.parse(t.plan || '[]') as PlanStep[],
    }))
  );
}

export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  try {
    const body = (await req.json()) as {
      prompt?: string;
      provider?: string;
      model?: string;
      taskConfig?: Partial<TaskConfig>;
      /** per-agent (per-role) model routing */
      agentConfig?: AgentRoutingConfig;
      /** credentials are used for the planning call only — never persisted */
      credentials?: CredentialMap;
      /** absolute path of the project to index-search before every step */
      projectRoot?: string;
      /** Jarvis #5: this task was created by approving a proactive suggestion */
      suggestionId?: string;
      /** Jarvis #2: 'screen' = vision loop (screenshot → model → approved actions) */
      mode?: 'screen';
    };
    const prompt = body.prompt?.trim();
    if (!prompt || prompt.length < 8) {
      return Response.json(
        { error: 'Prompt must be at least 8 characters.' },
        { status: 400 }
      );
    }
    if (prompt.length > 4000) {
      return Response.json(
        { error: 'Prompt is too long (max 4000 characters).' },
        { status: 400 }
      );
    }

    const taskFallback = {
      provider: body.provider || 'zai',
      model: body.model || '',
    };
    const routing = normalizeAgentConfig(body.agentConfig, taskFallback);
    const issues = validateAgentConfig(routing, body.credentials);
    if (issues.length) {
      return Response.json(
        {
          error: `Invalid agent configuration: ${issues
            .map((i) => i.message)
            .join('; ')}`,
        },
        { status: 400 }
      );
    }

    // the project root is validated up-front: an invalid or unreadable
    // directory must fail loudly instead of silently degrading the run
    let projectRoot = '';
    if (body.projectRoot && body.projectRoot.trim()) {
      try {
        const { resolveProjectRoot } = await import('@/lib/agentic/project-index');
        projectRoot = await resolveProjectRoot(body.projectRoot);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Invalid project folder.';
        return Response.json({ error: message }, { status: 400 });
      }
    }

    const task = await db.agenticTask.create({
      data: {
        prompt,
        provider: taskFallback.provider,
        model: taskFallback.model,
        // the task enters the lifecycle as QUEUED and moves to 'planning' as
        // soon as the planner starts (see planTask)
        status: 'queued',
        // only the NON-SECRET routing config is persisted
        agentConfig: JSON.stringify(redactAgentConfig(routing)),
        projectRoot,
        conversationId: `conv_${crypto.randomUUID()}`,
        mode: body.mode === 'screen' ? 'screen' : '',
      },
    });

    // Jarvis #2: a SCREEN task skips the LLM planner entirely — its "plan"
    // is the single vision loop; the run route starts it right away
    if (body.mode === 'screen') {
      const screenPlan: PlanStep[] = [
        {
          index: 1,
          kind: 'command',
          title: 'Screen task loop (screenshot → model → approved actions)',
          description: prompt.slice(0, 400),
          acceptance: 'goal achieved or safety stop',
          dependencies: [],
        },
      ];
      await db.agenticStep.deleteMany({ where: { taskId: task.id } });
      await db.agenticStep.create({
        data: {
          taskId: task.id,
          index: 1,
          kind: 'command',
          title: screenPlan[0].title,
          description: screenPlan[0].description,
          status: 'pending',
        },
      });
      await db.agenticTask.update({
        where: { id: task.id },
        data: {
          plan: JSON.stringify(screenPlan),
          status: 'awaiting_approval',
        },
      });
      await recordAudit({
        actor: 'user',
        taskId: task.id,
        action: 'task.create_screen',
        category: 'task',
        result: 'ok',
        details: { mode: 'screen', chars: prompt.length },
        ip: clientIp(req.headers),
      });
      return Response.json(
        {
          id: task.id,
          mode: 'screen',
          status: 'awaiting_approval',
          title: screenPlan[0].title,
          plan: screenPlan,
          privacy:
            'Screenshots cloud vision model ko bheji jaayengi. Payment/password screens par task khud ruk jayega. Har click ask-mode me approval maangega.',
        },
        { status: 201 }
      );
    }

    // Jarvis #5: a spoken/typed approval ("haan kar do") created this task —
    // link + close the suggestion so it does not stay open in the panel
    if (body.suggestionId) {
      await db.proactiveSuggestion
        .update({
          where: { id: body.suggestionId },
          data: { status: 'accepted', decidedAt: new Date(), taskId: task.id },
        })
        .catch(() => undefined);
    }

    // plan synchronously (Planner LLM call) — UI shows spinner meanwhile
    try {
      await planTask(task.id, undefined, body.taskConfig, {
        routing,
        credentials: body.credentials,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Planning failed';
      await db.agenticTask.update({
        where: { id: task.id },
        data: { status: 'failed', error: message },
      });
      await recordAudit({
        actor: 'user',
        taskId: task.id,
        action: 'task.create',
        category: 'task',
        result: 'error',
        errorCategory: 'planning_failed',
        error: message,
        ip: clientIp(req.headers),
      });
      return Response.json(
        { error: `Planning failed: ${message}`, taskId: task.id },
        { status: 502 }
      );
    }

    await recordAudit({
      actor: 'user',
      taskId: task.id,
      action: 'task.create',
      category: 'task',
      approval: 'auto',
      details: { provider: taskFallback.provider, model: taskFallback.model },
      ip: clientIp(req.headers),
    });

    const updated = await db.agenticTask.findUnique({
      where: { id: task.id },
      include: { steps: { orderBy: { index: 'asc' } } },
    });
    if (!updated) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }
    // the plan is returned PARSED (same shape as GET /api/agentic/tasks/[id])
    // so the client never has to know about the raw JSON column
    return Response.json(
      {
        ...updated,
        plan: JSON.parse(updated.plan || '[]') as PlanStep[],
        events: [],
        messages: [],
      },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return Response.json({ error: message }, { status: 500 });
  }
}
