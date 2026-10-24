import { NextRequest } from 'next/server';
import { getAuditLog } from '@/lib/agentic/tool-registry';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const limit = req.nextUrl.searchParams.get('limit');
    const n = limit ? parseInt(limit, 10) : 100;
    const log = getAuditLog(n);
    return Response.json(log);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to get audit log';
    return Response.json({ error: message }, { status: 500 });
  }
}
