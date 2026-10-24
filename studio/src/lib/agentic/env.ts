// env.ts — boot-time environment validation.
//
// The Studio reads its configuration from the environment. A missing variable
// used to fail late and in a confusing place (a Prisma error, an empty
// provider list, a silently unauthenticated API). This module turns that into
// an explicit, reportable list of issues.
//
// It never throws by itself — `assertEnv` is used where a hard failure is the
// right answer, and `validateEnv` is used for reporting (boot log, status
// endpoint, setup script).

export type EnvSeverity = 'error' | 'warning';

export interface EnvIssue {
  name: string;
  severity: EnvSeverity;
  message: string;
}

export interface EnvReport {
  ok: boolean;
  issues: EnvIssue[];
  production: boolean;
  /** the names of the variables that are actually set — never their values */
  present: string[];
}

export const PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'DASHSCOPE_API_KEY',
  'QWEN_API_KEY',
  'MOONSHOT_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'NVIDIA_API_KEY',
  'NGC_API_KEY',
  'ZAI_API_KEY',
] as const;

const HEX64 = /^[0-9a-f]{64}$/i;

function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  return Boolean((env[name] ?? '').trim());
}

/**
 * Validate the environment.
 *
 * `error`  — the Studio cannot work correctly (the app is degraded).
 * `warning` — the Studio works, but a capability is reduced.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const issues: EnvIssue[] = [];
  const production = env.NODE_ENV === 'production';

  if (!isSet(env, 'DATABASE_URL')) {
    issues.push({
      name: 'DATABASE_URL',
      severity: 'error',
      message:
        'DATABASE_URL is not set. Prisma has no database to talk to — set DATABASE_URL=file:../db/custom.db in .env',
    });
  }

  const tokenSet = isSet(env, 'AGENTSCOPE_API_TOKEN');
  const allowUnauthenticated = env.AGENTSCOPE_ALLOW_UNAUTHENTICATED === '1';
  if (production && !tokenSet && !allowUnauthenticated) {
    issues.push({
      name: 'AGENTSCOPE_API_TOKEN',
      severity: 'error',
      message:
        'AGENTSCOPE_API_TOKEN is not set. In production every mutating API call is rejected (fail-closed) until the token is configured.',
    });
  } else if (!tokenSet && !allowUnauthenticated) {
    issues.push({
      name: 'AGENTSCOPE_API_TOKEN',
      severity: 'warning',
      message:
        'AGENTSCOPE_API_TOKEN is not set — the API is reachable from the same origin only. Set it before exposing the Studio.',
    });
  }

  const secretKey = (env.AGENTSCOPE_SECRET_KEY ?? '').trim();
  if (!secretKey) {
    issues.push({
      name: 'AGENTSCOPE_SECRET_KEY',
      severity: 'warning',
      message:
        'AGENTSCOPE_SECRET_KEY is not set — a random key is generated and stored in db/.secret-key. Set it explicitly to keep provider keys decryptable across machines.',
    });
  } else if (!HEX64.test(secretKey)) {
    issues.push({
      name: 'AGENTSCOPE_SECRET_KEY',
      severity: 'error',
      message:
        'AGENTSCOPE_SECRET_KEY must be 64 hexadecimal characters (32 bytes). Generate one with: bun -e "console.log(crypto.randomBytes(32).toString(\'hex\'))"',
    });
  }

  if (!isSet(env, 'AGENTSCOPE_PYTHON')) {
    issues.push({
      name: 'AGENTSCOPE_PYTHON',
      severity: 'warning',
      message:
        'AGENTSCOPE_PYTHON is not set — the AgentScope Python bridge is detected automatically (python3, python, py).',
    });
  }

  const present = [
    ...PROVIDER_ENV_KEYS.filter((k) => isSet(env, k)),
    ...['DATABASE_URL', 'AGENTSCOPE_API_TOKEN', 'AGENTSCOPE_SECRET_KEY', 'AGENTSCOPE_PYTHON']
      .filter((k) => isSet(env, k)),
  ];

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    production,
    present,
  };
}

/** Throw when a required variable is missing. Used by the CLI/setup scripts. */
export function assertEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const report = validateEnv(env);
  const errors = report.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `Invalid environment:\n${errors.map((e) => `  - ${e.name}: ${e.message}`).join('\n')}`
    );
  }
  return report;
}
