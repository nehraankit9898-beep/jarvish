// provider-errors.ts — ONE classification for every provider failure.
//
// Before this module every layer invented its own vocabulary:
//   * /api/test-connection said "HTTP 401" (no idea it was an auth problem),
//   * /api/chat collapsed everything that was not 429 into "network",
//   * the voice layer said nothing at all.
// The same broken API key therefore produced three different messages in
// three places, and the UI could not tell "wrong key" from "no internet".
//
// Everything here is PURE (no node, no fetch): the browser, the chat route,
// the connection tester and the offline command runner all classify through
// this single implementation, and the automated tests can drive it directly.

/** The status vocabulary required by the product spec (section 9). */
export type ProviderErrorCategory =
  | 'not_configured'
  | 'testing'
  | 'connected'
  | 'auth'
  | 'model_unavailable'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'blocked'
  | 'empty_response'
  | 'config'
  | 'unknown';

/** Every non-success category, in display order. */
export const FAILURE_CATEGORIES: ProviderErrorCategory[] = [
  'not_configured',
  'auth',
  'model_unavailable',
  'rate_limit',
  'server',
  'network',
  'timeout',
  'blocked',
  'empty_response',
  'config',
  'unknown',
];

export const CATEGORY_LABELS: Record<ProviderErrorCategory, string> = {
  not_configured: 'Not configured',
  testing: 'Testing connection',
  connected: 'Connected and verified',
  auth: 'Authentication failed',
  model_unavailable: 'Model unavailable',
  rate_limit: 'Rate limited',
  server: 'Provider/server error',
  network: 'Network unavailable',
  timeout: 'Timed out',
  blocked: 'Response blocked by the provider',
  empty_response: 'Provider returned an empty response',
  config: 'Configuration error',
  unknown: 'Unknown error',
};

export interface ProviderFailure {
  ok: false;
  category: ProviderErrorCategory;
  /** human readable, already sanitised — safe to show and to speak */
  message: string;
  /** optional actionable next step */
  hint?: string;
  status?: number | null;
  retryAfterSec?: number | null;
  at: string;
}

export interface ProviderSuccess {
  ok: true;
  category: 'connected';
  message: string;
  at: string;
}

export type ProviderOutcome = ProviderSuccess | ProviderFailure;

const SECRET_PATTERNS: RegExp[] = [
  // Google AI Studio keys
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  // OpenAI / OpenRouter / DeepSeek / Moonshot style keys
  /\bsk-(?:or-|ant-)?[0-9A-Za-z_-]{12,}\b/g,
  // Groq
  /\bgsk_[0-9A-Za-z]{12,}\b/g,
  // NVIDIA
  /\bnvapi-[0-9A-Za-z_-]{12,}\b/g,
  // xAI
  /\bxai-[0-9A-Za-z_-]{12,}\b/g,
  // Authorization headers
  /(Bearer\s+)[0-9A-Za-z._~+/=-]{8,}/gi,
  /(x-goog-api-key["':\s]+)[0-9A-Za-z._~+/=-]{8,}/gi,
  /(x-api-key["':\s]+)[0-9A-Za-z._~+/=-]{8,}/gi,
];

/**
 * Remove credentials (and anything the caller passed in) from a provider
 * message before it reaches a log, the UI, the audit trail or the voice.
 * Providers happily echo the key back in `error.message` on some 400s.
 */
export function sanitizeProviderMessage(text: string, extraSecrets: string[] = []): string {
  let out = String(text ?? '');
  for (const secret of extraSecrets) {
    const value = String(secret ?? '').trim();
    if (value.length >= 6) out = out.split(value).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix: string | undefined) =>
      prefix ? `${prefix}[redacted]` : '[redacted]'
    );
  }
  // keep a readable, bounded message
  return out.replace(/\s+/g, ' ').trim().slice(0, 400);
}

/** HTTP status → category. Mirrors the spec's status list. */
export function classifyHttpStatus(status: number): ProviderErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'rate_limit'; // OpenRouter: insufficient credits
  if (status === 404) return 'model_unavailable';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status === 400 || status === 422) return 'config';
  return 'unknown';
}

/**
 * Classify a thrown error (fetch/DNS/abort).
 *
 * Node's fetch reports a DNS/TCP failure as `TypeError: fetch failed` with the
 * real reason in `cause`; `AbortSignal.timeout()` produces `TimeoutError`;
 * a caller abort produces `AbortError`. They are reported separately so
 * "internet down" is never confused with "the user pressed Stop".
 */
