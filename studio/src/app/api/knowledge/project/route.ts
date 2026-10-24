import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  indexProject,
  listProjectDocuments,
  projectIndexStatus,
  resetProjectIndex,
  searchProject,
  searchProjectSymbols,
  ProjectIndexError,
} from '@/lib/agentic/project-index';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/knowledge/project?root=<abs path>
 *
 *   ?root=…            → the status of the index + the stale files
 *   ?root=…&search=…   → the search hits of that project (with source files)
 *   ?root=…&symbols=…  → the symbols matching that name
 *   ?root=…&list=1     → the indexed documents
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  try {
    const { searchParams } = new URL(req.url);
    const root = searchParams.get('root') ?? '';
    if (!root.trim()) {
      return Response.json({ error: 'A project root is required.' }, { status: 400 });
    }

    const symbolQuery = searchParams.get('symbols');
    if (symbolQuery !== null) {
      const symbols = await searchProjectSymbols(root, symbolQuery, { limit: 50 });
      return Response.json({ root, query: symbolQuery, symbols });
    }

    const query = searchParams.get('search');
    if (query !== null) {
      const hits = await searchProject(root, query, { limit: 8 });
      return Response.json({ root, query, hits });
    }

    if (searchParams.get('list') === '1') {
      const documents = await listProjectDocuments(root);
      return Response.json({ root, documents });
    }

    const status = await projectIndexStatus(root);
    return Response.json(status);
  } catch (err) {
    if (err instanceof ProjectIndexError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to read the project index';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/knowledge/project
 *
 * Body: { root, action?: 'index' | 'refresh' | 'rebuild' | 'reset' }
 *
 *   index   — index every file of the project,
 *   refresh — re-index only the files that changed and drop the deleted ones,
 *   rebuild — delete the whole index and index it again,
 *   reset   — delete the whole index.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'knowledge.project.index',
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
    const root = String(body.root ?? '').trim();
    const action = String(body.action ?? 'index').trim();

    if (action === 'reset') {
      const removed = await resetProjectIndex(root);
      await recordAudit({
        actor: 'user',
        action: 'knowledge.project.reset',
        category: 'knowledge',
        details: { root, removed },
        ip: clientIp(req.headers),
      });
      return Response.json({ ok: true, action, root, removed });
    }

    const mode = action === 'refresh' ? 'refresh' : action === 'rebuild' ? 'rebuild' : 'full';
    const stats = await indexProject(root, { mode });
    await recordAudit({
      actor: 'user',
      action: 'knowledge.project.index',
      category: 'knowledge',
      details: {
        root: stats.root,
        action: mode,
        files: stats.files,
        chunks: stats.chunks,
        durationMs: stats.durationMs,
      },
      ip: clientIp(req.headers),
    });
    return Response.json({ ok: true, action: mode, ...stats });
  } catch (err) {
    if (err instanceof ProjectIndexError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to index the project';
    await recordAudit({
      actor: 'user',
      action: 'knowledge.project.index',
      category: 'knowledge',
      result: 'error',
      errorCategory: 'exception',
      error: message,
      ip: clientIp(req.headers),
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
