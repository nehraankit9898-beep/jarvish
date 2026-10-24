/**
 * A retired model id stored in the browser is migrated, but the substitution
 * is ANNOUNCED — never silent (spec §5). `loadConnections()` queues a notice
 * that the app shell drains once and speaks.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { consumeModelNotices, loadConnections } from '@/lib/api-keys-store';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  consumeModelNotices(); // drop anything left by another file
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
});

describe('retired model migration in the browser store', () => {
  test('gemini 2.0 (shut down by Google) is replaced with the current default', () => {
    store.set(
      'agentscope-studio-connections',
      JSON.stringify({ gemini: { apiKey: '', model: 'gemini-2.0-flash', baseUrl: '', connected: false } })
    );
    const map = loadConnections();
    expect(map.gemini?.model).toBe('gemini-3.8-flash');

    const notices = consumeModelNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual({
      provider: 'gemini',
      from: 'gemini-2.0-flash',
      to: 'gemini-3.8-flash',
    });
    // drained once — the toast/speech is not repeated on every read
    expect(consumeModelNotices()).toHaveLength(0);
  });

  test('a valid model is left exactly as stored, with no notice', () => {
    store.set(
      'agentscope-studio-connections',
      JSON.stringify({ openrouter: { apiKey: '', model: 'openrouter/free', baseUrl: '', connected: true } })
    );
    const map = loadConnections();
    expect(map.openrouter?.model).toBe('openrouter/free');
    expect(consumeModelNotices()).toHaveLength(0);
  });

  test('a non-Gemini id that merely looks retired is untouched', () => {
    store.set(
      'agentscope-studio-connections',
      JSON.stringify({ openai: { apiKey: '', model: 'gemini-2.0-flash', baseUrl: '', connected: false } })
    );
    expect(loadConnections().openai?.model).toBe('gemini-2.0-flash');
    expect(consumeModelNotices()).toHaveLength(0);
  });
});
