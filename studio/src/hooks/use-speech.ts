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
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[#*_>|]+/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' (link) ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
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
  const { lang = 'hi-IN', onFinal } = opts;
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
  onSpeaking: (speaking: boolean) => void
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
    return;
  }
  if (deps.browserSpeak(clean)) {
    onEngine('browser'); // onended/onerror handlers end the state
  } else {
    onSpeaking(false);
  }
}

export function useSpeechOutput() {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [enabled, setEnabled] = useState(false); // off by default — the user opts in
  const [engine, setEngine] = useState<SpeechEngine | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const seqRef = useRef(0); // a stale audio response never starts after a stop()

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    // deferred one tick — capability detection never sets state synchronously
    const t = setTimeout(() => setSupported(true), 0);
    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      // Hindi voice pehle, warna koi bhi Indian-English voice
      voiceRef.current =
        voices.find((v) => v.lang === 'hi-IN') ??
        voices.find((v) => v.lang === 'en-IN') ??
        voices.find((v) => v.lang.startsWith('hi')) ??
        voices[0] ??
        null;
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

  const speak = useCallback(
    (text: string) => {
      if (!enabled || typeof window === 'undefined') return;
      const clean = speechFriendly(text);
      if (!clean) return;
      stopSpeaking(); // queue me purana padha na jaye
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
                if (isCurrent()) setSpeaking(false);
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
              utter.lang = voiceRef.current?.lang ?? 'hi-IN';
              utter.rate = 1;
              utter.pitch = 1;
              utter.onend = () => {
                if (isCurrent()) setSpeaking(false);
              };
              utter.onerror = () => {
                if (isCurrent()) setSpeaking(false);
              };
              window.speechSynthesis.speak(utter);
              return true;
            } catch {
              return false;
            }
          },
          browserSynthAvailable: () => 'speechSynthesis' in window,
        },
        setEngine,
        setSpeaking
      );
    },
    [enabled, stopSpeaking]
  );

  return { supported, enabled, setEnabled, speaking, speak, stopSpeaking, engine };
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
  onWakeRef.current = onWake;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

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
  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastFiredTriggerAt = 0; // dedupe: one onWake per wake trigger

    const tick = async () => {
      try {
        // echo guard: bolte waqt wake pause — resume khud ho jata hai
        await fetch('/api/voice/wake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: pausedRef.current ? 'pause' : 'resume' }),
        }).catch(() => undefined);

        const res = await fetch('/api/voice/wake');
        const data = (await res.json()) as WakeStatus;
        if (stop) return;
        setStatus(data);
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
