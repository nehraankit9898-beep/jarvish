'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Activity, RefreshCw, CircleAlert, ShieldCheck, Server, Cpu, Wrench, KeyRound } from 'lucide-react';
import { loadApiToken, saveApiToken } from '@/lib/api-token';
import { ConnectorsCard } from './connectors-card';
import { toast } from '@/hooks/use-toast';

interface SystemStatus {
  ok: boolean;
  at: string;
  durationMs: number;
  database: { ok: boolean; error?: string; counts: Record<string, number> };
  env: { ok: boolean; issues: { name: string; severity: string; message: string }[] };
  python: {
    ok: boolean;
    binary: string | null;
    version: string | null;
    agentscope: string | null;
    hint: string;
  };
  providers: {
    total: number;
    enabled: number;
    configured: number;
    withKey: number;
    freeEnabled: number;
    lastTest: { provider: string; ok: boolean; at: string | null }[];
    settings: Record<string, unknown> | null;
  };
  tools: { total: number; healthy: number; broken: number };
  security: {
    apiTokenConfigured: boolean;
    production: boolean;
    allowUnauthenticated: boolean;
    failClosed: boolean;
    hint: string;
  };
  runtime: { node: string; platform: string; cwd: string };
}

interface PolicyRow {
  action: string;
  level: string;
  requiresApproval: boolean;
  note: string;
}

interface Sample {
  command: string;
  permission: string;
  requiresApproval: boolean;
  reason: string;
}

const levelBadge: Record<string, string> = {
  safe: 'border-emerald-500/40 text-emerald-300',
  review: 'border-sky-500/40 text-sky-300',
  destructive: 'border-amber-500/40 text-amber-300',
  forbidden: 'border-red-500/40 text-red-300',
};

