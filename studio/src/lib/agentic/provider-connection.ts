// provider-connection.ts — ONE implementation of "can I really talk to this
// provider?", used by /api/test-connection, by /api/providers/[id]/test and by
// the model-list endpoint.
//
// The previous implementation lived inside /api/test-connection and used a
// fixed host allowlist. That allowlist was missing several catalog providers
// (OpenRouter, Groq, NVIDIA) and every local endpoint (Ollama, LM Studio), so
// "Test connection" could never succeed for them. It is replaced by the
// DNS-aware SSRF guard in `outbound.ts`, which blocks the dangerous targets
// (loopback, private ranges, cloud metadata) while allowing any public host.

import { getProvider, resolveModel } from '@/lib/providers';
import { hasZaiSdkConfig, ZAI_NOT_CONFIGURED } from '@/lib/llm-core';
import { assertOutboundUrl, OutboundUrlError } from './outbound';

export interface ConnectionTestInput {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  message?: string;
  error?: string;
  /** the model that was actually used */
  model?: string;
  /** 'auth' | 'rate_limit' | 'server' | 'timeout' | 'network' | 'config' | 'unknown' */
  errorCategory?: string;
}

/** Providers that are meant to run on the developer's own machine. */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

/**
 * H19: loopback used to be allowed for OLLAMA ONLY, while the code that
 * actually issues LLM calls (src/lib/llm-core) applies no outbound guard at
 * all. A user running LM Studio / vLLM / LiteLLM on http://localhost:1234/v1
 * therefore had a provider that WORKED but was reported BROKEN ("Base URL
 * resolves to a loopback address"), with an empty model list — a diagnostic
 * that contradicts the runtime. The guard protects a CLASS of address, not a
 * product name, so loopback is allowed for any user-configured provider;
 * a hardened deployment can close it again with
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

function classifyHttp(status: number): string {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status === 404) return 'config';
  return 'unknown';
}

async function errorFromResponse(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  let msg = `HTTP ${res.status}`;
  try {
    const json = JSON.parse(text);
    msg = json?.error?.message || json?.message || msg;
  } catch {
    if (text) msg += ` — ${text.slice(0, 150)}`;
  }
  return msg;
}

/**
 * Make a REAL minimal request to the provider and report what happened.
 * Never throws — the result always describes the outcome.
 */
