import { NextRequest } from 'next/server';
import { completeText } from '@/lib/llm-core';
import { getProvider, resolveModel } from '@/lib/providers';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/compare — ek prompt, saare connected providers pe PARALLEL.
 * Body: { prompt: string, targets: [{ provider, model?, apiKey?, baseUrl? }] }
 * Har target completeText() (shared llm-core layer) se chalta hai — wahi
 * connection logic jo chat route aur agentic engine use karte hain.
 * Response: { results: [{ provider, name, emoji, model, ok, text, error, elapsedMs }] }
 */

interface CompareTarget {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** Allowlist of public host suffixes for outbound LLM providers (SSRF guard). */
const ALLOWED_HOST_SUFFIXES = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.deepseek.com',
  'dashscope.aliyuncs.com',
  'api.moonshot.cn',
  'api.x.ai',
];

function isAllowedBaseUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl.replace(/\/+$/, ''));
    if (u.protocol !== 'https:') return false;
    if (!u.hostname) return false;
    // Block private/reserved IPs and localhost
    if (/^(127\.|::1|localhost|0\.0\.0\.0)$/i.test(u.hostname)) return false;
    if (/^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(u.hostname)) return false;
    if (/^169\.254\./.test(u.hostname)) return false;
    // Only allow known public provider hosts
    return ALLOWED_HOST_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith('.' + s));
  } catch {
    return false;
  }
}

interface CompareResult {
  provider: string;
  name: string;
  emoji: string;
  kind: string;
  model: string;
  ok: boolean;
  text: string;
  error: string;
  elapsedMs: number;
}

export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as {
      prompt?: string;
      targets?: CompareTarget[];
    };
    const prompt = body.prompt?.trim() ?? '';
    if (!prompt) {
      return Response.json({ error: 'Prompt khali hai' }, { status: 400 });
    }
    const targets = (body.targets ?? [])
      .slice(0, 10)
      .filter((t) => t && typeof t.provider === 'string' && t.provider);
    if (!targets.length) {
      return Response.json(
        { error: 'Kam se kam ek provider chuno' },
        { status: 400 }
      );
    }
    // SSRF guard: reject any target whose baseUrl is not an allowed public host
    for (const t of targets) {
      if (t.baseUrl && !isAllowedBaseUrl(t.baseUrl)) {
        return Response.json(
          { error: `Base URL not allowed: ${t.baseUrl}` },
          { status: 400 }
        );
      }
    }

    const runOne = async (t: CompareTarget): Promise<CompareResult> => {
      const p = getProvider(t.provider);
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      if (!p) {
        return {
          provider: t.provider,
          name: t.provider,
          emoji: '❓',
          kind: 'unknown',
          model: t.model ?? '',
          ok: false,
          text: '',
          error: `Unknown provider: ${t.provider}`,
          elapsedMs: 0,
        };
      }
      try {
        const text = await completeText(
          [{ role: 'user', content: prompt }],
          {
            provider: t.provider,
            apiKey: t.apiKey,
            model: t.model,
            baseUrl: t.baseUrl,
            temperature: 0.4,
          },
          { getProvider }
        );
        return {
          provider: t.provider,
          name: p.name,
          emoji: p.emoji,
          kind: p.kind,
          model: resolveModel(p, t.model),
          ok: true,
          text,
          error: '',
          elapsedMs: elapsed(),
        };
      } catch (err) {
        return {
          provider: t.provider,
          name: p.name,
          emoji: p.emoji,
          kind: p.kind,
          model: resolveModel(p, t.model),
          ok: false,
          text: '',
          error: err instanceof Error ? err.message : 'Unknown error',
          elapsedMs: elapsed(),
        };
      }
    };

    const results = await Promise.all(targets.map(runOne));
    return Response.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Compare failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
