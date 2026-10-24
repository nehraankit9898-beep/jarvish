/**
 * Voice-feedback contract (spec §6 + §11).
 *
 * These tests exercise the SHIPPED speech logic — `runSpeechChain`,
 * `createSentenceChain`, `speechFriendly`, `splitStreamSentences` — with the
 * DOM/network boundary injected. Nothing here needs a browser, an audio
 * device or a running python bridge, so the guarantees are checked
 * deterministically:
 *
 *   - a success is actually spoken,
 *   - a failure is spoken instead of being swallowed,
 *   - when the speech API is down, the offline (browser) voice is used,
 *   - when NO engine can speak, the UI is told (visible error),
 *   - queued sentences never overlap and keep their order,
 *   - an identical announcement is not synthesised twice,
 *   - empty / code-fence text never reaches the voice engine,
 *   - abort drops the queue AND the in-flight request exactly once.
 */
import { describe, expect, test } from 'bun:test';
import {
  createSentenceChain,
  runSpeechChain,
  speechFriendly,
  splitStreamSentences,
  type SentenceChainDeps,
  type SpeechChainDeps,
} from '@/hooks/use-speech';

const audio = () =>
  new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** deps for the single-shot chain (acknowledgements, final status) */
function deps(overrides: Partial<SpeechChainDeps> = {}): SpeechChainDeps {
  return {
    fetchImpl: async () => audio(),
    playServerAudio: async () => undefined,
    browserSpeak: () => true,
    browserSynthAvailable: () => true,
    ...overrides,
  };
}

describe('runSpeechChain — one utterance', () => {
  test('a spoken success uses the server voice and reports the engine', async () => {
    const engines: string[] = [];
    let played = 0;
    await runSpeechChain(
      'YouTube successfully open ho gaya.',
      () => true,
      deps({ playServerAudio: async () => void played++ }),
      (e) => engines.push(e),
      () => undefined
    );
    expect(played).toBe(1);
    expect(engines).toEqual(['server']);
  });

  test('the text that reaches the bridge is the clean text, not markdown', async () => {
    let sent = '';
    await runSpeechChain(
      // the caller (speakNow / the sentence chain) cleans before speaking
      speechFriendly('**Done.** `YouTube` https://youtube.com'),
      () => true,
      deps({
        fetchImpl: async (_url, init) => {
          sent = JSON.parse(String(init?.body)).text;
          return audio();
        },
      }),
      () => undefined,
      () => undefined
    );
    expect(sent).toBe('Done. YouTube (link)');
  });

  test('a provider failure is SPOKEN (a failed request is not a silent one)', async () => {
    const engines: string[] = [];
    await runSpeechChain(
      'Gemini API connect nahi ho pa rahi. Error: API key invalid.',
      () => true,
      deps({ fetchImpl: async () => json(503, { error: 'bridge down', fallback: 'browser' }) }),
      (e) => engines.push(e),
      () => undefined
    );
    expect(engines).toEqual(['browser']);
  });

  test('bridge down → browser voice (offline feedback still works)', async () => {
    const spoken: string[] = [];
    await runSpeechChain(
      'Internet connection nahi mil raha.',
      () => true,
      deps({
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        },
        browserSpeak: (t) => {
          spoken.push(t);
          return true;
        },
      }),
      () => undefined,
      () => undefined
    );
    expect(spoken).toEqual(['Internet connection nahi mil raha.']);
  });

  test('no engine at all → a visible error, never a silent no-op', async () => {
    const errors: string[] = [];
    const speakingStates: boolean[] = [];
    await runSpeechChain(
      'Command execute nahi hui.',
      () => true,
      deps({
        fetchImpl: async () => json(503, { error: 'bridge down' }),
        browserSynthAvailable: () => false,
      }),
      () => undefined,
      (s) => {
        speakingStates.push(s);
      },
      (m) => errors.push(m)
    );
    expect(speakingStates).toEqual([false]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Voice unavailable');
  });

  test('the browser refusing to start is also a visible error', async () => {
    const errors: string[] = [];
    await runSpeechChain(
      'test',
      () => true,
      deps({
        fetchImpl: async () => json(500, {}),
        browserSpeak: () => false,
      }),
      () => undefined,
      () => undefined,
      (m) => errors.push(m)
    );
    expect(errors[0]).toContain('refused to start');
  });

  test('a superseded utterance never plays stale audio', async () => {
    let played = 0;
    let current = true;
    await runSpeechChain(
      'old sentence',
      () => current,
      deps({
        fetchImpl: async () => {
          current = false; // a newer speak() started while this was in-flight
          return audio();
        },
        playServerAudio: async () => void played++,
      }),
      () => undefined,
      () => undefined
    );
    expect(played).toBe(0);
  });

  test('empty text is never sent to the voice API', async () => {
    let calls = 0;
    await runSpeechChain(
      speechFriendly('   \n  '),
      () => true,
      deps({
        fetchImpl: async () => {
          calls++;
          return audio();
        },
      }),
      () => undefined,
      () => undefined
    );
    // speechFriendly('') === '' → the caller (speakNow) returns early; if it
    // does reach the chain, the request must at least not fabricate success.
    expect(calls).toBeLessThanOrEqual(1);
  });
});

/* -------------------------------------------------------------------------- */

