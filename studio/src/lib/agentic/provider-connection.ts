// provider-connection.ts — ONE implementation of "can I really talk to this
// provider?" used by /api/test-connection, /api/providers/[id]/test and
// /api/providers/[id]/models.
//
// Rules enforced here (they were all violated before):
//   1. `ok: true` requires a REAL, NON-EMPTY completion from the provider.
//      A 200 with an empty candidate, a safety block or a body that is not a
//      completion is a FAILURE, reported with its own category. The old code
//      returned `Connected! Model replied: ""`.
//   2. Every failure is classified (auth / model_unavailable / rate_limit /
//      server / network / timeout / config / blocked / empty_response) and
//      sanitised — a provider that echoes the key back never gets it into the
//      UI or the audit log.
//   3. Model discovery keeps the provider's exact ids, its free/paid
//      metadata and its capability information; only CHAT-capable models are
//      offered for the chat picker. The result is cached with a timestamp and
//      the caller is told whether it is live, cached or a static fallback.
//   4. Loopback is allowed for user-configured local servers (Ollama, LM
//      Studio, vLLM) but every other SSRF rule still applies.

import { createHash } from 'node:crypto';
import { chatCompletionParameters } from '@/lib/model-parameters';
import { getProvider, resolveModelWithNotice } from '@/lib/providers';
import { hasZaiSdkConfig, ZAI_NOT_CONFIGURED } from '@/lib/llm-core';
import { assertOutboundUrl, OutboundUrlError } from './outbound';
import {
  buildProviderFailure,
  buildProviderSuccess,
  classifyHttpStatus,
  classifyThrownError,
  extractAnthropicText,
  extractOpenAiText,
  extractProviderErrorMessage,
  sanitizeProviderMessage,
  summarizeGeminiResponse,
  type ProviderErrorCategory,
} from '@/lib/provider-errors';

export interface ConnectionTestInput {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** bypass the model-list cache when a refresh is requested */
  refresh?: boolean;
  /**
   * Include non-chat models (embeddings, TTS, image) in the result.
   * Default false: every consumer gets chat-capable models only, so a
   * TTS/embedding model can never be selected for chat by accident.
   */
  includeNonChat?: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  message?: string;
  error?: string;
  /** the model that was actually used */
  model?: string;
  /** one of the spec's status categories */
  errorCategory?: ProviderErrorCategory | string;
  /** machine-friendly status, mirrors errorCategory */
  status?: ProviderErrorCategory;
  hint?: string;
  statusCode?: number | null;
  retryAfterSec?: number | null;
  /** ISO timestamp of the real check that produced this result */
  checkedAt?: string;
  /** set when a retired model id was replaced — never silent */
  notice?: { from: string; to: string; reason: string };
  /** provider display name (used by the UI/voice) */
  providerName?: string;
}

export interface ProviderModel {
  id: string;
  /** true when the provider marks the model as free of charge */
  free?: boolean;
  contextWindow?: number;
  /** chat capable (generateContent / text completion) — the picker filter */
  chat?: boolean;
  /** the provider explicitly says it supports tool calling */
  tools?: boolean;
  /** input modalities the provider advertises (text, image, …) */
  inputs?: string[];
}

export interface ModelListResult {
  models: ProviderModel[];
  /** where the list came from */
  source: 'provider' | 'cache';
  /** ISO time the list was fetched from the provider */
  fetchedAt: string;
  error?: string;
  /** number of catalog entries the provider offers that are NOT chat-capable */
  filteredOut?: number;
}

/** Providers that are meant to run on the developer's own machine. */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

/**
 * Loopback is allowed for any user-configured provider (Ollama, LM Studio,
 * vLLM, LiteLLM). A hardened deployment can close it with
 * AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK=0. Private ranges, link-local and the
 * cloud metadata endpoints stay blocked in both cases.
 */
export function providerLoopbackAllowed(): boolean {
  return process.env.AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK !== '0';
}

