'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  LayoutDashboard,
  RefreshCw,
  CircleAlert,
  Server,
  KeyRound,
  Brain,
  FileText,
  Clock,
  ScrollText,
  ShieldCheck,
} from 'lucide-react';
import { SuggestionsCard } from './suggestions-card';

interface StatusSnapshot {
  ok: boolean;
  database: { ok: boolean; counts: Record<string, number> };
  python: { ok: boolean; version: string | null; agentscope: string | null };
  providers: {
    total: number;
    enabled: number;
    withKey: number;
    freeEnabled: number;
  };
  tools: { total: number; healthy: number; broken: number };
  security: { failClosed: boolean; production: boolean; hint: string };
}

interface TaskRow {
  id: string;
  prompt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface AuditRow {
  id: string;
  at: string;
  action: string;
  category: string;
  result: string;
  actor: string;
}

const statusTone: Record<string, string> = {
  completed: 'border-emerald-500/40 text-emerald-300',
  done: 'border-emerald-500/40 text-emerald-300',
  queued: 'border-zinc-600 text-zinc-300',
  awaiting_approval: 'border-amber-500/40 text-amber-300',
  running: 'border-sky-500/40 text-sky-300',
  verifying: 'border-cyan-500/40 text-cyan-300',
  planning: 'border-sky-500/40 text-sky-300',
  failed: 'border-red-500/40 text-red-300',
  cancelled: 'border-zinc-600 text-zinc-400',
  paused: 'border-zinc-600 text-zinc-400',
};

function Card({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4 text-emerald-400" />
        <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
      </div>
      {children}
    </section>
  );
}

export function DashboardPanel() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, tasksRes, auditRes] = await Promise.all([
        fetch('/api/system/status'),
        fetch('/api/agentic/tasks'),
        fetch('/api/audit?limit=12'),
      ]);
      if (statusRes.ok) setStatus(await statusRes.json());
      if (tasksRes.ok) setTasks(await tasksRes.json());
      if (auditRes.ok) setAudit(await auditRes.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <header className="h-14 shrink-0 border-b border-zinc-800 bg-zinc-900/30 backdrop-blur flex items-center gap-3 px-4">
        <LayoutDashboard className="h-5 w-5 text-emerald-400" />
        <h2 className="font-bold">Dashboard</h2>
        {status && (
          <Badge
            variant="outline"
            className={
              status.ok
                ? 'border-emerald-500/40 text-emerald-400 text-[10px]'
                : 'border-red-500/40 text-red-400 text-[10px]'
            }
          >
            {status.ok ? 'healthy' : 'degraded'}
          </Badge>
        )}
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

        {loading && !status ? (
          <div className="text-xs text-zinc-500">Loading…</div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card icon={Server} title="Runtime">
              {status ? (
                <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
                  <dt className="text-zinc-500">Database</dt>
                  <dd className={status.database.ok ? 'text-emerald-300' : 'text-red-300'}>
                    {status.database.ok ? 'connected' : 'unavailable'}
                  </dd>
                  <dt className="text-zinc-500">Python</dt>
                  <dd className="text-zinc-300">{status.python.version ?? 'not found'}</dd>
                  <dt className="text-zinc-500">AgentScope</dt>
                  <dd className="text-zinc-300">
                    {status.python.agentscope ?? 'not installed'}
                  </dd>
                  <dt className="text-zinc-500">Tools healthy</dt>
                  <dd className="text-zinc-300">
                    {status.tools.healthy}/{status.tools.total}
                  </dd>
                  <dt className="text-zinc-500">Auth policy</dt>
                  <dd
                    className={
                      status.security.failClosed ? 'text-emerald-300' : 'text-amber-300'
                    }
                  >
                    {status.security.production
                      ? status.security.failClosed
                        ? 'token required'
                        : 'open'
                      : 'open (dev)'}
                  </dd>
                </dl>
              ) : (
                <p className="text-xs text-zinc-500">No status available.</p>
              )}
            </Card>

            <Card icon={KeyRound} title="Providers">
              {status ? (
                <>
                  <p className="text-xs text-zinc-400">
                    {status.providers.total} configured · {status.providers.enabled} enabled ·{' '}
                    {status.providers.withKey} with a key · {status.providers.freeEnabled} free
                    &amp; enabled
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    {Object.entries(status.database.counts).map(([key, value]) => (
                      <div
                        key={key}
                        className="flex items-center justify-between rounded-md border border-zinc-800 px-2.5 py-1.5"
                      >
                        <span className="text-zinc-500">{key}</span>
                        <span className="text-zinc-200">{value}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-xs text-zinc-500">No provider data.</p>
              )}
            </Card>

            <Card icon={Brain} title="Recent agentic tasks">
              {tasks.length === 0 ? (
                <p className="text-xs text-zinc-500">No task yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {tasks.slice(0, 6).map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center gap-2 rounded-md border border-zinc-800 px-2.5 py-1.5"
                    >
                      <span className="flex-1 truncate text-xs text-zinc-300">{t.prompt}</span>
                      <Badge
                        variant="outline"
                        className={`text-[9px] ${statusTone[t.status] ?? 'border-zinc-600 text-zinc-400'}`}
                      >
                        {t.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Proactive suggestions (Feature 8) — the runtime proposes, the
                user decides. Full width under the two columns. */}
            <div className="lg:col-span-2">
              <SuggestionsCard />
            </div>

            <Card icon={ScrollText} title="Recent activity">
              {audit.length === 0 ? (
                <p className="text-xs text-zinc-500">Nothing recorded yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {audit.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center gap-2 rounded-md border border-zinc-800 px-2.5 py-1.5"
                    >
                      <span className="text-[10px] text-zinc-500 whitespace-nowrap">
                        {new Date(a.at).toLocaleTimeString()}
                      </span>
                      <span className="flex-1 truncate font-mono text-[11px] text-zinc-300">
                        {a.action}
                      </span>
                      <span
                        className={
                          a.result === 'error' ? 'text-[10px] text-red-400' : 'text-[10px] text-emerald-400'
                        }
                      >
                        {a.result}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card icon={ShieldCheck} title="What the Studio can do">
              <ul className="space-y-1.5 text-xs text-zinc-400">
                <li className="flex items-start gap-2">
                  <FileText className="h-3.5 w-3.5 mt-0.5 text-zinc-500 shrink-0" />
                  Import documents and answer with citations (Knowledge panel).
                </li>
                <li className="flex items-start gap-2">
                  <Brain className="h-3.5 w-3.5 mt-0.5 text-zinc-500 shrink-0" />
                  Store durable preferences that follow every task (Memory panel).
                </li>
                <li className="flex items-start gap-2">
                  <Clock className="h-3.5 w-3.5 mt-0.5 text-zinc-500 shrink-0" />
                  Run recurring work on a schedule (Automation panel).
                </li>
                <li className="flex items-start gap-2">
                  <ShieldCheck className="h-3.5 w-3.5 mt-0.5 text-zinc-500 shrink-0" />
                  Every privileged action is written to the audit trail.
                </li>
              </ul>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
