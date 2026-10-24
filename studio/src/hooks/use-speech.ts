'use client';

// use-speech.ts — voice command support for the Studio chat (Roadmap #6).
//
// Browser-native Web Speech API only — NO local Whisper model (the user's
// laptop is an i3 with 12 GB RAM; a speech model would eat it alive).
//   - SpeechRecognition: hi-IN and en-IN both work in Chrome/Edge; the user
//     can switch the language per mic session.
//   - speechSynthesis: speaks the assistant's replies (markdown stripped).
//
// Both features are strictly optional and client-side: a browser without
// the API simply shows a disabled button with a tooltip.

import { useCallback, useEffect, useRef, useState } from 'react';
import { perfSample } from '@/lib/perf';

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Strip markdown/syntax noise so the TTS voice reads clean sentences. */
export function speechFriendly(text: string): string {
  return String(text ?? '')
    .replace(/\[Stream error:[\s\S]*?(?:\]|$)/gi, '')
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[#*_>|]+/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' (link) ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

export function pickSpeechVoice<T extends { lang: string }>(voices: T[]): T | null {
  return voices.find((v) => v.lang.toLowerCase() === 'en-in')
    ?? voices.find((v) => v.lang.toLowerCase() === 'hi-in')
    ?? voices.find((v) => /^en(?:-|$)/i.test(v.lang))
    ?? voices.find((v) => /^hi(?:-|$)/i.test(v.lang))
    ?? null;
}

export type VoiceLang = 'hi-IN' | 'en-IN';

// ---------- speech recognition (mic -> text) ----------

/**
 * Immutable accumulator for one recognition session.
 *
 * BUGFIX (duplicate transcripts): `event.results` contains EVERY result since
 * the session start, so iterating the whole list and appending every `isFinal`
 * result re-appends the SAME final result on every `onresult` event —
 * "hello world" became "hello hello hello hello world ". The fix remembers
 * which result indexes were already appended (`handled`) and only adds new
 * ones; interim text is always recomputed from scratch.
 */
export interface RecognitionAccumulator {
  final: string;
  interim: string;
  handled: number[];
}

export function newRecognitionAccumulator(): RecognitionAccumulator {
  return { final: '', interim: '', handled: [] };
}

export function accumulateRecognition(
  acc: RecognitionAccumulator,
  event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }
): RecognitionAccumulator {
  let interim = '';
  const handled = acc.handled;
  let final = acc.final;
  for (let i = 0; i < event.results.length; i++) {
    const result = event.results[i];
    const transcript = result[0]?.transcript ?? '';
    if (result.isFinal) {
      // a result becomes final once and never changes — append it exactly once
      if (!handled.includes(i)) {
        handled.push(i);
        final += transcript + ' ';
      }
    } else {
      interim += transcript;
    }
  }
  return { final, interim, handled };
}

export function useVoiceInput(opts: {
  lang?: VoiceLang;
  onFinal?: (transcript: string) => void;
} = {}) {
  const { lang = 'en-IN', onFinal } = opts;
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const accRef = useRef<RecognitionAccumulator>(newRecognitionAccumulator());
  const onFinalRef = useRef(onFinal);
  // ref assignments happen after render, not during it (react-hooks/refs)
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  useEffect(() => {
    // deferred one tick — capability detection never sets state synchronously
    const t = setTimeout(() => setSupported(getRecognitionCtor() !== null), 0);
    return () => {
      clearTimeout(t);
      try {
        recRef.current?.abort();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('Is browser me speech recognition nahi hai — Chrome ya Edge use karo.');
      return;
    }
    try {
      recRef.current?.abort();
    } catch {
      /* ignore */
    }
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    accRef.current = newRecognitionAccumulator();
    setError(null);

    rec.onresult = (event) => {
      accRef.current = accumulateRecognition(accRef.current, event);
      setInterim(accRef.current.interim);
    };
    rec.onerror = (event) => {
      const code = event?.error ?? 'unknown';
      // no-speech = silence is fine; aborted = a normal stop()/abort() —
      // surfacing either as an error would block the LIVE loop restart
      if (code === 'no-speech' || code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setError('Mic permission nahi mili — browser address bar se allow karo.');
        setListening(false);
        return;
      }
      setError(`Mic error: ${code}`);
    };
    rec.onend = () => {
      setListening(false);
      setInterim('');
      const text = accRef.current.final.trim();
      if (text) onFinalRef.current?.(text);
      accRef.current = newRecognitionAccumulator();
    };

    try {
      rec.start();
      setListening(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mic start failed');
      setListening(false);
    }
  }, [lang]);

  const stop = useCallback(() => {
    try {
      recRef.current?.stop(); // onend fires the onFinal callback
    } catch {
      setListening(false);
    }
  }, []);

  return { supported, listening, interim, error, start, stop };
}

// ---------- speech synthesis (text -> voice) ----------
//
// Jarvis #3: the browser voice is ROBOTIC. The Studio tries the natural
// edge-tts voice first (python voice bridge, /api/voice/speak → audio/mpeg)
// and falls back to speechSynthesis when the bridge is not running or
// edge-tts is not installed. `engine` tells the UI which one is talking.
//
// The chain itself is IO-injected (`runSpeechChain`) so the fallback logic is
// unit-testable — it previously had an early `return` that skipped BOTH the
// browser fallback and the final `setSpeaking(false)` whenever the server
// answered non-OK, leaving the UI stuck in "speaking" forever (and the LIVE
// voice loop dead, since it waits for `!tts.speaking` before re-opening the
// mic).

export type SpeechEngine = 'server' | 'browser';

export interface SpeechChainDeps {
  /** structural on purpose — test doubles stay assignable (no `preconnect`) */
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  /** start server audio playback; resolves once playing, rejects on failure */
  playServerAudio: (blob: Blob) => Promise<void>;
  /** speak with the browser voice; false when speechSynthesis is unusable */
  browserSpeak: (text: string) => boolean;
  browserSynthAvailable: () => boolean;
}

/**
 * Speak `clean` through the server voice bridge, falling back to the browser
 * voice. `isCurrent()` is the stale guard — a speak() superseded by stop()
 * or a newer speak() must not touch state.
 *
 * GUARANTEE (bugfix): every non-superseded path ends the speech state —
 * success via the onended/onerror handlers, every failure via onSpeaking(false).
 */
export async function runSpeechChain(
  clean: string,
  isCurrent: () => boolean,
  deps: SpeechChainDeps,
  onEngine: (engine: SpeechEngine) => void,
  onSpeaking: (speaking: boolean) => void,
  /**
   * Called when NO voice engine could speak. Speech failures used to be
   * swallowed (the UI simply showed "speaking" and stopped), so the user had
   * no idea the assistant was silent — spec §6 requires a visible error.
   */
  onError?: (message: string) => void
): Promise<void> {
  // 1) natural voice try karo (python voice bridge, edge-tts)
  try {
    const res = await deps.fetchImpl('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean }),
    });
    if (!isCurrent()) return; // stop()/new speak() owns the state now
    const ctype = res.headers.get('content-type') ?? '';
    if (res.ok && ctype.startsWith('audio/')) {
      const blob = await res.blob();
      if (isCurrent()) {
        onEngine('server');
        await deps.playServerAudio(blob); // resolves when playback starts
        return; // server voice chal gaya — onended ends the state
      }
      return;
    }
    // non-audio answer (JSON error) → browser fallback below
  } catch {
    if (!isCurrent()) return;
    /* network hiccup → browser fallback below */
  }

  // 2) fallback: browser speechSynthesis (hamesha available nahi hota itna
  //    natural, par offline + zero-setup)
  if (!deps.browserSynthAvailable()) {
    onSpeaking(false);
    onError?.('Voice unavailable: the server voice bridge is not running and this browser has no compatible Hindi/English speech voice.');
    return;
  }
  if (deps.browserSpeak(clean)) {
    onEngine('browser'); // onended/onerror handlers end the state
  } else {
    onSpeaking(false);
    onError?.('Voice unavailable: the browser refused to start speech synthesis.');
  }
}

// ---------- incremental (streaming) speech ----------------------------------
//
// Problem: `speak(fullText)` waits for the ENTIRE AI answer before the first
// sound. On a slow provider that is 10-30 s of silence. The chain below
// speaks sentence-by-sentence AS the stream arrives:
//
//   stream chunk → sentence splitter → bounded queue → synth(1) → play(1)
//                                                        ├─ prefetch synth(2)
//                                                        └─ play(2) → …
//
// Guarantees:
//   - order is always preserved (playback is strictly sequential),
//   - at most MAX_PENDING_SENTENCES wait unplayed (overflow merges into the
//     tail — still spoken, just in fewer requests),
//   - the same sentence is never synthesised twice simultaneously (an audio
//     cache shares one in-flight request; identical repeats reuse its bytes),
//   - stop()/abort() drops everything: queue, in-flight synth, playback,
//   - a stale session (superseded by stop/speak) never touches state.
//
// Known limitation (documented, not hidden): this is SENTENCE-level
// streaming, not word-level. The python bridge returns one complete MP3 per
// request (edge-tts needs network access — it is NOT offline), so true
// word-by-word streaming is impossible with this TTS interface. Prefetch-1
// still overlaps synth(n+1) with play(n), which is what makes the voice
// feel continuous.

/** max sentences waiting unplayed before overflow merges into the tail */
export const MAX_PENDING_SENTENCES = 6;
/** identical-sentence audio reuse (bounds memory: a few short MP3s) */
const AUDIO_CACHE_SIZE = 8;
/** a sentence longer than this is hard-split (no endless waits) */
const MAX_SENTENCE_CHARS = 280;
/** newline splits only a long unpunctuated run (lists, code) */
const NEWLINE_SPLIT_AT = 80;

export interface SentenceSplit {
  complete: string[];
  rest: string;
}

const SENTENCE_BOUNDARY = new Set(['.', '!', '?', '…', '।']);
const SENTENCE_CLOSER = new Set(['"', "'", '“', '”', '‘', '’', ')', ']', '}']);

/**
 * Split `buffer` into complete sentences + unsent remainder.
 * Boundaries: . ! ? … । (danda) followed by whitespace, newlines in a long
 * run, and a hard length cap. A boundary as the LAST character is held back
 * (more context may arrive — "Dr." + " Smith"); `done()` flushes it.
 * A dot between digits ("3.5") is never a boundary.
 */
export function splitStreamSentences(buffer: string): SentenceSplit {
  const text = String(buffer ?? '');
  const complete: string[] = [];
  let start = 0;

  const emit = (end: number) => {
    const sentence = text.slice(start, end).trim();
    if (sentence) complete.push(sentence);
    let j = end;
    while (j < text.length && /\s/.test(text[j])) j++;
    start = j;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (SENTENCE_BOUNDARY.has(ch)) {
      // "3.5" — a dot between digits is not a boundary
      if (ch === '.' && /\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')) {
        continue;
      }
      let end = i + 1;
      while (end < text.length && SENTENCE_CLOSER.has(text[end])) end++;
      if (end >= text.length) continue; // held back — wait for more context
      if (/\s/.test(text[end])) {
        emit(end);
        i = start - 1;
      }
      continue;
    }
    if (ch === '\n' && i - start >= NEWLINE_SPLIT_AT) {
      emit(i);
      i = start - 1;
      continue;
    }
    if (i - start >= MAX_SENTENCE_CHARS) {
      // hard split at the last space (an unpunctuated wall of text)
      const slice = text.slice(start, i + 1);
      const cut = slice.lastIndexOf(' ');
      emit(cut > 40 ? start + cut : i + 1);
      i = start - 1;
    }
  }
  return { complete, rest: text.slice(start) };
}

/** Sentences that must never reach the voice (fences, table rows). */
export function isSpeakableSentence(raw: string, clean: string): boolean {
  if (!clean) return false;
  if (raw.includes('```')) return false;
  if (/^\s*\|.*\|\s*$/.test(raw)) return false; // markdown table row
  return true;
}

export interface SentenceChainDeps {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * Play server audio; resolves when THIS sentence FINISHES (or fails).
   * Must abandon silently when isCurrent() is false (stale session).
   */
  playServerAudioToEnd: (blob: Blob, isCurrent: () => boolean) => Promise<void>;
  /** Speak one sentence via the browser voice; resolves when done. */
  browserSpeakToEnd: (text: string, isCurrent: () => boolean) => Promise<void>;
  browserSynthAvailable: () => boolean;
}

export interface SentenceChain {
  /** feed one stream chunk (ignored after done()/abort()) */
  feed: (chunk: string) => void;
  /** no more text is coming — flush the remainder, drain, then settle */
  done: () => void;
  /** interrupt — drop queue + in-flight synth + playback, then settle */
  abort: () => void;
}

/**
 * The incremental speech session. DOM-free (all IO injected) so the shipped
 * logic is unit-testable exactly like runSpeechChain.
 */
export function createSentenceChain(
  isCurrent: () => boolean,
  deps: SentenceChainDeps,
  callbacks: {
    onEngine: (engine: SpeechEngine) => void;
    /** called EXACTLY once when the session ends (drained or aborted) */
    onSettled: () => void;
    /** called once when the first sentence starts playing (perf mark) */
    onFirstAudio?: () => void;
    /** called once when a sentence could not be spoken by ANY engine */
    onVoiceError?: (message: string) => void;
  }
): SentenceChain {
  let buffer = '';
  const queue: string[] = [];
  let finished = false;
  let settled = false;
  let pumping = false;
  let firstAudioFired = false;
  // sentence text → in-flight OR resolved audio (shared, never re-requested
  // while present; FIFO-capped so memory stays bounded — in-flight entries
  // are never evicted, and at most 2 exist (current + 1 prefetch))
  const audioCache = new Map<string, { p: Promise<Blob | null>; done: boolean }>();
  const aborters = new Set<AbortController>();

  const settle = () => {
    if (settled) return;
    settled = true;
    callbacks.onSettled();
  };

  const enqueue = (sentence: string) => {
    const clean = speechFriendly(sentence);
    if (!isSpeakableSentence(sentence, clean)) return;
    if (queue.length >= MAX_PENDING_SENTENCES) {
      // synth is slower than the stream — merge into the tail instead of
      // growing the queue (the words are still spoken, in one request)
      queue[queue.length - 1] += ' ' + clean;
      return;
    }
    queue.push(clean);
  };

  const synthAudio = (sentence: string): Promise<Blob | null> => {
    const cached = audioCache.get(sentence);
    // THE dedup rule: one sentence = one synth request at a time. An
    // identical repeat reuses the same bytes (correct audio, fewer calls).
    if (cached) return cached.p;
    const ctrl = new AbortController();
    aborters.add(ctrl);
    const entry = { p: null as unknown as Promise<Blob | null>, done: false };
    entry.p = (async () => {
      try {
        const res = await deps.fetchImpl('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sentence }),
          signal: ctrl.signal,
        });
        if (!isCurrent()) return null;
        const ctype = res.headers.get('content-type') ?? '';
        if (res.ok && ctype.startsWith('audio/')) return await res.blob();
        return null; // JSON error → browser fallback at play time
      } catch {
        return null; // abort / network hiccup → browser fallback
      } finally {
        entry.done = true;
        aborters.delete(ctrl);
      }
    })();
    audioCache.set(sentence, entry);
    // FIFO eviction of SETTLED entries only (in-flight ≤ 2 by construction)
    while (audioCache.size > AUDIO_CACHE_SIZE) {
      let victim: string | undefined;
      for (const [key, value] of audioCache) {
        if (value.done) {
          victim = key;
          break;
        }
      }
      if (victim === undefined) break;
      audioCache.delete(victim);
    }
    return entry.p;
  };

  const playOne = async (sentence: string): Promise<void> => {
    if (!isCurrent()) return;
    const blob = await synthAudio(sentence);
    if (!isCurrent()) return;
    if (!firstAudioFired) {
      firstAudioFired = true;
      callbacks.onFirstAudio?.();
    }
    if (blob) {
      callbacks.onEngine('server');
      await deps.playServerAudioToEnd(blob, isCurrent);
    } else if (deps.browserSynthAvailable()) {
      callbacks.onEngine('browser');
      await deps.browserSpeakToEnd(sentence, isCurrent);
    } else {
      // No engine at all: the chain continues (text is on screen) but the UI
      // is TOLD that audio is unavailable instead of pretending to speak.
      callbacks.onVoiceError?.(
        'Voice unavailable: server TTS failed and this browser has no compatible Hindi/English speech voice.'
      );
    }
  };

  const pump = () => {
    if (pumping || settled) return;
    pumping = true;
    void (async () => {
      try {
        for (;;) {
          if (!isCurrent() || settled) return;
          const sentence = queue.shift();
          if (sentence === undefined) return; // idle — feed()/done() re-pump
          // prefetch-1: synth(n+1) overlaps play(n) — this is what makes a
          // per-request MP3 bridge feel like continuous speech
          const upcoming = queue[0];
          if (upcoming !== undefined) void synthAudio(upcoming);
          await playOne(sentence);
        }
      } finally {
        pumping = false;
        if ((finished && queue.length === 0) || !isCurrent()) settle();
      }
    })();
  };

  return {
    feed(chunk: string) {
      if (finished || settled || !chunk) return;
      buffer += chunk;
      const { complete, rest } = splitStreamSentences(buffer);
      buffer = rest;
      for (const s of complete) enqueue(s);
      if (queue.length) pump();
    },
    done() {
      if (finished || settled) return;
      finished = true;
      const tail = buffer.trim();
      buffer = '';
      if (tail) enqueue(tail);
      if (!pumping && queue.length === 0) settle();
      else pump();
    },
    abort() {
      if (settled) return;
      finished = true;
      buffer = '';
      queue.length = 0;
      for (const ctrl of aborters) {
        try {
          ctrl.abort();
        } catch {
          /* ignore */
        }
      }
      aborters.clear();
      settle();
    },
  };
}

const TTS_PREF_KEY = 'agentscope-tts-enabled';

/**
 * JARVIS is a VOICE assistant: speech is ON by default when the browser can
 * speak at all, and the user's choice is remembered. It used to default to
 * OFF, which is why "JARVIS often does not speak" — unless the user found the
 * speaker toggle, every action was silent.
 */
export function useSpeechOutput() {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [enabled, setEnabledState] = useState(true);
  const [engine, setEngine] = useState<SpeechEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** the last sentence JARVIS actually tried to say (visible transcript) */
  const [lastSpoken, setLastSpoken] = useState<string>('');
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const seqRef = useRef(0); // a stale audio response never starts after a stop()
  const streamChainRef = useRef<SentenceChain | null>(null);
  const enabledRef = useRef(enabled);
  // ref assignments happen after render, not during it (react-hooks/refs)
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // hydrate the saved preference (default ON)
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(TTS_PREF_KEY);
      if (saved === '0') setEnabledState(false);
      if (saved === '1') setEnabledState(true);
    } catch {
      /* private mode — keep the default */
    }
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      window.localStorage.setItem(TTS_PREF_KEY, next ? '1' : '0');
    } catch {
      /* private mode */
    }
    if (!next) setError(null);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    // deferred one tick — capability detection never sets state synchronously
    const t = setTimeout(() => setSupported(true), 0);
    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      // Roman-script Hinglish is best served by Indian English. Never pick
      // an arbitrary installed voice in an unrelated language.
      voiceRef.current = pickSpeechVoice(voices);
    };
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
    return () => {
      clearTimeout(t);
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    // server (edge-tts) audio bhi turant rokna hai — barge-in/interrupt
    seqRef.current += 1;
    // an incremental session owns queued sentences + in-flight synth — drop
    // all of it (the seq bump already stales its state callbacks)
    try {
      streamChainRef.current?.abort();
    } catch {
      /* ignore */
    }
    streamChainRef.current = null;
    if (audioRef.current) {
      const audio = audioRef.current;
      try {
        audio.pause();
        URL.revokeObjectURL(audio.src); // bugfix: blob URLs leaked per reply
        audio.src = '';
      } catch {
        /* ignore */
      }
      audioRef.current = null;
    }
    setSpeaking(false);
  }, []);

  /**
   * Speak one complete text (used for acknowledgements, final statuses,
   * settings confirmations). Returns TRUE when an engine took the job.
   *
   * `force` is for the explicit "Test voice" button and for the guaranteed
   * final status of an action: the user asked for audio, so a muted toggle
   * must not turn the button into a no-op that looks broken.
   */
  const speakNow = useCallback(
    (text: string, force = false): boolean => {
      if (typeof window === 'undefined') return false;
      if (!enabled && !force) return false;
      const clean = speechFriendly(text);
      if (!clean) return false;
      stopSpeaking(); // never overlap two utterances
      setError(null);
      setLastSpoken(clean);
      const seq = ++seqRef.current;
      setSpeaking(true);
      const isCurrent = () => seq === seqRef.current;

      void runSpeechChain(
        clean,
        isCurrent,
        {
          fetchImpl: fetch,
          playServerAudio: (blob) =>
            new Promise<void>((resolve, reject) => {
              const audio = new Audio(URL.createObjectURL(blob));
              audioRef.current = audio;
              audio.onended = () => {
                if (isCurrent()) setSpeaking(false);
                try {
                  URL.revokeObjectURL(audio.src);
                } catch {
                  /* ignore */
                }
              };
              audio.onerror = () => {
                if (isCurrent()) {
                  // media element failed AFTER the bytes arrived — surface it,
                  // the browser voice is still tried below by the chain? No:
                  // this rejects so the chain falls back.
                  setError('Audio playback failed — using the browser voice instead.');
                }
                try {
                  URL.revokeObjectURL(audio.src);
                } catch {
                  /* ignore */
                }
              };
              audio.play().then(() => resolve(), reject);
            }),
          browserSpeak: (t) => {
            try {
              const utter = new SpeechSynthesisUtterance(t);
              if (voiceRef.current) utter.voice = voiceRef.current;
              utter.lang = voiceRef.current?.lang ?? 'en-IN';
              utter.rate = 1;
              utter.pitch = 1;
              utter.onend = () => {
                if (isCurrent()) setSpeaking(false);
              };
              utter.onerror = (event) => {
                if (isCurrent()) {
                  setSpeaking(false);
                  setError(
                    `Voice error: ${String((event as { error?: string })?.error ?? 'speech synthesis failed')}`
                  );
                }
              };
              window.speechSynthesis.speak(utter);
              return true;
            } catch {
              return false;
            }
          },
          browserSynthAvailable: () => 'speechSynthesis' in window && Boolean(voiceRef.current),
        },
        setEngine,
        setSpeaking,
        (message) => {
          if (isCurrent()) setError(message);
        }
      );
      return true;
    },
    [enabled, stopSpeaking]
  );

  /** The normal path (respects the mute toggle). */
  const speak = useCallback((text: string) => speakNow(text, false), [speakNow]);

  /**
   * "Test voice" — ALWAYS produces audio (or an explicit error), even when
   * the toggle is off. Previously the settings button called `speak()`, which
   * returned immediately while muted: the button looked broken.
   */
  const testVoice = useCallback(
    (text = 'All systems online. Main aapki awaaz sun raha hoon.') => {
      const started = speakNow(text, true);
      if (!started) {
        setError('Voice unavailable: this browser cannot synthesise speech.');
      }
      return started;
    },
    [speakNow]
  );

  /**
   * Incremental speech for a streaming reply: feed() each stream chunk, then
   * done() at stream end. Sentences start playing as soon as the first one
   * is complete — no waiting for the whole answer. Returns null when TTS is
   * off (the caller falls back to speak(fullText) at the end, preserving the
   * "enabled mid-stream" behavior).
   */
  const startStreamSpeak = useCallback((): SentenceChain | null => {
    if (!enabledRef.current || typeof window === 'undefined') return null;
    stopSpeaking(); // queue me purana padha na jaye — no overlaps, ever
    const seq = ++seqRef.current;
    const sessionStart = Date.now();
    setSpeaking(true); // stays true until the session settles (blocks LIVE mic)
    setError(null);
    const isCurrent = () => seq === seqRef.current;

    const chain = createSentenceChain(
      isCurrent,
      {
        fetchImpl: fetch,
        playServerAudioToEnd: (blob, current) =>
          new Promise<void>((resolve) => {
            if (!current()) {
              resolve();
              return;
            }
            const audio = new Audio(URL.createObjectURL(blob));
            audioRef.current = audio;
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              // a stale session never clears a NEWER session's audio element
              if (current() && audioRef.current === audio) audioRef.current = null;
              try {
                URL.revokeObjectURL(audio.src);
              } catch {
                /* ignore */
              }
              resolve();
            };
            audio.onended = finish;
            audio.onerror = finish;
            audio.play().then(
              () => undefined,
              () => finish()
            );
          }),
        browserSpeakToEnd: (text, current) =>
          new Promise<void>((resolve) => {
            if (!current()) {
              resolve();
              return;
            }
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(safety);
              resolve();
            };
            // Hang guard: speechSynthesis can swallow onend (background tab,
            // driver glitch). Cap the wait, then cancel (no overlap) and let
            // the chain continue — a cut sentence beats a deadlocked voice.
            const safety = setTimeout(() => {
              try {
                window.speechSynthesis.cancel();
              } catch {
                /* ignore */
              }
              finish();
            }, Math.min(30_000, 5000 + text.length * 80));
            try {
              const utter = new SpeechSynthesisUtterance(text);
              if (voiceRef.current) utter.voice = voiceRef.current;
              utter.lang = voiceRef.current?.lang ?? 'en-IN';
              utter.rate = 1;
              utter.pitch = 1;
              utter.onend = finish;
              utter.onerror = finish;
              window.speechSynthesis.speak(utter);
            } catch {
              finish();
            }
          }),
        browserSynthAvailable: () => 'speechSynthesis' in window && Boolean(voiceRef.current),
      },
      {
        onEngine: (e) => {
          if (isCurrent()) setEngine(e);
        },
        onSettled: () => {
          if (streamChainRef.current === chain) streamChainRef.current = null;
          if (isCurrent()) setSpeaking(false);
        },
        onFirstAudio: () => {
          if (isCurrent()) perfSample('tts.firstAudio', Date.now() - sessionStart);
        },
        onVoiceError: (message) => {
          if (isCurrent()) setError(message);
        },
      }
    );
    streamChainRef.current = chain;
    // Disabling TTS mid-stream drops the session (same visible result as the
    // old speak-at-end path, which no-ops when disabled).
    return {
      feed: (chunk: string) => {
        if (enabledRef.current) chain.feed(chunk);
      },
      done: () => {
        if (enabledRef.current) chain.done();
        else chain.abort();
      },
      abort: () => chain.abort(),
    };
  }, [stopSpeaking]);

  return {
    supported,
    enabled,
    setEnabled,
    speaking,
    speak,
    speakEssential: (text: string) => speakNow(text, true),
    testVoice,
    stopSpeaking,
    engine,
    /** visible voice problem (engine down, playback refused, ...) */
    error,
    clearError: () => setError(null),
    /** transcript of the last sentence JARVIS said */
    lastSpoken,
    startStreamSpeak,
  };
}

