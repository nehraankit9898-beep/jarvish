// browser-panel.tsx — the live browser view (Features 11 + 12 + 13).
//
// Shows the agent browser sessions with their current screenshot. The user
// can navigate manually, TAKE OVER the session (agent actions are refused at
// the engine layer while the hold is on) and release control back to the
// agent. Pay/Order buttons confirm through an explicit dialog — the payment
// guard only accepts the user's confirmation.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Globe,
  Plus,
  Hand,
  Play,
  Camera,
  RefreshCw,
  X,
  MousePointerClick,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';

interface SessionItem {
  id: string;
  taskId: string;
  status: string;
  currentUrl: string;
  pageTitle: string;
  userHold: boolean;
  hasScreenshot: boolean;
  updatedAt: string;
}

interface Intel {
  title: string;
  forms: { heading: string; fields: { label: string; name: string; sensitive: boolean; required: boolean }[]; looksLikePayment: boolean; looksLikeCheckout: boolean }[];
  checkout: { detected: boolean; totals: { label: string; amount: string }[]; items: { name: string }[]; subscriptionWords: string[]; returnPolicyLink: string | null };
  payment: { detected: boolean; cardFields: string[]; payButtons: string[]; walletOptions: string[] };
  humanVerification: { detected: boolean; kinds: string[] };
}

