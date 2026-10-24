// outbound.ts — SSRF guard for every server-initiated HTTP call.
//
// The Studio talks to LLM providers from the server, so a user-supplied
// "Base URL" is a classic SSRF vector (it can reach cloud metadata endpoints
// or services on the private network of the machine that runs the Studio).
//
// The guard therefore:
//   * only allows http/https,
//   * resolves the hostname and rejects EVERY address that is loopback,
//     link-local (169.254.0.0/16 — cloud metadata), private (RFC1918) or
//     otherwise reserved,
//   * allows loopback only when the caller explicitly opts in (Ollama and
//     LM Studio run on the developer's own machine),
//   * optionally restricts the request to a fixed host allowlist.
//
// Resolving the DNS name (instead of only string-matching the hostname) also
// closes the DNS-rebinding hole where a public name resolves to a private IP.

import dns from 'dns/promises';
import net from 'net';

export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundUrlError';
  }
}

export interface OutboundPolicy {
  /** allow loopback hosts (127.0.0.1, ::1, localhost) — Ollama / LM Studio */
  allowLoopback?: boolean;
  /** allow RFC1918 / CGNAT private addresses */
  allowPrivateNetwork?: boolean;
  /** require https (default true, except for loopback) */
  requireHttps?: boolean;
  /** optional fixed allowlist of hostnames */
  allowHosts?: string[];
}

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

function ipv4IsBlocked(ip: string, policy: OutboundPolicy): string | null {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null; // not a plain IPv4 literal
  }
  const [a, b] = parts;
  if (a === 127) {
    return policy.allowLoopback ? null : 'loopback address';
  }
  if (a === 0) return 'unspecified address';
  if (a === 169 && b === 254) return 'link-local (cloud metadata) address';
  if (a === 10) {
    return policy.allowPrivateNetwork ? null : 'private network address';
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return policy.allowPrivateNetwork ? null : 'private network address';
  }
  if (a === 192 && b === 168) {
    return policy.allowPrivateNetwork ? null : 'private network address';
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return policy.allowPrivateNetwork ? null : 'carrier-grade NAT address';
  }
  if (a >= 224) return 'multicast/reserved address';
  return null;
}

function ipv6IsBlocked(ip: string, policy: OutboundPolicy): string | null {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::' ) {
    return policy.allowLoopback ? null : 'loopback address';
  }
  if (normalized.startsWith('fe80')) return 'link-local address';
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return policy.allowPrivateNetwork ? null : 'unique local address';
  }
  // IPv4-mapped (::ffff:127.0.0.1)
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
  if (mapped) return ipv4IsBlocked(mapped[1], policy);
  return null;
}

/** Is this address blocked? Returns the reason or null when it is fine. */
export function addressBlocked(ip: string, policy: OutboundPolicy = {}): string | null {
  const family = net.isIP(ip);
  if (family === 4) return ipv4IsBlocked(ip, policy);
  if (family === 6) return ipv6IsBlocked(ip, policy);
  return null;
}

/**
 * Validate a base URL for an outbound request.
 * Throws OutboundUrlError with a redacted reason.
 */
export async function assertOutboundUrl(
  rawUrl: string,
  policy: OutboundPolicy = {}
): Promise<URL> {
  const value = String(rawUrl ?? '').trim();
  if (!value) {
    throw new OutboundUrlError('Base URL is required');
  }
  let url: URL;
  try {
    url = new URL(value.replace(/\/+$/, ''));
  } catch {
    throw new OutboundUrlError('Base URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OutboundUrlError(`Unsupported protocol "${url.protocol}" — use http or https`);
  }
  if (!url.hostname) {
    throw new OutboundUrlError('Base URL has no host');
  }
  if (policy.allowHosts?.length) {
    const allowed = policy.allowHosts.some(
      (h) => url.hostname === h || url.hostname.endsWith(`.${h}`)
    );
    if (!allowed) {
      throw new OutboundUrlError(`Host "${url.hostname}" is not in the allowed host list`);
    }
  }

  const isLoopbackHost =
    url.hostname === 'localhost' ||
    url.hostname === '::1' ||
    net.isIP(url.hostname) !== 0;

  const requireHttps = policy.requireHttps !== false;
  if (requireHttps && url.protocol !== 'https:' && !(policy.allowLoopback && isLoopbackHost)) {
    throw new OutboundUrlError('Only https:// base URLs are allowed');
  }

  if (METADATA_HOSTS.has(url.hostname.toLowerCase())) {
    throw new OutboundUrlError('Cloud metadata endpoints are blocked');
  }

  // Literal IP?
  if (net.isIP(url.hostname) !== 0) {
    const reason = addressBlocked(url.hostname, policy);
    if (reason) {
      throw new OutboundUrlError(`Base URL resolves to a ${reason} (${url.hostname})`);
    }
    return url;
  }

  // Hostname → resolve and check EVERY address it maps to.
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new OutboundUrlError(`Host "${url.hostname}" could not be resolved`);
  }
  if (!addresses.length) {
    throw new OutboundUrlError(`Host "${url.hostname}" could not be resolved`);
  }
  for (const { address } of addresses) {
    const reason = addressBlocked(address, policy);
    if (reason) {
      throw new OutboundUrlError(
        `Base URL resolves to a ${reason} (${url.hostname} → ${address})`
      );
    }
  }
  return url;
}

/**
 * The hosts of the built-in provider catalog. Used as the allowlist for the
 * default provider endpoints so a tampered catalog entry cannot be used to
 * reach an internal service.
 */
export function isCatalogHost(
  hostname: string,
  catalog: { baseUrl: string }[]
): boolean {
  const host = hostname.toLowerCase();
  return catalog.some((p) => {
    if (!p.baseUrl) return false;
    try {
      const u = new URL(p.baseUrl);
      const catalogHost = u.hostname.toLowerCase();
      return host === catalogHost || host.endsWith(`.${catalogHost}`);
    } catch {
      return false;
    }
  });
}
