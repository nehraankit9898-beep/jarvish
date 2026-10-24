// llm-core.ts — SHARED provider connection layer
// Extracted from /api/chat/route.ts so that the chat route AND the agentic
// engine use the EXACT SAME connection logic (no duplicate API clients).
// Provider kinds: 'zai' (built-in SDK) | 'openai-compatible' | 'anthropic' | 'gemini'

import { chatCompletionParameters, userFirstHistory } from './model-parameters';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveModelWithNotice, type ModelNotice } from './providers';
import { assertOutboundUrl } from './agentic/outbound';
import {
  extractProviderErrorMessage,
  sanitizeProviderMessage,
  summarizeGeminiResponse,
} from './provider-errors';

export interface CoreChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * Jarvis #2 (vision): optional images attached to this message.
   * ADDITIVE — every existing caller (string content only) keeps working.
   * The payload builders below translate this per provider kind:
   *   openai-compatible/zai → content parts [{type:'text'},{type:'image_url'}]
   *   anthropic             → content blocks [{type:'image',source:…}]
   *   gemini                → parts [{inline_data:{mime_type,data}}]
   */
  images?: CoreImage[];
}

export interface CoreImage {
  /** raw base64 (WITHOUT the data: prefix) */
  base64: string;
  /** e.g. 'image/png' */
  mediaType: string;
}

/** true when the message carries at least one image */
export function hasImages(messages: CoreChatMessage[]): boolean {
  return messages.some((m) => (m.images?.length ?? 0) > 0);
}

/** OpenAI-style multimodal content parts. */
function openAiContent(m: CoreChatMessage): string | Array<Record<string, unknown>> {
  if (!m.images?.length) return m.content;
  const parts: Array<Record<string, unknown>> = [];
  if (m.content) parts.push({ type: 'text', text: m.content });
  for (const img of m.images) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
    });
  }
  return parts;
}

/** Anthropic content blocks (system messages never carry images). */
function anthropicContent(m: CoreChatMessage): string | Array<Record<string, unknown>> {
  if (!m.images?.length) return m.content;
  const blocks: Array<Record<string, unknown>> = [];
  for (const img of m.images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }
  if (m.content) blocks.push({ type: 'text', text: m.content });
  return blocks;
}

/** Gemini content parts. */
function geminiParts(m: CoreChatMessage): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (m.content) parts.push({ text: m.content });
  for (const img of m.images ?? []) {
    parts.push({ inline_data: { mime_type: img.mediaType, data: img.base64 } });
  }
  return parts;
}

export interface LLMConfig {
  provider: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Per-call timeout in ms. The model router sets a tighter timeout for
   * cheap/lightweight roles (e.g. the tester) so one slow provider cannot
   * stall the whole orchestration.
   */
  timeoutMs?: number;
  /**
   * Optional caller abort (e.g. the chat route's request signal, so the
   * user's Stop button also stops the upstream provider call instead of
   * leaving it running server-side). Combined with the timeout — whichever
   * fires first wins. Cancelling the returned stream releases the upstream
   * connection as well.
   */
  signal?: AbortSignal;
  /**
   * Called once the model id has been resolved. When a retired id had to be
   * replaced, `notice` is set — callers MUST report it (header, UI, voice)
   * instead of silently answering with a different model.
   */
  onModelResolved?: (notice: ModelNotice | undefined) => void;
}

// ---------- SSE parsers (moved from chat route, unchanged logic) ----------

/**
 * `release` drops the upstream HTTP connection (called when the consumer
 * cancels the stream — e.g. the user pressed Stop — so the provider socket
 * is not left dangling until GC). A normally-completed stream never calls
 * it, which keeps the pooled keep-alive connection reusable.
 */
type UpstreamRelease = () => void;

/**
 * ONE SSE reader for every provider.
 *
 * Each event is `data: <json>` on its own line. Two correctness rules that the
 * three copy-pasted parsers used to get wrong:
 *
 *  1. THE LAST EVENT IS NOT ALWAYS NEWLINE-TERMINATED. The old code split the
 *     buffer on "\n" and kept the tail in `buffer`; on EOF it closed the stream
 *     and DISCARDED that tail. A provider that ends its response with
 *     `data: {...}` and closes the socket (no trailing newline — OpenAI-compatible
 *     gateways, some proxies and Gemini's alt=sse all do this) therefore lost
 *     the final text of the reply, silently: the answer was cut off and nothing
 *     reported an error. The remainder is now flushed through the same handler
 *     at EOF.
 *  2. `\r\n` line endings are handled (the trim below) and a `data:` line that
 *     arrives in several TCP chunks is buffered until it is complete.
 */
