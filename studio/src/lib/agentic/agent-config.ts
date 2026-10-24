// agent-config.ts — per-role (per-agent) model configuration.
//
// Before this file existed every role (Planner/Coder/Tester/Reviewer) used the
// SINGLE provider+model stored on the task row (see orchestrator.llmConfig).
// Now each role can point at a different provider/model, optionally with a
// fallback model that is used when the primary one fails.
//
// SECURITY: an API key is NEVER part of AgentModelConfig. Credentials travel
// in a separate structure (AgentCredential) and are never persisted, never
// serialized into events and never logged.

import { getProvider, resolveModel } from '@/lib/providers';

export type AgentRole =
  | 'planner'
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'researcher'
  | 'debugger'
  | 'security'
  | 'docs';

export const AGENT_ROLES: readonly AgentRole[] = [
  'planner',
  'coder',
  'tester',
  'reviewer',
  'researcher',
  'debugger',
  'security',
  'docs',
] as const;

export const AGENT_ROLE_LABEL: Record<AgentRole, string> = {
  planner: 'Planner',
  coder: 'Coder',
  tester: 'Tester',
  reviewer: 'Reviewer',
  researcher: 'Researcher',
  debugger: 'Debugger',
  security: 'Security Reviewer',
  docs: 'Documentation',
};

/** A single model target for a role. */
export interface AgentModelConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  /** per-call timeout for this model */
  timeoutMs?: number;
  /** extra attempts on the SAME model before the fallback is used */
  maxRetries?: number;
  /** optional secondary model used when the primary one keeps failing */
  fallback?: AgentModelConfig;
}

/** Credentials are supplied per request and never stored. */
export interface AgentCredential {
  apiKey?: string;
  baseUrl?: string;
}

export type CredentialMap = Record<string, AgentCredential>;

