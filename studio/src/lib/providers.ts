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
  models: string[];
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
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-4-argon', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    keyLabel: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey',
    free: false,
    description: 'Gemini models — generous free tier available.',
    docsNote: 'Free key from aistudio.google.com',
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
    defaultModel: 'google/gemini-2.5-flash-preview-05-20:free',
    models: [
      'google/gemini-2.5-flash-preview-05-20:free',
      'deepseek/deepseek-chat-v3-0324:free',
      'meta-llama/llama-4-maverick:free',
      'mistralai/mistral-small-3.1-24b-instruct:free',
      'moonshotai/kimi-k2:free',
      'google/gemma-3-27b-it:free',
    ],
    keyLabel: 'sk-or-v1-...',
    keyUrl: 'https://www.openrouter.ai/keys',
    free: true,
    description: 'Unified API for many models with generous free tiers.',
    docsNote: 'Free models use :free suffix. Paid models can be disabled in Free-only mode.',
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

// Retired/deprecated models → recommended replacement.
// Google ne gemini-2.0-flash (aur us family) ko shutdown kar diya hai, isliye
// purane saved configs (localStorage/DB) ko bina manual edit ke naye model par
// map karte hain — warna API 404 deti hai.
const RETIRED_MODELS: Record<string, string> = {
  'gemini-2.0-flash': 'gemini-3.8-flash',
  'gemini-2.0-flash-lite': 'gemini-3.8-flash',
  'gemini-1.5-pro': 'gemini-3.8-flash',
  'gemini-1.5-flash': 'gemini-3.8-flash',
  'gemini-1.5-flash-latest': 'gemini-3.8-flash',
  'gemini-1.5-pro-latest': 'gemini-3.8-flash',
};

/**
 * Resolve the model that should actually be used for a provider:
 * - empty/missing → provider.defaultModel
 * - retired model (e.g. gemini-2.0-flash) → its recommended replacement
 * - anything else (incl. custom/preview models) → unchanged
 *
 * Ye helper chat/compare/test-connection/agentic paths sab me use hota hai,
 * taaki koi bhi purana saved model 404 na de.
 */
export function resolveModel(
  provider: ProviderInfo | undefined,
  model?: string
): string {
  const base = model?.trim() || provider?.defaultModel || '';
  if (!base) return provider?.defaultModel || '';
  // Alias sirf Gemini endpoints par lagao — custom/ollama providers ke
  // model names ko touch mat karo (unka model independent ho sakta hai)
  if (provider && provider.kind !== 'gemini') return base;
  return RETIRED_MODELS[base] ?? base;
}
