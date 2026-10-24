// suggestions-card.tsx — proactive suggestions on the dashboard (Feature 8).
//
// The runtime analyses the task history and proposes actions. Accepting a
// suggestion creates + plans a task (nothing runs by itself); dismissing
// hides it. Evidence is shown so the user can judge before acting.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Lightbulb, Check, X, Loader2, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';

interface Suggestion {
  id: string;
  kind: string;
  title: string;
  body: string;
  actionPrompt: string;
  status: string;
  taskId: string;
  createdAt: string;
}

const KIND_META: Record<string, { emoji: string; label: string }> = {
  recurring_check: { emoji: '🔁', label: 'Recurring check' },
  docs_update: { emoji: '📚', label: 'Docs' },
  failed_schedule: { emoji: '⏰', label: 'Automation' },
  follow_up: { emoji: '➡️', label: 'Follow-up' },
  cleanup: { emoji: '🧹', label: 'Cleanup' },
  downloads_cleanup: { emoji: '🧹', label: 'Downloads' },
  stuck_task: { emoji: '🧊', label: 'Stuck task' },
  morning_summary: { emoji: '🌅', label: 'Morning' },
};

export function SuggestionsCard({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState('');
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/suggestions?status=open');
      if (res.ok) {
        const data = await res.json();
        setSuggestions(data.suggestions ?? []);
      }
    } catch {
      // the card never breaks the dashboard
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (id: string, action: 'accept' | 'dismiss' | 'mute') => {
    setBusy(`${action}:${id}`);
    try {
      const res = await fetch('/api/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Action failed');
      if (action === 'accept' && data.taskId) {
        toast({
          title: 'Suggestion accepted — task planned',
          description: 'Agentic panel me plan review karke run start karo.',
        });
        onOpenTask?.(data.taskId);
      } else if (action === 'dismiss') {
        toast({ title: 'Suggestion dismissed' });
      }
      await load();
    } catch (err) {
      toast({
        title: 'Action failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusy('');
    }
  };

  const rescan = async () => {
    setScanning(true);
    try {
      await fetch('/api/suggestions?status=open');
      await load();
      toast({ title: 'Scan complete', description: 'Runtime apne regular interval par bhi scan karta hai.' });
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-semibold">Proactive Suggestions</h3>
          {suggestions.length > 0 && (
            <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">
              {suggestions.length} open
            </Badge>
          )}
        </div>
        <button
          onClick={rescan}
          className="text-[11px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
        >
          {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Refresh
        </button>
      </div>

      {suggestions.length === 0 ? (
        <p className="text-[11px] text-zinc-600 py-4 text-center">
          Runtime task history analyse karke yahan suggestions dega — e.g. &quot;build 2 baar fail hua,
          recurring check banau?&quot;
        </p>
      ) : (
        <div className="space-y-2">
          {suggestions.slice(0, 4).map((s) => {
            const meta = KIND_META[s.kind] ?? { emoji: '💡', label: s.kind };
            return (
              <div
                key={s.id}
                className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5"
              >
                <div className="flex items-start gap-2">
                  <span className="text-sm">{meta.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-zinc-200 font-medium leading-snug">{s.title}</p>
                    {s.body && <p className="text-[11px] text-zinc-500 mt-1 line-clamp-2">{s.body}</p>}
                    <p className="text-[10px] text-zinc-600 mt-1">
                      {meta.label} · {new Date(s.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <Button
                      size="sm"
                      className="h-7 text-[11px] bg-emerald-600 hover:bg-emerald-500"
                      disabled={busy === `accept:${s.id}`}
                      onClick={() => decide(s.id, 'accept')}
                    >
                      {busy === `accept:${s.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="h-3 w-3 mr-1" />
                      )}
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px] border-zinc-700 text-zinc-400"
                      disabled={busy === `dismiss:${s.id}`}
                      onClick={() => decide(s.id, 'dismiss')}
                      aria-label="Dismiss"
                      title="Dismiss"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] border-zinc-800 text-zinc-500 hover:text-zinc-300"
                      disabled={busy === `mute:${s.id}`}
                      onClick={() => decide(s.id, 'mute')}
                      aria-label="Aage se mat batao"
                      title="Aage se mat batao — is type ka suggestion phir kabhi nahi aayega"
                    >
                      <EyeOff className="h-3 w-3 mr-1" />
                      Mat batao
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
