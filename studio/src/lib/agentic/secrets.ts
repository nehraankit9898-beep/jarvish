// secrets.ts — detect & mask secrets so they never reach the LLM or UI logs

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'OpenAI key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI project key', re: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'Gemini/Google key', re: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
  { name: 'JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'Bearer header', re: /[Bb]earer\s+[A-Za-z0-9._-]{25,}/g },
  {
    name: 'Private key block',
    re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    name: 'Generic password assignment',
    re: /["']?(password|passwd|secret|api[_-]?key|token)["']?\s*[:=]\s*(?:'[^']{8,}'|"[^"]{8,}"|[^\s,;}{]{8,})/gi,
  },
];

export interface SecretScan {
  found: { name: string; preview: string }[];
  masked: string;
}

/** Mask every detected secret in the text; returns masked text + what was found. */
export function scanAndMask(text: string): SecretScan {
  const found: { name: string; preview: string }[] = [];
  let masked = text;
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    masked = masked.replace(re, (match) => {
      found.push({ name, preview: match.slice(0, 6) + '...' });
      return `[REDACTED-${name.replace(/\W+/g, '_').toUpperCase()}]`;
    });
  }
  return { found, masked };
}

/** Environment-style secret redaction for command output (common key=value lines). */
export function maskEnvValues(text: string): string {
  return text.replace(
    /^([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)=(\S+)$/gim,
    (_m, name) => `${name}=[REDACTED]`
  );
}

/** Full pipeline: env masking first, then pattern masking. */
export function protect(text: string): { masked: string; found: { name: string; preview: string }[] } {
  const env = maskEnvValues(text);
  const result = scanAndMask(env);
  return { masked: result.masked, found: result.found };
}

const SENSITIVE_KEY = /^(?:key|api[_-]?key|apikey|token|secret|password|passwd|authorization|bearer|cookie|set-cookie|credential|credentials)$/i;
const SENSITIVE_SUFFIX = /(?:ApiKey|Token|Secret|Password|Passphrase|Credential|Authorization)$/;

/**
 * Deeply redact JSON-shaped values without losing their structure. String
 * masking alone misses nested `{ credentials: { apiKey: "..." } }` objects;
 * sensitive keys are removed by name at every depth and all other strings go
 * through the normal pattern/env masker.
 */
export function redactUnknown(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === 'string') return protect(current).masked;
    if (current === null || current === undefined) return current;
    if (typeof current !== 'object') return current;
    if (depth > 12) return '[truncated]';
    if (seen.has(current as object)) return '[circular]';
    seen.add(current as object);
    try {
      if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        out[key] = SENSITIVE_KEY.test(key) || SENSITIVE_SUFFIX.test(key)
          ? '[REDACTED]'
          : visit(item, depth + 1);
      }
      return out;
    } finally {
      seen.delete(current as object);
    }
  };
  return visit(value, 0);
}