function sseTextStream(
  response: Response,
  extract: (json: any) => string[],
  release?: UpstreamRelease
): ReadableStream<string> {
  if (!response.body) {
    throw new Error('The provider returned an empty stream');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;
  let emitted = 0;

  /** Feed one complete line; returns the text pieces to emit. */
  const handleLine = (line: string): string[] => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return [];
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return [];
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return []; // ignore malformed JSON, not provider/extractor errors
    }
    if (json?.error || json?.type === 'error') {
      throw new Error(sanitizeProviderMessage(extractProviderErrorMessage(JSON.stringify(json))) || 'Provider stream error');
    }
    const pieces = extract(json);
    emitted += pieces.join('').trim().length;
    return pieces;
  };

  return new ReadableStream<string>({
    async pull(controller) {
      if (closed) return;
      try {
        // A TCP chunk may contain only half an SSE line (or a heartbeat).
        // Keep reading until we enqueue text or finish; returning without an
        // enqueue can leave a pending consumer read stranded indefinitely.
        for (;;) {
          const { done, value } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = done ? '' : lines.pop() ?? '';
          let enqueued = false;
          for (const line of lines) {
            for (const piece of handleLine(line)) {
              if (piece) { controller.enqueue(piece); enqueued = true; }
            }
          }
          if (done) {
            closed = true;
            if (!emitted) throw new Error('Provider returned an empty response');
            controller.close();
            return;
          }
          if (enqueued) return;
        }
      } catch (error) {
        closed = true;
        void reader.cancel().catch(() => undefined);
        release?.();
        controller.error(error);
      }
    },
    cancel() {
      closed = true;
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        /* already closed */
      }
      try {
        release?.();
      } catch {
        /* ignore */
      }
    },
  });
}

/** OpenAI-compatible (`choices[0].delta.content`, or a non-streaming message). */
function sseChunksFromOpenAI(response: Response, release?: UpstreamRelease): ReadableStream<string> {
  return sseTextStream(
    response,
    (json) => {
      if (json?.choices?.[0]?.finish_reason === 'content_filter') throw new Error('Provider blocked the response (content_filter)');
      const delta =
        json?.choices?.[0]?.delta?.content ??
        json?.choices?.[0]?.message?.content ??
        '';
      return [typeof delta === 'string' ? delta : ''];
    },
    release
  );
}

/** Anthropic (`content_block_delta` → `delta.text`). */
function sseChunksFromAnthropic(response: Response, release?: UpstreamRelease): ReadableStream<string> {
  return sseTextStream(
    response,
    (json) => [json?.type === 'content_block_delta' && json?.delta?.text ? String(json.delta.text) : ''],
    release
  );
}

/**
 * Gemini (`candidates[0].content.parts[].text`).
 *
 * Gemini reports safety blocks and quota problems INSIDE a HTTP 200 body
 * (`promptFeedback.blockReason`, `finishReason: SAFETY`). The generic parser
 * silently dropped those events, so a blocked reply looked like a successful
 * empty answer: the chat bubble stayed blank, JARVIS said nothing and the UI
 * reported success. The block reason is now tracked and surfaced.
 */
function sseChunksFromGemini(response: Response, release?: UpstreamRelease): ReadableStream<string> {
  return sseTextStream(response, (json) => {
    const summary = summarizeGeminiResponse(json);
    if (summary.blockReason || (summary.finishReason && !['STOP', 'MAX_TOKENS'].includes(summary.finishReason))) {
      throw new Error(`Gemini returned no text or blocked the response (blockReason=${summary.blockReason || summary.finishReason})`);
    }
    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    return Array.isArray(parts)
      ? parts.filter((part: any) => !part.thought).map((part: any) => typeof part?.text === 'string' ? part.text : '')
      : [];
  }, release);
}

/**
 * Where the z-ai-web-dev-sdk looks for its `.z-ai-config` file:
 * the project directory, the user home directory, then /etc.
 *
 * The SDK THROWS when the file is missing, so the Studio has to know whether
 * it is there before it calls the SDK — otherwise every Z.ai call fails with
 * "Configuration file not found" instead of using the API key.
 */
export function findZaiConfigPath(): string | null {
  const candidates = [
    path.join(process.cwd(), '.z-ai-config'),
    path.join(os.homedir(), '.z-ai-config'),
    '/etc/.z-ai-config',
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // unreadable path → try the next one
    }
  }
  return null;
}

/** Is the Z.ai SDK usable (i.e. is its config file present)? */
export function hasZaiSdkConfig(): boolean {
  return findZaiConfigPath() !== null;
}

