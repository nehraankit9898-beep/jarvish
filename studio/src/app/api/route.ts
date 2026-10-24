import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api — a short index of the HTTP surface.
 *
 * It is a discovery helper, not a health probe (use /api/health for that).
 * Only route names are listed — no configuration, no secrets.
 */
export async function GET() {
  return NextResponse.json({
    name: 'AgentScope Studio API',
    version: 1,
    health: '/api/health',
    groups: {
      chat: ['/api/chat', '/api/compare', '/api/conversations'],
      agentic: [
        '/api/agentic/tasks',
        '/api/agentic/tasks/{id}',
        '/api/agentic/tasks/{id}/run',
        '/api/agentic/tasks/{id}/stream',
        '/api/agentic/tasks/{id}/resume',
        '/api/agentic/tasks/{id}/pause',
        '/api/agentic/tasks/{id}/cancel',
        '/api/agentic/tasks/{id}/rollback',
        '/api/agentic/tasks/{id}/diff',
        '/api/agentic/tasks/{id}/workspace',
        '/api/goals',
        '/api/workflows',
      ],
      providers: [
        '/api/providers',
        '/api/providers/{id}',
        '/api/providers/{id}/test',
        '/api/providers/{id}/models',
        '/api/model-preferences',
        '/api/settings',
        '/api/test-connection',
      ],
      registry: [
        '/api/agents',
        '/api/agent-registry/agents',
        '/api/tools',
        '/api/tools/custom',
        '/api/prompt-versions',
      ],
      knowledge: ['/api/memory', '/api/knowledge', '/api/knowledge/search'],
      automation: ['/api/automation', '/api/automation/{id}'],
      governance: [
        '/api/audit',
        '/api/system/status',
        '/api/system/permissions',
        '/api/notifications',
        '/api/suggestions',
      ],
      browser: ['/api/browser', '/api/browser/{id}'],
      laptop: [
        '/api/laptop',
        '/api/host',
        '/api/recipes',
      ],
      runtime: ['/api/agentscope/status', '/api/agentscope/run', '/api/recovery'],
    },
  });
}
