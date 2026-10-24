import { NextRequest } from 'next/server';
import { listTools, getTool, hasTool } from '@/lib/agentic/tool-registry';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { registerBrowserTools } from '@/lib/agentic/browser-tools';
import { registerHostTools } from '@/lib/agentic/host-tools';
import { registerLaptopTools } from '@/lib/agentic/laptop-tools';
import { registerMemoryTools } from '@/lib/agentic/memory-tools';
import { registerConnectorTools } from '@/lib/agentic/connector-tools';
import { loadActiveCustomTools } from '@/lib/agentic/custom-tools';

export const runtime = 'nodejs';

/** The browser tools + approved custom tools join the built-ins lazily. */
async function ensureFullCatalog() {
  registerBrowserTools();
  registerHostTools();
  registerLaptopTools();
  registerMemoryTools();
  registerConnectorTools();
  await loadActiveCustomTools().catch(() => 0);
}

export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    await ensureFullCatalog();
    const tools = listTools();
    return Response.json(tools);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list tools';
    return Response.json({ error: message }, { status: 500 });
  }
}
