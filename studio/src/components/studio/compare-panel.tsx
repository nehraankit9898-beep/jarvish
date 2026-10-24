'use client';

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Zap, Settings2, Loader2, Clock, AlertTriangle } from 'lucide-react';
import { PROVIDERS, getProvider, type ProviderId } from '@/lib/providers';
import { isVerified, useConnections } from '@/lib/api-keys-store';

/**
 * ComparePanel — "Ek prompt, saare models ek saath" mode.
 * Jo providers Settings me connected hain, unhi pe real parallel calls
 * jaate hain (/api/compare) — koi mock nahi. Un-connected providers
 * selectable hi nahi hote.
 */

interface CompareResultView {
  provider: string;
  name: string;
  emoji: string;
  kind: string;
  model: string;
  ok: boolean;
  text: string;
  error: string;
  elapsedMs: number;
}

const SUGGESTIONS = [
  'Ek 4-line ki motivational shayari likho',
  'Explain recursion in one simple paragraph',
  'Ek chhota haiku likho coding par',
  'Best way to learn a new language? 3 tips',
];

export function ComparePanel({
  onOpenSettings,
}: {
  onOpenSettings?: () => void;
}) {
  const { connections, loaded } = useConnections();
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<CompareResultView[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const eligible = useMemo(
    () =>
      PROVIDERS.filter((p) => {
        if (p.id === 'zai') return true; // built-in — hamesha available, key nahi chahiye
        const c = connections[p.id as ProviderId];
        // only a configuration that passed its own test may be compared
        if (!isVerified(c)) return false;
        return !!(c?.apiKey?.trim() || c?.baseUrl?.trim() || c?.serverStored);
      }),
    [connections]
  );

  // jab eligible list bane, default sab select kar do
  useEffect(() => {
    if (!loaded) return;
    setSelected(new Set(eligible.map((p) => p.id)));
  }, [loaded, eligible]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runCompare = async () => {
    const q = prompt.trim();
    if (!q) return;
    if (selected.size === 0) return;
    setRunning(true);
    setError('');
    setResults(null);
    try {
      const targets = PROVIDERS.filter((p) => selected.has(p.id)).map((p) => {
        const c = connections[p.id as ProviderId];
        return {
          provider: p.id,
          model: c?.model || '',
          apiKey: c?.apiKey || '',
          baseUrl: c?.baseUrl || '',
        };
      });
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: q, targets }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setResults(data.results as CompareResultView[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compare fail hua');
    } finally {
      setRunning(false);
    }
  };

  const fastest = results?.filter((r) => r.ok).sort((a, b) => a.elapsedMs - b.elapsedMs)[0];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-xl bg-amber-500/15 ring-1 ring-amber-500/40 flex items-center justify-center shrink-0">
            <Zap className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold">Model Showdown ⚡</h2>
            <p className="text-sm text-zinc-400">
              Ek prompt — saare connected providers pe ek saath (parallel). Jo
              jawab pehle ya behtar aaya, wahi jeeta.
            </p>
          </div>
        </div>

        {/* Connected provider chips */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
            Available providers ({eligible.length}) — click karke on/off karo
          </div>
          {loaded && eligible.length === 0 ? (
            <div className="text-sm text-zinc-400 py-2">
              Koi provider connected nahi hai.{' '}
              {onOpenSettings ? (
                <button
                  onClick={onOpenSettings}
                  className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1"
                >
                  <Settings2 className="h-3.5 w-3.5" /> API Settings
                </button>
              ) : null}{' '}
              me jake connect karo (Z.ai built-in hai — bina key ke bhi chalega).
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {PROVIDERS.map((p) => {
                const isEligible = eligible.some((e) => e.id === p.id);
                const isSel = selected.has(p.id);
                return (
                  <button
                    key={p.id}
                    disabled={!isEligible}
                    onClick={() => toggle(p.id)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs border transition-colors ${
                      isSel
                        ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                        : isEligible
                          ? 'bg-zinc-800/60 border-zinc-700 text-zinc-300 hover:border-zinc-500'
                          : 'bg-zinc-900/40 border-zinc-800/60 text-zinc-600 cursor-not-allowed'
                    }`}
                  >
                    <span className="mr-1">{p.emoji}</span>
                    {p.name}
                    {!isEligible && (
                      <span className="ml-1 text-[10px] text-zinc-600">
                        (not connected)
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Prompt input */}
        <div className="space-y-2">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ek sawal likho — sabhi selected models ko ek saath jayega…"
            className="bg-zinc-900 border-zinc-800 min-h-24 text-sm"
            disabled={running}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={runCompare}
              disabled={running || !prompt.trim() || selected.size === 0}
              className="bg-amber-600 hover:bg-amber-500 text-white"
            >
              {running ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Zap className="h-4 w-4 mr-2" />
              )}
              {running
                ? `Sabhi ${selected.size} se puch raha hoon…`
                : `Sabhi ${selected.size} se pucho 🚀`}
            </Button>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setPrompt(s)}
                disabled={running}
                className="text-xs px-2.5 py-1.5 rounded-full border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40 transition-colors disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm p-3">
            {error}
          </div>
        )}

        {/* Running skeletons */}
        {running && (
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {Array.from(selected).map((id) => {
              const p = getProvider(id);
              return (
                <div
                  key={id}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2"
                >
                  <div className="flex items-center gap-2 text-sm text-zinc-300">
                    <span>{p?.emoji}</span>
                    <span className="font-medium">{p?.name}</span>
                    <Loader2 className="h-3.5 w-3.5 ml-auto animate-spin text-amber-400" />
                  </div>
                  <div className="space-y-1.5">
                    <div className="h-2.5 rounded bg-zinc-800 animate-pulse w-full" />
                    <div className="h-2.5 rounded bg-zinc-800 animate-pulse w-5/6" />
                    <div className="h-2.5 rounded bg-zinc-800 animate-pulse w-4/6" />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Results */}
        {results && (
          <div className="space-y-3">
            {fastest && (
              <div className="text-xs text-zinc-400">
                🏆 Fastest: <span className="text-emerald-400">{fastest.name}</span> —{' '}
                {fastest.elapsedMs} ms
              </div>
            )}
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {results.map((r) => (
                <div
                  key={r.provider}
                  className={`rounded-xl border p-4 flex flex-col ${
                    r.ok
                      ? 'border-zinc-800 bg-zinc-900/60'
                      : 'border-red-500/40 bg-red-500/5'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span>{r.emoji}</span>
                    <span className="text-sm font-semibold text-zinc-200">
                      {r.name}
                    </span>
                    {r.ok ? (
                      <Badge
                        variant="outline"
                        className="ml-auto text-[10px] text-zinc-400 border-zinc-700 gap-1"
                      >
                        <Clock className="h-3 w-3" /> {r.elapsedMs} ms
                      </Badge>
                    ) : (
                      <AlertTriangle className="h-4 w-4 ml-auto text-red-400" />
                    )}
                  </div>
                  <div className="text-[11px] text-zinc-500 mb-2 truncate">
                    {r.model}
                  </div>
                  {r.ok ? (
                    <ScrollArea className="max-h-64">
                      <div className="text-sm text-zinc-300 prose prose-invert prose-sm max-w-none [&_p]:mb-2 [&_pre]:bg-zinc-950 [&_code]:text-emerald-300">
                        <ReactMarkdown>{r.text}</ReactMarkdown>
                      </div>
                    </ScrollArea>
                  ) : (
                    <div className="text-xs text-red-300/90 break-words">
                      {r.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
