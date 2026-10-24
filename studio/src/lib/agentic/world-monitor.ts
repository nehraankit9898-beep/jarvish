// world-monitor.ts — the "World Monitor": what is happening on the planet right
// now, on a globe, with live headlines next to it.
//
// SOURCES (both keyless)
//   * GDELT 2.0 GEO API   → geocoded news events (lat/lon + mention counts)
//   * public RSS          → headlines (same parser as news-headlines)
//
// HONESTY RULES
//   * Nothing here is invented. If a source is unreachable the payload says
//     `degraded: true` and lists which source failed — the UI shows a banner
//     instead of an empty globe pretending everything is calm.
//   * Counts are GDELT mention counts, not casualty figures; the UI labels them
//     as "mentions".
//
// SAFETY
//   * HTTPS only, explicit host allowlist, private/IP-literal hosts refused
//     (same rule as info-tools), bounded result size, 5-minute cache so a
//     room full of screens cannot hammer the upstream API.

import { parseFeed, type NewsItem } from './info-tools';

export type HotspotCategory =
  | 'conflict'
  | 'protest'
  | 'disaster'
  | 'climate'
  | 'economy'
  | 'health'
  | 'cyber'
  | 'politics'
  | 'other';

export interface Hotspot {
  id: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  /** GDELT mention count for the cluster */
  mentions: number;
  category: HotspotCategory;
  severity: 'high' | 'medium' | 'low';
  sampleHeadline: string;
}

export interface WorldSnapshot {
  hotspots: Hotspot[];
  headlines: NewsItem[];
  /** which upstream produced what */
  sources: { hotspots: string; headlines: string };
  /** true when at least one source failed */
  degraded: boolean;
  errors: string[];
  generatedAt: string;
  cached: boolean;
}

export type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

const GDELT_HOST = 'api.gdeltproject.org';
const ALLOWED_HOSTS = new Set([GDELT_HOST, 'news.google.com', 'feeds.bbci.co.uk']);
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_HOTSPOTS = 60;
const MAX_HEADLINES = 24;

/** Category → the GDELT query fragment + how severe a cluster of N mentions is. */
export const CATEGORY_QUERIES: Record<Exclude<HotspotCategory, 'other'>, string> = {
  conflict: '(war OR airstrike OR missile OR offensive OR troops)',
  protest: '(protest OR demonstration OR strike OR riot)',
  disaster: '(earthquake OR flood OR wildfire OR hurricane OR cyclone OR landslide)',
  climate: '(heatwave OR drought OR emissions OR climate)',
  economy: '(inflation OR recession OR currency OR sanctions OR market)',
  health: '(outbreak OR epidemic OR virus OR hospital OR disease)',
  cyber: '(cyberattack OR ransomware OR data breach OR outage)',
  politics: '(election OR parliament OR coup OR summit OR protest vote)',
};

/** Which category a GDELT event's text most likely belongs to (first match wins, conflict first). */
const CATEGORY_ORDER: Exclude<HotspotCategory, 'other'>[] = [
  'conflict',
  'disaster',
  'protest',
  'cyber',
  'health',
  'climate',
  'economy',
  'politics',
];

/** word-boundary matchers — "ransomware" must NOT count as "war" */
const CATEGORY_MATCHERS: Record<Exclude<HotspotCategory, 'other'>, RegExp> = Object.fromEntries(
  CATEGORY_ORDER.map((category) => {
    const words = CATEGORY_QUERIES[category]
      .replace(/[()]/g, '')
      .split(' OR ')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    return [category, new RegExp(`\\b(?:${words.join('|')})\\b`, 'i')];
  })
) as Record<Exclude<HotspotCategory, 'other'>, RegExp>;

export function classifyHotspot(text: string): HotspotCategory {
  const t = String(text ?? '');
  for (const category of CATEGORY_ORDER) {
    if (CATEGORY_MATCHERS[category].test(t)) return category;
  }
  return 'other';
}

/** Deterministic severity from the mention count (documented for the UI tooltip). */
export function severityFor(mentions: number): Hotspot['severity'] {
  if (mentions >= 40) return 'high';
  if (mentions >= 12) return 'medium';
  return 'low';
}

export function assertSafeWorldUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'https:') throw new Error('Only https:// URLs are allowed');
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`Host not allowed: ${host}`);
  if (
    host === 'localhost' ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.endsWith('.local') ||
    host === '::1'
  ) {
    throw new Error('Private / literal-IP hosts are not allowed');
  }
  return url;
}

