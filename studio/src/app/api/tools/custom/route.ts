import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import { createCustomTool, listCustomTools, CustomToolError } from '@/lib/agentic/custom-tools';

export const runtime = 'nodejs';

/**
 * GET /api/tools/custom — every custom tool (any status) with its schema,
 * invocation count and last error. The CODE is included so the user can
 * review exactly what runs before approving.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const tools = await listCustomTools();
    return Response.json({ tools });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list custom tools';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/tools/custom — propose a new custom tool (Feature 6).
 *
 * The tool is created in `pending_approval` — it is NOT executable until the
 * user reviews the code and approves it via POST /api/tools/custom/[id].
 * Body: { name, description, category?, params[], permission?, baseUrl?, code }
 * `code` is an async function body with (params, api) — no require/process/
 * env; api.fetch is SSRF-guarded and locked to baseUrl.
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) {
    await recordAudit({
      actor: 'anonymous',
      action: 'tool.propose',
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
    const createdBy = body.createdBy === 'agent' ? 'agent' : 'user';
    const tool = await createCustomTool(body, { createdBy });
    return Response.json(tool, { status: 201 });
  } catch (err) {
    if (err instanceof CustomToolError) {
      return Response.json({ error: err.message, field: err.field }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to create tool';
    return Response.json({ error: message }, { status: 500 });
  }
}
