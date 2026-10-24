// Shared provider catalog — used by both frontend UI and backend API routes.
// Each provider describes how to make a REAL connection to its API.

export type ProviderId =
  | 'zai'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'qwen'
  | 'kimi'
  | 'grok'
  | 'ollama'
  | 'openrouter'
  | 'groq'
  | 'nvidia'
  | 'custom';

export type ProviderKind = 'zai' | 'openai-compatible' | 'anthropic' | 'gemini';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  emoji: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  /**
   * OFFLINE FALLBACK catalogue only. The authoritative list comes from the
   * provider (GET /models) through /api/providers/[id]/models — this array is
   * used when the provider cannot be reached and is always labelled as such
   * in the UI (`source: 'catalog'`), never presented as a live result.
   */
  models: string[];
  /** subset of `models` that the provider may have retired for new keys */
  legacyModels?: string[];
  /** per-model caveats shown next to the model in the UI */
  modelNotes?: Record<string, string>;
  keyLabel: string;
  keyUrl: string;
  free: boolean;
  description: string;
  docsNote: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'zai',
    name: 'Z.ai (Built-in)',
    emoji: '⚡',
    kind: 'zai',
    // The public Z.ai API is OpenAI-compatible, so the provider works with a
    // plain API key even when no `.z-ai-config` file is present.
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.6',
    models: ['glm-4.6'],
    keyLabel: 'API key or .z-ai-config file',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    free: true,
    description:
      'Works out of the box when a `.z-ai-config` file is present, otherwise with a Z.ai API key.',
    docsNote:
      'Default engine — the z-ai-web-dev-sdk needs a `.z-ai-config` file (project, home or /etc); without one the Studio falls back to the OpenAI-compatible Z.ai API when a key is configured.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    emoji: '🟢',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini'],
    keyLabel: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
    free: false,
    description: 'GPT models — the most popular AI API.',
    docsNote: 'Paste key from platform.openai.com',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    emoji: '🟠',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    models: [
      'claude-sonnet-4-5',
      'claude-opus-4-1',
      'claude-3-5-haiku-latest',
    ],
    keyLabel: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    free: false,
    description: 'Claude models — great for writing & reasoning.',
    docsNote: 'Paste key from console.anthropic.com',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    emoji: '💎',
    kind: 'gemini',
    // v1beta + `x-goog-api-key` header. The key is NEVER put in the query
    // string (it leaks into proxy logs and browser history).
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    // Default = a STABLE chat model that supports generateContent.
    // The live catalogue (GET /v1beta/models) replaces this list after a
    // successful "Refresh models"; this is only the offline fallback.
    defaultModel: 'gemini-3.8-flash',
    models: [
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-4-argon',
      'gemini-flash-latest',
      'gemini-pro-latest',
      'gemini-3.1-pro-preview',
      // legacy: only usable by projects that already used the 2.5 family
      'gemini-2.5-flash',
      'gemini-2.5-pro',
    ],
    legacyModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    modelNotes: {
      'gemini-2.5-flash': 'Legacy — Google limits the 2.5 family to projects that used it before 2026-09-18.',
      'gemini-2.5-pro': 'Legacy — Google limits the 2.5 family to projects that used it before 2026-09-18.',
      'gemini-3.1-pro-preview': 'Preview model — may be replaced by Google.',
      'gemini-flash-latest': 'Alias — always points at the current Flash model.',
      'gemini-pro-latest': 'Alias — always points at the current Pro model.',
    },
    keyLabel: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey',
    free: false,
    description: 'Gemini models — generous free tier available.',
    docsNote:
      'Key from aistudio.google.com. Models are verified against GET /v1beta/models (only generateContent-capable models are listed).',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    emoji: '🐋',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyLabel: 'sk-...',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    free: false,
    description: 'Very cheap & strong reasoning models.',
    docsNote: 'Paste key from platform.deepseek.com',
  },
  {
    id: 'qwen',
    name: 'Qwen (DashScope)',
    emoji: '🟣',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    keyLabel: 'sk-...',
    keyUrl: 'https://bailian.console.alibabacloud.com/',
    free: false,
    description: 'Alibaba Qwen models — AgentScope\u2019s home team.',
    docsNote: 'Key from Alibaba Cloud DashScope console',
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    emoji: '🌙',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0905-preview'],
    keyLabel: 'sk-...',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    free: false,
    description: 'Long-context models from Moonshot AI.',
    docsNote: 'Paste key from platform.moonshot.cn',
  },
  {
    id: 'grok',
    name: 'Grok (xAI)',
    emoji: '🦾',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3-mini',
    models: ['grok-3-mini', 'grok-3', 'grok-code-fast-1'],
    keyLabel: 'xai-...',
    keyUrl: 'https://console.x.ai',
    free: false,
    description: 'xAI Grok models — fast and witty.',
    docsNote: 'Paste key from console.x.ai',
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    emoji: '🦙',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    models: ['llama3.2', 'qwen2.5', 'mistral', 'gemma2', 'deepseek-r1'],
    keyLabel: 'No key needed (local)',
    keyUrl: 'https://ollama.com',
    free: true,
    description: 'Run models on your own computer — 100% private.',
    docsNote: 'Install ollama.com, then run: ollama pull llama3.2',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    emoji: '🌐',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    // `openrouter/free` is OpenRouter's own free-model router: it picks a
    // free model for the request instead of pinning one that may be retired
    // next week (every other `:free` id rotates regularly). The live
    // /api/v1/models list replaces this fallback after "Refresh models".
    defaultModel: 'openrouter/free',
    models: [
      'openrouter/free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'google/gemma-4-31b-it:free',
      'google/gemma-4-26b-a4b-it:free',
      'qwen/qwen3.8-27b:free',
      'cohere/north-mini-code:free',
      'openai/gpt-oss-120b:free',
    ],
    modelNotes: {
      'openrouter/free': 'Free router — OpenRouter itself picks an available free model (never a paid one).',
    },
    keyLabel: 'sk-or-v1-...',
    keyUrl: 'https://openrouter.ai/keys',
    free: true,
    description: 'Unified API for many models with generous free tiers.',
    docsNote:
      'Free models end in ":free" (also included: the openrouter/free router). Paid models are never selected automatically — free-only mode refuses anything without the suffix.',
  },
  {
    id: 'groq',
    name: 'Groq',
    emoji: '⚡',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.1-8b-instant',
    models: ['llama-3.1-8b-instant', 'gemma2-9b-it', 'mixtral-8x7b-32768', 'llama-3.2-3b-preview'],
    keyLabel: 'gsk_...',
    keyUrl: 'https://console.groq.com/keys',
    free: false,
    description: 'Ultra-fast inference with some free tier availability.',
    docsNote: 'Check current Groq pricing for free quota.',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    emoji: '🎮',
    kind: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.1-8b-instruct',
    models: ['meta/llama-3.1-8b-instruct', 'mistralai/mistral-7b-instruct-v0.3', 'google/gemma-2-9b-it'],
    keyLabel: 'nvapi-...',
    keyUrl: 'https://build.nvidia.com/',
    free: false,
    description: 'NVIDIA API catalog with some free models.',
    docsNote: 'Eligibility depends on NVIDIA account.',
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    emoji: '🔧',
    kind: 'openai-compatible',
    baseUrl: '',
    defaultModel: '',
    models: [],
    keyLabel: 'API key (if required)',
    keyUrl: '',
    free: false,
    description: 'Any OpenAI-compatible endpoint — LM Studio, vLLM, LiteLLM, OpenRouter, etc.',
    docsNote: 'Enter Base URL like https://host/v1',
  },
];

