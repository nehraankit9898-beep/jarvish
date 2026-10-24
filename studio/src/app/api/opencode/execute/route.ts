import { NextRequest, NextResponse } from "next/server";
import { executeOpenCodeTask } from "@/lib/agentic/opencode";
import { taskWorkspace } from "@/lib/agentic/workspace";
import { rejectIfUnauthorized } from "@/lib/agentic/api-auth";
import { recordAudit, clientIp } from "@/lib/agentic/audit";
import { isSafeTaskId } from "@/lib/agentic/workspace";

export async function POST(req: NextRequest) {
  // SECURITY: this route spawns a child process and runs a model-authored
  // prompt inside the workspace. It MUST be behind the same guard as every
  // other agentic route.
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'opencode.execute',
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
    const { taskId, prompt, config } = body;
    if (!taskId || !prompt) {
      return NextResponse.json({ error: "taskId and prompt required" }, { status: 400 });
    }
    if (!isSafeTaskId(String(taskId))) {
      return NextResponse.json({ error: "Invalid taskId" }, { status: 400 });
    }
    if (typeof prompt !== "string" || prompt.length > 20_000) {
      return NextResponse.json({ error: "prompt must be a string of max 20000 characters" }, { status: 400 });
    }
    const workspace = await taskWorkspace(taskId);
    const result = await executeOpenCodeTask(taskId, prompt, workspace, config || {});
    await recordAudit({
      actor: 'user',
      taskId: String(taskId),
      action: 'opencode.execute',
      category: 'task',
      approval: 'auto',
      result: result.success ? 'ok' : 'error',
      errorCategory: result.success ? '' : 'command_failed',
      details: { exitCode: result.exitCode, durationMs: result.durationMs },
    });
    return NextResponse.json(result);
  } catch (e: any) {
    await recordAudit({
      actor: 'user',
      action: 'opencode.execute',
      category: 'security',
      result: 'error',
      errorCategory: 'execution_failed',
      error: e?.message || 'Failed to execute OpenCode task',
      ip: clientIp(req.headers),
    });
    return NextResponse.json({ error: e?.message || "Failed to execute OpenCode task" }, { status: 500 });
  }
}

