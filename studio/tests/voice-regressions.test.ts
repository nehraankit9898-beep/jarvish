// voice-regressions.test.ts — regression tests for the repaired voice system
// (mic recognition accumulation, TTS fallback chain, wake-word dedupe).
//
// The browser-only parts of use-speech.ts (React hooks, Audio, speechSynthesis)
// run with IO injected through the exported pure helpers, so these tests
// exercise the REAL shipped logic, not a copy.

import { describe, expect, test } from 'bun:test';
import {
  accumulateRecognition,
  newRecognitionAccumulator,
  runSpeechChain,
  shouldFireWake,
  speechFriendly,
  type RecognitionAccumulator,
  type SpeechChainDeps,
} from '../src/hooks/use-speech';

function mkResults(
  parts: Array<{ t: string; final: boolean }>
): ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> {
  return parts.map((p) =>
    Object.assign([{ transcript: p.t }], { isFinal: p.final, length: 1 })
  );
}

// ---------------------------------------------------------------------------
// BUG B2 — recognition duplicated every final result on every onresult event
// ("hello world" became "hello hello hello hello world ")
// ---------------------------------------------------------------------------
describe('voice: recognition transcript accumulation (duplicate-command fix)', () => {
  test('final + interim + final yields each phrase exactly once', () => {
    let acc: RecognitionAccumulator = newRecognitionAccumulator();
    // "hello" finalizes, then "world" streams interim, then finalizes
    acc = accumulateRecognition(acc, { results: mkResults([{ t: 'hello', final: true }]) });
    acc = accumulateRecognition(acc, {
      results: mkResults([{ t: 'hello', final: true }, { t: 'wor', final: false }]),
    });
    acc = accumulateRecognition(acc, {
      results: mkResults([{ t: 'hello', final: true }, { t: 'world', final: false }]),
    });
    acc = accumulateRecognition(acc, {
      results: mkResults([{ t: 'hello', final: true }, { t: 'world', final: true }]),
    });
    expect(acc.final).toBe('hello world ');
    expect(acc.interim).toBe('');
  });

  // Some Chrome builds report resultIndex=0 with the FULL result list on every
  // event — the handled-index guard must absorb that too.
  test('repeated full-list events never duplicate finals', () => {
    let acc: RecognitionAccumulator = newRecognitionAccumulator();
    const full = mkResults([
      { t: 'hello', final: true },
      { t: 'world', final: true },
    ]);
    for (let i = 0; i < 5; i++) acc = accumulateRecognition(acc, { results: full });
    expect(acc.final).toBe('hello world ');
  });

  test('several finals arriving in one event are all appended once', () => {
    let acc: RecognitionAccumulator = newRecognitionAccumulator();
    acc = accumulateRecognition(acc, {
      results: mkResults([
        { t: 'ek', final: true },
        { t: 'do', final: true },
        { t: 'teen', final: true },
      ]),
    });
    expect(acc.final).toBe('ek do teen ');
  });

  test('interim text is replaced (not accumulated) between events', () => {
    let acc: RecognitionAccumulator = newRecognitionAccumulator();
    acc = accumulateRecognition(acc, { results: mkResults([{ t: 'na', final: false }]) });
    acc = accumulateRecognition(acc, { results: mkResults([{ t: 'nam', final: false }]) });
    acc = accumulateRecognition(acc, { results: mkResults([{ t: 'namas', final: false }]) });
    expect(acc.interim).toBe('namas');
    expect(acc.final).toBe('');
  });

  test('a fresh session starts with an empty accumulator', () => {
    let acc: RecognitionAccumulator = newRecognitionAccumulator();
    acc = accumulateRecognition(acc, { results: mkResults([{ t: 'old session', final: true }]) });
    acc = newRecognitionAccumulator();
    expect(acc.final).toBe('');
    expect(acc.handled).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BUG B1 — a 503 (bridge down / edge-tts missing) skipped the browser fallback
// AND left `speaking` stuck true forever (LIVE loop deadlock)
// ---------------------------------------------------------------------------
describe('voice: TTS chain fallback (stuck-speaking fix)', () => {
  function jsonRes(status: number) {
    return new Response(JSON.stringify({ error: 'TTS synthesis failed' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function makeDeps(over: Partial<SpeechChainDeps> = {}): SpeechChainDeps & {
    state: { browserUsed: boolean; serverUsed: boolean };
  } {
    const state = { browserUsed: false, serverUsed: false };
    const deps: SpeechChainDeps & { state: typeof state } = {
      state,
      fetchImpl: over.fetchImpl ?? (async () => jsonRes(503)),
      playServerAudio: over.playServerAudio ?? (async () => { state.serverUsed = true; }),
      browserSpeak: over.browserSpeak ?? (() => { state.browserUsed = true; return true; }),
      browserSynthAvailable: over.browserSynthAvailable ?? (() => true),
    };
    return deps;
  }

  test('HTTP 503 from /api/voice/speak falls back to the browser voice (old code: fallback never ran, speaking stuck true)', async () => {
    const deps = makeDeps();
    let speaking = null as boolean | null;
    let engine = null as string | null;
    await runSpeechChain('hello', () => true, deps, (e) => (engine = e), (s) => (speaking = s));
    expect(deps.state.browserUsed).toBe(true); // fallback actually spoke
    expect(deps.state.serverUsed).toBe(false);
    expect(engine).toBe('browser');
    expect(speaking).toBe(null); // no false set here — the browser utterance's onend owns it
  });

  // the full hook flow: setSpeaking(true) → chain → the fallback voice ends
  // the state. This is the exact "stuck speaking" scenario from the bug.
  test('hook flow: 503 → browser voice → utterance end → speaking=false (never stuck)', async () => {
    const deps = makeDeps();
    let speaking = false;
    let engine = null as string | null;
    let endBrowserUtterance = null as (() => void) | null;
    const hookDeps: SpeechChainDeps = {
      ...deps,
      browserSpeak: (t) => {
        deps.state.browserUsed = true;
        // mimic the real wrapper: registers utter.onend → setSpeaking(false)
        endBrowserUtterance = () => {
          if (engine === 'browser') speaking = false;
        };
        return true;
      },
    };
    // useSpeechOutput.speak: enable on, mark speaking, run the chain
    speaking = true;
    await runSpeechChain('hello', () => true, hookDeps, (e) => (engine = e), (s) => (speaking = s));
    expect(deps.state.browserUsed).toBe(true);
    expect(speaking).toBe(true); // talking right now
    endBrowserUtterance?.();
    expect(speaking).toBe(false); // finished — the LIVE loop can resume
  });

  test('successful audio keeps the server engine and the browser voice stays silent', async () => {
    const audioRes = new Response(new Blob([new Uint8Array([1, 2, 3])]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
    const deps = makeDeps({ fetchImpl: async () => audioRes });
    let speaking = null as boolean | null;
    let engine = null as string | null;
    await runSpeechChain('hello', () => true, deps, (e) => (engine = e), (s) => (speaking = s));
    expect(deps.state.serverUsed).toBe(true);
    expect(deps.state.browserUsed).toBe(false);
    expect(engine).toBe('server');
    expect(speaking).toBe(null); // untouched — audio.onended ends it in the hook
  });

  test('network failure (fetch throws) still reaches the browser fallback', async () => {
    const deps = makeDeps({ fetchImpl: async () => { throw new Error('unreachable'); } });
    let speaking = null as boolean | null;
    await runSpeechChain('hello', () => true, deps, () => undefined, (s) => (speaking = s));
    expect(deps.state.browserUsed).toBe(true);
    expect(speaking).toBe(null); // browser utterance owns the end
  });

  test('a superseded speak() (stop/newer reply) touches no state at all', async () => {
    const deps = makeDeps();
    let stateChanges = 0;
    await runSpeechChain('hello', () => false, deps, () => stateChanges++, () => stateChanges++);
    expect(deps.state.browserUsed).toBe(false);
    expect(stateChanges).toBe(0);
  });

  test('no speechSynthesis in the browser → speaking ends without an engine', async () => {
    const deps = makeDeps({ browserSynthAvailable: () => false });
    let speaking = null as boolean | null;
    let engine = null as string | null;
    await runSpeechChain('hello', () => true, deps, (e) => (engine = e), (s) => (speaking = s));
    expect(engine).toBeNull();
    expect(speaking).toBe(false);
  });

  test('browserSpeak failing (throws/false) still ends the speaking state', async () => {
    const deps = makeDeps({ browserSpeak: () => false });
    let speaking = null as boolean | null;
    await runSpeechChain('hello', () => true, deps, () => undefined, (s) => (speaking = s));
    expect(speaking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG B3 — a failed/slow wake `consume` re-fired onWake for the SAME trigger
// every 2 s, restarting the mic and losing the transcript
// ---------------------------------------------------------------------------
describe('voice: wake-word trigger dedupe', () => {
  const trigger = (at: number, pending = true) => ({ pending, last_trigger_at: at });

  test('a fresh pending trigger fires once', () => {
    expect(shouldFireWake(trigger(1000), 0)).toBe(true);
  });

  test('the same trigger never fires twice (consume lost / slow)', () => {
    expect(shouldFireWake(trigger(1000), 1000)).toBe(false);
  });

  test('a NEW trigger (refractory passed) fires again', () => {
    expect(shouldFireWake(trigger(1010), 1000)).toBe(true);
  });

  test('no pending → never fires', () => {
    expect(shouldFireWake(trigger(1000, false), 0)).toBe(false);
    expect(shouldFireWake(null, 0)).toBe(false);
    expect(shouldFireWake(undefined, 0)).toBe(false);
  });

  test('zero/absent timestamp is ignored (no synthetic trigger)', () => {
    expect(shouldFireWake({ pending: true, last_trigger_at: 0 }, 0)).toBe(false);
    expect(shouldFireWake({ pending: true }, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// speechFriendly — the text the TTS actually reads
// ---------------------------------------------------------------------------
describe('voice: TTS text sanitisation', () => {
  test('code blocks, markdown noise and links are not read aloud', () => {
    const md = '# Title\n```py\nprint(1)\n```\nSee [docs](https://x.y) and `npm i` — **bold**';
    const out = speechFriendly(md);
    expect(out).not.toContain('print(1)');
    expect(out).not.toContain('```');
    expect(out).not.toContain('**');
    expect(out).toContain('docs');
  });

  test('long answers are capped (a whole essay is not a voice reply)', () => {
    expect(speechFriendly('x'.repeat(5000)).length).toBe(1200);
  });

  test('empty/whitespace input collapses to empty', () => {
    expect(speechFriendly('')).toBe('');
    expect(speechFriendly('   \n\t ')).toBe('');
  });
});
