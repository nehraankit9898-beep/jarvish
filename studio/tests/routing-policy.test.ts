// Routing policy (free-only, disabled providers) and the agent role set.
// All LLM traffic is mocked — no network and no API keys needed.
// Run: bun test tests/routing-policy.test.ts
import { describe, expect, test } from 'bun:test';
import {
  ModelRouter,
  ModelRoutingError,
  type CompleteFn,
  type ModelRouteRecord,
} from '../src/lib/agentic/model-router';
import {
  AGENT_ROLES,
  AGENT_ROLE_LABEL,
  DEFAULT_TEMPERATURE,
  normalizeAgentConfig,
  type AgentRoutingConfig,
} from '../src/lib/agentic/agent-config';
import { ROLES, buildPlanParse } from '../src/lib/agentic/roles';
import { isReadOnlyKind } from '../src/lib/agentic/scheduler';

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];

function routerWith(
  routing: AgentRoutingConfig,
  complete: CompleteFn,
  policy: {
    freeOnly?: boolean;
    autoFallback?: boolean;
    providerOrder?: string[];
    disabledProviders?: string[];
    costClassOf?: (provider: string, model: string) => 'free' | 'paid' | 'unknown';
  } = {},
  onRoute?: (r: ModelRouteRecord) => void
) {
  return new ModelRouter({
    routing,
    taskFallback: { provider: 'zai', model: 'glm-4.6' },
    complete,
    onRoute,
    policy: {
      freeOnly: false,
      autoFallback: true,
      providerOrder: [],
      disabledProviders: [],
      ...policy,
    },
    retryBackoffMs: 1,
    healthCooldownMs: 10_000,
  });
}

describe('free-only policy', () => {
  test('a paid provider is never called in free-only mode', async () => {
    const called: string[] = [];
    const complete: CompleteFn = async (_m, config) => {
      called.push(config.provider);
      return 'ok';
    };
    const router = routerWith(
      { agents: { coder: { provider: 'openai', model: 'gpt-4o-mini' } } },
      complete,
      {
        freeOnly: true,
        costClassOf: () => 'paid',
      }
    );

    let err: unknown = null;
    try {
      await router.complete('coder', MESSAGES);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModelRoutingError);
    expect((err as ModelRoutingError).kind).toBe('no_model_available');
    expect(called.length).toBe(0);
  });

  test('an unknown cost class is treated as paid in free-only mode', async () => {
    const called: string[] = [];
    const complete: CompleteFn = async (_m, config) => {
      called.push(config.provider);
      return 'ok';
    };
    const router = routerWith(
      { agents: { coder: { provider: 'mystery', model: 'x' } } },
      complete,
      { freeOnly: true, costClassOf: () => 'unknown' }
    );
    await expect(router.complete('coder', MESSAGES)).rejects.toThrow();
    expect(called.length).toBe(0);
  });

  test('a free provider IS used in free-only mode', async () => {
    const complete: CompleteFn = async () => 'free answer';
    const router = routerWith(
      { agents: { coder: { provider: 'zai', model: 'glm-4.6' } } },
      complete,
      { freeOnly: true, costClassOf: () => 'free' }
    );
    const res = await router.complete('coder', MESSAGES);
    expect(res.text).toBe('free answer');
  });

  test('a disabled provider is skipped and reported', async () => {
    const called: string[] = [];
    const complete: CompleteFn = async (_m, config) => {
      called.push(config.provider);
      return 'ok';
    };
    const router = routerWith(
      {
        agents: {
          coder: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            fallback: { provider: 'zai', model: 'glm-4.6' },
          },
        },
      },
      complete,
      { disabledProviders: ['openai'] }
    );
    const res = await router.complete('coder', MESSAGES);
    expect(called).toEqual(['zai']);
    expect(res.provider).toBe('zai');
  });

  test('the provider priority decides the order', async () => {
    const called: string[] = [];
    const complete: CompleteFn = async (_m, config) => {
      called.push(config.provider);
      return 'ok';
    };
    const router = routerWith(
      {
        agents: {
          coder: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            fallback: { provider: 'zai', model: 'glm-4.6' },
          },
        },
      },
      complete,
      { providerOrder: ['zai', 'openai'] }
    );
    await router.complete('coder', MESSAGES);
    expect(called[0]).toBe('zai');
  });

  test('the reason for a skip is reported to the UI', async () => {
    const records: ModelRouteRecord[] = [];
    const complete: CompleteFn = async () => 'ok';
    const router = routerWith(
      { agents: { coder: { provider: 'openai', model: 'gpt-4o-mini' } } },
      complete,
      { freeOnly: true, costClassOf: () => 'paid' },
      (r) => records.push(r)
    );
    await router.complete('coder', MESSAGES).catch(() => undefined);
    const skipped = records.find((r) => r.attempt === 0);
    expect(skipped?.reason).toContain('free-only');
  });
});