function outboundPolicy(providerId: string) {
  return {
    allowLoopback: LOCAL_PROVIDERS.has(providerId) || providerLoopbackAllowed(),
    allowPrivateNetwork: false,
  };
}

function baseUrlFor(providerId: string, provided?: string): string {
  const info = getProvider(providerId);
  return (provided?.trim() || info?.baseUrl || '').replace(/\/+$/, '');
}

/** Does this provider require an API key to work at all? */
export function providerNeedsKey(providerId: string): boolean {
  const info = getProvider(providerId);
  if (!info) return true;
  if (info.kind === 'zai') return !hasZaiSdkConfig();
  if (providerId === 'ollama') return false;
  if (providerId === 'custom') return false; // key optional
  return true;
}

async function errorFromResponse(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return extractProviderErrorMessage(text) || `HTTP ${res.status} ${res.statusText}`.trim();
}

function retryAfter(res: Response): number | null {
  const raw = res.headers.get('retry-after')?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  return null;
}

function failure(
  providerId: string,
  input: ConnectionTestInput,
  model: string,
  opts: {
    category?: ProviderErrorCategory;
    status?: number | null;
    detail?: string;
    retryAfterSec?: number | null;
    hint?: string;
  }
): ConnectionTestResult {
  const info = getProvider(providerId);
  const built = buildProviderFailure({
    category: opts.category,
    status: opts.status ?? null,
    detail: opts.detail,
    secrets: input.apiKey ? [input.apiKey] : [],
    retryAfterSec: opts.retryAfterSec ?? null,
    providerName: info?.name ?? providerId,
    model,
    hint: opts.hint,
  });
  return {
    ok: false,
    status: built.category,
    errorCategory: built.category,
    error: built.message,
    hint: built.hint,
    message: built.message,
    statusCode: built.status ?? null,
    retryAfterSec: built.retryAfterSec ?? null,
    checkedAt: built.at,
    model,
    providerName: info?.name ?? providerId,
  };
}

function success(
  providerId: string,
  model: string,
  content: string,
  notice?: { from: string; to: string; reason: string }
): ConnectionTestResult {
  const info = getProvider(providerId);
  const reply = content.replace(/\s+/g, ' ').trim().slice(0, 60);
  const built = buildProviderSuccess(
    `Connected — ${info?.name ?? providerId} answered with model "${model}"${reply ? `: "${reply}"` : ''}`
  );
  return {
    ok: true,
    status: 'connected',
    message: built.message,
    model,
    checkedAt: built.at,
    providerName: info?.name ?? providerId,
    ...(notice ? { notice } : {}),
  };
}

/** A stable key for the model-list cache (never stores the raw key). */
function cacheKey(providerId: string, baseUrl: string, apiKey: string): string {
  return createHash('sha256').update(JSON.stringify([providerId, baseUrl, apiKey])).digest('hex');
}

interface CacheEntry {
  models: ProviderModel[];
  fetchedAt: number;
  filteredOut: number;
}

const MODEL_CACHE_TTL_MS = 10 * 60_000;

function modelCache(): Map<string, CacheEntry> {
  const g = globalThis as unknown as { __providerModelCache?: Map<string, CacheEntry> };
  return (g.__providerModelCache ??= new Map());
}

/** Test-only: drop the in-process model cache. */
export function __clearModelCache(): void {
  modelCache().clear();
}

const TEST_PROMPT = 'Reply with the single word OK.';

/**
 * Make a REAL minimal request to the provider and report what happened.
 * Never throws — the result always describes the outcome, and `ok` is only
 * true when the provider actually produced text.
 */