export function getProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// Retired/deprecated model ids → the replacement to OFFER.
//
// IMPORTANT (spec §5): a different model is never substituted SILENTLY. The
// resolver returns the replacement together with a `notice`, and every caller
// (chat, connection test, agentic engine) surfaces that notice to the UI and
// to the voice. A model that is merely legacy (still served for old projects)
// is NOT rewritten — the provider's own 404 is reported instead.
const RETIRED_MODELS: Record<string, string> = {
  // Gemini 2.0 family — shut down by Google (404 for every project)
  'gemini-2.0-flash': 'gemini-3.8-flash',
  'gemini-2.0-flash-001': 'gemini-3.8-flash',
  'gemini-2.0-flash-lite': 'gemini-3.8-flash',
  'gemini-2.0-flash-lite-001': 'gemini-3.8-flash',
  'gemini-2.0-pro-exp': 'gemini-3.8-flash',
  // Gemini 1.5 family — shut down
  'gemini-1.5-pro': 'gemini-3.8-flash',
  'gemini-1.5-pro-latest': 'gemini-3.8-flash',
  'gemini-1.5-flash': 'gemini-3.8-flash',
  'gemini-1.5-flash-latest': 'gemini-3.8-flash',
  'gemini-1.5-flash-8b': 'gemini-3.8-flash',
};

export interface ModelNotice {
  /** the model that was stored/requested */
  from: string;
  /** the model that will actually be used */
  to: string;
  reason: string;
}

export interface ResolvedModel {
  model: string;
  /** present when the requested model had to be replaced — MUST be reported */
  notice?: ModelNotice;
}

/**
 * Resolve the model plus an explicit notice when a retired id was replaced.
 * `resolveModel()` stays as the string-only convenience wrapper.
 */
export function resolveModelWithNotice(
  provider: ProviderInfo | undefined,
  model?: string
): ResolvedModel {
  const base = model?.trim() || provider?.defaultModel || '';
  if (!base) return { model: provider?.defaultModel || '' };
  // Only Gemini has the retirement table (its ids are versioned by Google).
  if (provider && provider.kind !== 'gemini') return { model: base };
  const replacement = RETIRED_MODELS[base];
  if (!replacement) return { model: base };
  return {
    model: replacement,
    notice: {
      from: base,
      to: replacement,
      reason: `"${base}" has been shut down by Google; using "${replacement}" instead.`,
    },
  };
}

/**
 * Resolve the model that should actually be used for a provider:
 * - empty/missing → provider.defaultModel
 * - retired model (e.g. gemini-2.0-flash) → its replacement (WITH a notice —
 *   see resolveModelWithNotice)
 * - anything else (incl. custom/preview models) → unchanged
 */
export function resolveModel(
  provider: ProviderInfo | undefined,
  model?: string
): string {
  return resolveModelWithNotice(provider, model).model;
}

/** Is this model marked legacy for the provider (may 404 for new keys)? */
export function isLegacyModel(provider: ProviderInfo | undefined, model: string): boolean {
  return Boolean(provider?.legacyModels?.includes(model.trim()));
}

/** The caveat shown under a model in the picker, when there is one. */
export function modelNote(
  provider: ProviderInfo | undefined,
  model: string
): string | undefined {
  if (!provider) return undefined;
  return provider.modelNotes?.[model.trim()];
}