export async function testProviderConnection(
  input: ConnectionTestInput
): Promise<ConnectionTestResult> {
  const providerId = String(input.provider ?? '').trim();
  const info = getProvider(providerId);
  if (!info) {
    return { ok: false, error: `Unknown provider "${providerId}"`, errorCategory: 'config' };
  }

  const timeoutMs = Math.min(120_000, Math.max(5_000, input.timeoutMs ?? 30_000));
  const model = resolveModel(info, input.model);

  try {
    if (info.kind === 'zai') {
      // The z-ai SDK needs a `.z-ai-config` file. Without it we probe the
      // OpenAI-compatible Z.ai API instead — and when neither is available the
      // diagnostic says exactly what to do.
      if (hasZaiSdkConfig()) {
        const ZAI = (await import('z-ai-web-dev-sdk')).default;
        const zai = await ZAI.create();
        const completion = await zai.chat.completions.create({
          messages: [{ role: 'user', content: 'Say OK' }],
          thinking: { type: 'disabled' },
        });
        const content = completion?.choices?.[0]?.message?.content ?? '';
        return {
          ok: true,
          message: `Connected! Model replied: "${String(content).slice(0, 40)}"`,
          model,
        };
      }
      if (!input.apiKey?.trim()) {
        return {
          ok: false,
          error: ZAI_NOT_CONFIGURED,
          errorCategory: 'config',
          model,
        };
      }
      // fall through to the OpenAI-compatible probe below
    }

    const baseUrl = baseUrlFor(providerId, input.baseUrl);
    if (!baseUrl) {
      return { ok: false, error: 'Base URL is required', errorCategory: 'config' };
    }
    const url = await assertOutboundUrl(baseUrl, outboundPolicy(providerId));
    const apiKey = input.apiKey?.trim() ?? '';
    const base = url.toString().replace(/\/+$/, '');

    if (info.kind === 'openai-compatible' || info.kind === 'zai') {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Say OK' }],
          max_tokens: 10,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const msg = await errorFromResponse(res);
        return { ok: false, error: msg, errorCategory: classifyHttp(res.status), model };
      }
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content ?? '';
      return {
        ok: true,
        message: `Connected! Model "${model}" replied: "${String(content).slice(0, 40)}"`,
        model,
      };
    }

    if (info.kind === 'anthropic') {
      if (!apiKey) {
        return { ok: false, error: 'API key is required', errorCategory: 'config', model };
      }
      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say OK' }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const msg = await errorFromResponse(res);
        return { ok: false, error: msg, errorCategory: classifyHttp(res.status), model };
      }
      const json = await res.json();
      const content = json?.content?.[0]?.text ?? '';
      return {
        ok: true,
        message: `Connected! Model "${model}" replied: "${String(content).slice(0, 40)}"`,
        model,
      };
    }

    // gemini
    if (!apiKey) {
      return { ok: false, error: 'API key is required', errorCategory: 'config', model };
    }
    const res = await fetch(
      `${base}/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
    if (!res.ok) {
      const msg = await errorFromResponse(res);
      return { ok: false, error: msg, errorCategory: classifyHttp(res.status), model };
    }
    const json = await res.json();
    const content = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return {
      ok: true,
      message: `Connected! Model "${model}" replied: "${String(content).slice(0, 40)}"`,
      model,
    };
  } catch (err) {
    if (err instanceof OutboundUrlError) {
      return { ok: false, error: err.message, errorCategory: 'config', model };
    }
    const message = err instanceof Error ? err.message : 'Connection failed';
    const lower = message.toLowerCase();
    const errorCategory = /timeout|timed out|abort/i.test(lower)
      ? 'timeout'
      : /fetch failed|enotfound|econnrefused|eai_again|network/i.test(lower)
        ? 'network'
        : 'unknown';
    return { ok: false, error: message, errorCategory, model };
  }
}

export interface ProviderModel {
  id: string;
  /** true when the provider marks the model as free of charge */
  free?: boolean;
  contextWindow?: number;
}

/**
 * Ask the provider which models it offers.
 * Returns null when the provider does not expose a model list (the caller
 * then falls back to the static catalog list).
 */
export async function listProviderModels(
  input: ConnectionTestInput
): Promise<{ models: ProviderModel[]; error?: string } | null> {
  const providerId = String(input.provider ?? '').trim();
  const info = getProvider(providerId);
  if (!info || info.kind === 'zai') return null;

  const baseUrl = baseUrlFor(providerId, input.baseUrl);
  if (!baseUrl) return { models: [], error: 'Base URL is required' };
  const timeoutMs = Math.min(60_000, Math.max(5_000, input.timeoutMs ?? 20_000));

  try {
    const url = await assertOutboundUrl(baseUrl, outboundPolicy(providerId));
    const base = url.toString().replace(/\/+$/, '');
    const apiKey = input.apiKey?.trim() ?? '';

    if (info.kind === 'openai-compatible') {
      const res = await fetch(`${base}/models`, {
        method: 'GET',
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return { models: [], error: await errorFromResponse(res) };
      }
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      return {
        models: list
          .filter((m: any) => m && typeof m.id === 'string')
          .map((m: any) => ({
            id: m.id,
            free: /:free$/i.test(m.id) || Boolean(m?.pricing?.prompt === '0'),
            contextWindow: typeof m?.context_length === 'number' ? m.context_length : undefined,
          })),
      };
    }

    if (info.kind === 'anthropic') {
      if (!apiKey) return { models: [], error: 'API key is required' };
      const res = await fetch(`${base}/models`, {
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { models: [], error: await errorFromResponse(res) };
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      return {
        models: list
          .filter((m: any) => m && typeof m.id === 'string')
          .map((m: any) => ({ id: m.id })),
      };
    }

    // gemini
    if (!apiKey) return { models: [], error: 'API key is required' };
    const res = await fetch(`${base}/models`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { models: [], error: await errorFromResponse(res) };
    const json = await res.json();
    const list = Array.isArray(json?.models) ? json.models : [];
    return {
      models: list
        .filter((m: any) => m && typeof m.name === 'string')
        .map((m: any) => ({
          id: String(m.name).replace(/^models\//, ''),
          contextWindow: typeof m?.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined,
        })),
    };
  } catch (err) {
    if (err instanceof OutboundUrlError) {
      return { models: [], error: err.message };
    }
    return {
      models: [],
      error: err instanceof Error ? err.message : 'Could not list models',
    };
  }
}