async function runConnectionTest(
  input: ConnectionTestInput
): Promise<ConnectionTestResult> {
  const providerId = String(input.provider ?? '').trim();
  const info = getProvider(providerId);
  if (!info) {
    return failure(providerId, input, '', {
      category: 'config',
      detail: `Unknown provider "${providerId}"`,
      hint: 'Pick a provider from the list.',
    });
  }

  const timeoutMs = Math.min(120_000, Math.max(5_000, input.timeoutMs ?? 30_000));
  // A retired model id is replaced WITH a notice (never silently) — the notice
  // is attached to the result and surfaced by the UI + the voice.
  const resolvedModel = resolveModelWithNotice(info, input.model);
  const model = resolvedModel.model;
  const notice = resolvedModel.notice;

  try {
    if (info.kind === 'zai' && hasZaiSdkConfig()) {
      const ZAI = (await import('z-ai-web-dev-sdk')).default;
      const zai = await ZAI.create();
      const completion = await zai.chat.completions.create({
        messages: [{ role: 'user', content: TEST_PROMPT }],
        thinking: { type: 'disabled' },
      });
      const content = String(
        completion?.choices?.[0]?.message?.content ?? completion?.choices?.[0]?.content ?? ''
      ).trim();
      if (!content) {
        return failure(providerId, input, model, {
          category: 'empty_response',
          detail: 'the Z.ai SDK returned no text',
        });
      }
      return success(providerId, model, content);
    }

    const apiKey = input.apiKey?.trim() ?? '';
    if (!apiKey && providerNeedsKey(providerId)) {
      return failure(providerId, input, model, {
        category: 'not_configured',
        detail:
          info.kind === 'zai'
            ? ZAI_NOT_CONFIGURED
            : `no API key saved for "${info.name}"`,
      });
    }

    const baseUrl = baseUrlFor(providerId, input.baseUrl);
    if (!baseUrl) {
      return failure(providerId, input, model, {
        category: 'config',
        detail: 'Base URL is required',
        hint: 'Enter an https:// base URL (for local servers http://localhost is allowed).',
      });
    }

    let base: string;
    try {
      const url = await assertOutboundUrl(baseUrl, outboundPolicy(providerId));
      base = url.toString().replace(/\/+$/, '');
    } catch (err) {
      if (err instanceof OutboundUrlError) {
        return failure(providerId, input, model, { category: 'config', detail: err.message });
      }
      throw err;
    }

    const signal = AbortSignal.timeout(timeoutMs);

    if (info.kind === 'openai-compatible' || info.kind === 'zai') {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          // OpenRouter asks for these; harmless for every other gateway and
          // they make the request attributable in the provider dashboard.
          ...(providerId === 'openrouter'
            ? {
                'HTTP-Referer': process.env.AGENTSCOPE_PUBLIC_URL || 'http://localhost:3000',
                'X-Title': 'AgentScope Studio JARVIS',
              }
            : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: TEST_PROMPT }],
          ...chatCompletionParameters(model, 0, 1024),
          stream: false,
        }),
        signal,
      });
      if (!res.ok) {
        const detail = await errorFromResponse(res);
        return failure(providerId, input, model, {
          category: classifyHttpStatus(res.status),
          status: res.status,
          detail,
          retryAfterSec: res.status === 429 ? retryAfter(res) : null,
        });
      }
      let json: any;
      try {
        json = await res.json();
      } catch {
        return failure(providerId, input, model, {
          category: 'config',
          detail: 'the response was not JSON (a proxy or a wrong base URL usually causes this)',
        });
      }
      const content = extractOpenAiText(json);
      if (!content) {
        const finish = json?.choices?.[0]?.finish_reason ?? json?.error?.code ?? '';
        return failure(providerId, input, model, {
          category: 'empty_response',
          detail: finish ? `finish_reason=${String(finish)}` : 'no text in choices[0]',
          hint: 'The model answered with nothing — check that the model id exists and supports chat.',
        });
      }
      return success(providerId, model, content);
    }

    if (info.kind === 'anthropic') {
      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          temperature: 0,
          messages: [{ role: 'user', content: TEST_PROMPT }],
        }),
        signal,
      });
      if (!res.ok) {
        return failure(providerId, input, model, {
          category: classifyHttpStatus(res.status),
          status: res.status,
          detail: await errorFromResponse(res),
          retryAfterSec: res.status === 429 ? retryAfter(res) : null,
        });
      }
      const json = await res.json().catch(() => null);
      const content = extractAnthropicText(json);
      if (!content) {
        return failure(providerId, input, model, {
          category: 'empty_response',
          detail: json?.stop_reason ? `stop_reason=${String(json.stop_reason)}` : 'no text blocks',
        });
      }
      return success(providerId, model, content);
    }

    // ---- Gemini (v1beta, x-goog-api-key) ----
    const geminiModel = model.replace(/^models\//, '');
    const res = await fetch(`${base}/models/${encodeURIComponent(geminiModel)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
        generationConfig: { maxOutputTokens: 32, temperature: 0 },
      }),
      signal,
    });
    if (!res.ok) {
      return failure(providerId, input, geminiModel, {
        category: classifyHttpStatus(res.status),
        status: res.status,
        detail: await errorFromResponse(res),
        retryAfterSec: res.status === 429 ? retryAfter(res) : null,
        hint:
          res.status === 404
            ? 'Refresh the model list — Google retires Gemini ids regularly.'
            : undefined,
      });
    }
    let json: any;
    try {
      json = await res.json();
    } catch {
      return failure(providerId, input, geminiModel, {
        category: 'config',
        detail: 'Gemini returned a non-JSON body',
      });
    }
    const summary = summarizeGeminiResponse(json);
    if (summary.empty) {
      return failure(providerId, input, geminiModel, {
        category: summary.blockReason ? 'blocked' : 'empty_response',
        detail: [
          summary.blockReason ? `blockReason=${summary.blockReason}` : '',
          summary.finishReason ? `finishReason=${summary.finishReason}` : '',
        ]
          .filter(Boolean)
          .join(' '),
        hint: 'A valid key with a blocked/empty answer is NOT a verified connection.',
      });
    }
    return success(providerId, geminiModel, summary.text);
  } catch (err) {
    const category = classifyThrownError(err);
    return failure(providerId, input, model, {
      category,
      detail: err instanceof Error ? err.message : 'Connection failed',
      hint:
        category === 'network'
          ? 'Check the internet connection, proxy and firewall.'
          : category === 'timeout'
            ? `No answer within ${Math.round(timeoutMs / 1000)}s.`
            : undefined,
    });
  }
}

/**
 * Public entry point: run the real check, then attach the retired-model notice
 * (when one exists) so it is NEVER a silent substitution.
 */
export async function testProviderConnection(
  input: ConnectionTestInput
): Promise<ConnectionTestResult> {
  const result = await runConnectionTest(input);
  const info = getProvider(String(input.provider ?? '').trim());
  const { notice } = resolveModelWithNotice(info, input.model);
  if (notice && !result.notice) return { ...result, notice };
  return result;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/** Regexes for model families that are NOT chat models. */
const NON_CHAT_GEMINI = /(embedding|embed|imagen|veo|image|tts|audio|live|native-audio|computer-use|deep-research|aqa)/i;
const NON_CHAT_GENERIC = /(embedding|embed-|whisper|tts|moderation|rerank|dall-e|stable-diffusion|image|transcribe|realtime|audio|sora|veo)/i;

function geminiModelToEntry(m: any): ProviderModel | null {
  const rawId = typeof m?.name === 'string' ? m.name : '';
  const id = rawId.replace(/^models\//, '');
  if (!id) return null;
  const methods: string[] = Array.isArray(m?.supportedGenerationMethods)
    ? m.supportedGenerationMethods.map(String)
    : [];
  const chat =
    methods.length === 0
      ? !NON_CHAT_GEMINI.test(id)
      : methods.some((x) => x === 'generateContent' || x === 'streamGenerateContent') &&
        !NON_CHAT_GEMINI.test(id);
  return {
    id,
    chat,
    contextWindow: typeof m?.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined,
    inputs: ['text', ...(Array.isArray(m?.inputModalities) ? m.inputModalities.map(String) : [])],
  };
}

function openRouterModelToEntry(m: any): ProviderModel | null {
  const id = typeof m?.id === 'string' ? m.id : '';
  if (!id) return null;
  const pricing = m?.pricing ?? {};
  const zero = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n === 0;
  };
  const free = /:free$/i.test(id) || (zero(pricing.prompt) && zero(pricing.completion));
  const outputs: string[] = Array.isArray(m?.architecture?.output_modalities)
    ? m.architecture.output_modalities.map(String)
    : [];
  const inputs: string[] = Array.isArray(m?.architecture?.input_modalities)
    ? m.architecture.input_modalities.map(String)
    : [];
  const params: string[] = Array.isArray(m?.supported_parameters)
    ? m.supported_parameters.map(String)
    : [];
  const chat = outputs.length ? outputs.includes('text') : !NON_CHAT_GENERIC.test(id);
  return {
    id,
    free,
    chat,
    tools: params.includes('tools') || params.includes('tool_choice'),
    contextWindow: typeof m?.context_length === 'number' ? m.context_length : undefined,
    inputs,
  };
}

function openAiModelToEntry(m: any): ProviderModel | null {
  const id = typeof m?.id === 'string' ? m.id : '';
  if (!id) return null;
  return { id, chat: !NON_CHAT_GENERIC.test(id) };
}

function anthropicModelToEntry(m: any): ProviderModel | null {
  const id = typeof m?.id === 'string' ? m.id : '';
  if (!id) return null;
  return { id, chat: true, contextWindow: typeof m?.context_window === 'number' ? m.context_window : undefined };
}

/**
 * Ask the provider which models it offers. Returns null when the provider does
 * not expose a model list at all (Z.ai SDK) — the caller then uses the static
 * catalog and labels it as such.
 */
export async function listProviderModels(
  input: ConnectionTestInput
): Promise<ModelListResult | null> {
  const providerId = String(input.provider ?? '').trim();
  const info = getProvider(providerId);
  if (!info || info.kind === 'zai') return null;

  const baseUrl = baseUrlFor(providerId, input.baseUrl);
  if (!baseUrl) {
    return { models: [], source: 'provider', fetchedAt: new Date().toISOString(), error: 'Base URL is required' };
  }
  const timeoutMs = Math.min(60_000, Math.max(5_000, input.timeoutMs ?? 20_000));
  const apiKey = input.apiKey?.trim() ?? '';
  const key = `${cacheKey(providerId, baseUrl, apiKey)}:${Boolean(input.includeNonChat)}`;

  if (!input.refresh) {
    const hit = modelCache().get(key);
    if (hit && Date.now() - hit.fetchedAt < MODEL_CACHE_TTL_MS) {
      return {
        models: hit.models,
        source: 'cache',
        fetchedAt: new Date(hit.fetchedAt).toISOString(),
        filteredOut: hit.filteredOut,
      };
    }
  }

  const fail = (error: string): ModelListResult => ({
    models: [],
    source: 'provider',
    fetchedAt: new Date().toISOString(),
    error: sanitizeProviderMessage(error, input.apiKey ? [input.apiKey] : []),
  });

  if (!apiKey && providerNeedsKey(providerId)) {
    return fail(`No API key saved for "${info.name}"`);
  }

  try {
    const url = await assertOutboundUrl(baseUrl, outboundPolicy(providerId));
    const base = url.toString().replace(/\/+$/, '');
    const signal = AbortSignal.timeout(timeoutMs);

    // Ollama's native tags endpoint reflects installed models, not a static
    // catalogue. Its OpenAI-compatible base URL normally ends in /v1.
    const ollama = providerId === 'ollama';
    const endpoint = ollama ? `${base.replace(/\/v1$/, '')}/api/tags` : `${base}/models`;
    const headers: Record<string, string> = {
      ...(apiKey
        ? info.kind === 'gemini'
          ? { 'x-goog-api-key': apiKey }
          : info.kind === 'anthropic'
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : { Authorization: `Bearer ${apiKey}` }
        : {}),
      ...(providerId === 'openrouter'
        ? {
            'HTTP-Referer': process.env.AGENTSCOPE_PUBLIC_URL || 'http://localhost:3000',
            'X-Title': 'AgentScope Studio JARVIS',
          }
        : {}),
    };
    let entries: ProviderModel[] = [];
    let cursor = '';
    const cursors = new Set<string>();
    // One deadline across ALL pages; never follow provider-supplied URLs
    // with credentials. Only opaque cursor values are copied to our endpoint.
    for (let page = 0; ; page++) {
      if (page >= 100) return fail('Model pagination exceeded 100 pages');
      const query = new URL(endpoint);
      if (info.kind === 'gemini') {
        query.searchParams.set('pageSize', '1000');
        if (cursor) query.searchParams.set('pageToken', cursor);
      } else if (info.kind === 'anthropic') {
        query.searchParams.set('limit', '1000');
        if (cursor) query.searchParams.set('after_id', cursor);
      }
      const res = await fetch(query.toString(), { method: 'GET', headers, signal });
      if (!res.ok) return fail(await errorFromResponse(res));
      const json = await res.json().catch(() => null);
      if (!json || typeof json !== 'object') return fail('the model list was not JSON');
      const list = ollama || info.kind === 'gemini' ? json.models : json.data;
      if (!Array.isArray(list)) return fail('the model list has an invalid format');
      const convert = ollama
        ? (m: any) => openAiModelToEntry({ id: m.name ?? m.model })
        : info.kind === 'gemini' ? geminiModelToEntry
        : info.kind === 'anthropic' ? anthropicModelToEntry
        : providerId === 'openrouter' ? openRouterModelToEntry : openAiModelToEntry;
      entries.push(...list.map(convert).filter((m: ProviderModel | null): m is ProviderModel => Boolean(m)));
      const next = info.kind === 'gemini' ? json.nextPageToken
        : info.kind === 'anthropic' && json.has_more ? json.last_id : '';
      if (info.kind === 'anthropic' && json.has_more && !next) return fail('Missing model pagination cursor');
      if (!next) break;
      if (typeof next !== 'string' || cursors.has(next)) return fail('Invalid or repeated model pagination cursor');
      cursors.add(next);
      cursor = next;
    }

    if (!entries.length) return fail(ollama ? 'No installed Ollama models. Install a model with ollama pull <model>, then refresh.' : 'the provider returned an empty model list');

    // De-duplicate by id (some gateways repeat entries) and keep provider order.
    const seen = new Set<string>();
    entries = entries.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));

    const chatOnly = entries.filter((m) => m.chat !== false);
    const filteredOut = entries.length - chatOnly.length;
    const offered = input.includeNonChat ? entries : chatOnly;
    if (!offered.length) {
      return fail('the provider offers no chat-capable model');
    }
    if (modelCache().size >= 200 && !modelCache().has(key)) {
      modelCache().delete(modelCache().keys().next().value!);
    }
    modelCache().set(key, { models: offered, fetchedAt: Date.now(), filteredOut });
    return {
      models: offered,
      source: 'provider',
      fetchedAt: new Date().toISOString(),
      filteredOut,
    };
  } catch (err) {
    if (err instanceof OutboundUrlError) return fail(err.message);
    return fail(err instanceof Error ? err.message : 'Could not list models');
  }
}

/** The static catalogue as ProviderModel entries (used as a labelled fallback). */
export function catalogModels(providerId: string): ProviderModel[] {
  const info = getProvider(providerId);
  if (!info) return [];
  return info.models.map((id) => ({ id, free: info.free, chat: true }));
}
