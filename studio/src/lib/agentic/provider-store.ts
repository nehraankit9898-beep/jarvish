import { connectionSettingsChanged } from './provider-test-state';
// provider-store.ts — SERVER-SIDE provider & model configuration.
//
// Until now the provider configuration lived only in the browser
// (`localStorage`). That had three consequences:
//   * no enable/disable — a broken provider could not be taken out of the
//     rotation without deleting the key,
//   * no priority — the router had no deterministic order to try targets in,
//   * no free-only policy — the "free" flag in the catalog was decorative.
//
// This module is the single source of truth for the server:
//
//   * credentials are stored ENCRYPTED (crypto.ts) and are never returned to
//     the browser — only a `keyHint` (last 4 characters),
//   * every provider can be enabled/disabled, given a priority, a timeout and
//     a retry budget,
//   * the cost class (free / paid / unknown) drives the free-only policy,
//   * the last connection result is persisted and shown in the UI.
//
// The browser-local settings keep working: a request-supplied credential
// always wins over the stored one, so nothing that exists today breaks.

import { db } from '@/lib/db';
import { getProvider, resolveModel, PROVIDERS, type ProviderInfo } from '@/lib/providers';
import type { CredentialMap } from './agent-config';
import type { RouterPolicy } from './model-router';
import {
  decryptSecret,
  encryptSecret,
  keyHint,
  packSecret,
  unpackSecret,
  SecretKeyUnavailableError,
} from './crypto';

export type CostClass = 'free' | 'paid' | 'unknown';

/** The provider configuration as the BROWSER is allowed to see it. */
export interface ProviderDto {
  provider: string;
  name: string;
  emoji: string;
  label: string;
  enabled: boolean;
  priority: number;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  costClass: CostClass;
  /** true when a key is stored on the server (the key itself is never sent) */
  hasKey: boolean;
  keyHint: string;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastError: string;
  inCatalog: boolean;
  catalogFree: boolean;
  /**
   * true when the provider has a stored server-side configuration. A catalog
   * provider that was never configured is still listed (so the user can
   * configure it) but is NOT usable yet.
   */
  configured: boolean;
}

export interface SaveProviderInput {
  provider: string;
  label?: string;
  enabled?: boolean;
  priority?: number;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  costClass?: CostClass;
  /** when set, replaces the stored credential; '' clears it */
  apiKey?: string;
  /** when false the stored credential is kept even if apiKey is empty */
  clearKey?: boolean;
}

export class ProviderValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'ProviderValidationError';
    this.field = field;
  }
}

const MAX_TIMEOUT_MS = 600_000;
const MAX_RETRIES = 5;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Infer the cost class of a provider.
 *
 * Precedence: explicit configuration → the catalog's `free` flag → a `:free`
 * model suffix (OpenRouter style) → 'unknown'.
 *
 * 'unknown' is treated as PAID by the free-only policy: the safe default is
 * never to spend money the user did not authorise.
 */
export function inferCostClass(
  providerId: string,
  model: string | undefined,
  explicit?: CostClass
): CostClass {
  if (explicit === 'free' || explicit === 'paid' || explicit === 'unknown') {
    return explicit;
  }
  const info = getProvider(providerId);
  if (info?.free) return 'free';
  if (model && /:free$/i.test(model.trim())) return 'free';
  if (info) return 'paid';
  return 'unknown';
}

/** Is this provider/model a free option? */
export function isFreeTarget(providerId: string, model: string | undefined): boolean {
  return inferCostClass(providerId, model) === 'free';
}

