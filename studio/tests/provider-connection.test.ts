// Provider connection tests — deterministic, mocked HTTP only.
// Run: bun test tests/provider-connection.test.ts
//
// A mocked test proves the CODE handles a response; it is NOT proof that a
// real key works. The manual real-key checks live in docs/VERIFY_MANUAL.md.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __clearModelCache,
  listProviderModels,
  providerNeedsKey,
  testProviderConnection,
} from '../src/lib/agentic/provider-connection';
import { PROVIDERS, getProvider, resolveModelWithNotice } from '../src/lib/providers';

// Loopback keeps the REAL SSRF guard active (it is allowed by policy) while
// letting the mocked fetch answer — no DNS, no network.
const LOCAL = 'http://localhost:9/v1';
const LOCAL_BETA = 'http://localhost:9/v1beta';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });

let calls: Array<{ url: string; init: RequestInit }> = [];
const realFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  __clearModelCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const KEY = 'AIzaTESTKEY_0123456789abcdefghijklmnop'; // fake, shaped like a real key

describe('Gemini connection test', () => {
  test('a real completion is required for ok:true', async () => {
    mockFetch(() =>
      json({
        candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
      })
    );
    const r = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('connected');
    expect(r.message).toContain('gemini-3.8-flash');
    expect(r.checkedAt).toBeTruthy();
  });

  test('uses the official endpoint, the header key and NEVER the query string', async () => {
    mockFetch(() => json({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }));
    await testProviderConnection({ provider: 'gemini', apiKey: KEY, baseUrl: LOCAL_BETA });
    const url = calls[0].url;
    expect(url).toContain('/models/gemini-3.8-flash:generateContent');
    expect(url).not.toContain('key=');
    expect(url).not.toContain(KEY);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe(KEY);
    expect(JSON.stringify(headers)).not.toContain('Authorization');
  });

  test('a blocked prompt is a FAILURE, not a connection', async () => {
    mockFetch(() => json({ promptFeedback: { blockReason: 'SAFETY' } }));
    const r = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCategory).toBe('blocked');
    expect(r.error).toContain('SAFETY');
  });

  test('an empty candidate is a FAILURE (the old code said "Connected: \\"\\"")', async () => {
    mockFetch(() => json({ candidates: [{ content: { parts: [] }, finishReason: 'OTHER' }] }));
    const r = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCategory).toBe('empty_response');
    expect(r.error).toContain('finishReason=OTHER');
  });

  test('401 is an auth failure and the key echoed by the provider is redacted', async () => {
    mockFetch(() =>
      json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: `API key not valid: ${KEY}` } }, 401)
    );
    const r = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCategory).toBe('auth');
    expect(r.statusCode).toBe(401);
    expect(r.error).not.toContain(KEY);
    expect(r.error).toContain('[redacted]');
  });

  test('403 is auth, 404 is model_unavailable with a refresh hint', async () => {
    mockFetch(() => json({ error: { message: 'denied' } }, 403));
    const denied = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
    });
    expect(denied.errorCategory).toBe('auth');

    mockFetch(() => json({ error: { message: 'models/gemini-x is not found' } }, 404));
    const missing = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
      model: 'gemini-does-not-exist',
    });
    expect(missing.errorCategory).toBe('model_unavailable');
    expect(missing.error).toContain('gemini-does-not-exist');
    expect(missing.hint).toContain('Refresh the model list');
  });

  test('429 keeps the provider Retry-After and is classified as rate_limit', async () => {
    mockFetch(() => json({ error: { message: 'quota' } }, 429, { 'retry-after': '17' }));
    const r = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
    });
    expect(r.errorCategory).toBe('rate_limit');
    expect(r.retryAfterSec).toBe(17);
    expect(r.error).toContain('17s');
  });

  test('5xx is a server failure, malformed JSON is a config failure', async () => {
    mockFetch(() => json({ error: { message: 'boom' } }, 503));
    const server = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
    });
    expect(server.errorCategory).toBe('server');

    mockFetch(() => text('<html>proxy error</html>'));
    const malformed = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.errorCategory).toBe('config');
  });

  test('a DNS failure is "network" — not "wrong key"', async () => {
    mockFetch(() => {
      const err = new TypeError('fetch failed');
      (err as any).cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' };
      throw err;
    });
    const r = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
    });
    expect(r.errorCategory).toBe('network');
    expect(r.hint).toContain('internet');
  });

  test('a TimeoutError is classified as timeout', async () => {
    mockFetch(() => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    const r = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
    });
    expect(r.errorCategory).toBe('timeout');
  });

  test('a missing key is not_configured and never sends a request', async () => {
    mockFetch(() => json({}));
    const r = await testProviderConnection({ provider: 'gemini', baseUrl: LOCAL_BETA });
    expect(r.ok).toBe(false);
    expect(r.errorCategory).toBe('not_configured');
    expect(calls.length).toBe(0);
  });

  test('a retired model is replaced WITH a notice (never silently)', async () => {
    mockFetch(() => json({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }));
    const r = await testProviderConnection({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
      model: 'gemini-2.0-flash',
    });
    expect(r.model).toBe('gemini-3.8-flash');
    expect(r.notice?.from).toBe('gemini-2.0-flash');
    expect(r.notice?.reason).toContain('shut down');
    expect(calls[0].url).toContain('gemini-3.8-flash');
  });
});

