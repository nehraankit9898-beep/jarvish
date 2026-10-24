import { afterEach, describe, expect, test } from 'bun:test';
import { __clearModelCache, listProviderModels, testProviderConnection } from '../src/lib/agentic/provider-connection';
import { buildUpstreamStream, capHistoryContext } from '../src/lib/llm-core';
import { getProvider } from '../src/lib/providers';
import { chatCompletionParameters, userFirstHistory } from '../src/lib/model-parameters';
import { connectionSignature, persistableConnections } from '../src/lib/api-keys-store';
import { pickSpeechVoice, speechFriendly } from '../src/hooks/use-speech';

const originalFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = (fn: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  globalThis.fetch = ((url: unknown, init?: RequestInit) => Promise.resolve(fn(String(url), init))) as typeof fetch;
};
afterEach(() => { globalThis.fetch = originalFetch; __clearModelCache(); });
const local = 'http://localhost:12345/v1';
const geminiEntry = (id: string) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] });

async function collect(stream: ReadableStream<string>) {
  const reader = stream.getReader();
  let result = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return result;
    result += value;
  }
}

describe('paginated, credential-specific model discovery', () => {
  test('Gemini follows opaque nextPageToken and authenticates every page using headers', async () => {
    const requests: URL[] = [];
    mockFetch((url, init) => {
      const parsed = new URL(url); requests.push(parsed);
      expect(parsed.searchParams.has('key')).toBe(false);
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('unsaved-key');
      return json(parsed.searchParams.has('pageToken')
        ? { models: [geminiEntry('new-chat')] }
        : { models: [geminiEntry('old-chat')], nextPageToken: 'next&+/=' });
    });
    const result = await listProviderModels({ provider: 'gemini', apiKey: 'unsaved-key', baseUrl: local });
    expect(result?.models.map((m) => m.id)).toEqual(['old-chat', 'new-chat']);
    expect(requests).toHaveLength(2);
    expect(requests[0].searchParams.get('pageSize')).toBe('1000');
    expect(requests[1].searchParams.get('pageToken')).toBe('next&+/=');
  });

  test('Anthropic uses limit and after_id through the last page', async () => {
    const requests: URL[] = [];
    mockFetch((url) => {
      const parsed = new URL(url); requests.push(parsed);
      return json(parsed.searchParams.has('after_id')
        ? { data: [{ id: 'second' }], has_more: false }
        : { data: [{ id: 'first' }], has_more: true, last_id: 'first' });
    });
    const result = await listProviderModels({ provider: 'anthropic', apiKey: 'key', baseUrl: local });
    expect(result?.models.map((m) => m.id)).toEqual(['first', 'second']);
    expect(requests[0].searchParams.get('limit')).toBe('1000');
    expect(requests[1].searchParams.get('after_id')).toBe('first');
  });

  test('a later-page auth error never returns a partially verified catalogue', async () => {
    mockFetch((url) => new URL(url).searchParams.has('pageToken')
      ? json({ error: { message: 'denied' } }, 403)
      : json({ models: [geminiEntry('chat')], nextPageToken: 'next' }));
    const result = await listProviderModels({ provider: 'gemini', apiKey: 'key', baseUrl: local });
    expect(result?.error).toContain('denied');
    expect(result?.models).toEqual([]);
  });

  test('repeated cursors fail instead of looping forever', async () => {
    mockFetch(() => json({ models: [geminiEntry('chat')], nextPageToken: 'same' }));
    const result = await listProviderModels({ provider: 'gemini', apiKey: 'key', baseUrl: local });
    expect(result?.error).toContain('pagination');
  });

  test('Ollama discovers native installed tags without a key', async () => {
    mockFetch((url, init) => {
      expect(url).toBe('http://localhost:12345/api/tags');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return json({ models: [{ name: 'qwen3:0.6b' }, { name: 'nomic-embed-text:latest' }] });
    });
    const result = await listProviderModels({ provider: 'ollama', baseUrl: local });
    expect(result?.models.map((m) => m.id)).toEqual(['qwen3:0.6b']);
    expect(result?.filteredOut).toBe(1);
  });

  test('all-model and chat-only cache entries cannot contaminate each other', async () => {
    mockFetch(() => json({ data: [{ id: 'gpt-4o' }, { id: 'whisper-1' }, { id: 'gpt-4o-transcribe' }] }));
    const input = { provider: 'openai', apiKey: 'key', baseUrl: local };
    expect((await listProviderModels({ ...input, includeNonChat: true }))?.models).toHaveLength(3);
    expect((await listProviderModels(input))?.models.map((m) => m.id)).toEqual(['gpt-4o']);
    expect((await listProviderModels(input))?.source).toBe('cache');
  });
});

