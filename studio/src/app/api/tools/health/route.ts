import { NextRequest } from 'next/server';
import { healthCheckAllTools } from '@/lib/agentic/tool-registry';
import { ensureFullToolCatalog } from '@/lib/agentic/tool-catalog';
import { isSafeTaskId } from '@/lib/agentic/workspace';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const taskId = req.nextUrl.searchParams.get('taskId') || 'health-check';
    if (!isSafeTaskId(taskId)) {
      return Response.json({ error: 'Invalid taskId' }, { status: 400 });
    }
    // H35: the health report used to enumerate a registry this route never
    // filled — on a fresh server it reported an empty catalog (and after some
    // other request, a random subset). Register the full catalog first.
    await ensureFullToolCatalog();
    // H11: a probe INVOKES the tool, so it stays opt-in — the default check is
    // side-effect free and never touches the workspace.
    const probe = ['1', 'true', 'yes'].includes((req.nextUrl.searchParams.get('probe') ?? '').toLowerCase());
    const results = await healthCheckAllTools(taskId, { probe });
    return Response.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Health check failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
