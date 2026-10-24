// model-router.ts — routes each agent role to its own provider/model.
//
// Responsibilities:
//   - per-role primary model + optional fallback chain
//   - provider/model health tracking (consecutive failures → cooldown)
//   - per-call timeout + controlled retry with backoff
//   - latency + (estimated) token usage accounting
//   - NEVER expose api keys in results, logs or events
//
// The actual LLM call is delegated to llm-core (the shared connection layer
// used by the chat UI) so no provider-specific client is duplicated here.
// The `complete` function is injectable, which lets the test-suite run the
// whole routing logic with mock providers — no network, no API keys.

import { completeText, type CoreChatMessage, type LLMConfig } from '@/lib/llm-core';
import { getProvider } from '@/lib/providers';
import {
  fallbackChain,
  resolveAgentModel,
  resolveCredential,
  type AgentCredential,
  type AgentModelConfig,
  type AgentRole,
  type AgentRoutingConfig,
  type CredentialMap,
} from './agent-config';

export type CompleteFn = (
  messages: CoreChatMessage[],
  config: LLMConfig
) => Promise<string>;

export interface RouterUsage {
  /** characters sent to the model */
  promptChars: number;
  /** characters received from the model */
  completionChars: number;
  /** rough token estimate (4 chars ≈ 1 token) — the streaming API does not
   *  return a usage block, so this is an ESTIMATE, never a billing number */
  estimatedTokens: number;
  estimated: true;
}

export interface ModelRouteRecord {
  role: AgentRole;
  provider: string;
  model: string;
  attempt: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
  fallbackUsed: boolean;
  /** why this target was chosen (or skipped) — never contains a secret */
  reason?: string;
  usage?: RouterUsage;
}

export interface RouterResult {
  text: string;
  provider: string;
  model: string;
  attempts: number;
  latencyMs: number;
  fallbackUsed: boolean;
  usage: RouterUsage;
}

export type RouterErrorKind =
  | 'timeout'
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'empty'
  | 'no_model_available'
  | 'unknown';

export interface ClassifiedError {
  kind: RouterErrorKind;
  retryable: boolean;
  message: string;
  /** the provider's own Retry-After on a 429, in ms */
  retryAfterMs?: number;
}

/** A Retry-After longer than this is not worth blocking on — try another model instead. */
export const MAX_INLINE_RETRY_AFTER_MS = 60_000;

export class ModelRoutingError extends Error {
  kind: RouterErrorKind;
  role: AgentRole;
  attempts: number;
  constructor(
    message: string,
    kind: RouterErrorKind,
    role: AgentRole,
    attempts: number
  ) {
    super(message);
    this.name = 'ModelRoutingError';
    this.kind = kind;
    this.role = role;
    this.attempts = attempts;
  }
}

/** Classify an upstream failure so the router knows what may be retried. */
export function classifyRouterError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  if (/API error 40[13]/i.test(message)) {
    return { kind: 'auth', retryable: false, message };
  }
  if (/API error 429/i.test(message)) {
    const m = message.match(/retry-after=(\d+(?:\.\d+)?)s/i);
    const retryAfterMs = m ? Math.round(parseFloat(m[1]) * 1000) : undefined;
    return { kind: 'rate_limit', retryable: true, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (/API error 5\d\d/i.test(message)) {
    return { kind: 'server', retryable: true, message };
  }
  if (/API error 4\d\d/i.test(message)) {
    return { kind: 'unknown', retryable: false, message };
  }
  if (/timeout|timed out|aborted|ETIMEDOUT/i.test(message)) {
    return { kind: 'timeout', retryable: true, message };
  }
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i.test(message)) {
    return { kind: 'network', retryable: true, message };
  }
  if (/empty response/i.test(message)) {
    return { kind: 'empty', retryable: true, message };
  }
  return { kind: 'unknown', retryable: false, message };
}

export interface HealthState {
  key: string;
  provider: string;
  model: string;
  consecutiveFailures: number;
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastError?: string;
  lastFailureAt?: number;
  /** until this timestamp the target is skipped by the router */
  cooldownUntil?: number;
  totalCalls: number;
  totalFailures: number;
}

export interface ModelRouterOptions {
  routing?: AgentRoutingConfig | null;
  taskFallback?: { provider: string; model: string };
  credentials?: CredentialMap;
  complete?: CompleteFn;
  now?: () => number;
  /** called after every attempt so the orchestrator can stream the decision */
  onRoute?: (record: ModelRouteRecord) => void;
  /** how many consecutive failures mark a target unhealthy */
  maxHealthFailures?: number;
  /** cooldown of an unhealthy target in ms */
  healthCooldownMs?: number;
  /** base backoff between retries in ms */
  retryBackoffMs?: number;
  /**
   * The global routing policy (provider enable/disable, priority, free-only
   * mode). Supplied by the orchestrator from the server-side provider store.
   */
  policy?: RouterPolicy;
}

