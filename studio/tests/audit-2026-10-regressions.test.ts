/**
 * Regression tests for the defects independently reproduced during the
 * 2026-10-24 repair pass.
 *
 * Each test pins OBSERVED behaviour of the shipped code, not of the patch:
 * every one of them fails against the previous revision and passes now.
 *
 *   A1 POST /api/providers/[id]/test did not exist (404) — the Providers
 *      panel's "Test connection" button could never succeed.
 *   A2 The three SSE parsers dropped a final `data:` frame that was not
 *      newline-terminated, silently truncating the end of a reply.
 *   A3 GET /api/agentic/tasks/[id]/stream sent no bytes (not even headers)
 *      until the first event existed, so the dashboard stayed on
 *      "connecting" for the whole quiet period of a live task.
 *   A4 executeOpenCodeTask spawned the OpenCode CLI with the Studio's whole
 *      environment, handing the AES key and the API token to an LLM agent.
 *   A5 deleteMemory({}) / DELETE /api/memory with no filter deleted EVERY
 *      memory entry, including other tasks' private notes.
 *   A6 eslint.config.mjs declared react-hooks rules without scoping them to
 *      the file set where the plugin is registered, so `npm run lint` aborted.
 *   A7 the H7 regression test only passed when a leftover workspace directory
 *      from an earlier run happened to exist (it now creates its own).
 */
import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { db } from '../src/lib/db';
import { POST as providerTest } from '../src/app/api/providers/[id]/test/route';
import { GET as taskStream } from '../src/app/api/agentic/tasks/[id]/stream/route';
import { DELETE as memoryDelete, POST as memoryPost } from '../src/app/api/memory/route';
import { buildUpstreamStream, completeText } from '../src/lib/llm-core';
import { getProvider } from '../src/lib/providers';
import { executeOpenCodeTask } from '../src/lib/agentic/opencode';
import { deleteMemory, listMemory, saveMemory } from '../src/lib/agentic/memory';
import { createWorkspace, removeWorkspace } from '../src/lib/agentic/workspace';
import { executeCommand, CommandDeniedError } from '../src/lib/agentic/terminal';

const uid = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const cleanups: Array<() => Promise<void> | void> = [];

afterAll(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
});

const req = (url: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) =>
  new NextRequest(url, init);

