import { NextRequest } from 'next/server';
import { invokeTool, getAuditLog } from '@/lib/agentic/tool-registry';
import { db } from '@/lib/db';
import { isSafeTaskId } from '@/lib/agentic/workspace';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { registerBrowserTools } from '@/lib/agentic/browser-tools';
import { registerHostTools } from '@/lib/agentic/host-tools';
import { registerLaptopTools } from '@/lib/agentic/laptop-tools';
import { loadActiveCustomTools } from '@/lib/agentic/custom-tools';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const { tool, parameters, taskId, approvedCommands } = body as {
      tool: string;
      parameters?: Record<string, any>;
      taskId: string;
      approvedCommands?: string[];
    };

    if (!tool) {
      return Response.json({ error: 'tool is required' }, { status: 400 });
    }
    if (!taskId) {
      return Response.json({ error: 'taskId is required' }, { status: 400 });
    }
    // The task id is turned into a directory name — it must be a plain
    // identifier and it must belong to an existing task, otherwise a caller
    // could address another task's workspace (or escape the sandbox).
    if (!isSafeTaskId(taskId)) {
      return Response.json({ error: 'Invalid taskId' }, { status: 400 });
    }
    const task = await db.agenticTask.findUnique({
      where: { id: taskId },
      select: { id: true },
    });
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }

    // the browser tools and approved custom tools join the catalog lazily,
    // right before the first invocation
    registerBrowserTools();
    registerHostTools();
    registerLaptopTools();
    await loadActiveCustomTools().catch(() => 0);

    const result = await invokeTool({
      tool,
      parameters: parameters ?? {},
      taskId,
      approvedCommands: approvedCommands ?? [],
    });

    await recordAudit({
      actor: 'user',
      taskId,
      action: 'tool.invoke',
      category: 'tool',
      approval: 'auto',
      result: result?.ok === false ? 'error' : 'ok',
      errorCategory: result?.ok === false ? 'tool_failed' : '',
      details: { tool, parameters: Object.keys(parameters ?? {}).slice(0, 20) },
      ip: clientIp(req.headers),
    });

    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool invocation failed';
    await recordAudit({
      actor: 'user',
      action: 'tool.invoke',
      category: 'tool',
      result: 'error',
      errorCategory: 'exception',
      error: message,
      ip: clientIp(req.headers),
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
