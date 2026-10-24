import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { listWorkflowTemplates, createWorkflowTask } from '@/lib/agentic/workflows';

export const runtime = 'nodejs';

/**
 * GET /api/workflows — the guided workflow templates (negotiation,
 * purchase protection). A workflow ships a DETERMINISTIC plan: the fixed
 * steps and approval gates ARE the safety feature.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  return Response.json({ workflows: listWorkflowTemplates() });
}

/**
 * POST /api/workflows — create a task from a template.
 * Body: { workflow: 'negotiation' | 'purchase-protection', prompt }
 * The task is created in `awaiting_approval` — nothing runs by itself.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { workflow?: string; prompt?: string };
    if (!body.workflow) {
      return Response.json({ error: 'workflow is required' }, { status: 400 });
    }
    const task = await createWorkflowTask(body.workflow, String(body.prompt ?? ''));
    await recordAudit({
      actor: 'user',
      action: 'workflow.create_task',
      category: 'task',
      approval: 'auto',
      details: { workflowId: body.workflow, taskId: task.taskId },
      ip: clientIp(req.headers),
    });
    return Response.json(task, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create workflow task';
    return Response.json({ error: message }, { status: 400 });
  }
}