export function classifyThrownError(err: unknown): ProviderErrorCategory {
  if (!err || typeof err !== 'object') return 'unknown';
  const name = String((err as { name?: unknown }).name ?? '');
  const message = String((err as { message?: unknown }).message ?? '');
  const cause = (err as { cause?: unknown }).cause;
  const causeCode = String(
    (cause as { code?: unknown; message?: unknown } | undefined)?.code ??
      (cause as { message?: unknown } | undefined)?.message ??
      ''
  );
  const haystack = `${name} ${message} ${causeCode}`.toLowerCase();

  if (name === 'TimeoutError' || /timed? ?out|timeout/.test(haystack)) return 'timeout';
  if (name === 'AbortError' || /aborted/.test(haystack)) return 'timeout';
  if (
    /enotfound|eai_again|econnrefused|econnreset|ehostunreach|enetunreach|network|fetch failed|socket|tls|certificate|dns/.test(
      haystack
    )
  ) {
    return 'network';
  }
  return 'unknown';
}

const DETERMINISTIC_HINTS: Partial<Record<ProviderErrorCategory, string>> = {
  not_configured: 'Add the API key in Settings → API, then press "Test connection".',
  auth: 'The key was rejected. Check for a typo, an expired key, or a key from another project.',
  model_unavailable: 'Refresh the model list and pick a model the provider actually offers (free/legacy models get retired).',
  rate_limit: 'Wait for the quota window, or choose another model/provider.',
  server: 'The provider is having an outage — retry shortly.',
  network: 'Check the internet connection / proxy / firewall on this machine.',
  timeout: 'The provider did not answer in time — retry, or lower the timeout.',
  blocked: 'The provider blocked this prompt/response (safety filters). Rephrase the request.',
  empty_response: 'The provider answered with no text — usually a wrong model capability or a filtered response.',
  config: 'The request was rejected — verify the base URL and the model id.',
  unknown: 'See the message above.',
};

/**
 * Pull the useful part out of a provider error body. One implementation for
 * OpenAI-compatible, Anthropic, Gemini and OpenRouter shapes.
 */
export function extractProviderErrorMessage(raw: string): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const json = JSON.parse(text) as any;
    const candidates = [
      json?.error?.message,
      json?.error?.error, // some gateways nest twice
      json?.message,
      Array.isArray(json) ? json[0]?.error?.message : undefined,
      typeof json?.error === 'string' ? json.error : undefined,
      // Gemini sometimes only carries a machine status
      json?.error?.status,
    ];
    const found = candidates.find((c) => typeof c === 'string' && c.trim());
    if (found) return String(found);
  } catch {
    // not JSON — the provider sent text/HTML (a proxy error page, a CDN 502...)
  }
  return text;
}

/** Gemini reports safety blocks inside a HTTP 200 body — this is not success. */
export interface GeminiBodySummary {
  text: string;
  blockReason?: string;
  finishReason?: string;
  /** true when the call technically succeeded but produced no usable text */
  empty: boolean;
}

export function summarizeGeminiResponse(json: any): GeminiBodySummary {
  const candidate = json?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = parts
    .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  const safetyFinish =
    candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'BLOCKLIST'
      ? candidate?.finishReason
      : undefined;
  const blockReason = json?.promptFeedback?.blockReason ?? safetyFinish;
  return {
    text,
    blockReason: blockReason ? String(blockReason) : undefined,
    finishReason: candidate?.finishReason ? String(candidate.finishReason) : undefined,
    empty: text.length === 0,
  };
}

