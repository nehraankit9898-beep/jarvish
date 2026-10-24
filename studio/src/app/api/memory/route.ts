import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  listMemory,
  saveMemory,
  deleteMemory,
  MemoryValidationError,
  type MemoryScope,
} from '@/lib/agentic/memory';

export const runtime = 'nodejs';

/**
 * GET /api/memory?scope=user|task&taskId=…
 *
 * `scope=task` REQUIRES a taskId — otherwise the private notes of every task
 * would be returned in one response.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const scope = (searchParams.get('scope') ?? 'user') as MemoryScope;
    const taskId = searchParams.get('taskId') ?? undefined;
    const category = searchParams.get('category') ?? undefined;
    const search = searchParams.get('q') ?? undefined;
    const entries = await listMemory({
      scope: scope === 'task' ? 'task' : 'user',
      taskId,
      category: category as never,
      search,
    });
    return Response.json(entries);
  } catch (err) {
    if (err instanceof MemoryValidationError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to read memory';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** POST /api/memory — create or update an entry. */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'memory.write',
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
    const entry = await saveMemory({
      scope: body.scope === 'task' ? 'task' : 'user',
      taskId: body.taskId,
      category: body.category,
      key: body.key,
      content: body.content,
      source: body.source,
    });
    await recordAudit({
      actor: 'user',
      taskId: entry.taskId,
      action: 'memory.write',
      category: 'memory',
      details: { scope: entry.scope, key: entry.key, category: entry.category },
      ip: clientIp(req.headers),
    });
    return Response.json(entry, { status: 201 });
  } catch (err) {
    if (err instanceof MemoryValidationError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to save memory';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/memory?id=… | /api/memory?scope=user|task&taskId=… */
export async function DELETE(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id') ?? undefined;
    const scope = (searchParams.get('scope') ?? undefined) as MemoryScope | undefined;
    const taskId = searchParams.get('taskId') ?? undefined;
    const removed = await deleteMemory({ id, scope, taskId });
    await recordAudit({
      actor: 'user',
      taskId: taskId ?? '',
      action: 'memory.delete',
      category: 'memory',
      details: { id: id ?? '', scope: scope ?? 'all', removed },
      ip: clientIp(req.headers),
    });
    return Response.json({ ok: true, removed });
  } catch (err) {
    if (err instanceof MemoryValidationError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to delete memory';
    return Response.json({ error: message }, { status: 500 });
  }
}