function toDto(row: {
  provider: string;
  label: string;
  enabled: boolean;
  priority: number;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  costClass: string;
  apiKeyEnc: string;
  keyHint: string;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  lastError: string;
}, configured = true): ProviderDto {
  const info = getProvider(row.provider);
  return {
    provider: row.provider,
    name: info?.name ?? row.provider,
    emoji: info?.emoji ?? '🔌',
    label: row.label || info?.name || row.provider,
    enabled: row.enabled,
    priority: row.priority,
    baseUrl: row.baseUrl || info?.baseUrl || '',
    model: row.model,
    timeoutMs: row.timeoutMs,
    maxRetries: row.maxRetries,
    costClass: (row.costClass as CostClass) || 'unknown',
    hasKey: Boolean(row.apiKeyEnc),
    keyHint: row.keyHint,
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    lastTestOk: row.lastTestOk ?? null,
    lastError: row.lastError,
    inCatalog: Boolean(info),
    catalogFree: Boolean(info?.free),
    configured,
  };
}

/** The shape a catalog provider gets when it has NO stored configuration. */
function defaultRowFor(info: ProviderInfo) {
  return {
    provider: info.id,
    label: '',
    enabled: true,
    priority: 100,
    baseUrl: info.baseUrl,
    model: info.defaultModel,
    timeoutMs: 120_000,
    maxRetries: 2,
    costClass: inferCostClass(info.id, info.defaultModel) as CostClass,
    apiKeyEnc: '',
    keyHint: '',
    lastTestedAt: null as Date | null,
    lastTestOk: null as boolean | null,
    lastError: '',
  };
}

/**
 * All provider configurations (server view, secrets removed).
 *
 * EVERY catalog provider is listed — even one that was never configured —
 * so the Providers panel can show the real catalog instead of an empty list.
 * `configured` tells the UI which ones are actually set up.
 */
export async function listProviderConfigs(): Promise<ProviderDto[]> {
  const rows = await db.providerConfig.findMany({
    orderBy: [{ priority: 'asc' }, { provider: 'asc' }],
  });
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const out: ProviderDto[] = [];

  for (const info of PROVIDERS) {
    const row = byProvider.get(info.id);
    if (row) {
      out.push(toDto(row, true));
    } else {
      out.push(toDto(defaultRowFor(info), false));
    }
    byProvider.delete(info.id);
  }
  // providers that only exist in the database (custom endpoints)
  for (const row of byProvider.values()) {
    out.push(toDto(row, true));
  }
  return out;
}

/**
 * The effective routing order: every catalog provider plus every configured
 * one, sorted by priority, with disabled providers removed.
 */
export async function providerRoutingOrder(): Promise<
  { provider: string; priority: number; enabled: boolean; costClass: CostClass; timeoutMs: number; maxRetries: number; baseUrl: string; model: string }[]
> {
  const rows = await db.providerConfig.findMany();
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const out: {
    provider: string;
    priority: number;
    enabled: boolean;
    costClass: CostClass;
    timeoutMs: number;
    maxRetries: number;
    baseUrl: string;
    model: string;
  }[] = [];

  for (const info of PROVIDERS) {
    const row = byProvider.get(info.id);
    if (row) {
      out.push({
        provider: info.id,
        priority: row.priority,
        enabled: row.enabled,
        costClass: inferCostClass(info.id, row.model, row.costClass as CostClass),
        timeoutMs: row.timeoutMs,
        maxRetries: row.maxRetries,
        baseUrl: row.baseUrl || info.baseUrl,
        model: row.model,
      });
    } else {
      out.push({
        provider: info.id,
        priority: 100,
        enabled: true,
        costClass: inferCostClass(info.id, undefined),
        timeoutMs: 120_000,
        maxRetries: 2,
        baseUrl: info.baseUrl,
        model: info.defaultModel,
      });
    }
    byProvider.delete(info.id);
  }
  // providers that only exist in the database (custom endpoints)
  for (const row of byProvider.values()) {
    out.push({
      provider: row.provider,
      priority: row.priority,
      enabled: row.enabled,
      costClass: inferCostClass(row.provider, row.model, row.costClass as CostClass),
      timeoutMs: row.timeoutMs,
      maxRetries: row.maxRetries,
      baseUrl: row.baseUrl,
      model: row.model,
    });
  }
  return out.sort((a, b) => a.priority - b.priority || a.provider.localeCompare(b.provider));
}