// ---------- wake word ("Hey Jarvis") — Jarvis #1 ----------

export interface WakeStatus {
  bridge: {
    running: boolean;
    ready: boolean;
    wakeEngine: string;
    ttsAvailable: boolean;
    lastError: string;
    installHint: string;
    port: number;
  };
  wake: {
    listening: boolean;
    paused: boolean;
    muted: boolean;
    killed: boolean;
    engine: string;
    sensitivity: number;
    triggers: number;
    pending: boolean;
    error: string;
    /** unix seconds of the last trigger — used to dedupe wake firings */
    last_trigger_at?: number;
  } | null;
}

/**
 * BUGFIX (duplicate wake capture): the trigger the UI reacted to is tracked
 * by its `last_trigger_at` timestamp — a failed/slow `consume` POST used to
 * re-fire `onWake()` every 2 s poll for the SAME trigger, restarting the mic
 * session each time and losing the accumulated transcript.
 */
export function shouldFireWake(
  wake: { pending?: boolean; last_trigger_at?: number } | null | undefined,
  lastFiredAt: number
): boolean {
  if (!wake?.pending) return false;
  const at = Number(wake.last_trigger_at ?? 0);
  return at > 0 && at !== lastFiredAt;
}

/**
 * Hands-free mode. While `enabled`:
 *   - the wake engine is started inside the python voice bridge,
 *   - status is polled every 2 s,
 *   - a pending trigger fires `onWake()` once and is acknowledged.
 *
 * Echo guard: while the assistant TALKS the poller sends `pause` (the spec:
 * "jab Jarvis bol raha ho tab wake word band rakho") and resumes after.
 */
