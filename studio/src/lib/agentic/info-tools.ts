// info-tools.ts — live information the Studio could not answer before:
// weather and news. Both are KEYLESS (Open-Meteo needs no API key, news comes
// from public RSS), so they work on a fresh install with zero configuration.
//
// SAFETY
//   * Only HTTPS is allowed.
//   * The URL must be on an explicit host allowlist (Open-Meteo + the news
//     feeds) — the query string is user/AI controlled, the HOST never is.
//   * localhost / private / link-local addresses are refused even if someone
//     puts them on the allowlist (no SSRF into the local network).
//   * The fetch implementation is injectable, so the tests never hit the
//     network and the tools degrade to a clear error when offline.

import type { ToolResult } from './tool-registry';
import { registerTool } from './tool-registry';

export type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

const WEATHER_HOSTS = new Set(['api.open-meteo.com', 'geocoding-api.open-meteo.com']);
const DEFAULT_NEWS_FEEDS = [
  'https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en',
];

function allowedNewsHosts(): Set<string> {
  const hosts = new Set(['news.google.com', 'feeds.bbci.co.uk']);
  for (const feed of (process.env.AGENTSCOPE_NEWS_FEEDS ?? '').split(',')) {
    const trimmed = feed.trim();
    if (!trimmed) continue;
    try {
      hosts.add(new URL(trimmed).hostname.toLowerCase());
    } catch {
      /* ignore a malformed feed url */
    }
  }
  return hosts;
}

/** Refuse anything that is not a public HTTPS endpoint. */
export function assertSafeUrl(raw: string, allowedHosts: Set<string>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'https:') throw new Error('Only https:// URLs are allowed');
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) throw new Error(`Host not allowed: ${host}`);
  if (
    host === 'localhost' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local') ||
    host === '::1' ||
    host === '[::1]'
  ) {
    throw new Error('Private / local addresses are not allowed');
  }
  return url;
}

const WMO_CODES: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'moderate drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'dense freezing drizzle',
  61: 'slight rain',
  63: 'moderate rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'heavy freezing rain',
  71: 'slight snowfall',
  73: 'moderate snowfall',
  75: 'heavy snowfall',
  77: 'snow grains',
  80: 'slight rain showers',
  81: 'moderate rain showers',
  82: 'violent rain showers',
  85: 'slight snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with slight hail',
  99: 'thunderstorm with heavy hail',
};

export function describeWeatherCode(code: number): string {
  return WMO_CODES[code] ?? `weather code ${code}`;
}

export interface WeatherNow {
  place: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
  current: {
    temperature: number;
    feelsLike: number;
    humidity: number;
    windSpeed: number;
    precipitation: number;
    condition: string;
  };
  daily: { date: string; min: number; max: number; rainChance: number; condition: string }[];
  fetchedAt: string;
}

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<any> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      signal: controller?.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Upstream returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Current weather + a 3-day outlook for a place name.
 * @example getWeather('Jaipur')  → real numbers from Open-Meteo
 */
export async function getWeather(
  place: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; days?: number } = {}
): Promise<WeatherNow> {
  const query = String(place ?? '').trim();
  if (!query) throw new Error('A place name is required (e.g. "Jaipur")');
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof doFetch !== 'function') throw new Error('No fetch implementation available');
  const timeoutMs = Math.min(Math.max(1_000, opts.timeoutMs ?? 10_000), 30_000);
  const days = Math.min(Math.max(1, Math.floor(opts.days ?? 3)), 7);

  const geoUrl = assertSafeUrl(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`,
    WEATHER_HOSTS
  );
  const geo = await getJson(doFetch, geoUrl.toString(), timeoutMs);
  const hit = Array.isArray(geo?.results) ? geo.results[0] : null;
  if (!hit) throw new Error(`I could not find a place called "${query}"`);

  const forecastUrl = assertSafeUrl(
    'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${hit.latitude}&longitude=${hit.longitude}` +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      `&timezone=auto&forecast_days=${days}`,
    WEATHER_HOSTS
  );
  const data = await getJson(doFetch, forecastUrl.toString(), timeoutMs);
  const current = data?.current ?? {};
  const daily = data?.daily ?? {};

  return {
    place: String(hit.name ?? query),
    country: String(hit.country ?? ''),
    latitude: Number(hit.latitude),
    longitude: Number(hit.longitude),
    timezone: String(data?.timezone ?? hit.timezone ?? ''),
    current: {
      temperature: Number(current.temperature_2m ?? NaN),
      feelsLike: Number(current.apparent_temperature ?? NaN),
      humidity: Number(current.relative_humidity_2m ?? NaN),
      windSpeed: Number(current.wind_speed_10m ?? NaN),
      precipitation: Number(current.precipitation ?? 0),
      condition: describeWeatherCode(Number(current.weather_code ?? -1)),
    },
    daily: (Array.isArray(daily.time) ? daily.time : []).map((date: string, i: number) => ({
      date,
      min: Number(daily.temperature_2m_min?.[i] ?? NaN),
      max: Number(daily.temperature_2m_max?.[i] ?? NaN),
      rainChance: Number(daily.precipitation_probability_max?.[i] ?? 0),
      condition: describeWeatherCode(Number(daily.weather_code?.[i] ?? -1)),
    })),
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// news
// ---------------------------------------------------------------------------

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: string;
}

