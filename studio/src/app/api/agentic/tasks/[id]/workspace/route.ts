import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { listTree, readWorkspaceFile } from '@/lib/agentic/workspace';
import {
  executeCommand,
  CommandDeniedError,
} from '@/lib/agentic/terminal';
import { protect } from '@/lib/agentic/secrets';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GET /api/agentic/tasks/[id]/workspace        — the file tree.
 * GET /api/agentic/tasks/[id]/workspace?path=x — the content of one file.
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
      select: { id: true },
    });
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }
    const { searchParams } = new URL(req.url);
    const filePath = searchParams.get('path');
    if (filePath) {
      const content = await readWorkspaceFile(id, filePath);
      return Response.json({ path: filePath, content: content.slice(0, 400_000) });
    }
    const tree = await listTree(id);
    return Response.json({ tree });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Workspace read failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/agentic/tasks/[id]/workspace — run a terminal command INSIDE the
 * task workspace from the UI.
 *
 * Body: { command: string, approve?: boolean }
 *
 * A destructive command without `approve: true` is answered with
 * 403 { needsApproval: true, error } — the UI shows the approval card and
 * re-sends the exact command with approve=true. `approve` is only honoured
 * for the command in the body itself (autoApproveDestructive is scoped to
 * THIS call, never persisted).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const task = await db.agenticTask.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      command?: string;
      approve?: boolean;
    };
    const command = String(body.command ?? '').trim();
    if (!command) {
      return Response.json({ error: 'command is required' }, { status: 400 });
    }

    const approvedCommands = body.approve === true ? [command] : [];

    try {
      const result = await executeCommand(id, command, {
        approvedCommands,
        autoApproveDestructive: body.approve === true,
      });
      await recordAudit({
        actor: 'user',
        taskId: id,
        action: 'workspace.command',
        category: 'task',
        approval: body.approve === true ? 'approved' : 'auto',
        details: { command, exitCode: result.exitCode },
        ip: clientIp(req.headers),
      });
      return Response.json({
        command: result.command,
        exitCode: result.exitCode,
        output: protect(result.output).masked.slice(0, 24_000),
        durationMs: result.durationMs,
      });
    } catch (err) {
      if (err instanceof CommandDeniedError) {
        await recordAudit({
          actor: 'user',
          taskId: id,
          action: 'workspace.command',
          category: 'security',
          result: 'error',
          errorCategory: 'needs_approval',
          error: err.message,
          details: { command },
          ip: clientIp(req.headers),
        });
        return Response.json(
          { needsApproval: true, error: err.message, command },
          { status: 403 }
        );
      }
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Command failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