/** An actionable error for a Z.ai call that cannot be made. */
export const ZAI_NOT_CONFIGURED =
  'Z.ai is not configured: create a .z-ai-config file ({"baseUrl":"...","apiKey":"..."}) in the project folder, the user home or /etc — or set a Z.ai API key in the Providers panel.';

async function streamFromZai(
  messages: CoreChatMessage[],
  temperature: number,
  signal?: AbortSignal
): Promise<ReadableStream<string>> {
  const ZAI = (await import('z-ai-web-dev-sdk')).default;
  const zai = await ZAI.create();
  const completion = await zai.chat.completions.create({
    messages: messages as any,
    temperature,
    thinking: { type: 'disabled' },
  });
  const content =
    completion?.choices?.[0]?.message?.content ??
    completion?.choices?.[0]?.content ??
    '';
  if (!content) throw new Error('Empty response from Z.ai');
  return new ReadableStream({
    start(controller) {
      if (!signal?.aborted) controller.enqueue(String(content));
      controller.close();
    },
  });
}

// ---------- public API ----------

/**
 * Open a real upstream LLM stream using the SAME connection config shape the
 * chat UI already sends (provider/apiKey/model/baseUrl/temperature).
 */
export async function buildUpstreamStream(
  messages: CoreChatMessage[],
  config: LLMConfig,
  providers: { getProvider: (id: string) => any }
): Promise<ReadableStream<string>> {
  messages = userFirstHistory(messages);
  const provider = providers.getProvider(config.provider || 'zai');
  if (!provider) throw new Error(`Unknown provider: ${config.provider}`);
  const apiKey = config.apiKey?.trim() || '';
  // A retired model id is replaced WITH a notice — never silently.
  const resolved = resolveModelWithNotice(provider, config.model);
  const model = resolved.model;
  try {
    config.onModelResolved?.(resolved.notice);
  } catch {
    /* a diagnostic callback must never break the request */
  }
  let baseUrl = (config.baseUrl?.trim() || provider.baseUrl).replace(
    /\/+$/,
    ''
  );
  const temperature = config.temperature ?? 0.4;
  // per-call timeout (model router) — clamped so a caller cannot disable the
  // safety net entirely
  const timeoutMs = Math.min(
    600_000,
    Math.max(5_000, config.timeoutMs ?? 180_000)
  );

  if (provider.kind === 'zai') {
    // The SDK needs a `.z-ai-config` file. When it is NOT there we fall back
    // to the OpenAI-compatible Z.ai API (same endpoint, plain API key) so a
    // configured key is enough to run the whole agentic engine.
    if (hasZaiSdkConfig()) {
      return streamFromZai(messages, temperature, config.signal);
    }
    if (!apiKey) {
      throw new Error(ZAI_NOT_CONFIGURED);
    }
    if (!baseUrl) {
      throw new Error('Z.ai base URL is required when no .z-ai-config file is present.');
    }
  }

  // Runtime calls use the same outbound boundary as connection tests. This
  // prevents a configured/custom endpoint from reaching metadata or private
  // services. Loopback remains available for local model servers unless the
  // operator explicitly disables it.
  baseUrl = (await assertOutboundUrl(baseUrl, {
    allowLoopback: process.env.AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK !== '0',
    allowPrivateNetwork: false,
  })).toString().replace(/\/+$/, '');

  // One upstream call = one timeout + the caller's abort (user Stop) + our
  // own release switch (stream cancel). Whichever fires first wins; a
  // normally-completed stream aborts nothing, so the pooled keep-alive
  // connection stays reusable. (Node's global fetch already pools
  // connections per origin — no custom agent needed.)
  const cancelUpstream = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const upstreamSignal = config.signal
    ? AbortSignal.any([timeoutSignal, config.signal, cancelUpstream.signal])
    : AbortSignal.any([timeoutSignal, cancelUpstream.signal]);
  const release = () => {
    try {
      cancelUpstream.abort();
    } catch {
      /* already settled */
    }
  };

  if (provider.kind === 'openai-compatible' || provider.kind === 'zai') {
    if (!baseUrl) throw new Error('Base URL is required for custom provider');
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        // OpenRouter attribution headers (ignored by other gateways).
        ...(provider.id === 'openrouter'
          ? {
              'HTTP-Referer': process.env.AGENTSCOPE_PUBLIC_URL || 'http://localhost:3000',
              'X-Title': 'AgentScope Studio JARVIS',
            }
          : {}),
      },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: openAiContent(m),
        })),
        ...chatCompletionParameters(model, temperature, config.maxTokens),
        stream: true,
      }),
      signal: upstreamSignal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        apiErrorMessage(res, errText)
      );
    }
    return sseChunksFromOpenAI(res, release);
  }

  if (provider.kind === 'anthropic') {
    if (!apiKey) throw new Error('Anthropic API key is required');
    const systemMsg = messages.find((m) => m.role === 'system');
    const rest = messages.filter((m) => m.role !== 'system');
    const res = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: config.maxTokens ?? 8192,
        temperature,
        stream: true,
        ...(systemMsg ? { system: systemMsg.content } : {}),
        messages: rest.map((m) => ({
          role: m.role,
          content: anthropicContent(m),
        })),
      }),
      signal: upstreamSignal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        apiErrorMessage(res, errText)
      );
    }
    return sseChunksFromAnthropic(res, release);
  }

  // gemini
  if (!apiKey) throw new Error('Gemini API key is required');
  const systemMsg = messages.find((m) => m.role === 'system');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: geminiParts(m),
    }));
  const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents,
      ...(systemMsg
        ? { systemInstruction: { parts: [{ text: systemMsg.content }] } }
        : {}),
      generationConfig: { temperature },
    }),
    signal: upstreamSignal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      apiErrorMessage(res, errText)
    );
  }
  return sseChunksFromGemini(res, release);
}