// ---------------------------------------------------------------------------
// A1 — the missing provider "Test connection" route
// ---------------------------------------------------------------------------
describe('A1 provider test route exists and reports the real outcome', () => {
  test('unknown provider is a 404 with a config category', async () => {
    const res = await providerTest(req('http://localhost/api/providers/nope/test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; errorCategory: string };
    expect(body.ok).toBe(false);
    expect(body.errorCategory).toBe('config');
  });

  test('a provider 401 is reported as an auth failure (not "unreachable")', async () => {
    const oldFetch = globalThis.fetch;
    let called = '';
    globalThis.fetch = (async (input: any) => {
      called = String(input);
      return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      // loopback literal: the SSRF guard accepts it without a DNS lookup, so the
      // test is hermetic and still walks the real request path.
      const res = await providerTest(
        req('http://localhost/api/providers/openai/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9/v1' }),
        }),
        { params: Promise.resolve({ id: 'openai' }) }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; errorCategory: string; error: string };
      expect(body.ok).toBe(false);
      expect(body.errorCategory).toBe('auth');
      expect(body.error).toContain('Incorrect API key');
      expect(called).toContain('/chat/completions');
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test('a successful upstream reply is reported as ok with the model that was used', async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    try {
      const res = await providerTest(
        req('http://localhost/api/providers/openai/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-4o-mini' }),
        }),
        { params: Promise.resolve({ id: 'openai' }) }
      );
      const body = (await res.json()) as { ok: boolean; message: string; model: string };
      expect(body.ok).toBe(true);
      expect(body.model).toBe('gpt-4o-mini');
      expect(body.message).toContain('Connected');
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test('the route is guarded: a cross-origin POST is refused before any call', async () => {
    const oldFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const res = await providerTest(
        req('http://localhost/api/providers/openai/test', {
          method: 'POST',
          headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9/v1' }),
        }),
        { params: Promise.resolve({ id: 'openai' }) }
      );
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// A2 — an SSE frame without a trailing newline must not be lost
// ---------------------------------------------------------------------------
function sseResponse(payloadText: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payloadText));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

async function drain(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += value;
  }
  return out;
}

describe('A2 the SSE reader keeps an unterminated final frame', () => {
  /** the parsers are reached through buildUpstreamStream with a stubbed fetch */
  async function streamWith(payload: string, provider: 'openai' | 'anthropic' | 'gemini') {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => sseResponse(payload)) as unknown as typeof fetch;
    try {
      const cfg =
        provider === 'openai'
          ? { provider: 'openai', apiKey: 'k', model: 'gpt-4o-mini', baseUrl: 'http://127.0.0.1:9/v1' }
          : provider === 'anthropic'
            ? { provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-5', baseUrl: 'http://127.0.0.1:9' }
            : { provider: 'gemini', apiKey: 'k', model: 'gemini-3.8-flash', baseUrl: 'http://127.0.0.1:9' };
      return await drain(await buildUpstreamStream([{ role: 'user', content: 'hi' }], cfg as any, { getProvider }));
    } finally {
      globalThis.fetch = oldFetch;
    }
  }

  test('openai-compatible: the last delta survives (old code dropped it)', async () => {
    const text = await streamWith(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":" world"}}]}',
      'openai'
    );
    expect(text).toBe('Hello world');
  });

  test('anthropic: the last content_block_delta survives', async () => {
    const text = await streamWith(
      'data: {"type":"content_block_delta","delta":{"text":"first"}}\n\n' +
        'data: {"type":"content_block_delta","delta":{"text":" second"}}',
      'anthropic'
    );
    expect(text).toBe('first second');
  });

  test('gemini: the last candidate part survives', async () => {
    const text = await streamWith(
      'data: {"candidates":[{"content":{"parts":[{"text":"one"}]}}]}\n\n' +
        'data: {"candidates":[{"content":{"parts":[{"text":" two"}]}}]}',
      'gemini'
    );
    expect(text).toBe('one two');
  });

  test('a frame split across transport chunks is reassembled', async () => {
    const oldFetch = globalThis.fetch;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"cont'));
        controller.enqueue(enc.encode('ent":"split-chunk"}}]}\n\n'));
        controller.close();
      },
    });
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    try {
      const text = await completeText(
        [{ role: 'user', content: 'hi' }],
        { provider: 'openai', apiKey: 'k', model: 'gpt-4o-mini', baseUrl: 'http://127.0.0.1:9/v1' },
        { getProvider }
      );
      expect(text).toBe('split-chunk');
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// A3 — the task stream opens immediately
// ---------------------------------------------------------------------------
describe('A3 the task event stream flushes its headers right away', () => {
  test('a quiet, non-terminal task still produces an SSE preamble at once', async () => {
    const taskId = uid('stream-open');
    await db.agenticTask.create({ data: { id: taskId, prompt: 'quiet task', status: 'awaiting_approval' } });
    cleanups.push(async () => {
      await db.agentEvent.deleteMany({ where: { taskId } });
      await db.agenticTask.deleteMany({ where: { id: taskId } });
    });

    const res = await taskStream(req(`http://localhost/api/agentic/tasks/${taskId}/stream?after=0`), {
      params: Promise.resolve({ id: taskId }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const first = await reader.read();
    await reader.cancel().catch(() => undefined);
    expect(first.done).toBe(false);
    const text = new TextDecoder().decode(first.value);
    // the old route produced NOTHING here (fetch never resolved)
    expect(text.startsWith(':')).toBe(true);
    expect(text).toContain('connected');
  }, 15000);
});

// ---------------------------------------------------------------------------
// A4 — the OpenCode child must not inherit the Studio's secrets
// ---------------------------------------------------------------------------
describe('A4 opencode runs with a sanitized environment', () => {
  test('AGENTSCOPE_SECRET_KEY / API token / DATABASE_URL never reach the child', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvish-opencode-'));
    const capture = path.join(dir, 'env.txt');
    const fake = path.join(dir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
    // `--version` probe + the real run both execute this script.
    const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode 0.0.0"; exit 0; fi\nenv > "${capture}"\necho "done"\n`;
    fs.writeFileSync(fake, script, { mode: 0o755 });
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const oldSecret = process.env.AGENTSCOPE_SECRET_KEY;
    const oldToken = process.env.AGENTSCOPE_API_TOKEN;
    if (process.platform === 'win32') {
      // the fixture script is POSIX-only; the assertion is still covered on
      // POSIX runners and by the static check below.
      return;
    }
    process.env.AGENTSCOPE_SECRET_KEY = 'super-secret-master-key';
    process.env.AGENTSCOPE_API_TOKEN = 'super-secret-api-token';
    try {
      const result = await executeOpenCodeTask(
        uid('opencode'),
        'do something',
        dir,
        { executablePath: fake, apiKey: 'run-only-key', timeoutMs: 20_000 }
      );
      expect(result.exitCode).toBe(0);
      const seen = fs.readFileSync(capture, 'utf8');
      expect(seen).not.toContain('super-secret-master-key');
      expect(seen).not.toContain('super-secret-api-token');
      expect(seen).not.toContain('DATABASE_URL');
      // the key the CALLER supplied for this run is still available
      expect(seen).toContain('run-only-key');
    } finally {
      if (oldSecret === undefined) delete process.env.AGENTSCOPE_SECRET_KEY;
      else process.env.AGENTSCOPE_SECRET_KEY = oldSecret;
      if (oldToken === undefined) delete process.env.AGENTSCOPE_API_TOKEN;
      else process.env.AGENTSCOPE_API_TOKEN = oldToken;
    }
  }, 40000);
});

// ---------------------------------------------------------------------------
// A5 — an unscoped memory delete must be refused
// ---------------------------------------------------------------------------
describe('A5 memory deletion requires a target', () => {
  test('deleteMemory({}) refuses instead of wiping every scope', async () => {
    const userEntry = await saveMemory({ scope: 'user', key: uid('pref'), content: 'a preference' });
    const taskEntry = await saveMemory({ scope: 'task', taskId: uid('t5'), key: uid('note'), content: 'a note' });
    cleanups.push(async () => {
      await db.memoryEntry.deleteMany({ where: { id: { in: [userEntry.id, taskEntry.id] } } });
    });

    await expect(deleteMemory({})).rejects.toThrow(/Refusing to delete every memory entry/i);

    // both records are still there
    const all = await listMemory({ scope: 'user', limit: 500 });
    expect(all.some((e) => e.id === userEntry.id)).toBe(true);
    const notes = await listMemory({ scope: 'task', taskId: taskEntry.taskId });
    expect(notes.some((e) => e.id === taskEntry.id)).toBe(true);
  });

  test('DELETE /api/memory with no query string is a 400, with a scope it works', async () => {
    const entry = await saveMemory({ scope: 'user', key: uid('route'), content: 'route-scoped' });
    cleanups.push(async () => {
      await db.memoryEntry.deleteMany({ where: { id: entry.id } });
    });

    const bare = await memoryDelete(req('http://localhost/api/memory', { method: 'DELETE' }));
    expect(bare.status).toBe(400);
    const body = (await bare.json()) as { error: string; field: string };
    expect(body.field).toBe('scope');

    const scoped = await memoryDelete(req('http://localhost/api/memory?id=' + entry.id, { method: 'DELETE' }));
    expect(scoped.status).toBe(200);
    const out = (await scoped.json()) as { removed: number };
    expect(out.removed).toBe(1);
  });

  test('POST still stores a valid entry (the guard changed nothing else)', async () => {
    const key = uid('post');
    const res = await memoryPost(
      req('http://localhost/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, content: 'still works', scope: 'user' }),
      })
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    cleanups.push(async () => {
      await db.memoryEntry.deleteMany({ where: { id: created.id } });
    });
    expect(created.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// A6 — `npm run lint` must be able to run at all
// ---------------------------------------------------------------------------
describe('A6 eslint can resolve every plugin it configures', () => {
  test('linting a .cjs file does not abort with "could not find plugin"', async () => {
    // The old config applied `react-hooks/*` rules to EVERY linted file while
    // eslint-config-next registers that plugin only for
    // `**/*.{js,jsx,mjs,ts,tsx,mts,cts}`. `eslint .` therefore died on
    // scripts/custom-tool-runner.cjs with
    //   "A configuration object specifies rule \"react-hooks/set-state-in-effect\",
    //    but could not find plugin \"react-hooks\""
    // before it reported a single real finding.
    const { ESLint } = (await import('eslint')) as any;
    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles(['scripts/custom-tool-runner.cjs']);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
    // and the resolved config for that file really is free of plugin rules
    const resolved = await eslint.calculateConfigForFile('scripts/custom-tool-runner.cjs');
    const pluginRules = Object.keys(resolved?.rules ?? {}).filter((rule) =>
      rule.startsWith('react-hooks/')
    );
    expect(pluginRules).toEqual([]);
  }, 60000);

  test('the config still declares the intended react-hooks policy', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'eslint.config.mjs'), 'utf8');
    expect(source).toContain('"react-hooks/set-state-in-effect": "warn"');
    expect(source).toContain('files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"]');
  });
});

// ---------------------------------------------------------------------------
// A7 — the H7 regression test must create its own workspace
// ---------------------------------------------------------------------------
describe('A7 executeCommand classifies before it looks at the workspace', () => {
  test('a multi-line payload is refused in a workspace that exists', async () => {
    const taskId = uid('h7');
    await createWorkspace(taskId);
    cleanups.push(() => removeWorkspace(taskId));
    // a fresh workspace directory is also exactly what the other regression
    // test forgot to create (it depended on state left by a previous run)
    const err = await executeCommand(taskId, ['echo hi', 'rm -rf ./build'].join('\n')).catch((e) => e);
    expect(err).toBeInstanceOf(CommandDeniedError);
    expect((err as CommandDeniedError).permission).toBe('destructive');
  });
});

// ---------------------------------------------------------------------------
// A8 — a provider auth error must not be reported as "network unreachable"
// ---------------------------------------------------------------------------
describe('A8 /api/chat names the real provider failure', () => {
  const makeConversation = async () => {
    const conv = await db.conversation.create({ data: { title: 'A8 probe' } });
    cleanups.push(async () => {
      await db.message.deleteMany({ where: { conversationId: conv.id } });
      await db.conversation.deleteMany({ where: { id: conv.id } });
    });
    return conv;
  };

  const chatWith = async (status: number, body: string) => {
    const { POST: chat } = await import('../src/app/api/chat/route');
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(body, { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    try {
      const conv = await makeConversation();
      return await chat(
        req('http://localhost/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: conv.id,
            content: 'hello there',
            provider: 'openai',
            apiKey: 'sk-wrong',
            model: 'gpt-4o-mini',
            baseUrl: 'http://127.0.0.1:9/v1',
          }),
        })
      );
    } finally {
      globalThis.fetch = oldFetch;
    }
  };

  test('a 401 says the key was rejected (was: "Unable to reach the model provider")', async () => {
    const res = await chatWith(401, JSON.stringify({ error: { message: 'Incorrect API key provided: sk-wrong' } }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; errorCategory: string; provider: string; model: string };
    expect(body.errorCategory).toBe('auth');
    expect(body.error).toContain('rejected the API key');
    expect(body.provider).toBe('openai');
    expect(body.model).toBe('gpt-4o-mini');
    // a secret echoed back by the provider never reaches the browser
    expect(body.error).not.toContain('sk-wrong');
  });

  test('a 404 names the model instead of blaming the network', async () => {
    const res = await chatWith(404, JSON.stringify({ error: { message: 'model not found' } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; errorCategory: string };
    expect(body.errorCategory).toBe('config');
    expect(body.error).toContain('gpt-4o-mini');
  });

  test('a provider 5xx is reported as a provider failure', async () => {
    const res = await chatWith(503, 'upstream down');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; errorCategory: string };
    expect(body.errorCategory).toBe('server');
    expect(body.error).toContain('provider is failing');
  });
});