function Stat({
  icon: Icon,
  label,
  value,
  tone = 'text-zinc-200',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="flex items-center gap-2 text-zinc-500 mb-1">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <div className={`text-sm font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

export function SystemPanel() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [policy, setPolicy] = useState<PolicyRow[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [tokenSaved, setTokenSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, permRes] = await Promise.all([
        fetch('/api/system/status'),
        fetch('/api/system/permissions'),
      ]);
      if (!statusRes.ok) {
        const err = await statusRes.json().catch(() => ({ error: 'Failed to load status' }));
        throw new Error(err.error || 'Failed to load status');
      }
      setStatus(await statusRes.json());
      if (permRes.ok) {
        const perm = await permRes.json();
        setPolicy(perm.policy ?? []);
        setSamples(perm.samples ?? []);
        setNotes(perm.notes ?? []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    setToken(loadApiToken());
  }, [load]);

  const storeToken = useCallback(() => {
    saveApiToken(token);
    setTokenSaved(true);
    toast({
      title: 'API token saved in this browser',
      description: 'It is sent as `x-agentscope-token` with every API request.',
    });
    // re-read the status with the new token
    void load();
  }, [token, load]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <header className="h-14 shrink-0 border-b border-zinc-800 bg-zinc-900/30 backdrop-blur flex items-center gap-3 px-4">
        <Activity className="h-5 w-5 text-emerald-400" />
        <h2 className="font-bold">System</h2>
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

        <Tabs defaultValue="status">
          <TabsList className="mb-4">
            <TabsTrigger value="status">Status</TabsTrigger>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
          </TabsList>

          <TabsContent value="status">
            {loading && !status ? (
              <div className="text-xs text-zinc-500">Loading…</div>
            ) : status ? (
              <div className="space-y-4">
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <Stat
                    icon={Server}
                    label="Database"
                    value={status.database.ok ? 'connected' : 'unavailable'}
                    tone={status.database.ok ? 'text-emerald-300' : 'text-red-300'}
                  />
                  <Stat
                    icon={Cpu}
                    label="Python runtime"
                    value={status.python.version ?? 'not found'}
                    tone={status.python.ok ? 'text-zinc-200' : 'text-amber-300'}
                  />
                  <Stat
                    icon={Wrench}
                    label="Tools"
                    value={`${status.tools.healthy}/${status.tools.total} healthy`}
                    tone={status.tools.broken ? 'text-amber-300' : 'text-emerald-300'}
                  />
                  <Stat
                    icon={ShieldCheck}
                    label="Auth"
                    value={
                      status.security.production
                        ? status.security.failClosed
                          ? 'token required'
                          : 'open (dev)'
                        : 'open (dev)'
                    }
                    tone={status.security.failClosed ? 'text-emerald-300' : 'text-amber-300'}
                  />
                </div>

                {status.database.error && (
                  <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm p-3">
                    Database error: {status.database.error}
                  </div>
                )}

                {status.env?.issues?.length ? (
                  <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                    <h3 className="text-sm font-semibold text-zinc-200 mb-2">Configuration</h3>
                    <ul className="space-y-1.5">
                      {status.env.issues.map((issue) => (
                        <li
                          key={issue.name}
                          className={`rounded-md border p-2.5 text-[11px] ${
                            issue.severity === 'error'
                              ? 'border-red-500/40 bg-red-500/5 text-red-300'
                              : 'border-amber-500/40 bg-amber-500/5 text-amber-300'
                          }`}
                        >
                          <span className="font-mono font-semibold">{issue.name}</span>
                          <span className="ml-2">{issue.message}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <KeyRound className="h-4 w-4 text-emerald-400" />
                    <h3 className="text-sm font-semibold text-zinc-200">API token</h3>
                    {tokenSaved && (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/40 text-emerald-300 text-[10px]"
                      >
                        saved
                      </Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-500 mb-2">
                    When the server runs with <code className="text-zinc-400">AGENTSCOPE_API_TOKEN</code>{' '}
                    set, every API call has to carry it. Paste the token here — it is kept
                    in this browser only and sent as <code className="text-zinc-400">x-agentscope-token</code>.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="AGENTSCOPE_API_TOKEN"
                      className="bg-zinc-800/60 border-zinc-700 text-sm"
                    />
                    <Button onClick={storeToken} className="bg-emerald-600 hover:bg-emerald-500 text-white">
                      Save
                    </Button>
                  </div>
                </section>

                <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                  <h3 className="text-sm font-semibold text-zinc-200 mb-3">Content</h3>
                  <div className="grid sm:grid-cols-3 gap-2">
                    {Object.entries(status.database.counts).map(([key, value]) => (
                      <div
                        key={key}
                        className="flex items-center justify-between rounded-md border border-zinc-800 px-3 py-2"
                      >
                        <span className="text-[11px] text-zinc-500">{key}</span>
                        <span className="text-sm text-zinc-200">{value}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                  <h3 className="text-sm font-semibold text-zinc-200 mb-2">Providers</h3>
                  <p className="text-xs text-zinc-400">
                    {status.providers.total} configured · {status.providers.enabled} enabled ·{' '}
                    {status.providers.withKey} with a stored key ·{' '}
                    {status.providers.freeEnabled} free &amp; enabled
                  </p>
                  {status.providers.lastTest.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {status.providers.lastTest.map((t) => (
                        <Badge
                          key={t.provider}
                          variant="outline"
                          className={
                            t.ok
                              ? 'border-emerald-500/40 text-emerald-300 text-[10px]'
                              : 'border-red-500/40 text-red-300 text-[10px]'
                          }
                        >
                          {t.provider}: {t.ok ? 'ok' : 'failed'}
                        </Badge>
                      ))}
                    </div>
                  )}
                </section>

                <ConnectorsCard />

                <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                  <h3 className="text-sm font-semibold text-zinc-200 mb-2">Runtime</h3>
                  <dl className="grid sm:grid-cols-2 gap-y-1 text-xs">
                    <dt className="text-zinc-500">Node</dt>
                    <dd className="text-zinc-300">{status.runtime.node}</dd>
                    <dt className="text-zinc-500">Platform</dt>
                    <dd className="text-zinc-300">{status.runtime.platform}</dd>
                    <dt className="text-zinc-500">CWD</dt>
                    <dd className="text-zinc-300 break-all">{status.runtime.cwd}</dd>
                    <dt className="text-zinc-500">AgentScope (python)</dt>
                    <dd className="text-zinc-300">
                      {status.python.agentscope ?? 'not installed'}
                    </dd>
                  </dl>
                  <p className="text-[11px] text-zinc-500 mt-3">{status.python.hint}</p>
                  <p className="text-[11px] text-zinc-500 mt-1">{status.security.hint}</p>
                </section>
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="permissions">
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 mb-4">
              <h3 className="text-sm font-semibold text-zinc-200 mb-3">Policy</h3>
              <div className="space-y-2">
                {policy.map((row) => (
                  <div
                    key={row.action}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-zinc-100">{row.action}</span>
                      <Badge
                        variant="outline"
                        className={`text-[9px] ${levelBadge[row.level] ?? levelBadge.review}`}
                      >
                        {row.level}
                      </Badge>
                      {row.requiresApproval && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 text-amber-300 text-[9px]"
                        >
                          approval required
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-1">{row.note}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 mb-4">
              <h3 className="text-sm font-semibold text-zinc-200 mb-3">
                Live classification
              </h3>
              <div className="space-y-2">
                {samples.map((s) => (
                  <div
                    key={s.command}
                    className="flex items-center gap-3 rounded-md border border-zinc-800 px-3 py-2"
                  >
                    <code className="text-xs text-zinc-200 font-mono flex-1 truncate">
                      {s.command}
                    </code>
                    <Badge
                      variant="outline"
                      className={`text-[9px] ${levelBadge[s.permission] ?? levelBadge.review}`}
                    >
                      {s.permission}
                    </Badge>
                    <span className="text-[10px] text-zinc-500 truncate max-w-[280px]">
                      {s.reason}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {notes.length > 0 && (
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                <h3 className="text-sm font-semibold text-zinc-200 mb-2">Principles</h3>
                <ul className="list-disc pl-5 space-y-1">
                  {notes.map((n) => (
                    <li key={n} className="text-xs text-zinc-400">
                      {n}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