describe('OpenRouter connection test', () => {
  test('uses the OpenAI-compatible endpoint, the bearer header and the exact model id', async () => {
    mockFetch(() => json({ choices: [{ message: { content: 'OK' } }] }));
    const r = await testProviderConnection({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-testkey1234567890',
      baseUrl: LOCAL,
      model: 'google/gemma-4-31b-it:free',
    });
    expect(r.ok).toBe(true);
    expect(r.model).toBe('google/gemma-4-31b-it:free');
    expect(calls[0].url).toContain('/chat/completions');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or-v1-testkey1234567890');
    expect(headers['X-Title']).toContain('AgentScope');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe('google/gemma-4-31b-it:free');
    expect(body.stream).toBe(false);
  });

  test('402/429 are both a quota problem for OpenRouter', async () => {
    mockFetch(() => json({ error: { message: 'Insufficient credits' } }, 402));
    const noCredits = await testProviderConnection({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-x1234567890',
      baseUrl: LOCAL,
    });
    expect(noCredits.errorCategory).toBe('rate_limit');
    expect(noCredits.error).toContain('credits');

    mockFetch(() => json({ error: { message: 'rate limited' } }, 429, { 'retry-after': '3' }));
    const limited = await testProviderConnection({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-x1234567890',
      baseUrl: LOCAL,
    });
    expect(limited.errorCategory).toBe('rate_limit');
    expect(limited.retryAfterSec).toBe(3);
  });

  test('a 200 without text is empty_response (never "Connected")', async () => {
    mockFetch(() => json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
    const r = await testProviderConnection({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-x1234567890',
      baseUrl: LOCAL,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCategory).toBe('empty_response');
    expect(r.error).toContain('finish_reason=length');
  });
});

describe('local providers', () => {
  test('Ollama needs no key', () => {
    expect(providerNeedsKey('ollama')).toBe(false);
    expect(providerNeedsKey('gemini')).toBe(true);
    expect(providerNeedsKey('custom')).toBe(false);
  });

  test('a local model server works with no key at all', async () => {
    mockFetch(() => json({ choices: [{ message: { content: 'hi' } }] }));
    const r = await testProviderConnection({
      provider: 'ollama',
      baseUrl: 'http://localhost:9/v1',
      model: 'llama3.2',
    });
    expect(r.ok).toBe(true);
    expect(r.model).toBe('llama3.2');
  });
});

describe('model discovery', () => {
  test('Gemini: only generateContent chat models, non-chat families filtered out', async () => {
    mockFetch(() =>
      json({
        models: [
          { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 },
          { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-tts', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/veo-3', supportedGenerationMethods: ['predictLongRunning'] },
        ],
      })
    );
    const list = await listProviderModels({
      provider: 'gemini',
      apiKey: KEY,
      baseUrl: LOCAL_BETA,
    });
    expect(list).not.toBeNull();
    const ids = list!.models.map((m) => m.id);
    expect(ids).toContain('gemini-3.8-flash');
    expect(ids).toContain('gemini-3.5-flash-lite');
    expect(ids).not.toContain('gemini-embedding-001');
    expect(ids).not.toContain('gemini-2.5-flash-image');
    expect(ids).not.toContain('veo-3');
    const flash = list!.models.find((m) => m.id === 'gemini-3.8-flash')!;
    expect(flash.chat).toBe(true);
    expect(flash.contextWindow).toBe(1048576);
  });

  test('OpenRouter: keeps exact ids + free metadata, drops image-only models', async () => {
    mockFetch(() =>
      json({
        data: [
          {
            id: 'google/gemma-4-31b-it:free',
            pricing: { prompt: '0', completion: '0' },
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            supported_parameters: ['tools'],
            context_length: 262144,
          },
          {
            id: 'qwen/qwen3.8-27b:free',
            pricing: { prompt: '0', completion: '0' },
            architecture: { output_modalities: ['text'] },
          },
          {
            id: 'someone/paid-model',
            pricing: { prompt: '0.000001', completion: '0.000002' },
            architecture: { output_modalities: ['text'] },
          },
          {
            id: 'google/gemini-image-preview',
            architecture: { output_modalities: ['image'] },
          },
        ],
      })
    );
    const list = await listProviderModels({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-x1234567890',
      baseUrl: LOCAL,
      refresh: true,
    });
    const ids = list!.models.map((m) => m.id);
    expect(ids).toContain('google/gemma-4-31b-it:free');
    expect(ids).toContain('someone/paid-model'); // present, but marked paid
    expect(ids).not.toContain('google/gemini-image-preview');
    expect(list!.models.find((m) => m.id === 'google/gemma-4-31b-it:free')?.free).toBe(true);
    expect(list!.models.find((m) => m.id === 'someone/paid-model')?.free).toBe(false);
    expect(list!.models.find((m) => m.id === 'google/gemma-4-31b-it:free')?.tools).toBe(true);
  });

  test('a second call is served from the cache, refresh bypasses it', async () => {
    mockFetch(() =>
      json({ data: [{ id: 'model-a', architecture: { output_modalities: ['text'] } }] })
    );
    const first = await listProviderModels({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-x1234567890',
      baseUrl: LOCAL,
    });
    expect(first!.source).toBe('provider');
    const second = await listProviderModels({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-x1234567890',
      baseUrl: LOCAL,
    });
    expect(second!.source).toBe('cache');
    expect(calls.length).toBe(1);
    const refreshed = await listProviderModels({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-x1234567890',
      baseUrl: LOCAL,
      refresh: true,
    });
    expect(refreshed!.source).toBe('provider');
    expect(calls.length).toBe(2);
  });

  test('a failing model list reports the real error instead of inventing models', async () => {
    mockFetch(() => json({ error: { message: 'invalid api key' } }, 401));
    const list = await listProviderModels({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-badkey1234567890',
      baseUrl: LOCAL,
    });
    expect(list!.models.length).toBe(0);
    expect(list!.error).toContain('invalid api key');
  });

  test('no key → no live request, an explicit error is returned', async () => {
    mockFetch(() => json({}));
    const list = await listProviderModels({ provider: 'gemini', baseUrl: LOCAL_BETA });
    expect(list!.error).toContain('No API key');
    expect(calls.length).toBe(0);
  });
});

describe('model id source of truth', () => {
  test('display names are never used as API ids', () => {
    for (const p of PROVIDERS) {
      for (const m of p.models) {
        expect(m).not.toContain(' ');
        expect(m).toBe(m.trim());
      }
    }
  });

  test('provider ids are unique and the default model is in the catalog', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROVIDERS) {
      if (p.models.length) expect(p.models).toContain(p.defaultModel);
    }
  });

  test('a live model id passes through unchanged (no alias rewriting)', () => {
    const gemini = getProvider('gemini')!;
    expect(resolveModelWithNotice(gemini, 'gemini-3.5-flash-lite')).toEqual({
      model: 'gemini-3.5-flash-lite',
    });
    expect(resolveModelWithNotice(getProvider('openrouter')!, 'vendor/some:free')).toEqual({
      model: 'vendor/some:free',
    });
  });

  test('the OpenRouter default stays a free target', () => {
    const or = getProvider('openrouter')!;
    expect(or.defaultModel === 'openrouter/free' || or.defaultModel.endsWith(':free')).toBe(true);
  });
});
