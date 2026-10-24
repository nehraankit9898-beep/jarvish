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

/**
 * Expand an IPv6 literal into its 8 sixteen-bit groups (null when it is not a
 * plain IPv6 address). String prefixes are NOT a safe test: `0:0:0:0:0:0:0:1`
 * is the loopback address too, and `::ffff:127.0.0.1` / `::127.0.0.1` embed an
 * IPv4 address that a prefix check never sees.
 */
function ipv6Groups(ip: string): number[] | null {
  let value = ip.trim().toLowerCase();
  if (value.startsWith('[')) value = value.slice(1);
  if (value.endsWith(']')) value = value.slice(0, -1);
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (!value || !/^[0-9a-f:.]+$/.test(value)) return null;

  // trailing embedded IPv4 (…:1.2.3.4) → two groups
  const parts = value.split(':');
  const last = parts[parts.length - 1];
  if (last.includes('.')) {
    const v4 = last.split('.');
    if (v4.length !== 4 || v4.some((n) => !/^\d{1,3}$/.test(n) || Number(n) > 255)) return null;
    const hi = (Number(v4[0]) << 8) | Number(v4[1]);
    const lo = (Number(v4[2]) << 8) | Number(v4[3]);
    parts.splice(parts.length - 1, 1, hi.toString(16), lo.toString(16));
    value = parts.join(':');
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((x) => x !== '') : [];
  const tail = halves[1] !== undefined
    ? (halves[1] ? halves[1].split(':').filter((x) => x !== '') : [])
    : null;
  if (halves.length === 1 && !halves[0].includes(':')) return null;
  const groups: (number | null)[] = [];
  const push = (token: string): boolean => {
    if (!/^[0-9a-f]{1,4}$/.test(token)) return false;
    groups.push(parseInt(token, 16));
    return true;
  };
  for (const t of head) if (!push(t)) return null;
  if (tail === null) {
    if (groups.length !== 8) return null;
  } else {
    for (const t of tail) if (!push(t)) return null;
    const fill = 8 - groups.length;
    if (fill < 1) return null;
    groups.splice(head.length, 0, ...Array<null>(fill).fill(null));
  }
  return groups.map((g) => g ?? 0);
}

/** Is this address literally the loopback interface (127.0.0.0/8 or ::1)? */
function isLoopbackAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  const family = net.isIP(bare);
  if (family === 4) return /^127(\.\d{1,3}){3}$/.test(bare);
  if (family === 6) {
    const groups = ipv6Groups(bare);
    if (!groups) return false;
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
    const embedded = embeddedIpv4(groups);
    return !!embedded && /^127(\.\d{1,3}){3}$/.test(embedded);
  }
  return false;
}

/**
 * The IPv4 address embedded in an IPv6 literal — `::ffff:127.0.0.1`
 * (v4-mapped) and the deprecated `::127.0.0.1` (v4-compatible) both name a
 * v4 host, and the v4 rules are what actually protect the machine.
 */
function embeddedIpv4(groups: number[]): string | null {
  const mapped =
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff;
  const compatible =
    !mapped &&
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0 &&
    // ::1 is the plain v6 loopback, handled by the caller
    !(groups[6] === 0 && groups[7] <= 1);
  if (!mapped && !compatible) return null;
  return [
    (groups[6] >> 8) & 0xff,
    groups[6] & 0xff,
    (groups[7] >> 8) & 0xff,
    groups[7] & 0xff,
  ].join('.');
}

function ipv6IsBlocked(ip: string, policy: OutboundPolicy): string | null {
  const groups = ipv6Groups(ip);
  if (!groups) return null; // not a plain literal — the DNS path will check it
  const isZero = groups.every((g) => g === 0);
  if (isZero) return 'unspecified address';
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return policy.allowLoopback ? null : 'loopback address';
  }
  // the v4 rules cover ::ffff:127.0.0.1 and ::127.0.0.1 as well
  const embedded = embeddedIpv4(groups);
  if (embedded) {
    const reason = ipv4IsBlocked(embedded, policy);
    if (reason) return reason;
    return null;
  }
  // link-local fe80::/10
  if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local address';
  // unique local fc00::/7
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return policy.allowPrivateNetwork ? null : 'unique local address';
  }
  // 6to4 (2002::/16) carries an IPv4 in groups 1-2
  if (groups[0] === 0x2002) {
    const v4 = [(groups[1] >> 8) & 0xff, groups[1] & 0xff, (groups[2] >> 8) & 0xff, groups[2] & 0xff].join('.');
    const reason = ipv4IsBlocked(v4, policy);
    if (reason) return `${reason} (via 6to4)`;
  }
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

  // H13: `net.isIP(hostname) !== 0` is true for EVERY IP literal, so this read
  // as "any IP host is loopback". With `allowLoopback` (the Ollama / LM Studio
  // policy) that also disabled the https requirement for arbitrary PUBLIC
  // addresses — `http://203.0.113.9` was accepted as a "loopback" endpoint.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isLoopbackHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    isLoopbackAddress(host);

  const requireHttps = policy.requireHttps !== false;
  if (requireHttps && url.protocol !== 'https:' && !(policy.allowLoopback && isLoopbackHost)) {
    throw new OutboundUrlError('Only https:// base URLs are allowed');
  }

  if (METADATA_HOSTS.has(url.hostname.toLowerCase())) {
    throw new OutboundUrlError('Cloud metadata endpoints are blocked');
  }

  // Literal IP? (brackets stripped — a v6 URL hostname is `[::1]`)
  if (net.isIP(host) !== 0) {
    const reason = addressBlocked(host, policy);
    if (reason) {
      throw new OutboundUrlError(`Base URL resolves to a ${reason} (${host})`);
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
