// voice-stream.test.ts — incremental (sentence-by-sentence) speech.
// The chain must ACTUALLY start before the stream ends (not post-split),
// keep order, bound its queue, dedupe identical synth, and settle on abort.
// DB-free — run: bun test tests/voice-stream.test.ts
import { describe, expect, test } from 'bun:test';
import {
  createSentenceChain,
  isSpeakableSentence,
  MAX_PENDING_SENTENCES,
  splitStreamSentences,
  type SentenceChainDeps,
} from '../src/hooks/use-speech';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function audioResponse(): Response {
  return new Response(new Blob(['fake-mp3'], { type: 'audio/mpeg' }));
}
function jsonErrorResponse(): Response {
  return new Response(JSON.stringify({ error: 'TTS down', fallback: 'browser' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

interface Harness {
  deps: SentenceChainDeps;
  fetchTexts: string[];
  serverPlays: string[];
  browserPlays: string[];
  engines: string[];
  settled: Promise<void>;
  markSettled: () => void;
  firstAudio: number;
  blockPlays: () => { release: () => void };
}

function makeHarness(opts: {
  server?: 'audio' | 'error';
  browser?: boolean;
} = {}): Harness {
  const h = {} as Harness;
  h.fetchTexts = [];
  h.serverPlays = [];
  h.browserPlays = [];
  h.engines = [];
  h.firstAudio = 0;
  let playGate: (() => void) | null = null;
  h.settled = new Promise<void>((resolve) => {
    h.markSettled = resolve;
  });
  h.blockPlays = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prev = playGate;
    playGate = () => {
      prev?.();
      release();
    };
    void gate;
    return { release: () => playGate?.() };
  };
  const gateFor = () => playGate;
  h.deps = {
    fetchImpl: async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
      h.fetchTexts.push(body.text ?? '');
      await tick(1);
      return opts.server === 'error' ? jsonErrorResponse() : audioResponse();
    },
    playServerAudioToEnd: async (blob: Blob) => {
      const g = gateFor();
      if (g) await new Promise<void>((r) => setTimeout(r, 5));
      h.serverPlays.push(await blob.text());
    },
    browserSpeakToEnd: async (text: string) => {
      h.browserPlays.push(text);
    },
    browserSynthAvailable: () => opts.browser !== false,
  };
  return h;
}

describe('splitStreamSentences — stream chunking', () => {
  test('splits on . ! ? followed by space', () => {
    const { complete, rest } = splitStreamSentences('Hello. How are you? Fine!');
    expect(complete).toEqual(['Hello.', 'How are you?']);
    // trailing boundary with no following context is held back
    expect(rest).toBe('Fine!');
  });

  test('Hindi danda (।) is a boundary', () => {
    const { complete, rest } = splitStreamSentences('Namaste। Aap kaise ho। ');
    expect(complete).toEqual(['Namaste।', 'Aap kaise ho।']);
    expect(rest).toBe('');
  });

  test('a dot between digits is not a boundary', () => {
    const { complete, rest } = splitStreamSentences('Version 3.5 is out. Yes ');
    expect(complete).toEqual(['Version 3.5 is out.']);
    expect(rest).toBe('Yes ');
  });

  test('closing quotes/parens stay with their sentence', () => {
    const { complete } = splitStreamSentences('He said "hi." Then left. ');
    expect(complete).toEqual(['He said "hi."', 'Then left.']);
  });

  test('end-of-buffer boundary waits for more context, done() flushes it', () => {
    const first = splitStreamSentences('Hello.');
    expect(first.complete).toEqual([]);
    expect(first.rest).toBe('Hello.');
    const second = splitStreamSentences(first.rest + ' World. ');
    expect(second.complete).toEqual(['Hello.', 'World.']);
  });

  test('long unpunctuated runs split at newlines, then hard-cap', () => {
    const long = 'word '.repeat(30) + '\nnext line here. ';
    const { complete, rest } = splitStreamSentences(long);
    expect(complete.length).toBeGreaterThan(0);
    expect(rest).toBe('');
    for (const s of complete) expect(s.length).toBeLessThanOrEqual(280);
  });

  test('empty input yields nothing', () => {
    expect(splitStreamSentences('')).toEqual({ complete: [], rest: '' });
  });
});

describe('isSpeakableSentence — code/table filtering', () => {
  test('normal sentences pass', () => {
    expect(isSpeakableSentence('Hello there.', 'Hello there.')).toBe(true);
  });
  test('empty cleaned text is skipped', () => {
    expect(isSpeakableSentence('   ', '')).toBe(false);
  });
  test('fence lines are skipped', () => {
    expect(isSpeakableSentence('```python', '(code block) python')).toBe(false);
  });
  test('table rows are skipped', () => {
    expect(isSpeakableSentence('| a | b |', '| a | b |')).toBe(false);
  });
});

describe('createSentenceChain — incremental playback', () => {
  test('speaks sentences IN ORDER via the server engine', async () => {
    const h = makeHarness();
    const chain = createSentenceChain(() => true, h.deps, {
      onEngine: (e) => h.engines.push(e),
      onSettled: h.markSettled,
    });
    // chunks split mid-word / mid-sentence, like a real stream
    chain.feed('First sent');
    chain.feed('ence. Second one! Thi');
    chain.feed('rd? ');
    chain.done();
    await h.settled;
    expect(h.serverPlays).toHaveLength(3);
    expect(h.browserPlays).toHaveLength(0);
    expect(h.engines).toEqual(['server', 'server', 'server']);
    expect(h.fetchTexts).toHaveLength(3);
  });

  test('playback STARTS before done() — truly incremental, not post-split', async () => {
    const h = makeHarness();
    const chain = createSentenceChain(() => true, h.deps, {
      onEngine: () => undefined,
      onSettled: h.markSettled,
    });
    chain.feed('First sentence is here. And more co');
    await tick(30); // let the async pump + synth run — done() NOT called yet
    expect(h.serverPlays.length).toBeGreaterThanOrEqual(1);
    expect(h.fetchTexts[0]).toBe('First sentence is here.');
    chain.feed('ming later. ');
    chain.done();
    await h.settled;
    expect(h.serverPlays).toHaveLength(2);
  });

  test('identical repeats share ONE synth request (same bytes, two plays)', async () => {
    const h = makeHarness();
    const chain = createSentenceChain(() => true, h.deps, {
      onEngine: () => undefined,
      onSettled: h.markSettled,
    });
    chain.feed('Haan. Haan. ');
    chain.done();
    await h.settled;
    expect(h.serverPlays).toHaveLength(2);
    expect(h.fetchTexts).toEqual(['Haan.']);
  });

  test('server failure falls back to the browser voice per sentence', async () => {
    const h = makeHarness({ server: 'error' });
    const chain = createSentenceChain(() => true, h.deps, {
      onEngine: (e) => h.engines.push(e),
      onSettled: h.markSettled,
    });
    chain.feed('Uno. Dos. ');
    chain.done();
    await h.settled;
    expect(h.serverPlays).toHaveLength(0);
    expect(h.browserPlays).toEqual(['Uno.', 'Dos.']);
    expect(h.engines).toEqual(['browser', 'browser']);
  });

  test('no engine at all still settles (silent skip, chain continues)', async () => {
    const h = makeHarness({ server: 'error', browser: false });
    const chain = createSentenceChain(() => true, h.deps, {
      onEngine: () => undefined,
      onSettled: h.markSettled,
    });
    chain.feed('Hello. World. ');
    chain.done();
    await h.settled;
    expect(h.serverPlays).toHaveLength(0);
    expect(h.browserPlays).toHaveLength(0);
  });

  test('queue is bounded — overflow merges into the tail, onSettled fires once', async () => {
    const h = makeHarness();
    // block playback so the whole feed piles up in the queue
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const origPlay = h.deps.playServerAudioToEnd;
    h.deps.playServerAudioToEnd = async (b, c) => {
      await gate;
      return origPlay(b, c);
    };
    let settledCount = 0;
    const chain = createSentenceChain(() => true, h.deps, {
      onEngine: () => undefined,
      onSettled: () => {
        settledCount++;
        h.markSettled();
      },
    });
    const words = Array.from({ length: MAX_PENDING_SENTENCES + 4 }, (_, i) => `S${i}.`).join(' ') + ' ';
    chain.feed(words);
    chain.done();
    release();
    await h.settled;
    // 6 slots max: first sentences + merged tail (all words still spoken)
    expect(h.serverPlays.length).toBeLessThanOrEqual(MAX_PENDING_SENTENCES);
    expect(h.serverPlays.length).toBeGreaterThan(0);
    expect(settledCount).toBe(1);
  });

  test('abort() drops everything and settles exactly once', async () => {
    const h = makeHarness();
    let settledCount = 0;
    const chain = createSentenceChain(() => true, h.deps, {
      onEngine: () => undefined,
      onSettled: () => {
        settledCount++;
        h.markSettled();
      },
    });
    chain.feed('One. Two. Three. ');
    chain.abort();
    chain.abort(); // second abort is a no-op
    chain.feed('Late arrival. '); // ignored after abort
    await h.settled;
    await tick(20);
    expect(settledCount).toBe(1);
    // at most the already-playing sentence finished; nothing new started
    expect(h.serverPlays.length).toBeLessThanOrEqual(1);
  });

  test('done() flushes a held-back tail fragment', async () => {
    const h = makeHarness();
    const chain = createSentenceChain(() => true, h.deps, {
      onEngine: () => undefined,
      onSettled: h.markSettled,
    });
    chain.feed('Trailing fragment without punctuation');
    await tick(20);
    expect(h.serverPlays).toHaveLength(0); // held back, correctly
    chain.done();
    await h.settled;
    expect(h.serverPlays).toHaveLength(1);
  });

  test('onFirstAudio fires exactly once per session', async () => {
    const h = makeHarness();
    const chain = createSentenceChain(() => true, h.deps, {
      onEngine: () => undefined,
      onSettled: h.markSettled,
      onFirstAudio: () => {
        h.firstAudio++;
      },
    });
    chain.feed('A. B. C. ');
    chain.done();
    await h.settled;
    expect(h.firstAudio).toBe(1);
  });

  test('prefetch overlaps synth(n+1) with play(n) — pipelined, not sequential', async () => {
    // 3 sentences, 40 ms synth + 10 ms play each. Fully sequential would
    // need >= 150 ms of mock delays alone; pipelined needs ~100 ms. The
    // bound (140 ms) leaves generous headroom for slow CI machines while
    // still failing a non-pipelined implementation.
    const h = makeHarness();
    const synthMs = 40;
    const playMs = 10;
    h.deps.fetchImpl = async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
      h.fetchTexts.push(body.text ?? '');
      await new Promise((r) => setTimeout(r, synthMs));
      return audioResponse();
    };
    h.deps.playServerAudioToEnd = async (blob: Blob) => {
      await new Promise((r) => setTimeout(r, playMs));
      h.serverPlays.push(await blob.text());
    };
    let firstAudioAt = -1;
    const startedAt = Date.now();
    const chain = createSentenceChain(() => true, h.deps, {
      onEngine: () => undefined,
      onSettled: h.markSettled,
      onFirstAudio: () => {
        firstAudioAt = Date.now() - startedAt;
      },
    });
    chain.feed('Sentence one here. Sentence two here. Sentence three here. ');
    chain.done();
    await h.settled;
    const total = Date.now() - startedAt;
    expect(h.serverPlays).toHaveLength(3);
    expect(firstAudioAt).toBeGreaterThanOrEqual(0);
    expect(firstAudioAt).toBeLessThan(80);
    expect(total).toBeLessThan(140);
  });

  test('a stale session never plays after its guard flips', async () => {
    const h = makeHarness();
    let current = true;
    const chain = createSentenceChain(() => current, h.deps, {
      onEngine: () => undefined,
      onSettled: h.markSettled,
    });
    chain.feed('One. Two. ');
    current = false; // superseded by stop()/new speak()
    chain.done();
    await h.settled;
    await tick(20);
    // synth responses arriving late must not start playback
    expect(h.serverPlays).toHaveLength(0);
  });
});
