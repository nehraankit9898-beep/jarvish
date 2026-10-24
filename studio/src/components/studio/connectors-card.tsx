'use client';

// connectors-card.tsx — System panel card for external connectors (Jarvis #7).
// Status + one-click Google OAuth connect/disconnect. Tokens never come
// back to the browser — only account email + scopes.

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CalendarDays, Mail, RefreshCw, Link2, Unlink } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  accountEmail: string;
  scopes: string;
  hasWrite: boolean;
  setupHint: string;
}

export function ConnectorsCard() {
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/connectors');
      if (!res.ok) return;
      const data = await res.json();
      setGoogle(data.google ?? null);
    } catch {
      /* panel stays silent — the card is optional info */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'auth-url' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Auth URL failed');
      window.open(data.url as string, '_blank', 'noopener');
      toast({
        title: 'Google consent khul gaya',
        description: 'Consent dekar wapas aa jao — status yahin update ho jayega.',
      });
      // the callback round-trip takes a few seconds — poll once
      setTimeout(() => void load(), 8000);
    } catch (err) {
      toast({
        title: 'Connect failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }, [load]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'disconnect' }),
      });
      if (!res.ok) throw new Error('Disconnect failed');
      toast({ title: 'Google disconnected', description: 'Tokens delete ho gaye.' });
      await load();
    } catch (err) {
      toast({
        title: 'Disconnect failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }, [load]);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold text-zinc-200">Connectors</h3>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => void load()} className="h-7 text-zinc-400">
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <div className="flex items-center gap-2 mb-1">
              <CalendarDays className="h-4 w-4 text-sky-400" />
              <span className="text-sm font-medium text-zinc-100">Google</span>
              {google?.connected ? (
                <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-300">
                  connected
                </Badge>
              ) : google?.configured ? (
                <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-300">
                  not connected
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] border-zinc-700 text-zinc-500">
                  not configured
                </Badge>
              )}
            </div>
            <p className="text-xs text-zinc-400">
              Google Calendar (read + reminders) aur Gmail (sirf padhna — kabhi send nahi).
            </p>
            {google?.connected && (
              <p className="text-[11px] text-zinc-500 mt-1">
                {google.accountEmail || 'account'} ·{' '}
                {google.hasWrite ? 'calendar write ON' : 'read-only'}
              </p>
            )}
            {google && !google.connected && google.setupHint && (
              <p className="text-[11px] text-amber-400/80 mt-1">{google.setupHint}</p>
            )}
            <p className="text-[10px] text-zinc-600 mt-2 flex items-center gap-1">
              <Mail className="h-3 w-3" /> Tokens AGENTSCOPE_SECRET_KEY se encrypted store hote hain — UI me kabhi nahi dikhte.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {google?.connected ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void disconnect()}
                disabled={busy}
                className="h-8 border-zinc-700 text-zinc-300 hover:text-red-300"
              >
                <Unlink className="h-3.5 w-3.5 mr-1.5" /> Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void connect()}
                disabled={busy || (google ? !google.configured : false)}
                className="h-8 bg-sky-600 hover:bg-sky-500 text-white"
              >
                <Link2 className="h-3.5 w-3.5 mr-1.5" /> Connect Google
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
