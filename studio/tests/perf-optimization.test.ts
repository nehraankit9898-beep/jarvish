// Perf-optimization regression tests (Phase 2: API pipeline + diagnostics).
// DB-free — run: bun test tests/perf-optimization.test.ts
import { describe, expect, test } from 'bun:test';
import {
  apiErrorMessage,
  capHistoryContext,
  parseApiError,
} from '../src/lib/llm-core';
import {
  perfClear,
  perfDropped,
  perfLine,
  perfSample,
  perfSamples,
  perfStart,
  perfStats,
  perfSummary,
  setPerfClock,
  PERF_BUFFER_SIZE,
} from '../src/lib/perf';

describe('parseApiError — upstream failures keep their meaning', () => {
  test('a 429 keeps its status and Retry-After', () => {
    const p = parseApiError(
      new Error('API error 429 [retry-after=20s]: rate limited')
    );
    expect(p.status).toBe(429);
    expect(p.retryAfterSec).toBe(20);
  });

  test('round-trips with apiErrorMessage (fractional retry-after)', () => {
    const fake = {
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '2.5' }),
    } as Response;
    const msg = apiErrorMessage(fake, 'slow down');
    expect(msg).toContain('API error 429');
    const p = parseApiError(msg);
    expect(p.status).toBe(429);
    expect(p.retryAfterSec).toBe(2.5);
  });

  test('non-429 statuses parse without a retry hint', () => {
    expect(parseApiError('API error 500: boom')).toEqual({
      status: 500,
      retryAfterSec: null,
    });
    expect(parseApiError('API error 401: bad key').status).toBe(401);
  });

  test('unparseable messages yield nulls (never throw)', () => {
    expect(parseApiError('fetch failed')).toEqual({ status: null, retryAfterSec: null });
    expect(parseApiError(null)).toEqual({ status: null, retryAfterSec: null });
    expect(parseApiError(undefined)).toEqual({ status: null, retryAfterSec: null });
  });
});

describe('capHistoryContext — history bounded by count AND characters', () => {
  const msg = (content: string) => ({ role: 'user' as const, content });

  test('short histories pass through untouched', () => {
    const h = [msg('hi'), msg('hello there'), msg('how are you?')];
    const out = capHistoryContext(h, { maxMessages: 40, maxChars: 24000 });
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.content)).toEqual(['hi', 'hello there', 'how are you?']);
  });

  test('old messages are dropped first when over budget', () => {
    const h = [msg('a'.repeat(100)), msg('b'.repeat(100)), msg('CURRENT QUESTION')];
    const out = capHistoryContext(h, { maxMessages: 40, maxChars: 120 });
    // newest-first walk: question (16) + 100-char message fit, oldest dropped
    expect(out.map((m) => m.content)).toEqual(['b'.repeat(100), 'CURRENT QUESTION']);
  });

  test('the newest message ALWAYS survives, even over budget alone', () => {
    const h = [msg('old'), msg('x'.repeat(50_000))];
    const out = capHistoryContext(h, { maxMessages: 40, maxChars: 100 });
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('x'.repeat(50_000));
  });

  test('message-count cap still applies', () => {
    const h = Array.from({ length: 50 }, (_, i) => msg(`m${i}`));
    const out = capHistoryContext(h, { maxMessages: 40, maxChars: 24_000 });
    expect(out).toHaveLength(40);
    expect(out[0].content).toBe('m10'); // oldest 10 dropped
    expect(out[39].content).toBe('m49');
  });

  test('order is preserved (oldest → newest)', () => {
    const h = [msg('1'), msg('22'), msg('333')];
    const out = capHistoryContext(h, { maxMessages: 2, maxChars: 24_000 });
    expect(out.map((m) => m.content)).toEqual(['22', '333']);
  });
});

describe('perf collector — bounded diagnostics', () => {
  test('records samples and computes median/p95', () => {
    perfClear();
    setPerfClock(() => 1000);
    for (let i = 1; i <= 100; i++) perfSample('x', i);
    const s = perfSummary('x');
    expect(s).not.toBeNull();
    expect(s!.count).toBe(100);
    expect(s!.min).toBe(1);
    expect(s!.max).toBe(100);
    expect(s!.median).toBe(51);
    expect(s!.p95).toBe(96);
    expect(perfLine('x')).toContain('n=100');
    perfClear();
  });

  test('perfStats returns null when empty', () => {
    expect(perfStats([])).toBeNull();
    perfClear();
    expect(perfSummary('nope')).toBeNull();
    expect(perfLine('nope')).toContain('n=0');
  });

  test('stopwatch records elapsed time', () => {
    perfClear();
    let t = 5000;
    setPerfClock(() => t);
    const sw = perfStart('sw');
    expect(sw.elapsed()).toBe(0);
    t += 250;
    expect(sw.elapsed()).toBe(250);
    expect(sw.stop()).toBe(250);
    expect(perfSamples('sw')).toEqual([250]);
    perfClear();
  });

  test('buffer is bounded (oldest overwritten, drops counted)', () => {
    perfClear();
    setPerfClock(() => 0);
    for (let i = 0; i < PERF_BUFFER_SIZE + 50; i++) perfSample('b', i);
    const kept = perfSamples('b');
    expect(kept.length).toBe(PERF_BUFFER_SIZE);
    expect(kept[0]).toBe(50); // oldest 50 gone
    expect(perfDropped()).toBeGreaterThan(0);
    perfClear();
  });

  test('garbage input is ignored, never stored', () => {
    perfClear();
    perfSample('g', NaN);
    perfSample('g', -5);
    perfSample('g', Infinity);
    expect(perfSamples('g')).toEqual([]);
    perfClear();
  });
});
