import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { listAudit, clearAudit } from '@/lib/agentic/audit';

export const runtime = 'nodejs';

/**
 * GET /api/audit — the audit trail (newest first).
 *
 * Query: ?taskId=… &category=… &action=… &limit=…
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const limit = Number(searchParams.get('limit') ?? 100);
    const entries = await listAudit({
      taskId: searchParams.get('taskId') ?? undefined,
      category: searchParams.get('category') ?? undefined,
      action: searchParams.get('action') ?? undefined,
      limit: Number.isFinite(limit) ? limit : 100,
    });
    return Response.json(entries);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read audit log';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/audit?taskId=… — clear the audit trail (user action). */
export async function DELETE(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get('taskId') ?? undefined;
    const removed = await clearAudit({ taskId });
    return Response.json({ ok: true, removed });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to clear audit log';
    return Response.json({ error: message }, { status: 500 });
  }
}