describe('shared completion compatibility', () => {
  test('reasoning models omit temperature and use completion token budgets', () => {
    for (const id of ['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5.1', 'openai/o3-mini']) {
      expect(chatCompletionParameters(id, 0.4, 1024)).toEqual({ max_completion_tokens: 1024 });
    }
    expect(chatCompletionParameters('gpt-4o', 0.4, 50)).toEqual({ temperature: 0.4, max_tokens: 50 });
    expect(chatCompletionParameters('grok-4', 0.4)).toEqual({ temperature: 0.4 });
  });

  test('connection probes and real streaming both use compatible reasoning payloads', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.temperature).toBeUndefined();
      expect(body.max_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBe(1024);
      return body.stream
        ? new Response('data: {"choices":[{"delta":{"content":"OK"}}]}')
        : json({ choices: [{ message: { content: 'OK' } }] });
    });
    expect((await testProviderConnection({ provider: 'openai', model: 'o3-mini', apiKey: 'key', baseUrl: local })).ok).toBe(true);
    const stream = await buildUpstreamStream([{ role: 'user', content: 'hello' }], {
      provider: 'openai', model: 'o3-mini', apiKey: 'key', baseUrl: local, maxTokens: 1024,
    }, { getProvider });
    expect(await collect(stream)).toBe('OK');
  });

  test('truncated histories keep systems but start the conversation with a user turn', () => {
    const history = capHistoryContext([
      { role: 'user', content: 'old' }, { role: 'assistant', content: 'orphan' },
      { role: 'user', content: 'current' },
    ], { maxMessages: 2 });
    expect(userFirstHistory([{ role: 'system', content: 'system' }, ...history]).map((m) => m.role)).toEqual(['system', 'user']);
  });

  test('orphan assistant history is removed from provider request payloads', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
      return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}');
    });
    expect(await collect(await buildUpstreamStream([
      { role: 'system', content: 'system' }, { role: 'assistant', content: 'orphan' }, { role: 'user', content: 'now' },
    ], { provider: 'openai', model: 'gpt-4o', baseUrl: local }, { getProvider }))).toBe('OK');
  });
});

describe('stream failures never masquerade as empty successes', () => {
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    test(`${provider}: a 200 SSE error event rejects`, async () => {
      mockFetch(() => new Response('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'));
      const stream = await buildUpstreamStream([{ role: 'user', content: 'hello' }], { provider, apiKey: 'key', baseUrl: local }, { getProvider });
      await expect(collect(stream)).rejects.toThrow('Overloaded');
    });
    test(`${provider}: empty streams reject`, async () => {
      mockFetch(() => new Response('data: [DONE]\n'));
      const stream = await buildUpstreamStream([{ role: 'user', content: 'hello' }], { provider, apiKey: 'key', baseUrl: local }, { getProvider });
      await expect(collect(stream)).rejects.toThrow('empty');
    });
  }

  test('a safety block after partial Gemini output is still a failure', async () => {
    mockFetch(() => new Response('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\ndata: {"candidates":[{"finishReason":"SAFETY"}]}\n'));
    const stream = await buildUpstreamStream([{ role: 'user', content: 'hello' }], { provider: 'gemini', apiKey: 'key', baseUrl: local }, { getProvider });
    await expect(collect(stream)).rejects.toThrow('SAFETY');
  });

  test('split UTF-8 and non-newline-terminated final frames survive', async () => {
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"नमस्ते"}}]}');
    mockFetch(() => new Response(new ReadableStream({ start(c) {
      for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
      c.close();
    } })));
    const stream = await buildUpstreamStream([{ role: 'user', content: 'hello' }], { provider: 'openai', baseUrl: local }, { getProvider });
    expect(await collect(stream)).toBe('नमस्ते');
  });
});

describe('voice and browser-secret hygiene', () => {
  test('Hinglish prefers Indian English and never picks a random language', () => {
    expect(pickSpeechVoice([{ lang: 'ja-JP' }, { lang: 'hi-IN' }, { lang: 'en-IN' }])?.lang).toBe('en-IN');
    expect(pickSpeechVoice([{ lang: 'ja-JP' }])).toBeNull();
    expect(pickSpeechVoice([{ lang: 'en-US' }])?.lang).toBe('en-US');
    expect(speechFriendly('Hello. [Stream error: quota exhausted]')).toBe('Hello.');
  });

  test('neither raw keys nor legacy verification signatures are persisted', () => {
    const secret = 'private-api-key';
    const map = { openai: { apiKey: secret, model: 'gpt-4o', baseUrl: local, connected: true, testedSign: `raw:${secret}|gpt-4o|${local}` } };
    const safe = persistableConnections(map);
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(safe.openai?.apiKey).toBe('');
    expect(safe.openai?.connected).toBe(false);
    expect(map.openai.apiKey).toBe(secret); // session still owns the unsaved key
  });

  test('session test identities distinguish keys without embedding the secret', () => {
    const first = connectionSignature({ apiKey: 'secret-one', model: 'gpt-4o' });
    expect(first).not.toContain('secret-one');
    expect(connectionSignature({ apiKey: 'secret-one', model: 'gpt-4o' })).toBe(first);
    expect(connectionSignature({ apiKey: 'secret-two', model: 'gpt-4o' })).not.toBe(first);
  });
});
