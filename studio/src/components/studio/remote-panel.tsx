'use client';

// remote-panel.tsx — the PC end of Stonic Remote.
//
// Shows the 6-digit pairing code (big, because you read it off the screen),
// the URL the phone must open, who is connected right now, and a hang-up
// button per device. Everything on this panel is PC-only and authenticated.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Smartphone, RefreshCw, Copy, Check, Power, Wifi, ShieldCheck, Link2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface Pairing {
  code: string;
  expiresAt: number;
  remainingSec: number;
  attemptsLeft: number;
}

interface Session {
  id: string;
  device: { label: string; userAgent: string; ip: string };
  createdAt: number;
  lastSeenAt: number;
  messages: number;
}

interface RemoteEvent {
  at: number;
  type: string;
  detail: string;
}

interface Status {
  pairing: Pairing | null;
  sessions: Session[];
  events: RemoteEvent[];
}

function ago(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

export function RemotePanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState('');
  const [tick, setTick] = useState(0);
  const revokedRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/remote/status');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load remote status');
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load remote status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    void load();
    const poll = setInterval(() => void load(), 3000);
    const clock = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  const startPairing = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/remote/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create a code');
      await load();
      toast({ title: 'Pairing code ready', description: 'Phone par /remote kholo aur ye code daalo (3 min).' });
    } catch (err) {
      toast({
        title: 'Pairing failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }, [load]);

  const cancelPairing = useCallback(async () => {
    await fetch('/api/remote/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    }).catch(() => undefined);
    await load();
  }, [load]);

  const revoke = useCallback(
    async (sessionId: string) => {
      revokedRef.current.add(sessionId);
      await fetch('/api/remote/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => undefined);
      await load();
      toast({ title: 'Remote disconnected' });
    },
    [load]
  );

  const remoteUrl = origin ? `${origin}/remote` : '/remote';
  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(remoteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: 'Copy failed', description: remoteUrl, variant: 'destructive' });
    }
  }, [remoteUrl]);

  const remaining = status?.pairing
    ? Math.max(0, Math.round((status.pairing.expiresAt - Date.now()) / 1000))
    : 0;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400">
        <RefreshCw className="h-4 w-4 animate-spin mr-2" /> Loading remote…
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
        <header>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-cyan-400" /> Stonic Remote
          </h2>
          <p className="text-sm text-zinc-400 mt-1">
            Phone se is PC ke JARVIS se baat karo — voice ya text. PC par code dikhta hai, phone usi code se
            judta hai; dono taraf se kabhi bhi disconnect kar sakte ho.
          </p>
        </header>

        {error ? (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        ) : null}

        {/* ---- pairing ---- */}
        <section className="rounded-xl border border-cyan-500/25 bg-[rgba(4,12,20,0.8)] p-5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
              <Link2 className="h-4 w-4 text-cyan-400" /> Pairing
            </h3>
            {status?.pairing ? (
              <Button size="sm" variant="outline" onClick={() => void cancelPairing()}>
                Cancel code
              </Button>
            ) : (
              <Button size="sm" onClick={() => void startPairing()} disabled={busy} className="bg-cyan-600 hover:bg-cyan-500 text-white">
                {busy ? 'Creating…' : 'Generate code'}
              </Button>
            )}
          </div>

          {status?.pairing ? (
            <div className="mt-4 grid sm:grid-cols-[auto_1fr] gap-5 items-center">
              <div className="text-center">
                <p className="text-4xl font-mono tracking-[0.3em] text-cyan-200 tabular-nums">
                  {status.pairing.code}
                </p>
                <p className="text-[11px] text-zinc-500 mt-1">
                  expires in {remaining}s · {status.pairing.attemptsLeft} guesses left
                </p>
              </div>
              <div className="space-y-2 min-w-0">
                <p className="text-xs text-zinc-400">
                  Phone par ye address kholo, phir upar ka code daalo:
                </p>
                <div className="flex items-center gap-2">
                  <code className="text-[11px] bg-black/50 border border-zinc-800 rounded px-2 py-1.5 truncate flex-1">
                    {remoteUrl}
                  </code>
                  <Button size="sm" variant="outline" onClick={() => void copyLink()}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  Same WiFi par ye address seedha chalega. Internet se (bahar se) judna ho to Studio ko tunnel
                  se expose karo — jaise <code>cloudflared tunnel --url http://localhost:3000</code> — aur wahi
                  https address phone me kholo.
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-500 mt-3">
              Koi code active nahi hai. <span className="text-zinc-300">Generate code</span> dabao — code 3 minute
              tak chalta hai aur sirf ek baar.
            </p>
          )}
        </section>

        {/* ---- connected devices ---- */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
          <h3 className="text-sm font-semibold text-zinc-200 flex items-center gap-2 mb-3">
            <Wifi className="h-4 w-4 text-emerald-400" /> Connected devices
            <Badge variant="outline" className="border-zinc-700 text-zinc-400">
              {status?.sessions.length ?? 0}/3
            </Badge>
          </h3>
          {!status?.sessions.length ? (
            <p className="text-xs text-zinc-500">Koi phone connected nahi hai.</p>
          ) : (
            <ul className="space-y-2">
              {status.sessions.map((session) => {
                const idleMin = Math.round((Date.now() - session.lastSeenAt) / 60000);
                return (
                  <li
                    key={session.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-black/30 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-200 truncate">
                        {session.device.label}
                        <span className="text-[10px] text-zinc-500 font-mono ml-2">{session.id}</span>
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        {session.messages} message(s) · last seen {ago(session.lastSeenAt)}
                        {idleMin >= 30 ? ' · idle' : ''}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => void revoke(session.id)}>
                      <Power className="h-3.5 w-3.5 mr-1.5" /> Disconnect
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ---- events ---- */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
          <h3 className="text-sm font-semibold text-zinc-200 flex items-center gap-2 mb-3">
            <ShieldCheck className="h-4 w-4 text-cyan-400" /> Activity
          </h3>
          {!status?.events.length ? (
            <p className="text-xs text-zinc-500">Kuch nahi hua abhi.</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {[...status.events].reverse().map((event, index) => (
                <li key={`${event.at}-${index}`} className="text-[11px] text-zinc-400 flex gap-2">
                  <span className="text-zinc-600 font-mono shrink-0">
                    {new Date(event.at).toLocaleTimeString()}
                  </span>
                  <span
                    className={
                      event.type === 'rejected'
                        ? 'text-amber-300'
                        : event.type === 'connected'
                          ? 'text-emerald-300'
                          : event.type === 'ended'
                            ? 'text-zinc-400'
                            : 'text-zinc-300'
                    }
                  >
                    {event.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-[11px] text-zinc-500 leading-relaxed">
          Security: code 3 min me expire, ek hi baar chalta hai, 5 galat koshish par cancel, session 2 ghante
          idle rehne par khatam, aur kill switch engage hone par pairing + messages dono band. Token sirf phone
          ke sessionStorage me rehta hai aur PC kabhi use log me nahi likhta. <span className="sr-only">{tick}</span>
        </p>
      </div>
    </div>
  );
}