export function useWakeWord(opts: {
  enabled: boolean;
  sensitivity?: number;
  paused?: boolean; // e.g. while TTS speaks or a mic session is open
  onWake?: () => void;
}) {
  const { enabled, sensitivity = 0.5, paused = false, onWake } = opts;
  const [status, setStatus] = useState<WakeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const onWakeRef = useRef(onWake);
  const pausedRef = useRef(paused);
  // Refs are synced in an effect, never during render: writing a ref while
  // rendering is exactly the "cannot access refs during render" anti-pattern
  // (and it breaks with React's concurrent rendering).
  useEffect(() => {
    onWakeRef.current = onWake;
  }, [onWake]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // start / stop the engine when the user flips Hands-free
  useEffect(() => {
    // the engine runs SERVER-side (python bridge + mic): it must be stopped
    // on toggle-off AND on unmount/tab close, else the bridge keeps listening
    // forever with nobody around to consume the trigger
    const stopEngine = () => {
      fetch('/api/voice/wake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'stop' }),
        keepalive: true, // survive page unload
      }).catch(() => undefined);
    };
    if (!enabled) {
      stopEngine();
      return;
    }
    let cancelled = false;
    setStarting(true);
    (async () => {
      try {
        const res = await fetch('/api/voice/wake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'start', sensitivity }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok && !cancelled) setError(data.error || `Wake start failed (HTTP ${res.status})`);
        else if (!cancelled) setError(null);
      } catch {
        if (!cancelled) setError('Wake engine start failed');
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();
    // tab close / refresh: fetch does not survive unload — sendBeacon does
    const onHidden = () => {
      try {
        const blob = new Blob([JSON.stringify({ op: 'stop' })], { type: 'application/json' });
        navigator.sendBeacon?.('/api/voice/wake', blob);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pagehide', onHidden);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onHidden);
      stopEngine();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // sensitivity changes are pushed live (no restart)
  useEffect(() => {
    if (!enabled) return;
    fetch('/api/voice/wake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'start', sensitivity }),
    }).catch(() => undefined);
  }, [sensitivity, enabled]);

  // poll status; react to triggers
  // NOTE: this poller is deliberately NOT hidden-tab gated. Hands-free is an
  // explicit always-listening feature — a minimized browser must still hear
  // "Hey Jarvis". The steady-state cost is one tiny local GET per 2 s; the
  // pause/resume POST now goes out only when it CHANGES (was: every tick),
  // and hidden tabs skip the setState (trigger detection still runs).
  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastFiredTriggerAt = 0; // dedupe: one onWake per wake trigger
    let lastSentPaused: boolean | null = null;

    const tick = async () => {
      try {
        // echo guard: bolte waqt wake pause — resume khud ho jata hai.
        // Sent only on change; re-asserted when the bridge disagrees
        // (e.g. it restarted and forgot the pause).
        const wantPaused = pausedRef.current;
        if (lastSentPaused !== wantPaused) {
          lastSentPaused = wantPaused;
          await fetch('/api/voice/wake', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: wantPaused ? 'pause' : 'resume' }),
          }).catch(() => undefined);
        }

        const res = await fetch('/api/voice/wake');
        const data = (await res.json()) as WakeStatus;
        if (stop) return;
        if (typeof data.wake?.paused === 'boolean' && data.wake.paused !== wantPaused) {
          lastSentPaused = null; // bridge disagrees — re-assert next tick
        }
        // Hidden tab: no UI to update — but triggers below must still fire.
        if (typeof document === 'undefined' || !document.hidden) {
          setStatus(data);
        }
        if (shouldFireWake(data.wake, lastFiredTriggerAt)) {
          lastFiredTriggerAt = Number(data.wake?.last_trigger_at ?? 0);
          onWakeRef.current?.();
          fetch('/api/voice/wake', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'consume' }),
          }).catch(() => undefined);
        }
      } catch {
        /* bridge down — next tick retries */
      }
      if (!stop) timer = setTimeout(tick, 2000);
    };
    tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);

  return { status, error, starting };
}
