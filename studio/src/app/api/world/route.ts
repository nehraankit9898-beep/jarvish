import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { getWorldSnapshot, hotspotCounts } from '@/lib/agentic/world-monitor';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * GET /api/world — live world hotspots + headlines for the World Monitor.
 * `?refresh=1` bypasses the 5-minute cache. A dead upstream is reported as
 * `degraded: true` (never as an empty, calm world).
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const force = new URL(req.url).searchParams.get('refresh') === '1';
    const snapshot = await getWorldSnapshot({ force });
    return Response.json({ ...snapshot, counts: hotspotCounts(snapshot.hotspots) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'World monitor unavailable';
    return Response.json({ error: message }, { status: 500 });
  }
}