/**
 * Full-text (non-streaming) completion — used by the agentic engine roles.
 * Internally reuses buildUpstreamStream, so every provider kind works.
 */
export async function completeText(
  messages: CoreChatMessage[],
  config: LLMConfig,
  providers: { getProvider: (id: string) => any }
): Promise<string> {
  const stream = await buildUpstreamStream(messages, config, providers);
  const reader = stream.getReader();
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += value ?? '';
  }
  if (!full.trim()) throw new Error('Empty response from model');
  return full;
}

/**
 * "API error <status>: <body>" — the prefix is parsed by the model router.
 * A 429 also carries the provider's Retry-After (seconds) so the router can wait
 * exactly that long, or skip to another model when the wait is too long.
 */
export function apiErrorMessage(res: Response, errText: string): string {
  const retryAfter = res.status === 429 ? res.headers.get('retry-after')?.trim() : '';
  const hint = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? ` [retry-after=${retryAfter}s]` : '';
  // Providers return JSON ({error:{message}}), HTML proxy pages, or plain text.
  // Only the useful part is kept, and any credential echoed back is redacted.
  const detail =
    sanitizeProviderMessage(extractProviderErrorMessage(errText)).slice(0, 300) ||
    res.statusText ||
    'request failed';
  return `API error ${res.status}${hint}: ${detail}`;
}

export interface ParsedApiError {
  /** HTTP status from "API error <status>", or null when not parseable */
  status: number | null;
  /** provider Retry-After in seconds (429 only), or null when absent */
  retryAfterSec: number | null;
}

/**
 * Parse what apiErrorMessage() produced — lets the chat route turn a 429
 * into a real 429 (with the provider's own retry hint) instead of a flat
 * 502, without touching the model router's classification.
 */
export function parseApiError(message: unknown): ParsedApiError {
  const text = message instanceof Error ? message.message : String(message ?? '');
  const statusMatch = /API error (\d{3})/i.exec(text);
  const retryMatch = /retry-after=(\d+(?:\.\d+)?)s/i.exec(text);
  return {
    status: statusMatch ? parseInt(statusMatch[1], 10) : null,
    retryAfterSec: retryMatch ? parseFloat(retryMatch[1]) : null,
  };
}

export interface HistoryCap {
  /** max messages to keep (newest first) */
  maxMessages?: number;
  /** max total characters across the kept messages */
  maxChars?: number;
}

/**
 * Bound the conversation history sent to the model: newest messages first,
 * up to `maxMessages` AND `maxChars` total. The newest message (the current
 * question) ALWAYS survives, even if it alone exceeds the char budget —
 * dropping the actual question would be worse than a long prompt.
 *
 * Why both caps: 40 short messages are fine, but 40 long code dumps make a
 * prompt of 100k+ chars (slow + expensive + slow TTFT on every provider).
 */
export function capHistoryContext<T extends { content: string }>(
  history: T[],
  cap: HistoryCap = {}
): T[] {
  const maxMessages = Math.max(1, cap.maxMessages ?? 40);
  const maxChars = Math.max(1, cap.maxChars ?? 24_000);
  const tail = history.slice(-maxMessages);
  const kept: T[] = [];
  let chars = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    const len = m.content?.length ?? 0;
    if (kept.length > 0 && chars + len > maxChars) break;
    kept.push(m);
    chars += len;
  }
  return kept.reverse();
}
