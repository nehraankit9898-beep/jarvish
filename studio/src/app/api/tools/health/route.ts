import { NextRequest } from 'next/server';
import { healthCheckAllTools } from '@/lib/agentic/tool-registry';
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
    const results = await healthCheckAllTools(taskId);
    return Response.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Health check failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
