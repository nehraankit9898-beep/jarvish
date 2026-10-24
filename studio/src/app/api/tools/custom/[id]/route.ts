import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { decideCustomTool, deleteCustomTool, scanToolCode } from '@/lib/agentic/custom-tools';

export const runtime = 'nodejs';

/** GET /api/tools/custom/[id] — one custom tool including its full code. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const row = await db.customTool.findUnique({ where: { id } });
    if (!row) return Response.json({ error: 'Tool not found' }, { status: 404 });
    let envelope: { params?: unknown[]; baseUrl?: string } = {};
    try {
      const raw = JSON.parse(row.paramsSchema || '[]');
      envelope = Array.isArray(raw) ? { params: raw } : raw;
    } catch {
      envelope = {};
    }
    return Response.json({
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      permission: row.permission,
      status: row.status,
      version: row.version,
      createdBy: row.createdBy,
      invokeCount: row.invokeCount,
      lastError: row.lastError,
      params: envelope.params ?? [],
      baseUrl: envelope.baseUrl ?? '',
      code: row.code,
      updatedAt: row.updatedAt.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load tool';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/tools/custom/[id] — the approval lifecycle (Feature 6).
 *
 *   { action: 'approve' } — activate the tool (loads it into the registry;
 *     the code is re-scanned for forbidden patterns first)
 *   { action: 'reject' }  — reject the proposal
 *   { action: 'disable' } — take an active tool out of the registry
 *   { action: 'enable' }  — re-activate a disabled tool
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const action = body.action as 'approve' | 'reject' | 'disable' | 'enable' | undefined;
    if (!action || !['approve', 'reject', 'disable', 'enable'].includes(action)) {
      return Response.json({ error: 'action must be approve | reject | disable | enable' }, { status: 400 });
    }
    const result = await decideCustomTool(id, action);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    await recordAudit({
      actor: 'user',
      action: `tool.${action}`,
      category: 'tool',
      approval: action === 'approve' ? 'approved' : 'auto',
      details: { toolId: id },
      ip: clientIp(req.headers),
    });
    return Response.json({ ok: true, status: result.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/tools/custom/[id] — remove a custom tool entirely. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const removed = await deleteCustomTool(id);
    if (!removed) return Response.json({ error: 'Tool not found' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
