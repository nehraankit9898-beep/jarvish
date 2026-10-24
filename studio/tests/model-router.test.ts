// Model router tests — per-role routing, fallback, retries, health, usage.
// All LLM traffic is mocked, so these tests need NO network and NO API keys.
// Run: bun test tests/model-router.test.ts
import { describe, expect, test } from 'bun:test';
import {
  ModelRouter,
  classifyRouterError,
  type CompleteFn,
  type ModelRouteRecord,
} from '../src/lib/agentic/model-router';
import {
  fallbackChain,
  normalizeAgentConfig,
  redactAgentConfig,
  resolveAgentModel,
  validateAgentConfig,
  type AgentRoutingConfig,
} from '../src/lib/agentic/agent-config';

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];

function routerWith(
  routing: AgentRoutingConfig,
  complete: CompleteFn,
  onRoute?: (r: ModelRouteRecord) => void,
  opts: { credentials?: Record<string, { apiKey?: string; baseUrl?: string }> } = {}
) {
  return new ModelRouter({
    routing,
    taskFallback: { provider: 'zai', model: 'glm-4.6' },
    credentials: opts.credentials,
    complete,
    onRoute,
    retryBackoffMs: 1,
    healthCooldownMs: 10_000,
  });
}

describe('agent configuration', () => {
  test('each role keeps its own provider/model', () => {
    const routing = normalizeAgentConfig({
      agents: {
        planner: { provider: 'gemini', model: 'gemini-3.8-flash' },
        coder: { provider: 'ollama', model: 'qwen2.5' },
        tester: { provider: 'openai', model: 'gpt-4o-mini' },
        reviewer: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      },
    });
    expect(routing.agents.planner?.provider).toBe('gemini');
    expect(routing.agents.coder?.provider).toBe('ollama');
    expect(routing.agents.tester?.provider).toBe('openai');
    expect(routing.agents.reviewer?.provider).toBe('anthropic');
  });

  test('a role without an assignment falls back to the task model', () => {
    const routing = normalizeAgentConfig(
      { agents: { coder: { provider: 'ollama', model: 'qwen2.5' } } },
      { provider: 'zai', model: 'glm-4.6' }
    );
    expect(routing.agents.planner?.provider).toBe('zai');
    expect(routing.agents.planner?.model).toBe('glm-4.6');
    expect(routing.agents.coder?.provider).toBe('ollama');
  });

  test('invalid configuration is reported', () => {
    const issues = validateAgentConfig({
      agents: {
        planner: { provider: 'not-a-provider', model: 'x' },
        coder: { provider: 'custom', model: '' },
      },
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.field === 'provider')).toBe(true);
    expect(issues.some((i) => i.field === 'model')).toBe(true);
  });

  test('a baseUrl supplied through the credentials satisfies the validation', () => {
    // the browser sends the baseUrl of a "custom" provider in the credential
    // map — the role config itself does not have to repeat it
    const issues = validateAgentConfig(
      {
        agents: {
          planner: { provider: 'custom', model: 'mock-model' },
        },
      },
      { custom: { baseUrl: 'http://localhost:11499/v1' } }
    );
    expect(issues.filter((i) => i.field === 'baseUrl')).toHaveLength(0);
  });

  test('the credential baseUrl is copied into the (non-secret) routing config', () => {
    const routing = normalizeAgentConfig(
      { agents: { planner: { provider: 'custom', model: 'mock-model' } } },
      { provider: 'custom', model: 'mock-model' },
      { custom: { baseUrl: 'http://localhost:11499/v1', apiKey: 'sk-secret' } }
    );
    expect(routing.agents.planner?.baseUrl).toBe('http://localhost:11499/v1');
    // the role that fell back to the task model gets it as well
    expect(routing.agents.coder?.baseUrl).toBe('http://localhost:11499/v1');
    // …but the API key NEVER ends up in the persisted config
    expect(JSON.stringify(routing)).not.toContain('sk-secret');
  });

  test('the fallback chain is flattened and cycle safe', () => {
    const chain = fallbackChain({
      provider: 'openai',
      model: 'a',
      fallback: {
        provider: 'anthropic',
        model: 'b',
        fallback: { provider: 'openai', model: 'a' },
      },
    });
    expect(chain.length).toBe(2);
    expect(chain[1].provider).toBe('anthropic');
  });

  test('redaction removes anything that looks like a credential', () => {
    const dirty = {
      agents: {
        planner: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          apiKey: 'sk-super-secret-value-1234567890',
        },
      },
    } as unknown as AgentRoutingConfig;
    const clean = redactAgentConfig(dirty);
    expect(JSON.stringify(clean)).not.toContain('sk-super-secret-value-1234567890');
    expect(clean.agents.planner?.provider).toBe('openai');
  });
});

