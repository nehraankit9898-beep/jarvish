import { NextRequest } from 'next/server';
import { listTools, getTool, hasTool } from '@/lib/agentic/tool-registry';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { ensureFullToolCatalog } from '@/lib/agentic/tool-catalog';

export const runtime = 'nodejs';


export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    await ensureFullToolCatalog();
    const tools = listTools();
    return Response.json(tools);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list tools';
    return Response.json({ error: message }, { status: 500 });
  }
}
