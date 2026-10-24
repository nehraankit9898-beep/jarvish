'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Clock, Play, Plus, RefreshCw, Trash2, CircleAlert, Ban, ChefHat, Check } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface Schedule {
  id: string;
  name: string;
  prompt: string;
  intervalMs: number;
  cronExpr: string;
  timezone: string;
  misfirePolicy: string;
  enabled: boolean;
  provider: string;
  model: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string;
  createdAt: string;
}

interface Recipe {
  id: string;
  title: string;
  description: string;
  cronExpr?: string;
  intervalMs?: number;
  risk: string;
  appliedScheduleId: string | null;
}

interface Run {
  id: string;
  scheduleId: string;
  taskId: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';
  error: string;
  result: string;
}

function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}

const runBadge: Record<string, string> = {
  running: 'border-sky-500/40 text-sky-300',
  done: 'border-emerald-500/40 text-emerald-300',
  failed: 'border-red-500/40 text-red-300',
  skipped: 'border-zinc-600 text-zinc-400',
  cancelled: 'border-amber-500/40 text-amber-300',
};

export function AutomationPanel() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [intervalMin, setIntervalMin] = useState(60);
  // ---- cron mode (Feature 5) ----
  const [useCron, setUseCron] = useState(false);
  const [cronExpr, setCronExpr] = useState('0 9 * * MON-FRI');
  const [timezone, setTimezone] = useState('');
  const [misfirePolicy, setMisfirePolicy] = useState<'skip' | 'run_once' | 'catch_up'>('skip');
  // ---- laptop-control recipes (Roadmap #10) ----
  const [recipes, setRecipes] = useState<Recipe[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/automation');
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to load automations' }));
        throw new Error(err.error || 'Failed to load automations');
      }
      const data = await res.json();
      setSchedules(data.schedules ?? []);
      setRuns(data.runs ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load automations');
    } finally {
      setLoading(false);
    }
    // recipes load independently — a failure here must not blank the panel
    try {
      const r = await fetch('/api/recipes');
      if (r.ok) {
        const rd = await r.json();
        setRecipes(rd.recipes ?? []);
      }
    } catch {
      /* recipes are optional */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    if (!name.trim() || prompt.trim().length < 8) {
      setError('A name and a prompt of at least 8 characters are required');
      return;
    }
    setBusy('create');
    setError(null);
    try {
      const res = await fetch('/api/automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          prompt,
          ...(useCron
            ? { cronExpr: cronExpr.trim(), timezone: timezone.trim(), misfirePolicy }
            : { intervalMs: Math.max(60_000, intervalMin * 60_000) }),
          enabled: false,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Create failed');
      setName('');
      setPrompt('');
      toast({
        title: 'Schedule created',
        description: 'It is disabled — enable it when you are happy with the prompt.',
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Create failed';
      setError(msg);
      toast({ title: 'Create failed', description: msg, variant: 'destructive' });
    } finally {
      setBusy('');
    }
  }, [name, prompt, intervalMin, useCron, cronExpr, timezone, misfirePolicy, load]);

  const toggle = useCallback(
    async (schedule: Schedule, enabled: boolean) => {
      setBusy(`toggle:${schedule.id}`);
      try {
        const res = await fetch(`/api/automation/${schedule.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Update failed');
        await load();
        toast({
          title: enabled ? 'Schedule enabled' : 'Schedule disabled',
          description: schedule.name,
        });
      } catch (err) {
        toast({
          title: 'Update failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      } finally {
        setBusy('');
      }
    },
    [load]
  );

  const runNow = useCallback(
    async (schedule: Schedule) => {
      setBusy(`run:${schedule.id}`);
      try {
        const res = await fetch(`/api/automation/${schedule.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run' }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Run failed');
        if (data.status === 'skipped') {
          toast({
            title: 'Duplicate run prevented',
            description: 'The schedule is already running.',
          });
        } else {
          toast({
            title: 'Run started',
            description: data.taskId ? `Task ${data.taskId}` : undefined,
          });
        }
        await load();
      } catch (err) {
        toast({
          title: 'Run failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      } finally {
        setBusy('');
      }
    },
    [load]
  );

  const remove = useCallback(
    async (schedule: Schedule) => {
      setBusy(`remove:${schedule.id}`);
      try {
        const res = await fetch(`/api/automation/${schedule.id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Delete failed');
        await load();
      } catch (err) {
        toast({
          title: 'Delete failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      } finally {
        setBusy('');
      }
    },
    [load]
  );

  const applyRecipe = useCallback(
    async (recipe: Recipe) => {
      setBusy(`recipe:${recipe.id}`);
      try {
        const res = await fetch('/api/recipes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipeId: recipe.id, enabled: false }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Recipe apply failed');
        toast({
          title: 'Recipe ready',
          description: `${recipe.title} schedule ban gaya — enable karke chalao.`,
        });
        await load();
      } catch (err) {
        toast({
          title: 'Recipe apply failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      } finally {
        setBusy('');
      }
    },
    [load]
  );

  const cancel = useCallback(
    async (run: Run) => {
      setBusy(`cancel:${run.id}`);
      try {
        const res = await fetch(`/api/automation/${run.scheduleId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', runId: run.id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Cancel failed');
        await load();
      } catch (err) {
        toast({
          title: 'Cancel failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      } finally {
        setBusy('');
      }
    },
    [load]
  );

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <header className="h-14 shrink-0 border-b border-zinc-800 bg-zinc-900/30 backdrop-blur flex items-center gap-3 px-4">
        <Clock className="h-5 w-5 text-violet-400" />
        <h2 className="font-bold">Automation</h2>
        <Badge variant="outline" className="border-violet-500/30 text-violet-400 text-[10px]">
          {schedules.length} schedule(s)
        </Badge>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => void load()} className="h-9">
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm p-3 flex items-start gap-2">
            <CircleAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <section className="mb-5 rounded-xl border border-violet-500/20 bg-violet-500/5 p-4">
          <h3 className="text-sm font-semibold text-zinc-200 mb-1 flex items-center gap-2">
            <ChefHat className="h-4 w-4 text-violet-400" /> Recipes — ready-made automations
          </h3>
          <p className="text-xs text-zinc-500 mb-3">
            Ek click me schedule ban jata hai (disabled). Enable karte hi background runtime chalayega — destructive steps phir bhi approval maangenge.
          </p>
          {recipes.length === 0 ? (
            <p className="text-xs text-zinc-600">Recipes load nahi hui (optional).</p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {recipes.map((r) => (
                <div key={r.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-zinc-200 truncate">{r.title}</div>
                      <div className="text-xs text-zinc-500 mt-0.5">{r.description}</div>
                    </div>
                    <Badge variant="outline" className={`shrink-0 text-[10px] ${r.risk === 'medium' ? 'border-amber-500/40 text-amber-300' : 'border-emerald-500/40 text-emerald-300'}`}>
                      {r.risk}
                    </Badge>
                  </div>
                  <div className="text-[10px] text-zinc-600 font-mono">
                    {r.cronExpr ? `cron: ${r.cronExpr}` : `interval: ${formatInterval(r.intervalMs ?? 3_600_000)}`}
                  </div>
                  <Button
                    size="sm"
                    variant={r.appliedScheduleId ? 'outline' : 'default'}
                    disabled={busy === `recipe:${r.id}` || Boolean(r.appliedScheduleId)}
                    onClick={() => void applyRecipe(r)}
                    className="self-start bg-violet-600 hover:bg-violet-500"
                  >
                    {r.appliedScheduleId ? (
                      <>
                        <Check className="mr-1 h-3.5 w-3.5" /> Applied
                      </>
                    ) : (
                      <>
                        <Plus className="mr-1 h-3.5 w-3.5" /> Apply
                      </>
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mb-5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="text-sm font-semibold text-zinc-200 mb-3">New schedule</h3>
          <div className="grid sm:grid-cols-[1fr_160px] gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-400">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="nightly dependency check"
                className="bg-zinc-800/60 border-zinc-700 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-400">Timing mode</Label>
              <div className="flex rounded-lg border border-zinc-700 overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setUseCron(false)}
                  className={`flex-1 px-2 py-2 transition-colors ${!useCron ? 'bg-violet-600 text-white' : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800'}`}
                >
                  Interval
                </button>
                <button
                  type="button"
                  onClick={() => setUseCron(true)}
                  className={`flex-1 px-2 py-2 transition-colors ${useCron ? 'bg-violet-600 text-white' : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800'}`}
                >
                  Cron
                </button>
              </div>
            </div>
          </div>

          {useCron ? (
            <div className="grid sm:grid-cols-[1fr_170px_150px] gap-3 mt-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-400">
                  Cron expression (min hour dom month dow)
                </Label>
                <Input
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="30 8 * * *  (daily 8:30)"
                  className="bg-zinc-800/60 border-zinc-700 text-sm font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-400">Timezone (optional)</Label>
                <Input
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="Asia/Kolkata"
                  className="bg-zinc-800/60 border-zinc-700 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-400" title="Server band tha to missed runs ka kya karein?">
                  Missed runs
                </Label>
                <select
                  value={misfirePolicy}
                  onChange={(e) => setMisfirePolicy(e.target.value as typeof misfirePolicy)}
                  className="w-full h-9 rounded-lg bg-zinc-800/60 border border-zinc-700 text-sm px-2"
                >
                  <option value="skip">skip (default)</option>
                  <option value="run_once">run once</option>
                  <option value="catch_up">catch up (max 5)</option>
                </select>
              </div>
            </div>
          ) : (
            <div className="grid sm:grid-cols-[160px] gap-3 mt-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-400">Every (minutes)</Label>
                <Input
                  type="number"
                  value={intervalMin}
                  min={1}
                  onChange={(e) => setIntervalMin(Number(e.target.value) || 1)}
                  className="bg-zinc-800/60 border-zinc-700 text-sm"
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5 mt-3">
            <Label className="text-xs text-zinc-400">Prompt the agent will run</Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="Check the project dependencies and report anything outdated."
              className="bg-zinc-800/60 border-zinc-700 text-sm"
            />
          </div>
          <Button
            onClick={() => void create()}
            disabled={busy === 'create'}
            className="mt-3 bg-violet-600 hover:bg-violet-500 text-white"
          >
            <Plus className="h-4 w-4 mr-2" />
            Create (disabled)
          </Button>
        </section>

        <section className="mb-5">
          <h3 className="text-sm font-semibold text-zinc-200 mb-2">Schedules</h3>
          {loading ? (
            <div className="text-xs text-zinc-500">Loading…</div>
          ) : schedules.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
              No schedule yet.
            </div>
          ) : (
            <div className="space-y-2">
              {schedules.map((s) => (
                <div
                  key={s.id}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-zinc-100">{s.name}</div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">
                        {s.cronExpr ? (
                          <>
                            <span className="font-mono text-violet-300">{s.cronExpr}</span>
                            {s.timezone ? ` (${s.timezone})` : ''} · missed: {s.misfirePolicy} ·{' '}
                          </>
                        ) : (
                          <>every {formatInterval(s.intervalMs)} · </>
                        )}
                        {s.enabled
                          ? s.nextRunAt
                            ? `next run ${new Date(s.nextRunAt).toLocaleString()}`
                            : 'armed'
                          : 'disabled'}
                        {s.lastStatus ? ` · last: ${s.lastStatus}` : ''}
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                      <Switch
                        checked={s.enabled}
                        disabled={busy === `toggle:${s.id}`}
                        onCheckedChange={(v) => void toggle(s, v)}
                      />
                      {s.enabled ? 'on' : 'off'}
                    </label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runNow(s)}
                      disabled={busy === `run:${s.id}`}
                    >
                      <Play className="h-3.5 w-3.5 mr-1" />
                      Run
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove(s)}
                      disabled={busy === `remove:${s.id}`}
                      aria-label={`Delete ${s.name}`}
                      className="text-red-400 hover:text-red-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-2 line-clamp-2">{s.prompt}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="text-sm font-semibold text-zinc-200 mb-2">Recent runs</h3>
          {runs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
              No run yet.
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map((r) => (
                <div
                  key={r.id}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 flex items-center gap-3"
                >
                  <Badge
                    variant="outline"
                    className={`text-[9px] ${runBadge[r.status] ?? runBadge.skipped}`}
                  >
                    {r.status}
                  </Badge>
                  <span className="text-[11px] text-zinc-500">
                    {new Date(r.startedAt).toLocaleString()}
                  </span>
                  {r.taskId && (
                    <span className="text-[11px] text-zinc-400">task {r.taskId}</span>
                  )}
                  {r.error && <span className="text-[11px] text-red-400">{r.error}</span>}
                  {r.result && !r.error && (
                    <span className="text-[11px] text-zinc-500 truncate">{r.result}</span>
                  )}
                  {r.status === 'running' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void cancel(r)}
                      className="ml-auto text-amber-400 hover:text-amber-300"
                    >
                      <Ban className="h-3.5 w-3.5 mr-1" />
                      Cancel
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