function stripCdata(text: string): string {
  return text.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** Parse an RSS 2.0 or Atom feed into normalised items. */
export function parseFeed(xml: string, opts: { limit?: number; source?: string } = {}): NewsItem[] {
  const limit = Math.min(Math.max(1, opts.limit ?? 10), 50);
  const items: NewsItem[] = [];

  const itemRe = /<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/g;
  for (const match of xml.match(itemRe) ?? []) {
    const title = stripCdata(/<title[^>]*>([\s\S]*?)<\/title>/.exec(match)?.[1] ?? '');
    let link = stripCdata(/<link[^>]*>([\s\S]*?)<\/link>/.exec(match)?.[1] ?? '');
    if (!link) link = /<link[^>]*href="([^"]+)"/.exec(match)?.[1] ?? '';
    const published =
      stripCdata(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/.exec(match)?.[1] ?? '') ||
      stripCdata(/<updated[^>]*>([\s\S]*?)<\/updated>/.exec(match)?.[1] ?? '') ||
      stripCdata(/<published[^>]*>([\s\S]*?)<\/published>/.exec(match)?.[1] ?? '');
    const sourceTag = stripCdata(/<source[^>]*>([\s\S]*?)<\/source>/.exec(match)?.[1] ?? '');
    if (!title) continue;
    items.push({
      title: decodeEntities(title),
      link: decodeEntities(link),
      source: decodeEntities(sourceTag) || opts.source || 'rss',
      publishedAt: published,
    });
    if (items.length >= limit) break;
  }
  return items;
}

function feedUrlFor(query: string): string {
  const configured = (process.env.AGENTSCOPE_NEWS_FEEDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.length) return configured[0];
  if (!query) return DEFAULT_NEWS_FEEDS[0];
  const hl = process.env.AGENTSCOPE_NEWS_LOCALE ?? 'en-IN';
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${hl.split('-')[1] ?? 'IN'}&ceid=${(hl.split('-')[1] ?? 'IN')}:${hl.split('-')[0] ?? 'en'}`;
}

/** Headlines for a topic (or the configured default feed). */
export async function getNews(
  query = '',
  opts: { fetchImpl?: FetchLike; limit?: number; timeoutMs?: number } = {}
): Promise<{ query: string; feed: string; items: NewsItem[] }> {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof doFetch !== 'function') throw new Error('No fetch implementation available');
  const timeoutMs = Math.min(Math.max(1_000, opts.timeoutMs ?? 10_000), 30_000);
  const feed = feedUrlFor(String(query ?? '').trim());
  const url = assertSafeUrl(feed, allowedNewsHosts());

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(url.toString(), {
      signal: controller?.signal,
      headers: { accept: 'application/rss+xml, application/xml, text/xml' },
    });
    if (!res.ok) throw new Error(`Upstream returned HTTP ${res.status}`);
    const xml = await res.text();
    return { query: String(query ?? ''), feed: url.toString(), items: parseFeed(xml, { limit: opts.limit ?? 10 }) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

let registered = false;

function ok(data: unknown): ToolResult {
  return { ok: true, data, permission: 'safe', at: new Date().toISOString() };
}

function fail(error: string): ToolResult {
  return { ok: false, error, permission: 'safe', at: new Date().toISOString() };
}

/** Register the weather/news tools once (idempotent). */
export function registerInfoTools(): void {
  if (registered) return;
  registered = true;

  registerTool(
    {
      name: 'weather-now',
      description:
        'Current weather and a short outlook for any place (keyless, Open-Meteo). ' +
        'Answers "aaj mausam kaisa hai", "weather in Jaipur", "kal barish hogi?".',
      category: 'adapter',
      parameters: {
        place: { type: 'string', description: 'City or place name, e.g. "Jaipur"', required: true },
        days: { type: 'number', description: 'Outlook length in days (1-7, default 3)', required: false },
      },
      required: ['place'],
      permission: 'safe',
      timeoutMs: 20_000,
    },
    async ({ parameters }) => {
      try {
        return ok(await getWeather(String(parameters.place ?? ''), { days: Number(parameters.days) || undefined }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Weather lookup failed');
      }
    }
  );

  registerTool(
    {
      name: 'news-headlines',
      description:
        'Latest news headlines, optionally for a topic (keyless RSS). ' +
        'Answers "aaj ki khabar", "AI news", "cricket headlines".',
      category: 'adapter',
      parameters: {
        query: { type: 'string', description: 'Topic (empty = top headlines)', required: false },
        limit: { type: 'number', description: 'How many headlines (1-50, default 10)', required: false },
      },
      required: [],
      permission: 'safe',
      timeoutMs: 20_000,
    },
    async ({ parameters }) => {
      try {
        return ok(await getNews(String(parameters.query ?? ''), { limit: Number(parameters.limit) || undefined }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'News lookup failed');
      }
    }
  );
}
