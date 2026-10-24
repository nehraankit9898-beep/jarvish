// Server-side provider configuration, secret storage and routing policy.
// Run: bun test tests/provider-config.test.ts
import { describe, expect, test, afterAll } from 'bun:test';
import { db } from '../src/lib/db';
import {
  saveProvider,
  setProviderEnabled,
  removeProvider,
  listProviderConfigs,
  readProviderSecret,
  recordConnectionResult,
  inferCostClass,
  isFreeTarget,
  providerRoutingOrder,
  loadRouterPolicy,
  loadStoredCredentials,
  readStudioSettings,
  writeStudioSettings,
  saveModelPreference,
  listModelPreferences,
  removeModelPreference,
  effectiveCredential,
  ProviderValidationError,
} from '../src/lib/agentic/provider-store';
import {
  encryptSecret,
  decryptSecret,
  packSecret,
  unpackSecret,
  keyHint,
  resetMasterKeyCache,
} from '../src/lib/agentic/crypto';

const TEST_PROVIDER = 'test-provider';

afterAll(async () => {
  await db.providerConfig.deleteMany({ where: { provider: TEST_PROVIDER } });
  await db.modelPreference.deleteMany({ where: { role: 'test-role' } });
});

describe('secret storage', () => {
  test('a secret round-trips through encryption', () => {
    const plain = 'sk-test-1234567890';
    const packed = packSecret(encryptSecret(plain));
    expect(packed).not.toContain(plain);
    expect(packed.startsWith('v1.')).toBe(true);
    expect(decryptSecret(unpackSecret(packed))).toBe(plain);
  });

  test('every encryption uses a fresh IV', () => {
    const a = packSecret(encryptSecret('same-plaintext'));
    const b = packSecret(encryptSecret('same-plaintext'));
    expect(a).not.toBe(b);
  });

  test('a tampered payload is rejected', () => {
    const packed = packSecret(encryptSecret('secret-value'));
    const parts = packed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(unpackSecret(parts.join('.')))).toThrow();
  });

  test('a malformed payload is rejected', () => {
    expect(() => unpackSecret('not-a-payload')).toThrow();
  });

  test('the key hint hides the secret', () => {
    const hint = keyHint('sk-live-ABCDEFGH1234');
    expect(hint).toBe('••••1234');
    expect(hint).not.toContain('sk-live');
  });
});

describe('provider configuration', () => {
  test('editing connection settings clears a previously successful test', async () => {
    await saveProvider({ provider: TEST_PROVIDER, model: 'old-model', baseUrl: 'https://api.example.com/v1' });
    await recordConnectionResult(TEST_PROVIDER, true);
    const unchanged = await saveProvider({ provider: TEST_PROVIDER, label: 'Renamed' });
    expect(unchanged.lastTestOk).toBe(true);
    const changed = await saveProvider({ provider: TEST_PROVIDER, model: 'new-model' });
    expect(changed.lastTestOk).toBeNull();
    expect(changed.lastTestedAt).toBeNull();
    expect(changed.lastError).toBe('');
  });

  test('stores a provider with an encrypted key and never returns it', async () => {
    const dto = await saveProvider({
      provider: TEST_PROVIDER,
      label: 'Test Provider',
      apiKey: 'sk-test-abcdefgh1234',
      model: 'test-model',
      baseUrl: 'https://api.example.com/v1',
      priority: 5,
    });

    expect(dto.hasKey).toBe(true);
    expect(dto.keyHint).toBe('••••1234');
    expect(JSON.stringify(dto)).not.toContain('sk-test-abcdefgh1234');

    // the raw row holds ciphertext, not the key
    const row = await db.providerConfig.findUnique({ where: { provider: TEST_PROVIDER } });
    expect(row?.apiKeyEnc).toBeTruthy();
    expect(row?.apiKeyEnc).not.toContain('sk-test-abcdefgh1234');

    // …and the server can read it back
    expect(await readProviderSecret(TEST_PROVIDER)).toBe('sk-test-abcdefgh1234');
  });

  test('the key can be cleared', async () => {
    const dto = await saveProvider({ provider: TEST_PROVIDER, clearKey: true });
    expect(dto.hasKey).toBe(false);
    expect(dto.keyHint).toBe('');
    expect(await readProviderSecret(TEST_PROVIDER)).toBe('');
  });

  test('rejects an invalid provider id and a bad base url', async () => {
    await expect(saveProvider({ provider: 'bad id!' })).rejects.toBeInstanceOf(
      ProviderValidationError
    );
    await expect(
      saveProvider({ provider: 'x-provider', baseUrl: 'ftp://example.com' })
    ).rejects.toBeInstanceOf(ProviderValidationError);
  });

  test('a provider can be disabled and enabled again', async () => {
    const disabled = await setProviderEnabled(TEST_PROVIDER, false);
    expect(disabled.enabled).toBe(false);
    const enabled = await setProviderEnabled(TEST_PROVIDER, true);
    expect(enabled.enabled).toBe(true);
  });

  test('the last connection result is persisted', async () => {
    await recordConnectionResult(TEST_PROVIDER, false, '401 unauthorized');
    const list = await listProviderConfigs();
    const row = list.find((p) => p.provider === TEST_PROVIDER);
    expect(row?.lastTestOk).toBe(false);
    expect(row?.lastError).toContain('401');
    expect(row?.lastTestedAt).not.toBeNull();
  });

  test('a removed provider loses its credential', async () => {
    await saveProvider({ provider: TEST_PROVIDER, apiKey: 'sk-temp-9999' });
    expect(await removeProvider(TEST_PROVIDER)).toBe(true);
    expect(await readProviderSecret(TEST_PROVIDER)).toBe('');
  });
});

