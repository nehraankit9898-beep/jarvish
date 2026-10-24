/**
 * Route-level contract for provider settings (spec §5, §8, §9, §11).
 *
 * The storage layer is mocked so the platform-independent parts can be tested
 * without a database: the request/response shape, the "key travels in the
 * body, never in a URL" rule, provenance labels, and the guarantee that a
 * secret is never echoed back.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: {
  listProviderModels: Array<Record<string, unknown>>;
  testProviderConnection: Array<Record<string, unknown>>;
  recordConnectionResult: Array<[string, boolean, string]>;
  recordLastError: Array<Record<string, unknown>>;
} = {
  listProviderModels: [],
  testProviderConnection: [],
  recordConnectionResult: [],
  recordLastError: [],
};

let liveModels: { models: Array<{ id: string; free?: boolean; chat?: boolean }>; source: string; fetchedAt: string | null; error?: string } = {
  models: [
    { id: 'gemini-3.8-flash', chat: true },
    { id: 'text-embedding-004', chat: false },
  ],
  source: 'provider',
  fetchedAt: '2026-10-24T10:00:00.000Z',
};

let storedKey = '';

let testResult: Record<string, unknown> = {
  ok: true,
  message: 'Connected — verified with a real request',
  model: 'gemini-3.8-flash',
  checkedAt: '2026-10-24T10:00:00.000Z',
};

mock.module('@/lib/agentic/api-auth', () => ({
  rejectIfUnauthorized: () => null,
}));

mock.module('@/lib/agentic/audit', () => ({
  recordAudit: async () => undefined,
  clientIp: () => '127.0.0.1',
}));

mock.module('@/lib/agentic/provider-store', () => ({
  effectiveCredential: async () => ({ apiKey: storedKey, baseUrl: '' }),
  recordConnectionResult: async (provider: string, ok: boolean, error: string) => {
    calls.recordConnectionResult.push([provider, ok, error]);
  },
}));

mock.module('@/lib/agentic/last-action-error', () => ({
  recordLastError: (input: Record<string, unknown>) => {
    calls.recordLastError.push(input);
  },
}));

mock.module('@/lib/agentic/provider-connection', () => ({
  testProviderConnection: async (input: Record<string, unknown>) => {
    calls.testProviderConnection.push(input);
    return testResult;
  },
  listProviderModels: async (input: Record<string, unknown>) => {
    calls.listProviderModels.push(input);
    return liveModels;
  },
  catalogModels: () => [
    { id: 'gemini-3.8-flash', chat: true },
    { id: 'gemini-3.6-flash', chat: true },
  ],
  providerNeedsKey: () => true,
}));

type Handler = (
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) => Promise<Response>;

async function modelsRoute(): Promise<{ POST: Handler }> {
  return (await import('@/app/api/providers/[id]/models/route')) as unknown as {
    POST: Handler;
  };
}

async function testRoute(): Promise<{ POST: Handler }> {
  return (await import('@/app/api/providers/[id]/test/route')) as unknown as {
    POST: Handler;
  };
}

const post = (body: unknown) =>
  new Request('http://localhost/api/providers/gemini/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  calls.listProviderModels.length = 0;
  calls.testProviderConnection.length = 0;
  calls.recordConnectionResult.length = 0;
  calls.recordLastError.length = 0;
  storedKey = '';
  liveModels = {
    models: [
      { id: 'gemini-3.8-flash', chat: true },
      { id: 'text-embedding-004', chat: false },
    ],
    source: 'provider',
    fetchedAt: '2026-10-24T10:00:00.000Z',
  };
  testResult = {
    ok: true,
    message: 'Connected — verified with a real request',
    model: 'gemini-3.8-flash',
  };
});

describe('POST /api/providers/[id]/models', () => {
  test('an unsaved key is sent in the body and never in the URL', async () => {
    const { POST } = await modelsRoute();
    const res = await POST(post({ apiKey: 'sk-or-very-secret-1234', model: 'gemini-3.8-flash' }), {
      params: Promise.resolve({ id: 'gemini' }),
    });
    expect(res.status).toBe(200);
    const sent = calls.listProviderModels[0];
    expect(sent.apiKey).toBe('sk-or-very-secret-1234');
    expect(String(post({}).url)).not.toContain('apiKey');
  });

  test('the response separates live/chat models and never echoes the key', async () => {
    const { POST } = await modelsRoute();
    const res = await POST(post({ apiKey: 'sk-live-key-9999' }), {
      params: Promise.resolve({ id: 'gemini' }),
    });
    const text = await res.text();
    const data = JSON.parse(text) as {
      models: Array<{ id: string }>;
      source: string;
      cached: boolean;
      fetchedAt: string;
      chatOnly: boolean;
      selected: string;
    };
    expect(data.source).toBe('provider');
    expect(data.cached).toBe(false);
    expect(data.fetchedAt).toBe('2026-10-24T10:00:00.000Z');
    expect(data.chatOnly).toBe(true);
    // embeddings are not chat models
    expect(data.models.map((m) => m.id)).toEqual(['gemini-3.8-flash']);
    expect(data.selected).toBe('gemini-3.8-flash');
    expect(text).not.toContain('sk-live-key-9999');
  });

  test('a provider failure falls back to the catalog and says so', async () => {
    liveModels = { models: [], source: 'cache', fetchedAt: null, error: '429 rate limited' };
    const { POST } = await modelsRoute();
    const res = await POST(post({}), { params: Promise.resolve({ id: 'gemini' }) });
    const data = (await res.json()) as { source: string; note: string; error: string };
    expect(data.source).toBe('catalog');
    expect(data.error).toContain('429');
    expect(data.note).toBeTruthy();
  });

  test('an unknown provider is a 404, not a fabricated list', async () => {
    const { POST } = await modelsRoute();
    const res = await POST(post({}), { params: Promise.resolve({ id: 'not-a-provider' }) });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/providers/[id]/test', () => {
  test('a passing test is returned AND persisted as verified', async () => {
    const { POST } = await testRoute();
    const res = await POST(post({ apiKey: 'sk-test-1234', model: 'gemini-3.8-flash' }), {
      params: Promise.resolve({ id: 'gemini' }),
    });
    const data = (await res.json()) as { ok: boolean; message: string };
    expect(data.ok).toBe(true);
    expect(data.message).toContain('verified');
    expect(calls.recordConnectionResult).toEqual([['gemini', true, '']]);
    expect(calls.testProviderConnection[0].apiKey).toBe('sk-test-1234');
  });

  test('a failure keeps its category, is persisted, and hides the key', async () => {
    testResult = {
      ok: false,
      error: 'API key not valid. Please pass a valid API key.',
      errorCategory: 'auth',
      hint: 'Check the key in Google AI Studio.',
      model: 'gemini-3.8-flash',
    };
    const { POST } = await testRoute();
    const res = await POST(post({ apiKey: 'sk-super-secret-0000' }), {
      params: Promise.resolve({ id: 'gemini' }),
    });
    const text = await res.text();
    const data = JSON.parse(text) as { ok: boolean; errorCategory: string; hint: string };
    expect(data.ok).toBe(false);
    expect(data.errorCategory).toBe('auth');
    expect(data.hint).toContain('Google AI Studio');
    expect(text).not.toContain('sk-super-secret-0000');
    expect(calls.recordConnectionResult[0]).toEqual([
      'gemini',
      false,
      'API key not valid. Please pass a valid API key.',
    ]);
    expect(calls.recordLastError).toHaveLength(1);
  });

  test('the stored credential is used when the body has no key', async () => {
    storedKey = 'stored-key-xyz';
    const { POST } = await testRoute();
    await POST(post({}), { params: Promise.resolve({ id: 'gemini' }) });
    expect(calls.testProviderConnection[0].apiKey).toBe('stored-key-xyz');
  });

  test('a key typed in the body wins over the stored one', async () => {
    storedKey = 'stored-key-xyz';
    const { POST } = await testRoute();
    await POST(post({ apiKey: 'typed-key-123' }), { params: Promise.resolve({ id: 'gemini' }) });
    expect(calls.testProviderConnection[0].apiKey).toBe('typed-key-123');
  });
});
