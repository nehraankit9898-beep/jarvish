// goals-panel.tsx — long-running goals UI (Feature 2).
//
// Create a goal (the planner decomposes it into task prompts), watch the
// per-task progress and start the next runnable task. Nothing auto-runs:
// "Next task" creates + PLANS the task; the run starts from the Agentic
// panel after the plan review — same as every other task.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Target, Plus, Play, Ban, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/hooks/use-toast';

interface GoalTask {
  index: number;
  title: string;
  dependsOn: number[];
  taskId: string;
  taskStatus: string | null;
}

interface Goal {
  id: string;
  title: string;
  description: string;
  status: string;
  tasks: GoalTask[];
  progress: { total: number; done: number; active: boolean };
  createdAt: string;
}

const STATUS_TONE: Record<string, string> = {
  done: 'border-emerald-500/40 text-emerald-400',
  failed: 'border-red-500/40 text-red-400',
  cancelled: 'border-zinc-600 text-zinc-400',
  running: 'border-sky-500/40 text-sky-400',
  awaiting_approval: 'border-amber-500/40 text-amber-400',
  paused: 'border-zinc-500 text-zinc-400',
  planning: 'border-violet-500/40 text-violet-400',
  queued: 'border-zinc-600 text-zinc-400',
  verifying: 'border-sky-500/40 text-sky-400',
};

export function GoalsPanel({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/goals');
      if (res.ok) {
        const data = await res.json();
        setGoals(data.goals ?? []);
      }
    } catch {
      // panel stays usable
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!title.trim() || description.trim().length < 8 || creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Create failed');
      toast({
        title: 'Goal created',
        description: `Planner ne ${data.tasks?.length ?? 0} tasks me toda. Ab "Next task" se ek-ek karke chalao.`,
      });
      setTitle('');
      setDescription('');
      await load();
    } catch (err) {
      toast({
        title: 'Create failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  };

  const nextTask = async (goalId: string) => {
    setBusy(`next:${goalId}`);
    try {
      const res = await fetch(`/api/goals/${goalId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'next' }),
      });
      const data = await res.json();
      if (data.taskId) {
        toast({
          title: 'Goal task planned',
          description: 'Plan review karke Agentic panel se run start karo.',
        });
        onOpenTask?.(data.taskId);
      } else {
        toast({ title: 'Next task', description: data.reason ?? 'Nothing to start' });
      }
      await load();
    } catch (err) {
      toast({
        title: 'Failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusy('');
    }
  };

  const abandon = async (goalId: string) => {
    if (!confirm('Abandon this goal? Existing tasks are kept.')) return;
    setBusy(`abandon:${goalId}`);
    try {
      const res = await fetch(`/api/goals/${goalId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'abandon' }),
      });
      if (res.ok) await load();
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="h-full overflow-hidden flex flex-col">
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/30 px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Target className="h-4 w-4 text-emerald-400" />
          <h2 className="font-semibold text-sm">Long-Running Goals</h2>
          <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">
            Feature 2
          </Badge>
        </div>
        <p className="text-[11px] text-zinc-500">
          Bada goal do — planner usse chhote tasks me todta hai. Har task purani engine guarantees
          ke saath chalta hai (workspace, approvals, test gate). Progress restart ke baad bhi bachi rehti hai.
        </p>
        <div className="mt-3 grid sm:grid-cols-[200px_1fr_auto] gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Goal title (e.g. Production readiness)"
            className="bg-zinc-900 border-zinc-700 text-sm"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Goal description — planner isi ko todta hai (e.g. 'Mere software ko audit karke production-ready banao')"
            className="bg-zinc-900 border-zinc-700 text-sm min-h-[38px] h-[38px] resize-none"
            rows={1}
          />
          <Button onClick={create} disabled={creating || !title.trim() || description.trim().length < 8}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Create
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-3 max-w-4xl mx-auto">
          {goals.length === 0 && (
            <div className="text-center py-16 text-zinc-500 text-sm">
              <Target className="h-10 w-10 mx-auto mb-3 opacity-30" />
              Abhi koi goal nahi. Upar ek bada objective likho — planner use task queue bana dega.
            </div>
          )}
          {goals.map((goal) => (
            <div key={goal.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm truncate">{goal.title}</h3>
                  <p className="text-[11px] text-zinc-500 line-clamp-2 mt-0.5">{goal.description}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge
                    variant="outline"
                    className={
                      goal.status === 'active'
                        ? 'border-emerald-500/40 text-emerald-400'
                        : goal.status === 'completed'
                          ? 'border-sky-500/40 text-sky-400'
                          : 'border-zinc-600 text-zinc-400'
                    }
                  >
                    {goal.status}
                  </Badge>
                  {goal.status === 'active' && (
                    <>
                      <Button size="sm" onClick={() => nextTask(goal.id)} disabled={busy === `next:${goal.id}`}>
                        {busy === `next:${goal.id}` ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="h-3.5 w-3.5 mr-1" />
                        )}
                        Next task
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-zinc-700 text-zinc-400"
                        onClick={() => abandon(goal.id)}
                        disabled={busy === `abandon:${goal.id}`}
                      >
                        <Ban className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* progress */}
              <div className="flex items-center gap-2 mb-3">
                <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all"
                    style={{ width: `${goal.progress.total ? (goal.progress.done / goal.progress.total) * 100 : 0}%` }}
                  />
                </div>
                <span className="text-[11px] text-zinc-500 shrink-0">
                  {goal.progress.done}/{goal.progress.total} done
                </span>
              </div>

              {/* task queue */}
              <div className="space-y-1">
                {goal.tasks.map((t) => (
                  <div
                    key={t.index}
                    className="flex items-center gap-2 rounded-lg bg-zinc-800/40 px-2.5 py-1.5"
                  >
                    <span className="text-[11px] text-zinc-500 w-5 shrink-0">#{t.index}</span>
                    <span className="text-xs text-zinc-300 flex-1 truncate">{t.title}</span>
                    {t.dependsOn.length > 0 && (
                      <span className="text-[10px] text-zinc-600 shrink-0 hidden sm:inline">
                        needs {t.dependsOn.join(', ')}
                      </span>
                    )}
                    {t.taskId ? (
                      <button
                        onClick={() => onOpenTask?.(t.taskId)}
                        className="shrink-0"
                        title="Open in Agentic panel"
                      >
                        <Badge
                          variant="outline"
                          className={`text-[10px] cursor-pointer hover:brightness-125 ${
                            STATUS_TONE[t.taskStatus ?? ''] ?? 'border-zinc-600 text-zinc-400'
                          }`}
                        >
                          {t.taskStatus ?? '—'}
                        </Badge>
                      </button>
                    ) : (
                      <Badge variant="outline" className="text-[10px] border-zinc-700 text-zinc-500 shrink-0">
                        not started
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