/**
 * The policy the router applies before it talks to a provider.
 *
 * `freeOnly` is the important one: while it is active the router refuses to
 * use a provider whose cost class is 'paid' or 'unknown'. When EVERY target
 * is excluded the router fails with `no_model_available` instead of silently
 * spending money the user did not authorise.
 */
export interface RouterPolicy {
  freeOnly?: boolean;
  /**
   * Free-tier-FIRST routing: free providers are tried BEFORE paid ones, but a
   * paid provider is still allowed as a fallback when no free target is
   * available (or when the free one fails).
   *
   * This is different from `freeOnly`, which forbids paid providers entirely.
   */
  preferFree?: boolean;
  /** may the router fall back to another model? */
  autoFallback?: boolean;
  /** provider ids in the order they should be tried (lower priority first) */
  providerOrder?: string[];
  /** provider ids the user has switched off */
  disabledProviders?: string[];
  /** cost class of a provider: 'free' | 'paid' | 'unknown' */
  costClassOf?: (provider: string, model: string) => 'free' | 'paid' | 'unknown';
}

const DEFAULT_MAX_HEALTH_FAILURES = 3;
const DEFAULT_HEALTH_COOLDOWN_MS = 60_000;
const DEFAULT_RETRY_BACKOFF_MS = 750;

/**
 * Routes agent-role LLM calls to a provider/model, with health tracking,
 * retries and fallback. One instance per task run.
 */
export class ModelRouter {
  private routing?: AgentRoutingConfig | null;
  private taskFallback?: { provider: string; model: string };
  private credentials: CredentialMap;
  private completeFn: CompleteFn;
  private now: () => number;
  private onRoute?: (record: ModelRouteRecord) => void;
  private maxHealthFailures: number;
  private healthCooldownMs: number;
  private retryBackoffMs: number;
  private policy: RouterPolicy;
  private health = new Map<string, HealthState>();
  /** full routing journal of this run (no secrets) */
  readonly journal: ModelRouteRecord[] = [];

  constructor(opts: ModelRouterOptions = {}) {
    this.routing = opts.routing;
    this.taskFallback = opts.taskFallback;
    this.credentials = opts.credentials ?? {};
    this.completeFn =
      opts.complete ?? ((messages, config) => completeText(messages, config, { getProvider }));
    this.now = opts.now ?? (() => Date.now());
    this.onRoute = opts.onRoute;
    this.maxHealthFailures = opts.maxHealthFailures ?? DEFAULT_MAX_HEALTH_FAILURES;
    this.healthCooldownMs = opts.healthCooldownMs ?? DEFAULT_HEALTH_COOLDOWN_MS;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.policy = opts.policy ?? {};
  }

  /** The model config a role would use right now (primary only). */
  modelFor(role: AgentRole): AgentModelConfig {
    return resolveAgentModel(role, this.routing, this.taskFallback);
  }

  /** Health snapshot for a provider/model pair. */
  healthOf(provider: string, model: string): HealthState {
    const key = healthKey(provider, model);
    const existing = this.health.get(key);
    if (existing) return { ...existing };
    return {
      key,
      provider,
      model,
      consecutiveFailures: 0,
      status: 'healthy',
      totalCalls: 0,
      totalFailures: 0,
    };
  }

  /** All tracked health states. */
  getHealth(): HealthState[] {
    return Array.from(this.health.values()).map((h) => ({ ...h }));
  }

  private markSuccess(provider: string, model: string) {
    const key = healthKey(provider, model);
    const prev = this.health.get(key);
    this.health.set(key, {
      key,
      provider,
      model,
      consecutiveFailures: 0,
      status: 'healthy',
      lastError: undefined,
      lastFailureAt: prev?.lastFailureAt,
      cooldownUntil: undefined,
      totalCalls: (prev?.totalCalls ?? 0) + 1,
      totalFailures: prev?.totalFailures ?? 0,
    });
  }

  private markFailure(provider: string, model: string, error: string) {
    const key = healthKey(provider, model);
    const prev = this.health.get(key);
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    const status: HealthState['status'] =
      failures >= this.maxHealthFailures ? 'unhealthy' : 'degraded';
    this.health.set(key, {
      key,
      provider,
      model,
      consecutiveFailures: failures,
      status,
      lastError: error.slice(0, 300),
      lastFailureAt: this.now(),
      cooldownUntil:
        status === 'unhealthy' ? this.now() + this.healthCooldownMs : undefined,
      totalCalls: (prev?.totalCalls ?? 0) + 1,
      totalFailures: (prev?.totalFailures ?? 0) + 1,
    });
  }

