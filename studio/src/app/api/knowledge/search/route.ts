import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { searchKnowledge, documentChunks, asUntrustedReference } from '@/lib/agentic/knowledge';

export const runtime = 'nodejs';

/**
 * GET /api/knowledge/search?q=…&taskId=…
 *
 * Lexical retrieval over the indexed chunks. Every hit carries its SOURCE
 * (document name, workspace path and chunk number) so the answer can cite it.
 *
 * GET /api/knowledge/search?docId=… — the chunks of ONE document (used by the
 * "view document" panel).
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const docId = searchParams.get('docId');
    if (docId) {
      const chunks = await documentChunks(docId);
      return Response.json(chunks);
    }
    const q = searchParams.get('q') ?? '';
    const taskId = searchParams.get('taskId') ?? undefined;
    const limit = Number(searchParams.get('limit') ?? 5);
    if (!q.trim()) {
      return Response.json({ hits: [], reference: '' });
    }
    const hits = await searchKnowledge(q, { taskId, limit: Number.isFinite(limit) ? limit : 5 });
    return Response.json({ hits, reference: asUntrustedReference(hits) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Search failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
