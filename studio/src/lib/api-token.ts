'use client';

// api-token.ts — the browser side of the API token.
//
// The server refuses every mutating API call when AGENTSCOPE_API_TOKEN is
// configured (production is fail-closed). The browser therefore has to send
// the token as well — otherwise the Studio would work in development and be
// unusable in production.
//
// The token is kept in localStorage (it never leaves the browser) and attached
// to every same-origin /api request by a single fetch wrapper, so no call
// site has to know about it.

const TOKEN_KEY = 'agentscope-studio-api-token';

export function loadApiToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return (localStorage.getItem(TOKEN_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

export function saveApiToken(token: string): void {
  if (typeof window === 'undefined') return;
  const value = token.trim();
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event('agentscope-api-token-changed'));
}

let installed = false;

/**
 * Attach the stored token to every same-origin /api request.
 * Safe to call more than once — the wrapper is installed only once.
 */
export function installTokenFetch(): void {
  if (typeof window === 'undefined' || installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);
  const patched = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = loadApiToken();
    if (!token) return originalFetch(input, init);

    try {
      const url =
        typeof input === 'string'
          ? new URL(input, window.location.origin)
          : input instanceof URL
            ? input
            : new URL((input as Request).url, window.location.origin);

      if (url.origin !== window.location.origin) return originalFetch(input, init);
      if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);

      const headers = new Headers(init?.headers ?? (input as Request)?.headers ?? {});
      if (!headers.has('x-agentscope-token')) {
        headers.set('x-agentscope-token', token);
      }
      return originalFetch(input, { ...init, headers });
    } catch {
      return originalFetch(input, init);
    }
  };
  window.fetch = patched as unknown as typeof window.fetch;
}
