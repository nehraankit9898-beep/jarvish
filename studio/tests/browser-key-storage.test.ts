import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadConnections, saveConnections } from '../src/lib/api-keys-store';

const key = 'agentscope-studio-connections';
const storage = new Map<string, string>();
let originalWindow: PropertyDescriptor | undefined;
let originalStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => storage.set(name, value),
  } });
  storage.clear();
  saveConnections({ openai: { apiKey: '', model: 'gpt-4o', baseUrl: '', connected: false } });
});
afterEach(() => {
  saveConnections({ openai: { apiKey: '', model: '', baseUrl: '', connected: false } });
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('browser credential migration', () => {
  test('loading a legacy key scrubs disk but retains the key for migration in this tab', () => {
    storage.set(key, JSON.stringify({ openai: {
      apiKey: 'legacy-secret', model: 'gpt-4o', baseUrl: '', connected: true,
      testedSign: 'raw:legacy-secret|gpt-4o|', serverStored: true,
    } }));
    expect(loadConnections().openai?.apiKey).toBe('legacy-secret');
    expect(storage.get(key)).not.toContain('legacy-secret');
    expect(loadConnections().openai?.apiKey).toBe('legacy-secret');
    expect(loadConnections().openai?.connected).toBe(false);
  });

  test('saving a session key never persists it or its raw test signature', () => {
    saveConnections({ openai: { apiKey: 'new-secret', model: 'gpt-4o', baseUrl: '', connected: true, testedSign: 'raw:new-secret|gpt-4o|' } });
    expect(storage.get(key)).not.toContain('new-secret');
    expect(loadConnections().openai?.apiKey).toBe('new-secret');
  });

  test('a confirmed server save clears the session-only key', () => {
    saveConnections({ openai: { apiKey: 'session-secret', model: 'gpt-4o', baseUrl: '', connected: false } });
    saveConnections({ openai: { apiKey: '', model: 'gpt-4o', baseUrl: '', connected: false, serverStored: true, keyHint: 'cret' } });
    expect(loadConnections().openai?.apiKey).toBe('');
    expect(loadConnections().openai?.keyHint).toBe('cret');
    expect(storage.get(key)).not.toContain('session-secret');
  });
});
