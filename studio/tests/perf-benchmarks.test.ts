// perf-benchmarks.test.ts — reproducible latency numbers (Rule 8).
//
// These are MEASUREMENTS, not assertions on absolute speed: a sandbox CPU is
// not the user's i3, so absolute thresholds would be meaningless. Each
// benchmark prints a median/p95 line (see the test output) and only asserts
// completion + correctness. Re-run on any machine with:
//     bun test tests/perf-benchmarks.test.ts
// Compare runs before/after a change with the SAME command on the SAME box.
//
// DB-free.
import { describe, expect, test } from 'bun:test';
import { detectIntent } from '../src/lib/agentic/jarvis';
import { classifyRouterError } from '../src/lib/agentic/model-router';
import {
  capHistoryContext,
  parseApiError,
} from '../src/lib/llm-core';
import {
  perfClear,
  perfLine,
  perfSample,
  perfSamples,
  perfStats,
} from '../src/lib/perf';
import {
  splitStreamSentences,
  speechFriendly,
} from '../src/hooks/use-speech';

function bench(label: string, iterations: number, fn: (i: number) => void): void {
  // warmup (JIT, caches) — never measured
  for (let i = 0; i < Math.min(50, iterations); i++) fn(i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  const s = perfStats(samples)!;
  const r = (n: number) => (n >= 10 ? n.toFixed(1) : n.toFixed(3));
  console.log(
    `  [bench] ${label}: n=${s.count} median=${r(s.median)}ms p95=${r(s.p95)}ms max=${r(s.max)}ms`
  );
}

describe('benchmarks — pure hot-path functions (numbers printed, not asserted)', () => {
  test('intent routing (local, no LLM call)', () => {
    const prompts = [
      'chrome khol do',
      'aaj mausam kaisa hai?',
      'mere downloads saaf kar do',
      'ek kahani sunao',
      'jarvis screen dekh kar click karo',
    ];
    bench('jarvis.detectIntent', 2000, (i) => {
      detectIntent(prompts[i % prompts.length]);
    });
    expect(detectIntent('chrome khol do').intent).toBe('action');
  });

  test('error classification (router hot path)', () => {
    const errs = [
      'API error 429 [retry-after=20s]: slow down',
      'API error 500: boom',
      'fetch failed: ECONNREFUSED',
      'API error 401: bad key',
    ];
    bench('router.classifyRouterError', 2000, (i) => {
      classifyRouterError(new Error(errs[i % errs.length]));
    });
    expect(classifyRouterError(new Error('API error 429: x')).kind).toBe('rate_limit');
  });

  test('chat error parsing (429 mapping)', () => {
    bench('chat.parseApiError', 2000, (i) => {
      parseApiError(i % 2 ? 'API error 429 [retry-after=2s]: x' : 'API error 500: y');
    });
    expect(parseApiError('API error 429 [retry-after=2s]: x').status).toBe(429);
  });

  test('history capping (40-message conversation)', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'assistant' | 'user',
      content: `message ${i} `.repeat(50),
    }));
    bench('chat.capHistoryContext', 500, () => {
      capHistoryContext(history, { maxMessages: 40, maxChars: 24000 });
    });
    expect(capHistoryContext(history).length).toBeGreaterThan(0);
  });

  test('TTS text cleaning (1200-char reply)', () => {
    const reply = 'Hello **world**! Yeh ek [link](https://x.y) hai. '.repeat(25);
    bench('tts.speechFriendly', 500, () => {
      speechFriendly(reply);
    });
    expect(speechFriendly(reply).length).toBeGreaterThan(0);
  });

  test('sentence splitting (streaming chunk)', () => {
    const chunk =
      'Pehla sentence yahan hai. Dusra bhi aa gaya! Teesra sawal hai? Chautha। Paanchva chal raha ';
    bench('tts.splitStreamSentences', 1000, () => {
      splitStreamSentences(chunk);
    });
    expect(splitStreamSentences(chunk).complete.length).toBeGreaterThanOrEqual(4);
  });

  test('perf collector overhead (1000 samples)', () => {
    perfClear();
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      perfSample('bench', i % 100);
    }
    const total = performance.now() - t0;
    console.log(`  [bench] perf.record x1000: total=${total.toFixed(2)}ms`);
    expect(perfSamples('bench').length).toBeGreaterThan(0);
    console.log(`  [bench] ${perfLine('bench')}`);
    perfClear();
  });
});
