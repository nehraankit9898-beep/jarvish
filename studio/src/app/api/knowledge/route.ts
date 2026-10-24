import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  importDocument,
  listDocuments,
  deleteDocument,
  KnowledgeError,
} from '@/lib/agentic/knowledge';

export const runtime = 'nodejs';

/** GET /api/knowledge — the imported documents. */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get('taskId') ?? undefined;
    const docs = await listDocuments({ taskId });
    return Response.json(docs);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list documents';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/knowledge — import a document.
 *
 * Body: { name?, content?, path?, taskId?, mime? }
 *   * `content` — raw text (paste),
 *   * `path`    — a file INSIDE the workspace of `taskId`.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'knowledge.import',
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
    const doc = await importDocument({
      name: body.name,
      content: body.content,
      path: body.path,
      taskId: body.taskId,
      mime: body.mime,
    });
    await recordAudit({
      actor: 'user',
      taskId: doc.taskId,
      action: 'knowledge.import',
      category: 'knowledge',
      result: doc.status === 'failed' ? 'error' : 'ok',
      errorCategory: doc.status === 'failed' ? 'indexing_failed' : '',
      error: doc.error,
      details: { docId: doc.id, name: doc.name, status: doc.status, chunks: doc.chunkCount },
      ip: clientIp(req.headers),
    });
    return Response.json(doc, { status: 201 });
  } catch (err) {
    if (err instanceof KnowledgeError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to import document';
    await recordAudit({
      actor: 'user',
      action: 'knowledge.import',
      category: 'knowledge',
      result: 'error',
      errorCategory: 'exception',
      error: message,
      ip: clientIp(req.headers),
    });
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/knowledge?id=… */
export async function DELETE(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id') ?? '';
    const removed = await deleteDocument(id);
    await recordAudit({
      actor: 'user',
      action: 'knowledge.delete',
      category: 'knowledge',
      details: { docId: id, removed },
      ip: clientIp(req.headers),
    });
    return Response.json({ ok: true, removed });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete document';
    return Response.json({ error: message }, { status: 500 });
  }
}
