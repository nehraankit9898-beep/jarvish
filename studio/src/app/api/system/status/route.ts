import { NextRequest } from 'next/server';
import { execFile } from 'child_process';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { listProviderConfigs, readStudioSettings } from '@/lib/agentic/provider-store';
import { listTools, healthCheckTool } from '@/lib/agentic/tool-registry';
import { ensureFullToolCatalog } from '@/lib/agentic/tool-catalog';
import { validateEnv } from '@/lib/agentic/env';

export const runtime = 'nodejs';
export const maxDuration = 60;

function findPython(): Promise<string | null> {
  return new Promise((resolve) => {
    const candidates = process.env.AGENTSCOPE_PYTHON
      ? [process.env.AGENTSCOPE_PYTHON]
      : ['python3', 'python', 'py'];
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return resolve(null);
      const bin = candidates[i++];
      execFile(bin, ['--version'], { timeout: 10_000 }, (err) => {
        if (err) return tryNext();
        resolve(bin);
      });
    };
    tryNext();
  });
}

async function pythonVersion(python: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(python, ['--version'], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim())
    );
  });
}

async function agentscopeVersion(python: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      python,
      ['-c', 'import agentscope; print(getattr(agentscope, "__version__", "unknown"))'],
      { timeout: 20_000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim())
    );
  });
}

/**
 * GET /api/system/status — one unified health snapshot.
 *
 * Everything reported here is a FACT measured at request time: database
 * counts, the python/agentscope runtime, the provider configuration and the
 * tool registry health. No secret is included.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  const started = Date.now();

  // --- database ---
  let database: { ok: boolean; error?: string; counts: Record<string, number> } = {
    ok: false,
    counts: {},
  };
  try {
    const [tasks, agents, conversations, audit, docs, schedules] = await Promise.all([
      db.agenticTask.count(),
      db.agent.count(),
      db.conversation.count(),
      db.auditLog.count(),
      db.knowledgeDoc.count(),
      db.automationSchedule.count(),
    ]);
    database = {
      ok: true,
      counts: {
        tasks,
        agents,
        conversations,
        auditEntries: audit,
        knowledgeDocs: docs,
        automationSchedules: schedules,
      },
    };
  } catch (err) {
    database = {
      ok: false,
      error: err instanceof Error ? err.message : 'database unavailable',
      counts: {},
    };
  }

  // --- python runtime ---
  const python = await findPython();
  const pythonVersionText = python ? await pythonVersion(python) : null;
  const agentscope = python ? await agentscopeVersion(python) : null;

  // --- providers ---
  let providers: {
    total: number;
    enabled: number;
    configured: number;
    withKey: number;
    freeEnabled: number;
    lastTest: { provider: string; ok: boolean; at: string | null }[];
  } = {
    total: 0,
    enabled: 0,
    configured: 0,
    withKey: 0,
    freeEnabled: 0,
    lastTest: [],
  };
  try {
    const configs = await listProviderConfigs();
    providers = {
      total: configs.length,
      enabled: configs.filter((c) => c.enabled).length,
      configured: configs.length,
      withKey: configs.filter((c) => c.hasKey).length,
      freeEnabled: configs.filter((c) => c.enabled && c.costClass === 'free').length,
      lastTest: configs
        .filter((c) => c.lastTestedAt)
        .map((c) => ({
          provider: c.provider,
          ok: Boolean(c.lastTestOk),
          at: c.lastTestedAt,
        })),
    };
  } catch {
    // keep the empty snapshot
  }

  // --- tools ---
  let tools: { total: number; healthy: number; broken: number } = {
    total: 0,
    healthy: 0,
    broken: 0,
  };
  try {
    // H35: the catalog has to be assembled before it can be counted (this
    // route never registered any tool family, so the tile showed 0/0/0).
    await ensureFullToolCatalog();
    const list = listTools();
    let healthy = 0;
    for (const tool of list) {
      const health = await healthCheckTool(tool.name, 'health-check');
      if (health?.ok) healthy++;
    }
    tools = { total: list.length, healthy, broken: list.length - healthy };
  } catch {
    // keep the empty snapshot
  }

  const settings = await readStudioSettings().catch(() => null);

  const tokenConfigured = Boolean((process.env.AGENTSCOPE_API_TOKEN ?? '').trim());
  const production = process.env.NODE_ENV === 'production';
  const allowUnauthenticated = process.env.AGENTSCOPE_ALLOW_UNAUTHENTICATED === '1';
  const env = validateEnv();

  return Response.json({
    ok: database.ok && env.ok,
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    database,
    env: {
      ok: env.ok,
      issues: env.issues,
      present: env.present,
    },
    python: {
      ok: Boolean(python),
      binary: python,
      version: pythonVersionText,
      agentscope,
      hint: agentscope
        ? 'AgentScope Python runtime is available.'
        : 'Optional: install the Python package to use the AgentScope engine (pip install -e ./agentscope).',
    },
    providers: { ...providers, settings },
    tools,
    security: {
      apiTokenConfigured: tokenConfigured,
      production,
      allowUnauthenticated,
      failClosed:
        !production ||
        tokenConfigured ||
        allowUnauthenticated,
      hint: production && !tokenConfigured && !allowUnauthenticated
        ? 'Agent execution is DISABLED in production until AGENTSCOPE_API_TOKEN is set.'
        : 'Agent execution is available.',
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
    },
  });
}