export function BrowserPanel() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [shot, setShot] = useState<string | null>(null);
  const [intel, setIntel] = useState<Intel | null>(null);
  const [busy, setBusy] = useState(false);
  const [payConfirm, setPayConfirm] = useState<{ target: string } | null>(null);
  const shotRef = useRef<HTMLImageElement>(null);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/browser');
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions ?? []);
        if (!activeId && data.sessions?.length) {
          setActiveId(data.sessions[0].id);
        }
      }
    } catch {
      // panel stays usable
    }
  }, [activeId]);

  const loadSession = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const res = await fetch(`/api/browser/${id}?include=screenshot`);
      if (res.ok) {
        const data = await res.json();
        setShot(data.screenshotBase64 ? `data:image/png;base64,${data.screenshotBase64}` : null);
        setIntel(data.intel ?? null);
        setUrl(data.currentUrl || '');
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (activeId) loadSession(activeId);
  }, [activeId, loadSession]);

  const newSession = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Session open failed');
      setActiveId(data.id);
      setShot(null);
      setIntel(null);
      setUrl('');
      await loadSessions();
      toast({ title: 'Browser session ready', description: 'Ek isolated Chromium context khula hai.' });
    } catch (err) {
      toast({
        title: 'Browser unavailable',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!activeId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/browser/${activeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${action} failed`);

      if (action === 'screenshot') {
        setShot(data.base64 ? `data:image/png;base64,${data.base64}` : null);
      } else if (data.intel) {
        setIntel(data.intel);
        if (data.intel.url) setUrl(data.intel.url);
        await loadSession(activeId); // refresh screenshot too
      } else {
        await loadSession(activeId);
      }

      if (action === 'click' && data.paymentBlocked) {
        toast({
          title: '🛡️ Payment guard',
          description: data.reason ?? 'Payment needs your confirmation.',
          variant: 'destructive',
        });
      }
      if (action === 'click' && data.clicked && !data.paymentBlocked) {
        toast({ title: 'Clicked', description: extra.target as string });
      }
      await loadSessions();
    } catch (err) {
      toast({
        title: 'Action failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  const active = sessions.find((s) => s.id === activeId);

  return (
    <div className="h-full overflow-hidden flex flex-col">
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/30 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Globe className="h-4 w-4 text-cyan-400" />
          <h2 className="font-semibold text-sm">Live Browser</h2>
          <Badge variant="outline" className="text-[10px] border-cyan-500/30 text-cyan-400">
            Playwright + Chromium
          </Badge>
        </div>
        <p className="text-[11px] text-zinc-500">
          Isolated browser contexts. Agent in tools (browser-navigate / click / fill) same sessions
          use karte hain. <span className="text-amber-400">Take Control</span> dabao — agent ke actions
          turant ruk jaate hain (engine layer par, sirf UI par nahi).
        </p>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
        {/* session list */}
        <div className="lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-zinc-800 p-3 space-y-2 overflow-y-auto max-h-40 lg:max-h-none">
          <Button onClick={newSession} disabled={busy} className="w-full justify-start" size="sm">
            <Plus className="h-3.5 w-3.5 mr-1.5" /> New session
          </Button>
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className={`w-full text-left rounded-lg px-2.5 py-2 transition-colors ${
                s.id === activeId ? 'bg-zinc-800 text-cyan-300' : 'text-zinc-400 hover:bg-zinc-800/60'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-mono truncate">{s.id.slice(-8)}</span>
                {s.userHold && <Hand className="h-3 w-3 text-amber-400" />}
              </div>
              <p className="text-[10px] text-zinc-500 truncate">{s.pageTitle || s.currentUrl || 'empty'}</p>
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="text-[11px] text-zinc-600 text-center py-4">Koi session nahi</p>
          )}
        </div>

        {/* main view */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* URL bar + controls */}
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/40">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && url.trim()) act('navigate', { url: url.trim() });
              }}
              placeholder="https://example.com"
              className="flex-1 bg-zinc-900 border-zinc-700 text-xs font-mono h-8"
            />
            <Button size="sm" variant="outline" className="border-zinc-700 h-8" disabled={!activeId || busy} onClick={() => url.trim() && act('navigate', { url: url.trim() })}>
              Go
            </Button>
            <Button size="sm" variant="outline" className="border-zinc-700 h-8" disabled={!activeId || busy} onClick={() => act('screenshot')} title="Refresh screenshot">
              <Camera className="h-3.5 w-3.5" />
            </Button>
            {active?.userHold ? (
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-500 h-8" disabled={!activeId || busy} onClick={() => act('release')}>
                <Play className="h-3.5 w-3.5 mr-1" /> Resume Agent
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="border-amber-600/50 text-amber-400 hover:bg-amber-600/10 h-8" disabled={!activeId || busy} onClick={() => act('takeover')}>
                <Hand className="h-3.5 w-3.5 mr-1" /> Take Control
              </Button>
            )}
            <Button size="sm" variant="outline" className="border-red-900/50 text-red-400 hover:bg-red-900/20 h-8" disabled={!activeId || busy} onClick={() => act('close')}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-3 space-y-3">
              {/* screenshot */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden relative">
                {shot ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    ref={shotRef}
                    src={shot}
                    alt="Browser screenshot"
                    className="w-full"
                  />
                ) : (
                  <div className="aspect-[16/10] flex items-center justify-center text-zinc-600 text-sm">
                    <Globe className="h-8 w-8 mb-2 opacity-40" />
                    <p className="absolute bottom-4">
                      Koi page open nahi — URL daalo ya agent ke browser tools chalao.
                    </p>
                  </div>
                )}
                {active?.userHold && (
                  <div className="absolute top-2 left-2 bg-amber-600/90 text-white text-[11px] px-2 py-1 rounded-md flex items-center gap-1">
                    <Hand className="h-3 w-3" /> User control active — agent paused
                  </div>
                )}
              </div>

              {/* page intel */}
              {intel && (
                <div className="grid sm:grid-cols-2 gap-3">
                  {/* payment + verification alerts */}
                  {(intel.payment?.detected || intel.humanVerification?.detected) && (
                    <div className="rounded-xl border border-amber-600/40 bg-amber-600/5 p-3 space-y-2 sm:col-span-2">
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="h-4 w-4 text-amber-400" />
                        <span className="text-xs font-semibold text-amber-300">Safety checks</span>
                      </div>
                      {intel.payment?.detected && (
                        <p className="text-[11px] text-zinc-400">
                          💳 Payment form detected{intel.payment.cardFields?.length ? ` (card fields: ${intel.payment.cardFields.length})` : ''}.
                          Agent kabhi card/CVV values nahi padhta. Final Pay/Order button sirf tumhare
                          confirmation ke baad chalta hai.
                        </p>
                      )}
                      {intel.humanVerification?.detected && (
                        <p className="text-[11px] text-zinc-400">
                          🤖 Human verification ({intel.humanVerification.kinds.join(', ')}) — agent
                          isko bypass NAHI karega. Manually complete karke Resume Agent dabao.
                        </p>
                      )}
                      {intel.payment?.payButtons?.length ? (
                        <div className="space-y-1.5 pt-1">
                          {intel.payment.payButtons.map((label) => (
                            <div key={label} className="flex items-center gap-2">
                              <span className="text-[11px] text-zinc-300 truncate flex-1">{label}</span>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 border-amber-600/50 text-amber-400 text-[11px]"
                                disabled={busy}
                                onClick={() => setPayConfirm({ target: `text=${label}` })}
                              >
                                <MousePointerClick className="h-3 w-3 mr-1" /> Confirm & click
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}

                  {/* checkout summary */}
                  {intel.checkout?.detected && (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                      <p className="text-xs font-semibold mb-2">🛒 Checkout intel</p>
                      {intel.checkout.totals.length ? (
                        <div className="space-y-1">
                          {intel.checkout.totals.map((t, i) => (
                            <div key={i} className="flex justify-between text-[11px]">
                              <span className="text-zinc-500 capitalize">{t.label}</span>
                              <span className="text-zinc-300 font-mono">{t.amount}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11px] text-zinc-500">Totals nahi mile</p>
                      )}
                      {intel.checkout.subscriptionWords.length > 0 && (
                        <p className="text-[10px] text-amber-400 mt-2">
                          ⚠️ Subscription/recurring billing words: {intel.checkout.subscriptionWords.join(', ')}
                        </p>
                      )}
                      {intel.checkout.returnPolicyLink && (
                        <p className="text-[10px] text-zinc-500 mt-2 truncate">
                          Return policy: {intel.checkout.returnPolicyLink}
                        </p>
                      )}
                    </div>
                  )}

                  {/* forms */}
                  {intel.forms?.length > 0 && (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                      <p className="text-xs font-semibold mb-2">📝 Forms ({intel.forms.length})</p>
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {intel.forms.slice(0, 6).map((f, i) => (
                          <div key={i}>
                            <p className="text-[11px] text-zinc-300 truncate">
                              {f.heading || `Form ${i + 1}`}{' '}
                              {f.looksLikePayment && <span className="text-amber-400">· payment</span>}
                              {f.looksLikeCheckout && <span className="text-cyan-400">· checkout</span>}
                            </p>
                            <p className="text-[10px] text-zinc-500">
                              {f.fields.length} fields ({f.fields.filter((x) => x.sensitive).length} sensitive —
                              values kabhi capture nahi hote)
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* payment confirmation dialog (Feature 14) */}
      <Dialog open={payConfirm !== null} onOpenChange={(open) => !open && setPayConfirm(null)}>
        <DialogContent className="bg-zinc-900 border-zinc-700">
          <DialogHeader>
            <DialogTitle>Payment confirmation</DialogTitle>
            <DialogDescription>
              Ye ek PAYMENT/CHECKOUT action hai. Agent ye button khud kabhi nahi dabata — sirf tumhare
              explicit confirmation se. Confirm karne par page par click hoga (card data tumne khud bhara
              hoga, agent ne nahi).
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg bg-zinc-800/60 px-3 py-2 text-xs text-zinc-300 font-mono break-all">
            {payConfirm?.target}
          </div>
          <DialogFooter>
            <Button variant="outline" className="border-zinc-700" onClick={() => setPayConfirm(null)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 hover:bg-amber-500 text-white"
              onClick={async () => {
                const target = payConfirm?.target ?? '';
                setPayConfirm(null);
                await act('click', { target, confirmPayment: true });
              }}
            >
              Confirm payment click
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
