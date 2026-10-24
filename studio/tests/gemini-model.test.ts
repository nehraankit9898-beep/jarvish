// Gemini model migration tests — gemini-2.0-flash retired by Google (404)
// Run: bun test tests/gemini-model.test.ts
import { describe, expect, test } from 'bun:test';
import { PROVIDERS, getProvider, resolveModel } from '../src/lib/providers';

describe('gemini model catalog (retired gemini-2.0-flash fix)', () => {
  const gemini = getProvider('gemini')!;

  test('gemini default model is current, not retired', () => {
    expect(gemini.defaultModel).toBe('gemini-3.8-flash');
    expect(gemini.defaultModel).not.toBe('gemini-2.0-flash');
  });

  test('gemini models list does NOT include retired models', () => {
    expect(gemini.models).not.toContain('gemini-2.0-flash');
    expect(gemini.models).not.toContain('gemini-1.5-flash');
    expect(gemini.models).not.toContain('gemini-1.5-pro');
  });

  test('gemini models list includes the default model', () => {
    expect(gemini.models).toContain(gemini.defaultModel);
  });
});

describe('resolveModel() — retired model auto-migration', () => {
  const gemini = getProvider('gemini')!;

  test('retired gemini-2.0-flash maps to current default', () => {
    expect(resolveModel(gemini, 'gemini-2.0-flash')).toBe('gemini-3.8-flash');
  });

  test('other retired gemini models map to current default', () => {
    expect(resolveModel(gemini, 'gemini-2.0-flash-lite')).toBe('gemini-3.8-flash');
    expect(resolveModel(gemini, 'gemini-1.5-pro')).toBe('gemini-3.8-flash');
    expect(resolveModel(gemini, 'gemini-1.5-flash')).toBe('gemini-3.8-flash');
    expect(resolveModel(gemini, 'gemini-1.5-flash-latest')).toBe('gemini-3.8-flash');
    expect(resolveModel(gemini, 'gemini-1.5-pro-latest')).toBe('gemini-3.8-flash');
  });

  test('empty/missing model falls back to provider default', () => {
    expect(resolveModel(gemini, '')).toBe('gemini-3.8-flash');
    expect(resolveModel(gemini, undefined)).toBe('gemini-3.8-flash');
    expect(resolveModel(gemini, '   ')).toBe('gemini-3.8-flash');
  });

  test('current and custom models pass through unchanged', () => {
    expect(resolveModel(gemini, 'gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(resolveModel(gemini, 'gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(resolveModel(gemini, 'my-preview-model')).toBe('my-preview-model');
  });

  test('whitespace around model is trimmed', () => {
    expect(resolveModel(gemini, '  gemini-3.8-flash ')).toBe('gemini-3.8-flash');
  });

  test('undefined provider returns model as-is (or empty)', () => {
    expect(resolveModel(undefined, 'some-model')).toBe('some-model');
    expect(resolveModel(undefined, '')).toBe('');
    expect(resolveModel(undefined, undefined)).toBe('');
  });

  test('non-gemini providers keep retired-looking names untouched', () => {
    const openai = getProvider('openai')!;
    expect(resolveModel(openai, 'gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(resolveModel(openai, '')).toBe('gpt-4o-mini');
    // Alias map sirf provider.kind === 'gemini' par apply hota hai —
    // custom endpoints par model name nahi badalna chahiye
    const custom = getProvider('custom')!;
    expect(resolveModel(custom, 'gemini-2.0-flash')).toBe('gemini-2.0-flash');
    const ollama = getProvider('ollama')!;
    expect(resolveModel(ollama, 'gemini-2.0-flash')).toBe('gemini-2.0-flash');
  });
});
