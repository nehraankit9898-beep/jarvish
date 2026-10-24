import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { isActiveStatus, normalizeTaskStatus } from '@/lib/agentic/types';
import { computeProgress } from '@/lib/agentic/parallel';

export const runtime = 'nodejs';

/**
 * GET /api/agentic/tasks/[id] — the full task detail: plan, steps, report,
 * pending approval, recent events and the agent-to-agent messages.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const task = await db.agenticTask.findUnique({
      where: { id },
      include: {
        steps: { orderBy: { index: 'asc' } },
        messages: { orderBy: { seq: 'asc' } },
      },
    });
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }

    const events = await db.agentEvent.findMany({
      where: { taskId: id },
      orderBy: { seq: 'asc' },
      take: 200,
    });

    const plan = JSON.parse(task.plan || '[]') as { index: number }[];

    return Response.json({
      id: task.id,
      prompt: task.prompt,
      status: task.status,
      plan,
      /** live board: terminal/running/pending counts + percent */
      progress: computeProgress(task.steps),
      currentStep: task.currentStep,
      steps: task.steps,
      report: task.report ? JSON.parse(task.report) : null,
      error: task.error,
      pendingCommand: task.pendingCommand ? JSON.parse(task.pendingCommand) : null,
      events: events.map((e) => ({
        type: e.type,
        taskId: e.taskId,
        at: e.at,
        stepIndex: e.stepIndex ?? undefined,
        seq: e.seq,
        data: JSON.parse(e.payload || '{}'),
      })),
      messages: task.messages.map((m) => ({
        id: m.id,
        taskId: m.taskId,
        conversationId: m.conversationId,
        seq: m.seq,
        fromAgent: m.fromAgent,
        toAgent: m.toAgent,
        type: m.type,
        correlationId: m.correlationId,
        content: m.content,
        provider: m.provider,
        model: m.model,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load task';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/agentic/tasks/[id] — remove a task that is no longer active
 * (together with its steps, events and messages via cascade).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const task = await db.agenticTask.findUnique({ where: { id } });
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }
    if (isActiveStatus(normalizeTaskStatus(task.status)) && task.status !== 'paused') {
      return Response.json(
        { error: 'Task is still active — cancel it first' },
        { status: 400 }
      );
    }
    await db.agenticTask.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete task';
    return Response.json({ error: message }, { status: 500 });
  }
}
