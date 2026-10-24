import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { baselineRef, diffBetween, changedFiles } from '@/lib/agentic/git-tools';
import { protect } from '@/lib/agentic/secrets';

export const runtime = 'nodejs';

/**
 * GET /api/agentic/tasks/[id]/diff — the workspace diff (baseline → HEAD).
 * The diff is secret-masked before it leaves the server.
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
    const base = await baselineRef(id);
    const [diff, files] = await Promise.all([
      diffBetween(id, base, 'HEAD'),
      changedFiles(id, base, 'HEAD'),
    ]);
    return Response.json({
      diff: protect(diff.slice(0, 200_000)).masked,
      files,
      baseline: base,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Diff failed';
    return Response.json({ diff: '', error: message });
  }
}