/** OpenAI-compatible chat completion → text ('' when unusable). */
export function extractOpenAiText(json: any): string {
  const choice = json?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? '';
  if (typeof content === 'string') return content.trim();
  // multimodal/multi-part content arrays
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

/** Anthropic messages → text ('' when unusable). */
export function extractAnthropicText(json: any): string {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return blocks
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('')
    .trim();
}

export interface FailureInput {
  category?: ProviderErrorCategory;
  status?: number | null;
  /** raw body / thrown message — will be sanitised */
  detail?: string;
  secrets?: string[];
  retryAfterSec?: number | null;
  /** provider display name, e.g. "Google Gemini" */
  providerName?: string;
  /** model id, when the failure is model specific */
  model?: string;
  /** override the default hint */
  hint?: string;
}

/** Build the canonical failure object (sanitised, timestamped). */
export function buildProviderFailure(input: FailureInput = {}): ProviderFailure {
  const category =
    input.category ??
    (typeof input.status === 'number' ? classifyHttpStatus(input.status) : 'unknown');
  const detail = sanitizeProviderMessage(input.detail ?? '', input.secrets ?? []);
  const provider = input.providerName?.trim() || 'Provider';
  const model = input.model?.trim();

  let message: string;
  switch (category) {
    case 'not_configured':
      message = `${provider} is not configured: no API key has been saved.`;
      break;
    case 'auth':
      message = `${provider} rejected the API key${input.status ? ` (HTTP ${input.status})` : ''}.`;
      break;
    case 'model_unavailable':
      message = model
        ? `${provider} does not offer the model "${model}".`
        : `${provider} does not offer the selected model.`;
      break;
    case 'rate_limit':
      message = input.status === 402
        ? `${provider} refused the request: insufficient credits/quota.`
        : `${provider} is rate limited (quota exhausted or too many requests).`;
      break;
    case 'server':
      message = `${provider} is failing${input.status ? ` (HTTP ${input.status})` : ''}.`;
      break;
    case 'network':
      message = `${provider} is unreachable from this machine (network/DNS).`;
      break;
    case 'timeout':
      message = `${provider} did not answer in time.`;
      break;
    case 'blocked':
      message = `${provider} blocked the response (safety filter).`;
      break;
    case 'empty_response':
      message = `${provider} returned an empty response.`;
      break;
    case 'config':
      message = `${provider} rejected the request configuration${input.status ? ` (HTTP ${input.status})` : ''}.`;
      break;
    default:
      message = `${provider} request failed.`;
  }
  // the provider's own words matter — append them, never replace our summary
  if (detail && !/^(provider|request) failed\.?$/i.test(detail)) {
    message += ` ${detail}`;
  }
  if (category === 'rate_limit' && input.retryAfterSec) {
    message += ` Retry in ~${Math.ceil(input.retryAfterSec)}s.`;
  }

  return {
    ok: false,
    category,
    message: sanitizeProviderMessage(message, input.secrets ?? []),
    hint: input.hint ?? DETERMINISTIC_HINTS[category],
    status: input.status ?? null,
    retryAfterSec: input.retryAfterSec ?? null,
    at: new Date().toISOString(),
  };
}

/** Build the success object. Only call after a REAL non-empty provider answer. */
export function buildProviderSuccess(message: string): ProviderSuccess {
  return {
    ok: true,
    category: 'connected',
    message: sanitizeProviderMessage(message),
    at: new Date().toISOString(),
  };
}

/** Human label for a category. */
export function categoryLabel(category: ProviderErrorCategory): string {
  return CATEGORY_LABELS[category] ?? CATEGORY_LABELS.unknown;
}

/**
 * The sentence JARVIS speaks when a provider call fails (Hinglish, like the
 * rest of the assistant). Never contains a key: the message was sanitised
 * when the failure was built.
 */
export function spokenProviderFailure(
  providerName: string,
  failure: Pick<ProviderFailure, 'category' | 'message'>
): string {
  const provider = providerName?.trim() || 'Provider';
  const detail = failure.message ? ` ${failure.message}` : '';
  switch (failure.category) {
    case 'not_configured':
      return `${provider} configure nahi hai. Settings me API key daal kar Test connection dabaiye.`;
    case 'auth':
      return `${provider} API key accept nahi kar raha. Key check kijiye.${detail}`;
    case 'model_unavailable':
      return `${provider} ka selected model available nahi hai. Doosra model chuniye.${detail}`;
    case 'rate_limit':
      return `${provider} ki limit khatam ho gayi. Thodi der baad try kijiye.${detail}`;
    case 'server':
      return `${provider} ke server me problem hai. Thodi der baad try kijiye.${detail}`;
    case 'network':
      return `Internet connection nahi mil raha. Offline commands abhi bhi available hain.${detail}`;
    case 'timeout':
      return `${provider} time par jawab nahi diya. Dobara try kijiye.${detail}`;
    case 'blocked':
      return `${provider} ne jawab block kar diya. Request badal kar dekhiye.${detail}`;
    case 'empty_response':
      return `${provider} ne khaali jawab bheja. Model ya key badal kar dekhiye.${detail}`;
    case 'config':
      return `${provider} ka configuration sahi nahi hai. Base URL aur model check kijiye.${detail}`;
    default:
      return `Command execute nahi hui. Main aapko actual error bata raha hoon.${detail}`;
  }
}