describe('agent roles', () => {
  test('the four additional roles exist', () => {
    for (const role of ['researcher', 'debugger', 'security', 'docs'] as const) {
      expect(AGENT_ROLES).toContain(role);
      expect(AGENT_ROLE_LABEL[role]).toBeTruthy();
      expect(ROLES[role]).toBeDefined();
      expect(ROLES[role].systemPrompt.length).toBeGreaterThan(100);
      expect(DEFAULT_TEMPERATURE[role]).toBeGreaterThanOrEqual(0);
    }
  });

  test('every role has a system prompt and an emoji', () => {
    for (const role of AGENT_ROLES) {
      expect(ROLES[role as keyof typeof ROLES]).toBeDefined();
      expect(ROLES[role as keyof typeof ROLES].systemPrompt.length).toBeGreaterThan(50);
      expect(ROLES[role as keyof typeof ROLES].emoji).toBeTruthy();
    }
  });

  test('the planner may use the new step kinds', () => {
    const parsed = buildPlanParse(
      JSON.stringify({
        title: 'A plan with every kind',
        steps: [
          { index: 1, title: 'look around', description: '', kind: 'research', acceptance: '' },
          { index: 2, title: 'fix it', description: '', kind: 'debug', acceptance: '' },
          { index: 3, title: 'audit', description: '', kind: 'security', acceptance: '' },
          { index: 4, title: 'document', description: '', kind: 'docs', acceptance: '' },
          { index: 5, title: 'verify', description: '', kind: 'test', acceptance: '' },
        ],
      })
    );
    expect(parsed.steps.map((s) => s.kind)).toEqual([
      'research',
      'debug',
      'security',
      'docs',
      'test',
    ]);
  });

  test('a research step is read-only, an implement step is not', () => {
    expect(isReadOnlyKind('research')).toBe(true);
    expect(isReadOnlyKind('analyze')).toBe(true);
    expect(isReadOnlyKind('implement')).toBe(false);
    expect(isReadOnlyKind('docs')).toBe(false);
  });

  test('an unknown kind falls back to implement', () => {
    const parsed = buildPlanParse(
      JSON.stringify({
        title: 'x',
        steps: [{ index: 1, title: 'a', description: '', kind: 'not-a-kind', acceptance: '' }],
      })
    );
    expect(parsed.steps[0].kind).toBe('implement');
  });

  test('the new roles can be configured like every other role', () => {
    const routing = normalizeAgentConfig({
      agents: {
        researcher: { provider: 'zai', model: 'glm-4.6' },
        debugger: { provider: 'zai', model: 'glm-4.6' },
        security: { provider: 'zai', model: 'glm-4.6' },
        docs: { provider: 'zai', model: 'glm-4.6' },
      },
    });
    expect(routing.agents.researcher?.provider).toBe('zai');
    expect(routing.agents.docs?.provider).toBe('zai');
  });
});
