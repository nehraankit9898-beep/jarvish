// llm-core.ts — SHARED provider connection layer
// Extracted from /api/chat/route.ts so that the chat route AND the agentic
// engine use the EXACT SAME connection logic (no duplicate API clients).
// Provider kinds: 'zai' (built-in SDK) | 'openai-compatible' | 'anthropic' | 'gemini'

import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveModel } from './providers';

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
}

// ---------- SSE parsers (moved from chat route, unchanged logic) ----------

function sseChunksFromOpenAI(response: Response): ReadableStream<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta =
            json.choices?.[0]?.delta?.content ??
            json.choices?.[0]?.message?.content ??
            '';
          if (delta) controller.enqueue(delta as string);
        } catch {
          // partial JSON — ignore, next pull continues buffer
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

function sseChunksFromAnthropic(response: Response): ReadableStream<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        try {
          const json = JSON.parse(data);
          if (json.type === 'content_block_delta' && json.delta?.text) {
            controller.enqueue(json.delta.text as string);
          }
        } catch {
          // ignore partial
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

function sseChunksFromGemini(response: Response): ReadableStream<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        try {
          const json = JSON.parse(data);
          const parts = json.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.text) controller.enqueue(part.text as string);
          }
        } catch {
          // ignore partial
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

async function* simulateStream(text: string) {
  const pieces = text.match(/[\s\S]{1,4}/g) ?? [];
  for (const piece of pieces) {
    yield piece;
    await new Promise((r) => setTimeout(r, 12));
  }
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
  temperature: number
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
  const iterator = simulateStream(String(content));
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
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
  const provider = providers.getProvider(config.provider || 'zai');
  if (!provider) throw new Error(`Unknown provider: ${config.provider}`);
  const apiKey = config.apiKey?.trim() || '';
  // Retired models (e.g. gemini-2.0-flash → gemini-3.8-flash) auto-map karo
  const model = resolveModel(provider, config.model);
  const baseUrl = (config.baseUrl?.trim() || provider.baseUrl).replace(
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
      return streamFromZai(messages, temperature);
    }
    if (!apiKey) {
      throw new Error(ZAI_NOT_CONFIGURED);
    }
    if (!baseUrl) {
      throw new Error('Z.ai base URL is required when no .z-ai-config file is present.');
    }
  }

  if (provider.kind === 'openai-compatible' || provider.kind === 'zai') {
    if (!baseUrl) throw new Error('Base URL is required for custom provider');
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: openAiContent(m),
        })),
        temperature,
        stream: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        apiErrorMessage(res, errText)
      );
    }
    return sseChunksFromOpenAI(res);
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        apiErrorMessage(res, errText)
      );
    }
    return sseChunksFromAnthropic(res);
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
  const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      ...(systemMsg
        ? { systemInstruction: { parts: [{ text: systemMsg.content }] } }
        : {}),
      generationConfig: { temperature },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      apiErrorMessage(res, errText)
    );
  }
  return sseChunksFromGemini(res);
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
  return `API error ${res.status}${hint}: ${errText.slice(0, 300) || res.statusText}`;
}