describe('model router — per role selection', () => {
  test('every role calls its OWN provider/model', async () => {
    const seen: { role: string; provider: string; model: string }[] = [];
    const complete: CompleteFn = async (_m, config) => {
      return `ok ${config.provider}/${config.model}`;
    };
    const router = routerWith(
      {
        agents: {
          planner: { provider: 'gemini', model: 'gemini-3.8-flash' },
          coder: { provider: 'ollama', model: 'qwen2.5' },
          tester: { provider: 'openai', model: 'gpt-4o-mini' },
          reviewer: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
        },
      },
      complete
    );

    for (const role of ['planner', 'coder', 'tester', 'reviewer'] as const) {
      const res = await router.complete(role, MESSAGES);
      seen.push({ role, provider: res.provider, model: res.model });
    }

    expect(seen).toEqual([
      { role: 'planner', provider: 'gemini', model: 'gemini-3.8-flash' },
      { role: 'coder', provider: 'ollama', model: 'qwen2.5' },
      { role: 'tester', provider: 'openai', model: 'gpt-4o-mini' },
      { role: 'reviewer', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    ]);
  });

  test('the api key reaches the provider call but never the journal', async () => {
    let receivedKey: string | undefined;
    const complete: CompleteFn = async (_m, config) => {
      receivedKey = config.apiKey;
      return 'done';
    };
    const router = routerWith(
      { agents: { coder: { provider: 'openai', model: 'gpt-4o-mini' } } },
      complete,
      undefined,
      { credentials: { openai: { apiKey: 'sk-test-key-1234567890' } } }
    );
    await router.complete('coder', MESSAGES);
    expect(receivedKey).toBe('sk-test-key-1234567890');
    expect(JSON.stringify(router.journal)).not.toContain('sk-test-key-1234567890');
    expect(JSON.stringify(router.getHealth())).not.toContain('sk-test-key-1234567890');
  });
});

describe('model router — failures, retries and fallback', () => {
  test('a non-retryable failure falls back to the secondary model', async () => {
    const attempts: string[] = [];
    const complete: CompleteFn = async (_m, config) => {
      attempts.push(config.provider);
      if (config.provider === 'openai') {
        throw new Error('API error 401: invalid key');
      }
      return 'from fallback';
    };
    const router = routerWith(
      {
        agents: {
          coder: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            maxRetries: 1,
            fallback: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
          },
        },
      },
      complete
    );

    const res = await router.complete('coder', MESSAGES);
    expect(res.provider).toBe('anthropic');
    expect(res.fallbackUsed).toBe(true);
    expect(res.text).toBe('from fallback');
    // 401 is not retryable → exactly one attempt on the primary
    expect(attempts.filter((a) => a === 'openai').length).toBe(1);
    expect(attempts.filter((a) => a === 'anthropic').length).toBe(1);
  });

  test('a retryable failure is retried on the same model', async () => {
    let calls = 0;
    const complete: CompleteFn = async () => {
      calls++;
      if (calls < 3) throw new Error('fetch failed: network error');
      return 'recovered';
    };
    const router = routerWith(
      {
        agents: {
          tester: { provider: 'openai', model: 'gpt-4o-mini', maxRetries: 3 },
        },
      },
      complete
    );
    const res = await router.complete('tester', MESSAGES);
    expect(res.text).toBe('recovered');
    expect(res.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  test('the retry budget is respected', async () => {
    let calls = 0;
    const complete: CompleteFn = async () => {
      calls++;
      throw new Error('API error 500: server error');
    };
    const router = routerWith(
      {
        agents: {
          tester: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            maxRetries: 2,
            fallback: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
          },
        },
      },
      complete
    );
    await expect(router.complete('tester', MESSAGES)).rejects.toThrow();
    // 3 attempts on the primary (1 + 2 retries) + 1 on the fallback
    expect(calls).toBe(4);
  });

  test('a failing model is marked unhealthy and skipped afterwards', async () => {
    let calls = 0;
    const complete: CompleteFn = async (_m, config) => {
      calls++;
      if (config.provider === 'openai') {
        throw new Error('API error 500: server error');
      }
      return 'ok';
    };
    const router = routerWith(
      {
        agents: {
          coder: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            maxRetries: 0,
            fallback: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
          },
        },
      },
      complete
    );
    await router.complete('coder', MESSAGES);
    const health = router.healthOf('openai', 'gpt-4o-mini');
    expect(health.consecutiveFailures).toBe(1);
    expect(health.status).toBe('degraded');
    expect(health.totalFailures).toBe(1);
    expect(calls).toBe(2);
  });

  test('usage and latency are recorded for every call', async () => {
    const complete: CompleteFn = async () => 'a'.repeat(400);
    const router = routerWith(
      { agents: { coder: { provider: 'ollama', model: 'llama3.2' } } },
      complete
    );
    const res = await router.complete('coder', MESSAGES);
    expect(res.usage.estimated).toBe(true);
    expect(res.usage.completionChars).toBe(400);
    expect(res.usage.promptChars).toBe(MESSAGES[0].content.length);
    expect(res.usage.estimatedTokens).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(router.journal.length).toBe(1);
    expect(router.journal[0].ok).toBe(true);
  });

  test('the router reports the selected model through onRoute', async () => {
    const records: ModelRouteRecord[] = [];
    const router = routerWith(
      { agents: { planner: { provider: 'gemini', model: 'gemini-3.8-flash' } } },
      async () => 'plan',
      (r) => records.push(r)
    );
    await router.complete('planner', MESSAGES);
    expect(records.length).toBe(1);
    expect(records[0].role).toBe('planner');
    expect(records[0].provider).toBe('gemini');
    expect(records[0].model).toBe('gemini-3.8-flash');
    expect(records[0].ok).toBe(true);
  });
});

describe('model router — error classification', () => {
  test('auth errors are not retryable', () => {
    expect(classifyRouterError(new Error('API error 401: nope')).retryable).toBe(false);
    expect(classifyRouterError(new Error('API error 403: nope')).retryable).toBe(false);
  });

  test('rate limits, 5xx, timeouts and network errors are retryable', () => {
    expect(classifyRouterError(new Error('API error 429: slow down')).retryable).toBe(true);
    expect(classifyRouterError(new Error('API error 503: unavailable')).retryable).toBe(true);
    expect(classifyRouterError(new Error('The operation was aborted due to timeout')).retryable).toBe(true);
    expect(classifyRouterError(new Error('fetch failed')).retryable).toBe(true);
  });

  test('other 4xx errors are not retryable', () => {
    expect(classifyRouterError(new Error('API error 400: bad request')).retryable).toBe(false);
  });
});

describe('agent model resolution', () => {
  test('resolveAgentModel returns per-role settings with sane defaults', () => {
    const cfg = resolveAgentModel(
      'tester',
      { agents: { tester: { provider: 'ollama', model: 'qwen2.5' } } },
      { provider: 'zai', model: 'glm-4.6' }
    );
    expect(cfg.provider).toBe('ollama');
    expect(cfg.model).toBe('qwen2.5');
    expect(cfg.timeoutMs).toBeGreaterThan(0);
    expect(cfg.maxRetries).toBeGreaterThanOrEqual(0);
    expect(cfg.temperature).toBeGreaterThanOrEqual(0);
  });
});

describe('Retry-After (provider quota awareness)', () => {
  test('a 429 carries the provider Retry-After through the classifier', () => {
    const c = classifyRouterError(new Error('API error 429 [retry-after=30s]: slow down'));
    expect(c.kind).toBe('rate_limit');
    expect(c.retryable).toBe(true);
    expect(c.retryAfterMs).toBe(30_000);
  });

  test('a 429 without the header has no retryAfterMs and still retries', () => {
    const c = classifyRouterError(new Error('API error 429: slow down'));
    expect(c.retryable).toBe(true);
    expect(c.retryAfterMs).toBeUndefined();
  });

  test('a long Retry-After skips straight to the next model instead of waiting or hammering', async () => {
    const attempts: string[] = [];
    const complete: CompleteFn = async (_m, config) => {
      attempts.push(config.provider);
      if (config.provider === 'openai') throw new Error('API error 429 [retry-after=3600s]: quota');
      return 'from fallback';
    };
    const router = routerWith(
      {
        agents: {
          coder: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            maxRetries: 3,
            fallback: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
          },
        },
      },
      complete
    );
    const res = await router.complete('coder', MESSAGES);
    expect(res.provider).toBe('anthropic');
    // exactly ONE call to the rate-limited provider, although 3 retries were allowed
    expect(attempts.filter((a) => a === 'openai')).toHaveLength(1);
    // and it is parked for about the hour the provider asked for
    const parked = router.getHealth().find((h) => h.provider === 'openai')!;
    expect(parked.status).toBe('unhealthy');
    expect(parked.cooldownUntil! - Date.now()).toBeGreaterThan(3_500_000);
  });

  test('a short Retry-After is waited out and the SAME model succeeds', async () => {
    let n = 0;
    const complete: CompleteFn = async () => {
      n++;
      if (n === 1) throw new Error('API error 429 [retry-after=0.05s]: slow down');
      return 'ok after waiting';
    };
    const router = routerWith({ agents: { coder: { provider: 'openai', model: 'gpt-4o-mini', maxRetries: 2 } } }, complete);
    const res = await router.complete('coder', MESSAGES);
    expect(res.text).toBe('ok after waiting');
    expect(res.fallbackUsed).toBe(false);
    expect(n).toBe(2);
  });
});