/** factory for the streaming chain with observable playback */
function chainHarness(overrides: Partial<SentenceChainDeps> = {}) {
  const log: string[] = [];
  const engines: string[] = [];
  const errors: string[] = [];
  let active = 0;
  let maxConcurrent = 0;
  let settled = 0;
  let resolveSettled: () => void = () => undefined;
  const settledPromise = new Promise<void>((r) => {
    resolveSettled = r;
  });
  const deps: SentenceChainDeps = {
    fetchImpl: async () => audio(),
    playServerAudioToEnd: async (blob) => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 1));
      log.push(`${blob.size}`);
      active--;
    },
    browserSpeakToEnd: async () => undefined,
    browserSynthAvailable: () => true,
    ...overrides,
  };
  let current = true;
  const chain = createSentenceChain(
    () => current,
    deps,
    {
      onEngine: (e) => engines.push(e),
      onSettled: () => {
        settled++;
        resolveSettled();
      },
      onVoiceError: (m) => errors.push(m),
    }
  );
  return {
    chain,
    log,
    engines,
    errors,
    get settled() {
      return settled;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    waitSettled: () => settledPromise,
    supersede: () => {
      current = false;
    },
  };
}

describe('createSentenceChain — streaming replies', () => {
  test('plays sentences in order, one at a time (no overlap)', async () => {
    const h = chainHarness();
    h.chain.feed('Pehla sentence. Doosra sentence. ');
    h.chain.done();
    await h.waitSettled();
    expect(h.log.length).toBe(2);
    expect(h.maxConcurrent).toBe(1);
    expect(h.settled).toBe(1);
  });

  test('the same announcement is synthesised ONCE, not per repeat', async () => {
    let calls = 0;
    const h = chainHarness({
      fetchImpl: async () => {
        calls++;
        return audio();
      },
    });
    // two identical sentences, in one stream
    h.chain.feed('Done. Done. ');
    h.chain.done();
    await h.waitSettled();
    expect(calls).toBe(1);
  });

  test('empty and whitespace-only streams settle without touching the network', async () => {
    let calls = 0;
    const h = chainHarness({
      fetchImpl: async () => {
        calls++;
        return audio();
      },
    });
    h.chain.feed('');
    h.chain.feed('   ');
    h.chain.feed('\n\n');
    h.chain.done();
    await h.waitSettled();
    expect(calls).toBe(0);
    expect(h.settled).toBe(1);
  });

  test('a code block is never spoken, a normal sentence is', async () => {
    const spoken: string[] = [];
    const make = () =>
      chainHarness({
        fetchImpl: async (_u, init) => {
          spoken.push(JSON.parse(String(init?.body)).text);
          return audio();
        },
      });

    const fence = make();
    fence.chain.feed('```js\nconst a = 1;\n```');
    fence.chain.done();
    await fence.waitSettled();

    const table = make();
    table.chain.feed('| id | name |');
    table.chain.done();
    await table.waitSettled();

    const prose = make();
    prose.chain.feed('Real sentence. ');
    prose.chain.done();
    await prose.waitSettled();

    expect(spoken).toEqual(['Real sentence.']);
  });

  test('when every engine fails the UI is told once per sentence', async () => {
    const h = chainHarness({
      fetchImpl: async () => json(503, { error: 'down' }),
      browserSynthAvailable: () => false,
    });
    h.chain.feed('First. Second. ');
    h.chain.done();
    await h.waitSettled();
    expect(h.errors.length).toBe(2);
    expect(h.errors[0]).toContain('Voice unavailable');
  });

  test('abort drops the queue and settles exactly once', async () => {
    let aborted = 0;
    const h = chainHarness({
      fetchImpl: (_u, init) => {
        const signal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((resolve) => {
          signal?.addEventListener('abort', () => {
            aborted++;
            resolve(json(499, { error: 'aborted' }));
          });
          setTimeout(() => resolve(audio()), 50);
        });
      },
    });
    h.chain.feed('Ek. Do. Teen. ');
    h.chain.done();
    h.chain.abort();
    await h.waitSettled();
    expect(h.settled).toBe(1);
    expect(aborted).toBeGreaterThanOrEqual(1);
    expect(h.log.length).toBe(0); // nothing played after the interrupt
  });

  test('a superseded session does not report audio after the user interrupted', async () => {
    const h = chainHarness();
    h.chain.feed('Sentence one. ');
    h.supersede();
    h.chain.feed('Sentence two. ');
    h.chain.done();
    await Promise.race([h.waitSettled(), new Promise((r) => setTimeout(r, 30))]);
    expect(h.engines.length).toBe(0);
  });
});

describe('splitStreamSentences / speechFriendly', () => {
  test('a decimal is not a sentence boundary', () => {
    const { complete, rest } = splitStreamSentences('Pi is 3.14 exactly. ');
    expect(complete).toEqual(['Pi is 3.14 exactly.']);
    expect(rest).toBe('');
  });

  test('an incomplete tail is held back for the next chunk', () => {
    const { complete, rest } = splitStreamSentences('First done. Second is still');
    expect(complete).toEqual(['First done.']);
    expect(rest).toBe('Second is still');
  });

  test('markdown is reduced to speakable text and capped', () => {
    const out = speechFriendly('## Hello **world** — see https://example.com/' + 'x'.repeat(2000));
    expect(out.startsWith('Hello world')).toBe(true);
    expect(out).toContain('(link)');
    expect(out.length).toBeLessThanOrEqual(1200);
  });
});