/** Create or update a provider configuration. */
export async function saveProvider(input: SaveProviderInput): Promise<ProviderDto> {
  const provider = String(input.provider ?? '').trim();
  if (!provider || !/^[a-z0-9_-]{1,40}$/i.test(provider)) {
    throw new ProviderValidationError('provider', 'Invalid provider id');
  }
  const info = getProvider(provider);
  // M2: an absent baseUrl must KEEP the stored one — the old code coerced a
  // missing field to '' and wiped a custom endpoint on every unrelated save
  // (e.g. a priority/enable toggle). Validation applies only to a PROVIDED url.
  const providedBaseUrl = input.baseUrl !== undefined ? input.baseUrl.trim() : undefined;
  if (providedBaseUrl !== undefined && providedBaseUrl && !/^https?:\/\//i.test(providedBaseUrl)) {
    throw new ProviderValidationError('baseUrl', 'Base URL must start with http:// or https://');
  }

  const existing = await db.providerConfig.findUnique({ where: { provider } });
  const model = input.model !== undefined ? input.model.trim() : existing?.model ?? '';
  // M2: an absent baseUrl must KEEP the stored one — the old code coerced a
  // missing field to '' and wiped a custom endpoint on every unrelated save
  // (e.g. a priority/enable toggle).
  const baseUrl =
    input.baseUrl !== undefined ? input.baseUrl.trim() : existing?.baseUrl ?? '';

  let apiKeyEnc = existing?.apiKeyEnc ?? '';
  let hint = existing?.keyHint ?? '';
  if (input.clearKey) {
    apiKeyEnc = '';
    hint = '';
  } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    try {
      const secret = encryptSecret(input.apiKey.trim());
      apiKeyEnc = packSecret(secret);
      hint = keyHint(input.apiKey.trim());
    } catch (err) {
      if (err instanceof SecretKeyUnavailableError) {
        throw new ProviderValidationError('apiKey', err.message);
      }
      throw err;
    }
  }

  const timeoutMs = clampInt(
    input.timeoutMs,
    existing?.timeoutMs ?? 120_000,
    5_000,
    MAX_TIMEOUT_MS
  );
  const maxRetries = clampInt(input.maxRetries, existing?.maxRetries ?? 2, 0, MAX_RETRIES);
  const priority = clampInt(input.priority, existing?.priority ?? 100, 0, 10_000);
  // H28: same rule as `model` / `baseUrl` above (M2) — a field that is absent
  // from the request must KEEP what is stored. Re-inferring it unconditionally
  // meant that an unrelated partial save (priority reorder, label, enable)
  // wiped a user's explicit free/paid classification and free-only routing
  // quietly changed its mind about a provider.
  const costClass = inferCostClass(
    provider,
    model,
    input.costClass ?? (existing?.costClass as CostClass | undefined)
  );

  const data = {
    label: (input.label ?? existing?.label ?? '').slice(0, 120),
    enabled: input.enabled ?? existing?.enabled ?? true,
    priority,
    baseUrl,
    model,
    timeoutMs,
    maxRetries,
    costClass,
    apiKeyEnc,
    keyHint: hint,
  };

  // Never keep a green (or red) test badge after editing the tested connection.
  const testState = existing && connectionSettingsChanged(existing, data)
    ? { lastTestOk: null, lastTestedAt: null, lastError: '' }
    : {};
  const row = existing
    ? await db.providerConfig.update({ where: { provider }, data: { ...data, ...testState } })
    : await db.providerConfig.create({ data: { provider, ...data } });

  return toDto(row);
}

/** Enable / disable a provider. */
export async function setProviderEnabled(provider: string, enabled: boolean): Promise<ProviderDto> {
  const row = await db.providerConfig.update({
    where: { provider },
    data: { enabled },
  });
  return toDto(row);
}

/** Remove a provider configuration (and its stored credential). */
export async function removeProvider(provider: string): Promise<boolean> {
  const res = await db.providerConfig.deleteMany({ where: { provider } });
  return res.count > 0;
}

