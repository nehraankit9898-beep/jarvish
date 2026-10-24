import { NextResponse, type NextRequest } from 'next/server';

/**
 * Simple in-memory fixed-window rate limiter for API routes.
 * Keyed by (ip, route). Suitable for single-instance deploys; for multi-node
 * production deploys, back this with Redis.
 *
 * Limits:
 *   - mutating /api/* (POST/PUT/PATCH/DELETE): 60 req/min
 *   - read /api/* (GET): 120 req/min
 *   - /api/chat, /api/compare, /api/test-connection: 20 req/min (expensive/outbound)
 */
const LIMITS: Record<string, { max: number; windowMs: number }> = {
  '/api/chat': { max: 20, windowMs: 60_000 },
  '/api/compare': { max: 20, windowMs: 60_000 },
  '/api/test-connection': { max: 20, windowMs: 60_000 },
  '/api/providers': { max: 20, windowMs: 60_000 },
  'mutating': { max: 60, windowMs: 60_000 },
  'read': { max: 120, windowMs: 60_000 },
};

type Window = { count: number; resetAt: number };
const stores = new Map<string, Window>();

function getIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

function limitFor(req: NextRequest): { max: number; windowMs: number } {
  const url = req.nextUrl.pathname;
  for (const [key, limit] of Object.entries(LIMITS)) {
    if (key !== 'mutating' && key !== 'read' && url.startsWith(key)) {
      return limit;
    }
  }
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return LIMITS.read;
  }
  return LIMITS.mutating;
}

/**
 * Next.js 16 renamed the middleware entry point to `proxy`. The behaviour is
 * unchanged — this file is the same rate limiter that used to live in
 * `src/middleware.ts`.
 */
export function proxy(req: NextRequest) {
  const url = req.nextUrl.pathname;
  if (!url.startsWith('/api/')) {
    return NextResponse.next();
  }

  const ip = getIp(req);
  const { max, windowMs } = limitFor(req);
  const key = `${ip}:${url}`;
  const now = Date.now();
  let win = stores.get(key);
  if (!win || now > win.resetAt) {
    win = { count: 0, resetAt: now + windowMs };
    stores.set(key, win);
  }
  win.count += 1;
  if (win.count > max) {
    return NextResponse.json(
      { error: 'Too many requests. Please slow down.' },
      { status: 429 }
    );
  }

  const res = NextResponse.next();
  res.headers.set('X-RateLimit-Limit', String(max));
  res.headers.set('X-RateLimit-Remaining', String(Math.max(0, max - win.count)));
  res.headers.set('X-RateLimit-Reset', String(Math.ceil(win.resetAt / 1000)));
  return res;
}

export default proxy;

export const config = {
  matcher: ['/api/:path*'],
};