  /** A provider told us when its quota resets: stay away from that target until then. */
  private markRateLimited(provider: string, model: string, error: string, retryAfterMs: number) {
    const key = healthKey(provider, model);
    const prev = this.health.get(key);
    this.health.set(key, {
      key,
      provider,
      model,
      consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
      status: 'unhealthy',
      lastError: error.slice(0, 300),
      lastFailureAt: this.now(),
      cooldownUntil: this.now() + retryAfterMs,
      totalCalls: (prev?.totalCalls ?? 0) + 1,
      totalFailures: (prev?.totalFailures ?? 0) + 1,
    });
  }

  private isCoolingDown(state: HealthState): boolean {
    return Boolean(state.cooldownUntil && state.cooldownUntil > this.now());
  }

  /**
   * Which targets may be used, and why the others were skipped.
   *
   * The rules are deterministic and inspectable:
   *   1. a provider the user disabled is never used,
   *   2. in free-only mode a provider whose cost class is 'paid' or
   *      'unknown' is never used,
   *   3. the remaining targets keep the order of the fallback chain, but
   *      providers are reordered by their configured priority.
   */
  private eligibleTargets(
    chain: AgentModelConfig[]
  ): { eligible: AgentModelConfig[]; skipped: { target: AgentModelConfig; reason: string }[] } {
    const disabled = new Set(this.policy.disabledProviders ?? []);
    const order = this.policy.providerOrder ?? [];
    const priorityOf = (provider: string) => {
      const idx = order.indexOf(provider);
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };

    const eligible: AgentModelConfig[] = [];
    const skipped: { target: AgentModelConfig; reason: string }[] = [];

    for (const target of chain) {
      if (disabled.has(target.provider)) {
        skipped.push({ target, reason: `provider "${target.provider}" is disabled` });
        continue;
      }
      if (this.policy.freeOnly) {
        const costClass =
          this.policy.costClassOf?.(target.provider, target.model) ?? 'unknown';
        if (costClass !== 'free') {
          skipped.push({
            target,
            reason:
              `free-only mode: "${target.provider}/${target.model}" is ` +
              `classified as ${costClass}, not free`,
          });
          continue;
        }
      }
      eligible.push(target);
    }

    // stable sort by provider priority (the chain order is kept for equal
    // priorities, so the primary model of a role stays first)
    eligible.sort((a, b) => {
      const diff = priorityOf(a.provider) - priorityOf(b.provider);
      if (diff !== 0) return diff;
      return chain.indexOf(a) - chain.indexOf(b);
    });

    // Free-tier-FIRST: when the policy asks for it, the free targets are
    // moved to the front — but the paid ones are KEPT as a fallback so a task
    // is never dropped just because the free provider is down.
    if (this.policy.preferFree && !this.policy.freeOnly) {
      const isFree = (t: AgentModelConfig) =>
        (this.policy.costClassOf?.(t.provider, t.model) ?? 'unknown') === 'free';
      const free = eligible.filter(isFree);
      const paid = eligible.filter((t) => !isFree(t));
      eligible.length = 0;
      eligible.push(...free, ...paid);
    }

    return { eligible, skipped };
  }