describe('cost class', () => {
  test('an explicit cost class wins', () => {
    expect(inferCostClass('openai', 'gpt-4', 'free')).toBe('free');
    expect(inferCostClass('zai', 'glm-4', 'paid')).toBe('paid');
  });

  test('the catalog flag is used when nothing is configured', () => {
    expect(inferCostClass('zai', 'glm-4')).toBe('free');
  });

  test('a :free model suffix marks a provider as free', () => {
    expect(inferCostClass('openrouter', 'meta-llama/llama-3:free')).toBe('free');
    expect(isFreeTarget('openrouter', 'meta-llama/llama-3:free')).toBe(true);
  });

  test('an unknown provider is "unknown" — never assumed to be free', () => {
    expect(inferCostClass('mystery-provider', 'whatever')).toBe('unknown');
    expect(isFreeTarget('mystery-provider', 'whatever')).toBe(false);
  });

  test('a known paid provider is paid', () => {
    expect(inferCostClass('openai', 'gpt-4o')).toBe('paid');
  });
});

describe('routing policy', () => {
  test('the provider order is sorted by priority', async () => {
    await saveProvider({ provider: 'aaa-priority', priority: 1 });
    await saveProvider({ provider: 'zzz-priority', priority: 900 });
    const order = await providerRoutingOrder();
    const aaa = order.findIndex((o) => o.provider === 'aaa-priority');
    const zzz = order.findIndex((o) => o.provider === 'zzz-priority');
    expect(aaa).toBeGreaterThanOrEqual(0);
    expect(zzz).toBeGreaterThan(aaa);
    await db.providerConfig.deleteMany({ where: { provider: { in: ['aaa-priority', 'zzz-priority'] } } });
  });

  test('a disabled provider is excluded from the order and reported as disabled', async () => {
    await saveProvider({ provider: 'disabled-one', enabled: false, priority: 1 });
    const policy = await loadRouterPolicy();
    expect(policy.disabledProviders).toContain('disabled-one');
    expect(policy.providerOrder).not.toContain('disabled-one');
    await db.providerConfig.deleteMany({ where: { provider: 'disabled-one' } });
  });

  test('free-only mode is read from the studio settings', async () => {
    const before = await readStudioSettings();
    const after = await writeStudioSettings({ freeOnly: true });
    expect(after.freeOnly).toBe(true);
    const policy = await loadRouterPolicy();
    expect(policy.freeOnly).toBe(true);
    await writeStudioSettings({ freeOnly: before.freeOnly });
  });

  test('the cost class of a provider is exposed to the router', async () => {
    const policy = await loadRouterPolicy();
    expect(policy.costClassOf?.('zai', 'glm-4')).toBe('free');
    expect(policy.costClassOf?.('openai', 'gpt-4o')).toBe('paid');
  });

  test('only ENABLED providers contribute stored credentials', async () => {
    await saveProvider({ provider: 'cred-provider', apiKey: 'sk-cred-1111', enabled: true });
    await saveProvider({ provider: 'cred-off', apiKey: 'sk-cred-2222', enabled: false });
    const creds = await loadStoredCredentials();
    expect(creds['cred-provider']?.apiKey).toBe('sk-cred-1111');
    expect(creds['cred-off']).toBeUndefined();
    await db.providerConfig.deleteMany({ where: { provider: { in: ['cred-provider', 'cred-off'] } } });
  });
});

describe('model preferences and settings', () => {
  test('a per-agent model preference can be saved and removed', async () => {
    const pref = await saveModelPreference({
      role: 'test-role',
      provider: 'zai',
      model: 'glm-4',
      enabled: true,
    });
    expect(pref.role).toBe('test-role');
    expect(pref.provider).toBe('zai');

    const list = await listModelPreferences();
    expect(list.some((p) => p.role === 'test-role')).toBe(true);

    expect(await removeModelPreference('test-role')).toBe(true);
    expect((await listModelPreferences()).some((p) => p.role === 'test-role')).toBe(false);
  });

  test('an unknown provider is rejected for a preference', async () => {
    await expect(
      saveModelPreference({ role: 'test-role', provider: 'not-a-provider' })
    ).rejects.toBeInstanceOf(ProviderValidationError);
  });

  test('the studio settings keep their defaults', async () => {
    const settings = await readStudioSettings();
    expect(typeof settings.freeOnly).toBe('boolean');
    expect(typeof settings.autoFallback).toBe('boolean');
    expect(settings.defaultProvider).toBeTruthy();
  });

  test('a request-supplied credential wins over the stored one', async () => {
    await saveProvider({ provider: 'cred-provider', apiKey: 'sk-stored-9999' });
    const cred = await effectiveCredential('cred-provider', { apiKey: 'sk-request-1111' });
    expect(cred.apiKey).toBe('sk-request-1111');
    await db.providerConfig.deleteMany({ where: { provider: 'cred-provider' } });
  });
});

describe('master key cache', () => {
  test('the key can be reloaded after a cache reset', () => {
    resetMasterKeyCache();
    const packed = packSecret(encryptSecret('after-reset'));
    expect(decryptSecret(unpackSecret(packed))).toBe('after-reset');
  });
});
