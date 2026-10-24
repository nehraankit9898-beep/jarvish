import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health — a liveness/readiness probe.
 *
 * It is intentionally UNAUTHENTICATED (a health checker has no session) but it
 * exposes nothing but reachability: no paths, no versions of private code, no
 * secrets, no user data. A 503 is returned when the database is unreachable so
 * an orchestrator can restart the container.
 */
export async function GET() {
  const startedAt = Date.now();
  let database = { ok: false, latencyMs: 0, error: '' };

  try {
    await db.$queryRaw`SELECT 1`;
    database = { ok: true, latencyMs: Date.now() - startedAt, error: '' };
  } catch (err) {
    database = {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : 'database unavailable',
    };
  }

  const body = {
    status: database.ok ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: {
      database,
    },
  };

  return NextResponse.json(body, { status: database.ok ? 200 : 503 });
}