/**
 * Read the stored API key of a provider.
 * SERVER SIDE ONLY — the value must never be sent to the browser.
 */
export async function readProviderSecret(provider: string): Promise<string> {
  const row = await db.providerConfig.findUnique({ where: { provider } });
  if (!row?.apiKeyEnc) return '';
  try {
    return decryptSecret(unpackSecret(row.apiKeyEnc));
  } catch {
    // wrong master key / tampered payload → treat as "no credential"
    return '';
  }
}

/** Persist the result of a connection test. */
export async function recordConnectionResult(
  provider: string,
  ok: boolean,
  error = ''
): Promise<void> {
  try {
    const existing = await db.providerConfig.findUnique({ where: { provider } });
    if (!existing) return;
    await db.providerConfig.update({
      where: { provider },
      data: {
        lastTestedAt: new Date(),
        lastTestOk: ok,
        lastError: ok ? '' : String(error ?? '').slice(0, 500),
      },
    });
  } catch {
    // best effort — a failed status update must not fail the test itself
  }
}

// ---------------------------------------------------------------------------
// Per-agent model preferences
// ---------------------------------------------------------------------------

export interface ModelPreferenceDto {
  role: string;
  provider: string;
  model: string;
  enabled: boolean;
  updatedAt: string;
}

export async function listModelPreferences(): Promise<ModelPreferenceDto[]> {
  const rows = await db.modelPreference.findMany({ orderBy: { role: 'asc' } });
  return rows.map((r) => ({
    role: r.role,
    provider: r.provider,
    model: r.model,
    enabled: r.enabled,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function saveModelPreference(input: {
  role: string;
  provider?: string;
  model?: string;
  enabled?: boolean;
}): Promise<ModelPreferenceDto> {
  const role = String(input.role ?? '').trim();
  if (!role || !/^[a-z0-9_-]{1,40}$/i.test(role)) {
    throw new ProviderValidationError('role', 'Invalid role');
  }
  if (input.provider && !getProvider(input.provider)) {
    throw new ProviderValidationError('provider', `Unknown provider "${input.provider}"`);
  }
  const provider = (input.provider ?? '').trim();
  const model = (input.model ?? '').trim();
  const data = {
    provider,
    model,
    enabled: input.enabled ?? true,
  };
  const existing = await db.modelPreference.findUnique({ where: { role } });
  const row = existing
    ? await db.modelPreference.update({ where: { role }, data })
    : await db.modelPreference.create({ data: { role, ...data } });
  return {
    role: row.role,
    provider: row.provider,
    model: row.model,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function removeModelPreference(role: string): Promise<boolean> {
  const res = await db.modelPreference.deleteMany({ where: { role } });
  return res.count > 0;
}

// ---------------------------------------------------------------------------
// Studio settings (free-only mode, default model, auto fallback)
// ---------------------------------------------------------------------------

export interface StudioSettings {
  freeOnly: boolean;
  /**
   * Free-tier-first routing: try a free provider before a paid one, but keep
   * the paid one as a fallback. `freeOnly` is the strict variant that refuses
   * paid providers altogether.
   */
  preferFree: boolean;
  autoFallback: boolean;
  defaultProvider: string;
  defaultModel: string;
}

const SETTINGS_DEFAULTS: StudioSettings = {
  freeOnly: false,
  preferFree: true,
  autoFallback: true,
  defaultProvider: 'zai',
  defaultModel: '',
};

export async function readStudioSettings(): Promise<StudioSettings> {
  const rows = await db.studioSetting.findMany();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const bool = (key: string, fallback: boolean) => {
    const v = map.get(key);
    if (v === undefined) return fallback;
    return v === 'true' || v === '1';
  };
  return {
    freeOnly: bool('freeOnly', SETTINGS_DEFAULTS.freeOnly),
    preferFree: bool('preferFree', SETTINGS_DEFAULTS.preferFree),
    autoFallback: bool('autoFallback', SETTINGS_DEFAULTS.autoFallback),
    defaultProvider: map.get('defaultProvider') ?? SETTINGS_DEFAULTS.defaultProvider,
    defaultModel: map.get('defaultModel') ?? SETTINGS_DEFAULTS.defaultModel,
  };
}

export async function writeStudioSettings(
  patch: Partial<StudioSettings>
): Promise<StudioSettings> {
  const entries: [string, string][] = [];
  if (typeof patch.freeOnly === 'boolean') entries.push(['freeOnly', String(patch.freeOnly)]);
  if (typeof patch.preferFree === 'boolean') {
    entries.push(['preferFree', String(patch.preferFree)]);
  }
  if (typeof patch.autoFallback === 'boolean') {
    entries.push(['autoFallback', String(patch.autoFallback)]);
  }
  if (typeof patch.defaultProvider === 'string') {
    entries.push(['defaultProvider', patch.defaultProvider]);
  }
  if (typeof patch.defaultModel === 'string') {
    entries.push(['defaultModel', patch.defaultModel]);
  }
  for (const [key, value] of entries) {
    await db.studioSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
  return readStudioSettings();
}

/**
 * The credential for a provider: the request-supplied one wins, then the
 * encrypted server-side credential, then the environment.
 */
export async function effectiveCredential(
  provider: string,
  provided?: { apiKey?: string; baseUrl?: string }
): Promise<{ apiKey: string; baseUrl: string }> {
  const apiKey = provided?.apiKey?.trim() || (await readProviderSecret(provider));
  const stored = await db.providerConfig.findUnique({ where: { provider } });
  const info = getProvider(provider);
  const baseUrl =
    provided?.baseUrl?.trim() || stored?.baseUrl?.trim() || info?.baseUrl || '';
  return { apiKey, baseUrl };
}

/** Resolve the model a provider should use, honouring retired-model mapping. */
export function resolveProviderModel(provider: string, model?: string): string {
  const info: ProviderInfo | undefined = getProvider(provider);
  return resolveModel(info, model);
}

/**
 * The stored (encrypted) credentials of every ENABLED provider.
 * The plaintext never leaves the server process.
 */
export async function loadStoredCredentials(): Promise<CredentialMap> {
  const rows = await db.providerConfig.findMany({ where: { enabled: true } });
  const out: CredentialMap = {};
  for (const row of rows) {
    if (!row.apiKeyEnc) continue;
    let apiKey = '';
    try {
      apiKey = decryptSecret(unpackSecret(row.apiKeyEnc));
    } catch {
      continue; // wrong master key → treat as "no credential"
    }
    if (!apiKey) continue;
    out[row.provider] = {
      apiKey,
      ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    };
  }
  return out;
}

/**
 * The routing policy for the model router: which providers may be used, in
 * which order, and whether paid models are allowed at all.
 */
export async function loadRouterPolicy(): Promise<RouterPolicy> {
  const [order, settings] = await Promise.all([
    providerRoutingOrder(),
    readStudioSettings(),
  ]);
  const costByProvider = new Map(order.map((o) => [o.provider, o.costClass]));
  return {
    freeOnly: settings.freeOnly,
    preferFree: settings.preferFree,
    autoFallback: settings.autoFallback,
    providerOrder: order.filter((o) => o.enabled).map((o) => o.provider),
    disabledProviders: order.filter((o) => !o.enabled).map((o) => o.provider),
    costClassOf: (provider, model) => {
      // H29: the PER-MODEL marker wins over the provider-level class.
      // OpenRouter-style `…:free` models are free for this call even though the
      // provider itself is classified 'paid' — and the provider-level class used
      // to be returned first, so free-only mode refused exactly the free models
      // it was configured to use (and 'prefer free first' never moved them up).
      if (model && /:free$/i.test(String(model).trim())) return 'free';
      const configured = costByProvider.get(provider);
      if (configured && configured !== 'unknown') return configured;
      return inferCostClass(provider, model);
    },
  };
}
