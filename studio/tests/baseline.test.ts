// Baseline tests — existing core features (recorded BEFORE agentic engine integration)
// Run: bun test tests/baseline.test.ts
import { describe, expect, test } from 'bun:test';
import { PROVIDERS, getProvider } from '../src/lib/providers';

describe('providers catalog (existing feature)', () => {
  test('13 providers defined', () => {
    expect(PROVIDERS.length).toBe(13);
  });

  test('zai is built-in and needs no signup, but does need a way to authenticate', () => {
    const zai = getProvider('zai');
    expect(zai).toBeDefined();
    expect(zai!.kind).toBe('zai');
    // the z-ai-web-dev-sdk needs a `.z-ai-config` file; the Studio falls back
    // to the OpenAI-compatible Z.ai API when a key is configured instead
    expect(zai!.baseUrl).toContain('z.ai');
    expect(zai!.keyLabel).toBe('API key or .z-ai-config file');
  });

  test('all provider kinds are valid', () => {
    const valid = ['zai', 'openai-compatible', 'anthropic', 'gemini'];
    for (const p of PROVIDERS) {
      expect(valid).toContain(p.kind);
    }
  });

  test('getProvider returns undefined for unknown id', () => {
    expect(getProvider('does-not-exist')).toBeUndefined();
  });

  test('gemini + anthropic have baseUrls and default models', () => {
    expect(getProvider('gemini')!.baseUrl).toContain('generativelanguage');
    expect(getProvider('anthropic')!.baseUrl).toContain('anthropic');
    expect(getProvider('gemini')!.defaultModel.length).toBeGreaterThan(0);
    expect(getProvider('anthropic')!.defaultModel.length).toBeGreaterThan(0);
  });
});

describe('database connectivity (existing schema)', () => {
  test('agents + conversations tables reachable via prisma', async () => {
    const { db } = await import('../src/lib/db');
    const agents = await db.agent.findMany({ take: 1 });
    const convs = await db.conversation.findMany({ take: 1 });
    expect(Array.isArray(agents)).toBe(true);
    expect(Array.isArray(convs)).toBe(true);
  });

  test('agentic tables exist after schema upgrade', async () => {
    const { db } = await import('../src/lib/db');
    const tasks = await db.agenticTask.findMany({ take: 1 });
    expect(Array.isArray(tasks)).toBe(true);
  });
});
