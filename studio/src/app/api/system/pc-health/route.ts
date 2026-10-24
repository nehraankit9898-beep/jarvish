import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { analyzePcHealth, collectPcSnapshot, summarizeDiagnosis } from '@/lib/agentic/pc-health';

export const runtime = 'nodejs';

/**
 * GET /api/system/pc-health — "PC slow kyun hai?"
 *
 * Read-only: collects real CPU / memory / disk / process numbers and returns
 * ranked findings. Nothing is changed, nothing is spawned beyond fixed
 * diagnostic commands (`ps`/`df` or `tasklist`/`wmic`).
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const snapshot = await collectPcSnapshot();
    const diagnosis = analyzePcHealth(snapshot);
    return Response.json({
      score: diagnosis.score,
      verdict: diagnosis.verdict,
      summary: summarizeDiagnosis(diagnosis),
      findings: diagnosis.findings,
      snapshot,
      at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Diagnosis failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