  /**
   * Run a completion for a role. Tries the primary model, then its fallback
   * chain. Each target is retried up to `maxRetries` times when the error is
   * retryable (timeout / 5xx / 429 / network).
   */
  async complete(
    role: AgentRole,
    messages: CoreChatMessage[],
    opts: { temperature?: number; maxTokens?: number } = {}
  ): Promise<RouterResult> {
    const primary = this.modelFor(role);
    const chain = fallbackChain(primary).filter((c) => c.provider);
    if (!chain.length) {
      throw new ModelRoutingError(
        `No model configured for role "${role}"`,
        'unknown',
        role,
        0
      );
    }

    const { eligible, skipped } = this.eligibleTargets(chain);

    // Report the skipped targets so the UI can explain the decision.
    for (const s of skipped) {
      this.onRoute?.({
        role,
        provider: s.target.provider,
        model: s.target.model,
        attempt: 0,
        latencyMs: 0,
        ok: false,
        error: `skipped - ${s.reason}`,
        fallbackUsed: false,
        reason: s.reason,
      });
    }

    if (!eligible.length) {
      const reason = skipped.length
        ? skipped.map((s) => s.reason).join('; ')
        : 'no provider is available';
      throw new ModelRoutingError(
        `No usable model for role "${role}" (${reason}). ` +
          (this.policy.freeOnly
            ? 'Free-only mode is on and no free model is configured — enable a free provider or allow paid models explicitly.'
            : 'Configure an enabled provider first.'),
        'no_model_available',
        role,
        0
      );
    }

    // when auto-fallback is off only the primary target may be used
    const targets = this.policy.autoFallback === false ? eligible.slice(0, 1) : eligible;

    const promptChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    const started = this.now();
    let attempts = 0;
    let lastError: ClassifiedError = {
      kind: 'unknown',
      retryable: false,
      message: 'No attempt was made',
    };

    for (let chainIndex = 0; chainIndex < targets.length; chainIndex++) {
      const target = targets[chainIndex];
      const fallbackUsed = chainIndex > 0;
      const state = this.healthOf(target.provider, target.model);
      const reason = fallbackUsed
        ? `fallback #${chainIndex} after the previous target failed`
        : 'primary model for this role';

      // Skip a target that is cooling down — unless it is the only one left.
      if (this.isCoolingDown(state) && chainIndex < targets.length - 1) {
        this.onRoute?.({
          role,
          provider: target.provider,
          model: target.model,
          attempt: attempts,
          latencyMs: 0,
          ok: false,
          error: `skipped - ${target.provider}/${target.model} is unhealthy (cooldown)`,
          fallbackUsed,
          reason: 'provider is in a failure cooldown',
        });
        continue;
      }

      const credential = resolveCredential(
        target.provider,
        this.credentials[target.provider]
      );
      const maxRetries = Math.max(0, target.maxRetries ?? 0);

      for (let retry = 0; retry <= maxRetries; retry++) {
        attempts++;
        const attemptStarted = this.now();
        const llmConfig: LLMConfig = {
          provider: target.provider,
          model: target.model,
          apiKey: credential.apiKey || undefined,
          baseUrl: credential.baseUrl || target.baseUrl || undefined,
          temperature: opts.temperature ?? target.temperature ?? 0.3,
          maxTokens: opts.maxTokens ?? target.maxTokens ?? 8192,
          timeoutMs: target.timeoutMs,
        };

        try {
          const text = await this.completeFn(messages, llmConfig);
          const latencyMs = this.now() - attemptStarted;
          this.markSuccess(target.provider, target.model);
          const usage: RouterUsage = {
            promptChars,
            completionChars: text.length,
            estimatedTokens: Math.ceil((promptChars + text.length) / 4),
            estimated: true,
          };
          const record: ModelRouteRecord = {
            role,
            provider: target.provider,
            model: target.model,
            attempt: attempts,
            latencyMs,
            ok: true,
            fallbackUsed,
            reason,
            usage,
          };
          this.journal.push(record);
          this.onRoute?.(record);
          return {
            text,
            provider: target.provider,
            model: target.model,
            attempts,
            latencyMs: this.now() - started,
            fallbackUsed,
            usage,
          };
        } catch (err) {
          const classified = classifyRouterError(err);
          lastError = classified;
          const latencyMs = this.now() - attemptStarted;
          const longWait =
            classified.kind === 'rate_limit' &&
            classified.retryAfterMs !== undefined &&
            classified.retryAfterMs > MAX_INLINE_RETRY_AFTER_MS;
          if (longWait) {
            // quota exhausted for a while: park this target until the provider says it is back
            this.markRateLimited(target.provider, target.model, classified.message, classified.retryAfterMs!);
          } else {
            this.markFailure(target.provider, target.model, classified.message);
          }
          const record: ModelRouteRecord = {
            role,
            provider: target.provider,
            model: target.model,
            attempt: attempts,
            latencyMs,
            ok: false,
            error: classified.message.slice(0, 300),
            fallbackUsed,
            reason,
          };
          this.journal.push(record);
          this.onRoute?.(record);

          const canRetry = classified.retryable && !longWait && retry < maxRetries;
          if (!canRetry) break;
          // honour the provider's Retry-After; otherwise exponential backoff
          const waitMs =
            classified.retryAfterMs !== undefined
              ? classified.retryAfterMs
              : this.retryBackoffMs * Math.pow(2, retry);
          await delay(waitMs, this.now);
        }
      }
    }

    throw new ModelRoutingError(
      lastError.message || `Model routing failed for role "${role}"`,
      lastError.kind,
      role,
      attempts
    );
  }
}

function healthKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

function delay(ms: number, now: () => number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const started = now();
    const tick = () => {
      if (now() - started >= ms) resolve();
      else setTimeout(tick, Math.min(50, ms));
    };
    setTimeout(tick, 10);
  });
}
