// api-auth.ts — access control for the agentic / tool execution routes.
//
// The audit found that EVERY route in this app was reachable without any
// authentication. The agentic routes can execute shell commands and write
// files, so exposing them on a network is a real risk.
//
// This guard is applied to all agentic routes and to the tool-execution
// routes. It has two independent layers:
//
//  1. SAME-ORIGIN enforcement (always on)
//     A mutating request (POST/PUT/PATCH/DELETE) coming from another origin
//     is rejected. This blocks a malicious web page from driving the agent
//     engine through the victim's browser (CSRF / DNS-rebinding style).
//
//  2. API TOKEN enforcement (when AGENTSCOPE_API_TOKEN is configured)
//     The request must carry `x-agentscope-token` or `Authorization: Bearer
//     <token>` matching the configured token.
//
//  3. FAIL-CLOSED in production
//     With NODE_ENV=production and no token configured the agentic routes
//     refuse to run, unless AGENTSCOPE_ALLOW_UNAUTHENTICATED=1 is set
//     explicitly (the operator accepts the risk for a local-only deployment).

import type { NextRequest } from 'next/server';

export interface AccessCheck {
  ok: boolean;
  status: number;
  error?: string;
  /** the token that was presented (already compared) */
  authenticated: boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function configuredToken(): string {
  return (process.env.AGENTSCOPE_API_TOKEN ?? '').trim();
}

function requestToken(req: NextRequest): string {
  const header = req.headers.get('x-agentscope-token');
  if (header?.trim()) return header.trim();
  const auth = req.headers.get('authorization');
  if (auth?.trim().toLowerCase().startsWith('bearer ')) {
    return auth.trim().slice(7).trim();
  }
  return '';
}

function allowedOrigins(): string[] {
  const raw = (process.env.AGENTSCOPE_ALLOWED_ORIGINS ?? '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The origin of the request itself (used to allow same-origin calls).
 */
function selfOrigin(req: NextRequest): string[] {
  const origins = new Set<string>();
  try {
    origins.add(new URL(req.url).origin);
  } catch {
    // ignore malformed urls
  }
  const host = req.headers.get('host');
  if (host) {
    const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const scheme = proto || 'http';
    origins.add(`${scheme}://${host}`);
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }
  return Array.from(origins);
}

/**
 * Check whether a request may reach an agentic / tool-execution route.
 */
export function checkAgenticAccess(
  req: NextRequest,
  opts: { allowUnauthenticated?: boolean } = {}
): AccessCheck {
  const method = req.method.toUpperCase();

  // 1) same-origin enforcement for mutating requests
  if (!SAFE_METHODS.has(method)) {
    const origin = req.headers.get('origin');
    if (origin) {
      const allowed = new Set([...selfOrigin(req), ...allowedOrigins()]);
      if (!allowed.has(origin)) {
        return {
          ok: false,
          status: 403,
          error: `Cross-origin request blocked (origin: ${origin})`,
          authenticated: false,
        };
      }
    }
  }

  // 2) token enforcement
  const expected = configuredToken();
  if (expected) {
    const presented = requestToken(req);
    if (presented !== expected) {
      return {
        ok: false,
        status: 401,
        error: 'Missing or invalid API token',
        authenticated: false,
      };
    }
    return { ok: true, status: 200, authenticated: true };
  }

  // 3) fail closed in production
  const production = process.env.NODE_ENV === 'production';
  const bypass = process.env.AGENTSCOPE_ALLOW_UNAUTHENTICATED === '1';
  if (production && !bypass && !opts.allowUnauthenticated) {
    return {
      ok: false,
      status: 503,
      error:
        'Agent execution is disabled: set AGENTSCOPE_API_TOKEN (and send it as `x-agentscope-token` or `Authorization: Bearer <token>`), or set AGENTSCOPE_ALLOW_UNAUTHENTICATED=1 for a local-only deployment.',
      authenticated: false,
    };
  }

  return { ok: true, status: 200, authenticated: false };
}

/**
 * Convenience wrapper for route handlers.
 * Returns a Response when the request must be rejected, otherwise null.
 */
export function rejectIfUnauthorized(
  req: NextRequest,
  opts: { allowUnauthenticated?: boolean } = {}
): Response | null {
  const check = checkAgenticAccess(req, opts);
  if (check.ok) return null;
  return Response.json({ error: check.error }, { status: check.status });
}
