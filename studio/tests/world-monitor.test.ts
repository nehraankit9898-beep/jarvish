// world-monitor.test.ts — the live globe's data layer.
// No network: every test injects its own fetch.
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  assertSafeWorldUrl,
  classifyHotspot,
  clearWorldCache,
  getWorldSnapshot,
  hotspotCounts,
  parseGdeltGeo,
  severityFor,
} from '../src/lib/agentic/world-monitor';

const GEO = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [35.2, 31.8] },
      properties: { name: 'Gaza', countrycode: 'ISR', count: 90, url: 'https://example.com/airstrike' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [77.2, 28.6] },
      properties: { name: 'Delhi', countrycode: 'IND', count: 15, url: 'https://example.com/protest' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.7, 35.7] },
      properties: { name: 'Tokyo', countrycode: 'JPN', count: 3, url: 'https://example.com/earthquake' },
    },
    // duplicate location → merged
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [35.2, 31.8] },
      properties: { name: 'Gaza', countrycode: 'ISR', count: 10, url: 'https://example.com/missile' },
    },
    // garbage that must be skipped
    { type: 'Feature', geometry: { type: 'Point', coordinates: [500, 900] }, properties: { name: 'Nowhere' } },
    { type: 'Feature', properties: { name: 'No geometry' } },
  ],
};

const RSS = `<rss><channel>
  <item><title>Leaders meet for summit</title><link>https://example.com/1</link><pubDate>Fri, 24 Oct 2026 06:00:00 GMT</pubDate></item>
  <item><title>Markets slide on rate fear</title><link>https://example.com/2</link><pubDate>Fri, 24 Oct 2026 05:00:00 GMT</pubDate></item>
</channel></rss>`;

function fakeFetch(opts: { geo?: unknown; rss?: string; fail?: 'geo' | 'rss' | 'both' } = {}) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const isGeo = url.includes('gdeltproject');
    if (opts.fail === 'both' || (opts.fail === 'geo' && isGeo) || (opts.fail === 'rss' && !isGeo)) {
      return { ok: false, status: 503, text: async () => '', json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => (isGeo ? JSON.stringify(opts.geo ?? GEO) : opts.rss ?? RSS),
      json: async () => opts.geo ?? GEO,
    };
  };
  return { impl, calls };
}

beforeEach(() => {
  clearWorldCache();
  delete process.env.AGENTSCOPE_WORLD_HEADLINES;
});

describe('classification', () => {
  test('airstrikes and troops are conflict, protests are protest', () => {
    expect(classifyHotspot('airstrike reported near the border')).toBe('conflict');
    expect(classifyHotspot('thousands join protest in the capital')).toBe('protest');
    expect(classifyHotspot('earthquake of magnitude 6 hits the coast')).toBe('disaster');
    expect(classifyHotspot('ransomware attack on hospitals')).toBe('cyber');
    expect(classifyHotspot('something unremarkable')).toBe('other');
  });

  test('severity thresholds are stable', () => {
    expect(severityFor(5)).toBe('low');
    expect(severityFor(12)).toBe('medium');
    expect(severityFor(40)).toBe('high');
    expect(severityFor(900)).toBe('high');
  });
});

describe('GDELT parsing', () => {
  test('features become hotspots, duplicates merge, garbage is skipped', () => {
    const hotspots = parseGdeltGeo(GEO);
    expect(hotspots).toHaveLength(3);
    const gaza = hotspots.find((h) => h.name === 'Gaza');
    expect(gaza?.mentions).toBe(100);
    expect(gaza?.severity).toBe('high');
    expect(gaza?.category).toBe('conflict');
    expect(hotspots[0].name).toBe('Gaza'); // sorted by mentions
    expect(hotspots.find((h) => h.name === 'Delhi')?.category).toBe('protest');
    expect(hotspots.every((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon))).toBe(true);
  });

  test('the limit is honoured and ids are unique', () => {
    const hotspots = parseGdeltGeo(GEO, 2);
    expect(hotspots).toHaveLength(2);
    expect(new Set(hotspots.map((h) => h.id)).size).toBe(2);
  });

  test('a malformed payload yields no hotspots instead of throwing', () => {
    expect(parseGdeltGeo(null)).toEqual([]);
    expect(parseGdeltGeo({ features: 'nope' })).toEqual([]);
  });
});

describe('SSRF guard', () => {
  test('https + allowlisted host only', () => {
    expect(assertSafeWorldUrl('https://api.gdeltproject.org/api/v2/geo/geo').hostname).toBe('api.gdeltproject.org');
    expect(() => assertSafeWorldUrl('http://api.gdeltproject.org/x')).toThrow(/https/);
    expect(() => assertSafeWorldUrl('https://evil.example.com/x')).toThrow(/not allowed/);
    expect(() => assertSafeWorldUrl('https://127.0.0.1/x')).toThrow(/not allowed|Private/);
  });
});

describe('snapshot', () => {
  test('hotspots and headlines are merged into one payload', async () => {
    const { impl, calls } = fakeFetch();
    const snapshot = await getWorldSnapshot({ fetchImpl: impl });
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.hotspots.length).toBe(3);
    expect(snapshot.headlines.length).toBe(2);
    expect(snapshot.headlines[0].title).toContain('summit');
    expect(calls).toHaveLength(2);
    expect(hotspotCounts(snapshot.hotspots).conflict).toBe(1);
  });

  test('a dead upstream degrades honestly instead of showing a calm world', async () => {
    const { impl } = fakeFetch({ fail: 'geo' });
    const snapshot = await getWorldSnapshot({ fetchImpl: impl });
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.hotspots).toEqual([]);
    expect(snapshot.headlines.length).toBe(2); // headlines still work
    expect(snapshot.errors[0]).toContain('Hotspots unavailable');
  });

  test('both sources down still returns a payload', async () => {
    const { impl } = fakeFetch({ fail: 'both' });
    const snapshot = await getWorldSnapshot({ fetchImpl: impl });
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.errors).toHaveLength(2);
    expect(snapshot.hotspots).toEqual([]);
  });

  test('a good snapshot is cached; force bypasses the cache', async () => {
    const first = fakeFetch();
    const a = await getWorldSnapshot({ fetchImpl: first.impl, now: 1_000 });
    expect(a.cached).toBe(false);
    const second = fakeFetch();
    const b = await getWorldSnapshot({ fetchImpl: second.impl, now: 2_000 });
    expect(b.cached).toBe(true);
    expect(second.calls).toHaveLength(0);
    const c = await getWorldSnapshot({ fetchImpl: second.impl, now: 3_000, force: true });
    expect(c.cached).toBe(false);
    expect(second.calls).toHaveLength(2);
  });

  test('an outage is never cached', async () => {
    const bad = fakeFetch({ fail: 'both' });
    await getWorldSnapshot({ fetchImpl: bad.impl, now: 1_000 });
    const good = fakeFetch();
    const snapshot = await getWorldSnapshot({ fetchImpl: good.impl, now: 1_500 });
    expect(good.calls.length).toBe(2);
    expect(snapshot.degraded).toBe(false);
  });
});