/** The persisted, non-secret routing configuration of a task. */
export interface AgentRoutingConfig {
  agents: Partial<Record<AgentRole, AgentModelConfig>>;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_TEMPERATURE: Record<AgentRole, number> = {
  planner: 0.3,
  coder: 0.2,
  tester: 0.1,
  reviewer: 0.2,
  researcher: 0.1,
  debugger: 0.1,
  security: 0.1,
  docs: 0.2,
};

/**
 * Server-side credential lookup by provider id. The browser normally sends the
 * keys it stored in localStorage, but a deployment can also keep them in the
 * server environment (see .env.example) so background runs keep working.
 */
const ENV_KEY_BY_PROVIDER: Record<string, string[]> = {
  zai: ['ZAI_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  kimi: ['MOONSHOT_API_KEY'],
  grok: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  nvidia: ['NVIDIA_API_KEY', 'NGC_API_KEY'],
  ollama: [],
  custom: [],
};

export function envCredentialFor(provider: string): AgentCredential | undefined {
  const names = ENV_KEY_BY_PROVIDER[provider] ?? [];
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return { apiKey: value.trim() };
  }
  return undefined;
}

/**
 * Resolve the credential for a provider: the request-supplied one wins, the
 * server environment is the fallback.
 */
export function resolveCredential(
  provider: string,
  provided?: AgentCredential
): AgentCredential {
  const fromEnv = envCredentialFor(provider) ?? {};
  const apiKey = provided?.apiKey?.trim() || fromEnv.apiKey || '';
  const baseUrl = provided?.baseUrl?.trim() || fromEnv.baseUrl || '';
  return { apiKey, baseUrl };
}

export interface AgentConfigIssue {
  role: AgentRole;
  field: 'provider' | 'model' | 'baseUrl';
  message: string;
}

/**
 * Validate a routing config against the provider catalog.
 * Returns the list of problems (empty = valid).
 *
 * `credentials` is optional. When a provider's baseUrl comes from the
 * credential map instead of the role config, the role is NOT reported as
 * missing a baseUrl — the router resolves `credential.baseUrl` at call time.
 */
export function validateAgentConfig(
  config: AgentRoutingConfig | undefined | null,
  credentials?: CredentialMap
): AgentConfigIssue[] {
  const issues: AgentConfigIssue[] = [];
  if (!config || !config.agents) return issues;

  for (const role of AGENT_ROLES) {
    const entry = config.agents[role];
    if (!entry) continue;
    const check = (cfg: AgentModelConfig | undefined, label: string) => {
      if (!cfg) return;
      const provider = getProvider(cfg.provider);
      if (!provider) {
        issues.push({
          role,
          field: 'provider',
          message: `${label}: unknown provider "${cfg.provider}"`,
        });
        return;
      }
      const model = resolveModel(provider, cfg.model);
      if (!model) {
        issues.push({
          role,
          field: 'model',
          message: `${label}: model is required for provider "${cfg.provider}"`,
        });
      }
      const baseUrl = cfg.baseUrl?.trim() || credentials?.[cfg.provider]?.baseUrl?.trim();
      if (
        provider.kind === 'openai-compatible' &&
        provider.id !== 'ollama' &&
        !baseUrl
      ) {
        issues.push({
          role,
          field: 'baseUrl',
          message: `${label}: baseUrl is required for provider "${cfg.provider}"`,
        });
      }
    };
    check(entry, AGENT_ROLE_LABEL[role]);
    check(entry.fallback, `${AGENT_ROLE_LABEL[role]} fallback`);
  }
  return issues;
}

/**
 * Normalize a routing config: resolve retired models, drop empty entries and
 * clamp numeric fields into sane ranges.
 *
 * `credentials` is optional. When a provider's baseUrl is only known from the
 * credential map, it is copied into the (non-secret) routing config so the
 * persisted task stays self-sufficient for a background run.
 */
export function normalizeAgentConfig(
  config: AgentRoutingConfig | undefined | null,
  taskFallback?: { provider: string; model: string },
  credentials?: CredentialMap
): AgentRoutingConfig {
  const agents: Partial<Record<AgentRole, AgentModelConfig>> = {};

  const baseUrlFor = (provider: string, own?: string) => {
    const direct = own?.trim();
    if (direct) return direct;
    return credentials?.[provider]?.baseUrl?.trim() || undefined;
  };

  const normalizeOne = (cfg: AgentModelConfig): AgentModelConfig => {
    const provider = getProvider(cfg.provider);
    const model = provider ? resolveModel(provider, cfg.model) : cfg.model;
    const out: AgentModelConfig = {
      provider: cfg.provider,
      model,
    };
    const baseUrl = baseUrlFor(cfg.provider, cfg.baseUrl);
    if (baseUrl) out.baseUrl = baseUrl;
    if (typeof cfg.temperature === 'number') {
      out.temperature = Math.min(2, Math.max(0, cfg.temperature));
    }
    if (typeof cfg.maxTokens === 'number' && cfg.maxTokens > 0) {
      out.maxTokens = Math.min(64_000, Math.floor(cfg.maxTokens));
    }
    if (typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0) {
      out.timeoutMs = Math.min(600_000, Math.floor(cfg.timeoutMs));
    }
    if (typeof cfg.maxRetries === 'number' && cfg.maxRetries >= 0) {
      out.maxRetries = Math.min(5, Math.floor(cfg.maxRetries));
    }
    if (cfg.fallback && cfg.fallback.provider) {
      out.fallback = normalizeOne(cfg.fallback);
    }
    return out;
  };

  for (const role of AGENT_ROLES) {
    const entry = config?.agents?.[role];
    if (!entry || !entry.provider) continue;
    agents[role] = normalizeOne(entry);
  }

  // Roles without an explicit assignment fall back to the task-level model.
  if (taskFallback?.provider) {
    for (const role of AGENT_ROLES) {
      if (!agents[role]) {
        const fallback: AgentModelConfig = {
          provider: taskFallback.provider,
          model: taskFallback.model,
        };
        const baseUrl = baseUrlFor(taskFallback.provider);
        if (baseUrl) fallback.baseUrl = baseUrl;
        agents[role] = fallback;
      }
    }
  }

  return { agents };
}

/**
 * Pick the model config for a role. Order of preference:
 *  1. explicit per-role config
 *  2. task-level provider/model
 */
export function resolveAgentModel(
  role: AgentRole,
  routing: AgentRoutingConfig | undefined | null,
  taskFallback?: { provider: string; model: string }
): AgentModelConfig {
  const entry = routing?.agents?.[role];
  if (entry?.provider) {
    const provider = getProvider(entry.provider);
    return {
      ...entry,
      model: provider ? resolveModel(provider, entry.model) : entry.model,
      temperature: entry.temperature ?? DEFAULT_TEMPERATURE[role],
      maxTokens: entry.maxTokens ?? 8192,
      timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: entry.maxRetries ?? DEFAULT_MAX_RETRIES,
    };
  }
  const provider = taskFallback?.provider || 'zai';
  const info = getProvider(provider);
  return {
    provider,
    model: info ? resolveModel(info, taskFallback?.model) : taskFallback?.model ?? '',
    temperature: DEFAULT_TEMPERATURE[role],
    maxTokens: 8192,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
  };
}

/** Flatten the primary + fallback chain of a role into an ordered list. */
export function fallbackChain(
  cfg: AgentModelConfig
): AgentModelConfig[] {
  const chain: AgentModelConfig[] = [cfg];
  let current = cfg.fallback;
  const seen = new Set<string>([`${cfg.provider}::${cfg.model}`]);
  while (current && current.provider) {
    const key = `${current.provider}::${current.model}`;
    if (seen.has(key)) break; // never loop on a cyclic config
    seen.add(key);
    chain.push(current);
    current = current.fallback;
  }
  return chain;
}

/** Human readable label, e.g. "Gemini · gemini-3.8-flash". Never contains keys. */
export function describeAgentModel(cfg: AgentModelConfig): string {
  const info = getProvider(cfg.provider);
  const name = info?.name ?? cfg.provider;
  const model = cfg.model || info?.defaultModel || 'default';
  return `${name} · ${model}`;
}

/**
 * Strip everything secret from a routing config before it is persisted or
 * sent to the browser.
 */
export function redactAgentConfig(
  config: AgentRoutingConfig | undefined | null
): AgentRoutingConfig {
  const agents: Partial<Record<AgentRole, AgentModelConfig>> = {};
  for (const role of AGENT_ROLES) {
    const entry = config?.agents?.[role];
    if (!entry) continue;
    const clean: AgentModelConfig = {
      provider: entry.provider,
      model: entry.model,
    };
    if (entry.baseUrl) clean.baseUrl = entry.baseUrl;
    if (typeof entry.temperature === 'number') clean.temperature = entry.temperature;
    if (typeof entry.maxTokens === 'number') clean.maxTokens = entry.maxTokens;
    if (typeof entry.timeoutMs === 'number') clean.timeoutMs = entry.timeoutMs;
    if (typeof entry.maxRetries === 'number') clean.maxRetries = entry.maxRetries;
    if (entry.fallback) clean.fallback = redactAgentConfig({
      agents: { coder: entry.fallback },
    }).agents.coder;
    agents[role] = clean;
  }
  return { agents };
}

export function parseAgentRoutingConfig(
  raw: string | undefined | null
): AgentRoutingConfig | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as AgentRoutingConfig;
    if (!parsed || typeof parsed !== 'object' || !parsed.agents) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
