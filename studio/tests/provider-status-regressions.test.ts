import { describe, expect, test } from 'bun:test';
import { connectionSettingsChanged } from '../src/lib/agentic/provider-test-state';

const previous = {
  model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKeyEnc: 'encrypted-old-key',
  timeoutMs: 120000, maxRetries: 2, label: 'Work', enabled: true, priority: 1,
};

describe('saved connection result invalidation', () => {
  for (const change of [
    { model: 'new-model' }, { baseUrl: 'https://example.com/v1' },
    { apiKeyEnc: '' }, { apiKeyEnc: 'encrypted-new-key' },
    { timeoutMs: 5000 }, { maxRetries: 0 },
  ]) {
    test(`changing ${JSON.stringify(change)} invalidates the old test`, () => {
      expect(connectionSettingsChanged(previous, { ...previous, ...change })).toBe(true);
    });
  }
  test('unchanged connection settings preserve the test', () => {
    expect(connectionSettingsChanged(previous, { ...previous })).toBe(false);
  });
  test('label, priority and enabled edits preserve the test', () => {
    const next = { ...previous, label: 'Personal', priority: 20, enabled: false };
    expect(connectionSettingsChanged(previous, next)).toBe(false);
  });
});
