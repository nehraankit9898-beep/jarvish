'use client';

// /remote — Stonic Remote: the phone end of the Studio.
//
// Flow:
//   1. The PC shows a 6-digit code (Remote tab).
//   2. The phone opens this page (same network / tunnel), types the code and
//      gets a 256-bit session token (stored in sessionStorage — it dies with
//      the tab).
//   3. Tap the mic (or type) → the SAME JARVIS from the PC answers, and the
//      answer is spoken back. Hands-free keeps listening after each reply.
//
// Everything is relative-URL based, so it works behind a tunnel / the
// preview proxy exactly as it works on the LAN.

import { useCallback, useEffect, useRef, useState } from 'react';

interface Persona {
  id: string;
  name: string;
  emoji: string;
  greeting: string;
}

interface Bubble {
  id: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

type Phase = 'pair' | 'chat';

const TOKEN_KEY = 'stonic-remote-token';

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export default function RemotePage() {
  const [phase, setPhase] = useState<Phase>('pair');
  const [token, setToken] = useState('');
  const [code, setCode] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [persona, setPersona] = useState<Persona | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [handsFree, setHandsFree] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);

  const recognitionRef = useRef<any>(null);
  /** the listener restart hook — set below so `onend` never self-references */
  const startRef = useRef<() => void>(() => {});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const tokenRef = useRef('');
  const handsFreeRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [bubbles]);

  const push = useCallback((role: Bubble['role'], text: string) => {
    setBubbles((prev) => [...prev.slice(-40), { id: Date.now() + Math.random(), role, text }]);
  }, []);

  // ---- speech output ----------------------------------------------------
  const speak = useCallback(async (text: string) => {
    if (!text) return;
    setSpeaking(true);
    try {
      const res = await fetch('/api/remote/speak', {
        method: 'POST',
        headers: authHeaders(tokenRef.current),
        body: JSON.stringify({ text }),
      });
      if (res.ok && (res.headers.get('content-type') ?? '').startsWith('audio/')) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = audioRef.current ?? new Audio();
        audioRef.current = audio;
        audio.src = url;
        await new Promise<void>((resolve) => {
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          void audio.play().catch(() => resolve());
        });
        URL.revokeObjectURL(url);
        return;
      }
      // fall back to the phone's own voice
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        await new Promise<void>((resolve) => {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = /[\u0900-\u097F]/.test(text) ? 'hi-IN' : 'en-IN';
          utterance.onend = () => resolve();
          utterance.onerror = () => resolve();
          window.speechSynthesis.speak(utterance);
          setTimeout(resolve, 15_000);
        });
      }
    } finally {
      setSpeaking(false);
    }
  }, []);

  // ---- one turn ---------------------------------------------------------
  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      push('user', text);
      setDraft('');
      try {
        const res = await fetch('/api/remote/message', {
          method: 'POST',
          headers: authHeaders(tokenRef.current),
          body: JSON.stringify({ text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401) {
            sessionStorage.removeItem(TOKEN_KEY);
            setPhase('pair');
            setToken('');
            setError(data.error || 'Session ended — pair again on the PC.');
            return;
          }
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        push('assistant', data.reply ?? '');
        await speak(data.spoken || data.reply || '');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [push, speak]
  );

  // ---- speech input -----------------------------------------------------
  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setSpeechSupported(false);
      setNotice('Is phone par voice input support nahi hai — neeche likh kar bhejo.');
      return;
    }
    if (listening || busyRef.current) return;
    const recognition = new SR();
    recognition.lang = 'hi-IN';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onresult = (event: any) => {
      const result = event.results?.[event.results.length - 1];
      const transcript = result?.[0]?.transcript ?? '';
      if (transcript.trim()) void send(transcript);
    };
    recognition.onerror = (event: any) => {
      setListening(false);
      if (event?.error === 'not-allowed' || event?.error === 'service-not-allowed') {
        setNotice('Mic permission chahiye — browser me allow karo.');
      } else if (event?.error === 'no-speech') {
        setNotice('Kuch suna nahi. Dobara try karo.');
      }
    };
    recognition.onend = () => {
      setListening(false);
      if (handsFreeRef.current && !busyRef.current) {
        // hands-free: keep the mic warm for the next sentence
        setTimeout(() => {
          if (handsFreeRef.current && !busyRef.current) startRef.current();
        }, 700);
      }
    };
    try {
      recognition.start();
      recognitionRef.current = recognition;
      setListening(true);
      setNotice(null);
    } catch {
      setListening(false);
    }
  }, [listening, send]);

  useEffect(() => {
    startRef.current = startListening;
  }, [startListening]);

  const stopListening = useCallback(() => {
    setListening(false);
    try {
      recognitionRef.current?.stop?.();
    } catch {
      /* already stopped */
    }
  }, []);

  // ---- pairing ----------------------------------------------------------
  const connect = useCallback(async () => {
    if (code.replace(/\D/g, '').length !== 6) {
      setError('6-digit code chahiye — PC ke Remote tab par dikh raha hai.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/remote/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.replace(/\D/g, ''),
          label: deviceLabel.trim() || 'Phone',
          userAgent: navigator.userAgent,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Pairing failed');
      sessionStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPersona(data.persona ?? null);
      setPhase('chat');
      push('system', `Connected to the PC as “${data.device ?? 'Phone'}”.`);
      const greeting = data.persona?.greeting as string | undefined;
      if (greeting) {
        push('assistant', greeting);
        void speak(greeting);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pairing failed');
    } finally {
      setBusy(false);
    }
  }, [code, deviceLabel, push, speak]);

  const endSession = useCallback(async () => {
    try {
      await fetch('/api/remote/end', { method: 'POST', headers: authHeaders(tokenRef.current) });
    } catch {
      /* best effort */
    }
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setPhase('pair');
    setBubbles([]);
    setCode('');
    stopListening();
  }, [stopListening]);

  // resume a saved session after a reload
  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (!saved) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/remote/whoami', { headers: { Authorization: `Bearer ${saved}` } });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.ok) {
          setToken(saved);
          setPersona(data.persona ?? null);
          setPhase('chat');
          push('system', 'Session resumed.');
        } else {
          sessionStorage.removeItem(TOKEN_KEY);
        }
      } catch {
        /* offline — stay on the pairing screen */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [push]);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSpeechSupported(Boolean(SR));
  }, []);

  // stop everything when the tab goes away
  useEffect(() => {
    return () => {
      stopListening();
      window.speechSynthesis?.cancel?.();
    };
  }, [stopListening]);

  const statusText = error
    ? error
    : busy
      ? 'Soch raha hoon…'
      : speaking
        ? 'Bol raha hoon…'
        : listening
          ? 'Sun raha hoon…'
          : 'Ready';

  // ---- UI ---------------------------------------------------------------
  return (
    <main className="min-h-screen bg-[#050b12] text-zinc-100 flex flex-col">
      <header className="px-4 pt-5 pb-3 border-b border-cyan-500/20 bg-[rgba(4,12,20,0.9)] sticky top-0 z-10 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="h-8 w-8 rounded-full border border-cyan-400/50 bg-cyan-400/10 flex items-center justify-center shrink-0">
              <span className={`h-2 w-2 rounded-full bg-cyan-300 ${phase === 'chat' ? 'shadow-[0_0_10px_#22d3ee]' : 'opacity-50'}`} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{persona?.name ?? 'J.A.R.V.I.S'}</p>
              <p className="text-[10px] text-zinc-500 font-mono truncate">
                {phase === 'chat' ? `STONIC REMOTE · ${statusText}` : 'STONIC REMOTE · not paired'}
              </p>
            </div>
          </div>
          {phase === 'chat' && (
            <button
              onClick={() => void endSession()}
              className="text-[11px] rounded-full border border-red-400/40 text-red-300 px-3 py-1 hover:bg-red-500/10 shrink-0"
            >
              End
            </button>
          )}
        </div>
      </header>

      {phase === 'pair' ? (
        <section className="flex-1 flex flex-col justify-center px-5 py-8 gap-4 max-w-md w-full mx-auto">
          <div className="rounded-2xl border border-cyan-500/25 bg-[rgba(4,12,20,0.85)] p-5 space-y-4">
            <div>
              <h1 className="text-lg font-semibold">Connect to your PC</h1>
              <p className="text-xs text-zinc-400 mt-1">
                PC par <span className="text-cyan-300">Remote</span> tab kholo aur 6-digit code yahan daalo.
              </p>
            </div>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              aria-label="Pairing code"
              className="w-full text-center text-3xl tracking-[0.4em] font-mono bg-black/40 border border-cyan-500/30 rounded-xl py-3 outline-none focus:border-cyan-400"
            />
            <input
              value={deviceLabel}
              onChange={(e) => setDeviceLabel(e.target.value.slice(0, 40))}
              placeholder="Device name (optional)"
              aria-label="Device name"
              className="w-full text-sm bg-black/40 border border-zinc-700 rounded-xl px-3 py-2 outline-none focus:border-cyan-400"
            />
            <button
              onClick={() => void connect()}
              disabled={busy}
              className="w-full rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-medium py-3 transition-colors"
            >
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            {error && <p className="text-xs text-red-300">{error}</p>}
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Code 3 minute me expire ho jata hai, ek hi baar chalta hai, aur PC par kabhi bhi End dabakar ye
              phone disconnect ho sakta hai.
            </p>
          </div>
        </section>
      ) : (
        <>
          <section className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5">
            {bubbles.length === 0 && (
              <p className="text-xs text-zinc-500 text-center mt-6">
                Mic dabao aur bolo — ya neeche likh kar bhejo.
              </p>
            )}
            {bubbles.map((bubble) => (
              <div
                key={bubble.id}
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                  bubble.role === 'user'
                    ? 'ml-auto bg-cyan-600/90 text-white rounded-br-sm'
                    : bubble.role === 'system'
                      ? 'mx-auto bg-zinc-800/70 text-zinc-300 text-[11px] text-center rounded-lg'
                      : 'bg-zinc-900 border border-cyan-500/20 text-zinc-100 rounded-bl-sm'
                }`}
              >
                {bubble.text}
              </div>
            ))}
            {busy && <p className="text-[11px] text-zinc-500 pl-1">…</p>}
            <div ref={bottomRef} />
          </section>

          <footer className="border-t border-cyan-500/20 bg-[rgba(4,12,20,0.95)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            {notice && <p className="text-[11px] text-amber-300 mb-2">{notice}</p>}
            <div className="flex items-center gap-2">
              <button
                onClick={() => (listening ? stopListening() : startListening())}
                disabled={!speechSupported || busy}
                aria-label={listening ? 'Stop listening' : 'Start talking'}
                className={`h-12 w-12 shrink-0 rounded-full flex items-center justify-center border transition-colors ${
                  listening
                    ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300 animate-pulse'
                    : 'bg-cyan-600 border-cyan-400 text-white disabled:opacity-40'
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
                  <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
                  <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 1 0 2 0v-3.08A7 7 0 0 0 19 11Z" />
                </svg>
              </button>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
                placeholder={busy ? 'Soch raha hoon…' : 'Message…'}
                aria-label="Message"
                className="flex-1 text-sm bg-black/40 border border-zinc-700 rounded-full px-4 py-2.5 outline-none focus:border-cyan-400"
              />
              <button
                onClick={() => void send(draft)}
                disabled={busy || !draft.trim()}
                aria-label="Send"
                className="h-11 w-11 shrink-0 rounded-full bg-cyan-600 disabled:opacity-40 text-white flex items-center justify-center"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
                  <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2z" />
                </svg>
              </button>
            </div>
            <div className="flex items-center justify-between mt-2">
              <label className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={handsFree}
                  onChange={(e) => setHandsFree(e.target.checked)}
                  className="accent-cyan-500"
                />
                Hands-free (har jawab ke baad sunta rahe)
              </label>
              <span className="text-[10px] text-zinc-600 font-mono">
                {speechSupported ? 'voice ready' : 'text only'}
              </span>
            </div>
          </footer>
        </>
      )}
    </main>
  );
}
