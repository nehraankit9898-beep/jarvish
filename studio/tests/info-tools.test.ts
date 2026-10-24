// info-tools.test.ts — weather + news tools.
//
// The network is NEVER touched: every test injects a fake `fetch`, so the
// suite proves the parsing, the SSRF guard and the error paths deterministically.

import { describe, expect, test } from 'bun:test';
import {
  assertSafeUrl,
  describeWeatherCode,
  getNews,
  getWeather,
  parseFeed,
  registerInfoTools,
} from '../src/lib/agentic/info-tools';
import { invokeTool, hasTool } from '../src/lib/agentic/tool-registry';

const GEO_JSON = {
  results: [
    { name: 'Jaipur', country: 'India', latitude: 26.92, longitude: 75.82, timezone: 'Asia/Kolkata' },
  ],
};

const FORECAST_JSON = {
  timezone: 'Asia/Kolkata',
  current: {
    temperature_2m: 31.4,
    apparent_temperature: 34.1,
    relative_humidity_2m: 48,
    precipitation: 0,
    weather_code: 2,
    wind_speed_10m: 9.7,
  },
  daily: {
    time: ['2026-10-24', '2026-10-25', '2026-10-26'],
    weather_code: [2, 61, 0],
    temperature_2m_max: [33.2, 30.1, 32.5],
    temperature_2m_min: [21.5, 20.9, 20.1],
    precipitation_probability_max: [10, 80, 0],
  },
};

function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    const body = routes[key];
    return {
      ok: true,
      status: 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    };
  };
  return { impl, calls };
}

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Top stories</title>
  <item><title><![CDATA[AI summit opens in Delhi]]></title><link>https://example.com/a</link>
    <pubDate>Fri, 24 Oct 2026 06:00:00 GMT</pubDate><source>Example Wire</source></item>
  <item><title>Cricket &amp; rain: match delayed</title><link>https://example.com/b</link>
    <pubDate>Fri, 24 Oct 2026 05:00:00 GMT</pubDate></item>
</channel></rss>`;

describe('weather', () => {
  test('a place is geocoded and the forecast is normalised', async () => {
    const { impl, calls } = fakeFetch({ 'geocoding-api': GEO_JSON, 'api.open-meteo': FORECAST_JSON });
    const weather = await getWeather('Jaipur', { fetchImpl: impl });
    expect(weather.place).toBe('Jaipur');
    expect(weather.country).toBe('India');
    expect(weather.current.temperature).toBe(31.4);
    expect(weather.current.condition).toBe('partly cloudy');
    expect(weather.daily).toHaveLength(3);
    expect(weather.daily[1].rainChance).toBe(80);
    expect(calls).toHaveLength(2);
    // the coordinates really reach the forecast call
    expect(calls[1]).toContain('latitude=26.92');
  });

  test('an unknown place is reported, not crashed', async () => {
    const { impl } = fakeFetch({ 'geocoding-api': { results: [] } });
    await expect(getWeather('Nowhereville123', { fetchImpl: impl })).rejects.toThrow(/could not find/i);
  });

  test('an upstream failure surfaces as an error', async () => {
    const impl = async () => ({ ok: false, status: 503, text: async () => '', json: async () => ({}) });
    await expect(getWeather('Jaipur', { fetchImpl: impl })).rejects.toThrow(/503/);
  });

  test('weather codes are described', () => {
    expect(describeWeatherCode(0)).toBe('clear sky');
    expect(describeWeatherCode(95)).toBe('thunderstorm');
    expect(describeWeatherCode(1234)).toContain('1234');
  });
});

describe('news', () => {
  test('RSS items are parsed, CDATA and entities decoded', () => {
    const items = parseFeed(RSS, { limit: 5 });
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('AI summit opens in Delhi');
    expect(items[0].source).toBe('Example Wire');
    expect(items[0].link).toBe('https://example.com/a');
    expect(items[1].title).toBe('Cricket & rain: match delayed');
  });

  test('the limit is honoured', () => {
    expect(parseFeed(RSS, { limit: 1 })).toHaveLength(1);
  });

  test('Atom entries are parsed too', () => {
    const atom = `<feed><entry><title>Atom story</title><link href="https://example.com/c"/>
      <updated>2026-10-24T06:00:00Z</updated></entry></feed>`;
    const items = parseFeed(atom);
    expect(items[0].title).toBe('Atom story');
    expect(items[0].link).toBe('https://example.com/c');
  });

  test('headlines come back for a topic query', async () => {
    const { impl, calls } = fakeFetch({ 'news.google.com': RSS });
    const news = await getNews('artificial intelligence', { fetchImpl: impl, limit: 2 });
    expect(news.items).toHaveLength(2);
    expect(calls[0]).toContain('news.google.com');
  });
});

describe('SSRF guard', () => {
  test('non-https is refused', () => {
    expect(() => assertSafeUrl('http://api.open-meteo.com/x', new Set(['api.open-meteo.com']))).toThrow(/https/);
  });
  test('an unknown host is refused', () => {
    expect(() => assertSafeUrl('https://evil.example.com/x', new Set(['api.open-meteo.com']))).toThrow(/not allowed/);
  });
  test('localhost and private ranges are refused', () => {
    const hosts = new Set(['localhost', '127.0.0.1', '192.168.1.5', '10.0.0.2']);
    for (const host of ['localhost', '127.0.0.1', '192.168.1.5', '10.0.0.2']) {
      expect(() => assertSafeUrl(`https://${host}/x`, hosts)).toThrow(/Private/);
    }
  });
});

describe('tool registration', () => {
  test('weather-now and news-headlines are registered as safe tools', async () => {
    registerInfoTools();
    expect(hasTool('weather-now')).toBe(true);
    expect(hasTool('news-headlines')).toBe(true);
    const res = await invokeTool({ tool: 'weather-now', parameters: {}, taskId: 'test-info-task' });
    // an empty place name must fail cleanly (no network call)
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/place name/i);
  });
});