const GDELT_URL =
  'https://api.gdeltproject.org/api/v2/geo/geo' +
  `?query=${encodeURIComponent('(conflict OR protest OR earthquake OR flood OR outbreak OR cyberattack OR election OR inflation)')}` +
  '&format=geojson&timespan=1d';

const HEADLINES_URL = 'https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en';

interface GeoJsonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown>;
}

/**
 * Convert the GDELT GeoJSON payload into hotspots.
 * Pure — the tests feed it a captured shape.
 */
export function parseGdeltGeo(payload: unknown, limit = MAX_HOTSPOTS): Hotspot[] {
  const features = (payload as { features?: GeoJsonFeature[] })?.features;
  if (!Array.isArray(features)) return [];
  const byKey = new Map<string, Hotspot>();

  features.slice(0, 500).forEach((feature, index) => {
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return;
    const [lon, lat] = coords.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;

    const props = feature.properties ?? {};
    const name = String(props.name ?? props.fullname ?? props.html ?? 'Unknown location').slice(0, 80);
    const country = String(props.countrycode ?? props.country ?? '').slice(0, 40);
    const mentions = Math.max(1, Number(props.count ?? props.numarticles ?? 1) || 1);
    const text = [name, props.shareimage, props.html, props.url].filter(Boolean).join(' ');
    const category = classifyHotspot(text);

    const key = `${name}|${country}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.mentions += mentions;
      existing.severity = severityFor(existing.mentions);
      return;
    }
    byKey.set(key, {
      id: `h${index}-${Math.abs(hashString(key)).toString(36)}`,
      name,
      country,
      lat,
      lon,
      mentions,
      category,
      severity: severityFor(mentions),
      sampleHeadline: String(props.url ?? props.html ?? '').slice(0, 200),
    });
  });

  return Array.from(byKey.values())
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, Math.min(Math.max(1, limit), MAX_HOTSPOTS));
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

interface CacheEntry {
  at: number;
  value: WorldSnapshot;
}

let cache: CacheEntry | null = null;

/** Clear the cache (tests / the refresh button). */
export function clearWorldCache(): void {
  cache = null;
}

async function fetchText(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<string> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      signal: controller?.signal,
      headers: { accept: '*/*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One world snapshot: geocoded hotspots + headlines.
 * Never throws — a dead upstream becomes `degraded: true` with the reason.
 */
export async function getWorldSnapshot(
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; force?: boolean; now?: number } = {}
): Promise<WorldSnapshot> {
  const now = opts.now ?? Date.now();
  if (!opts.force && cache && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.value, cached: true };
  }

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available');
  const timeoutMs = Math.min(Math.max(1_000, opts.timeoutMs ?? 9_000), 30_000);
  const errors: string[] = [];

  let hotspots: Hotspot[] = [];
  let headlines: NewsItem[] = [];
  const sources = { hotspots: GDELT_HOST, headlines: 'news.google.com' };

  try {
    const url = assertSafeWorldUrl(GDELT_URL);
    const body = await fetchText(fetchImpl, url.toString(), timeoutMs);
    hotspots = parseGdeltGeo(JSON.parse(body));
    if (!hotspots.length) errors.push('GDELT returned no geocoded events for the last 24 h');
  } catch (err) {
    errors.push(`Hotspots unavailable: ${err instanceof Error ? err.message : 'unknown error'}`);
  }

  try {
    const url = assertSafeWorldUrl(process.env.AGENTSCOPE_WORLD_HEADLINES || HEADLINES_URL);
    const xml = await fetchText(fetchImpl, url.toString(), timeoutMs);
    headlines = parseFeed(xml, { limit: MAX_HEADLINES });
    if (!headlines.length) errors.push('The headline feed returned no items');
  } catch (err) {
    errors.push(`Headlines unavailable: ${err instanceof Error ? err.message : 'unknown error'}`);
  }

  const snapshot: WorldSnapshot = {
    hotspots,
    headlines,
    sources,
    degraded: errors.length > 0,
    errors,
    generatedAt: new Date(now).toISOString(),
    cached: false,
  };

  // only cache a usable snapshot; an outage must be retried on the next open
  if (!snapshot.degraded) cache = { at: now, value: snapshot };
  return snapshot;
}

/** Group hotspots for the side panel. */
export function hotspotCounts(hotspots: Hotspot[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const hotspot of hotspots) out[hotspot.category] = (out[hotspot.category] ?? 0) + 1;
  return out;
}
