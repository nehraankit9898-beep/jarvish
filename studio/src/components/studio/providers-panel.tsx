'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  PlugZap,
  RefreshCw,
  Trash2,
  ShieldCheck,
  KeyRound,
  CircleAlert,
  ListChecks,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface ProviderDto {
  provider: string;
  name: string;
  emoji: string;
  label: string;
  enabled: boolean;
  priority: number;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  costClass: 'free' | 'paid' | 'unknown';
  hasKey: boolean;
  keyHint: string;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastError: string;
  inCatalog: boolean;
  catalogFree: boolean;
  /** false when the provider has no stored server-side configuration yet */
  configured: boolean;
}

interface ModelPreference {
  role: string;
  provider: string;
  model: string;
  enabled: boolean;
  updatedAt: string;
}

interface StudioSettings {
  freeOnly: boolean;
  preferFree: boolean;
  autoFallback: boolean;
  defaultProvider: string;
  defaultModel: string;
}

interface OrderRow {
  provider: string;
  priority: number;
  enabled: boolean;
  costClass: 'free' | 'paid' | 'unknown';
  timeoutMs: number;
  maxRetries: number;
  baseUrl: string;
  model: string;
}

const ROLES = ['planner', 'coder', 'tester', 'reviewer'] as const;

const costBadge: Record<string, string> = {
  free: 'border-emerald-500/40 text-emerald-300',
  paid: 'border-amber-500/40 text-amber-300',
  unknown: 'border-zinc-600 text-zinc-400',
};

export function ProvidersPanel() {
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [order, setOrder] = useState<OrderRow[]>([]);
  const [preferences, setPreferences] = useState<ModelPreference[]>([]);
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // draft of the selected provider
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [priority, setPriority] = useState(100);
  const [timeoutMs, setTimeoutMs] = useState(120000);
  const [maxRetries, setMaxRetries] = useState(2);
  const [costClass, setCostClass] = useState<'free' | 'paid' | 'unknown'>('unknown');
  const [models, setModels] = useState<{ id: string; free?: boolean }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/providers');
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to load providers' }));
        throw new Error(err.error || 'Failed to load providers');
      }
      const data = await res.json();
      setProviders(data.providers ?? []);
      setOrder(data.order ?? []);
      setPreferences(data.preferences ?? []);
      setSettings(data.settings ?? null);
      setError(null);
      if (!selected && (data.providers ?? []).length) {
        setSelected(data.providers[0].provider);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load providers');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, []);

  const current = useMemo(
    () => providers.find((p) => p.provider === selected) ?? null,
    [providers, selected]
  );

  // keep the draft in sync with the selected provider
  useEffect(() => {
    if (!current) return;
    setApiKey('');
    setModel(current.model);
    setBaseUrl(current.baseUrl);
    setPriority(current.priority);
    setTimeoutMs(current.timeoutMs);
    setMaxRetries(current.maxRetries);
    setCostClass(current.costClass);
    setModels([]);
  }, [current?.provider]);

  const save = useCallback(async () => {
    if (!current) return;
    setBusy('save');
    setError(null);
    try {
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: current.provider,
          model,
          baseUrl,
          priority,
          timeoutMs,
          maxRetries,
          costClass,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setApiKey('');
      toast({ title: 'Saved', description: `${current.name} configuration updated.` });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setError(msg);
      toast({ title: 'Save failed', description: msg, variant: 'destructive' });
    } finally {
      setBusy('');
    }
  }, [current, model, baseUrl, priority, timeoutMs, maxRetries, costClass, apiKey, load]);

  const toggleEnabled = useCallback(
    async (provider: string, enabled: boolean) => {
      setBusy(`toggle:${provider}`);
      setError(null);
      try {
        const res = await fetch(`/api/providers/${provider}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Update failed');
        await load();
        toast({
          title: enabled ? 'Provider enabled' : 'Provider disabled',
          description: provider,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Update failed';
        setError(msg);
        toast({ title: 'Update failed', description: msg, variant: 'destructive' });
      } finally {
        setBusy('');
      }
    },
    [load]
  );

  const test = useCallback(async () => {
    if (!current) return;
    setBusy('test');
    setError(null);
    try {
      const res = await fetch(`/api/providers/${current.provider}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          ...(model ? { model } : {}),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: 'Connection OK', description: data.message });
      } else {
        setError(data.error || 'Connection failed');
        toast({
          title: 'Connection failed',
          description: data.error || 'Unknown error',
          variant: 'destructive',
        });
      }
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed';
      setError(msg);
      toast({ title: 'Connection failed', description: msg, variant: 'destructive' });
    } finally {
      setBusy('');
    }
  }, [current, apiKey, baseUrl, model, load]);

  const loadModels = useCallback(async () => {
    if (!current) return;
    setModelsLoading(true);
    try {
      const res = await fetch(`/api/providers/${current.provider}/models`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not list models');
      setModels(data.models ?? []);
      toast({
        title: data.source === 'provider' ? 'Models from provider' : 'Catalog models',
        description: `${(data.models ?? []).length} model(s)`,
      });
    } catch (err) {
      toast({
        title: 'Could not list models',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setModelsLoading(false);
    }
  }, [current]);

  const remove = useCallback(async () => {
    if (!current) return;
    setBusy('remove');
    try {
      const res = await fetch(`/api/providers/${current.provider}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setSelected('');
      toast({ title: 'Provider removed', description: current.provider });
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
  }, [current, load]);

  const saveSettings = useCallback(
    async (patch: Partial<StudioSettings>) => {
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Settings failed');
        setSettings(data);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Settings failed');
      }
    },
    [load]
  );

  const savePreference = useCallback(
    async (role: string, provider: string, modelName: string) => {
      try {
        const res = await fetch('/api/model-preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role, provider, model: modelName }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Preference failed');
        setPreferences((prev) => [
          ...prev.filter((p) => p.role !== role),
          { role, provider, model: modelName, enabled: true, updatedAt: data.updatedAt },
        ]);
        toast({ title: 'Preference saved', description: role });
      } catch (err) {
        toast({
          title: 'Preference failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      }
    },
    []
  );

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <header className="h-14 shrink-0 border-b border-zinc-800 bg-zinc-900/30 backdrop-blur flex items-center gap-3 px-4">
        <PlugZap className="h-5 w-5 text-emerald-400" />
        <h2 className="font-bold">Providers &amp; Models</h2>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          className="h-9"
        >
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

        {/* ---- global policy ---- */}
        {settings && (
          <section className="mb-5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-zinc-200">Routing policy</h3>
            </div>
            <div className="space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <Switch
                  checked={settings.preferFree}
                  onCheckedChange={(v) => void saveSettings({ preferFree: v })}
                />
                <span className="text-xs text-zinc-300">
                  <span className="font-semibold text-zinc-100">Free-tier first</span>
                  <span className="block text-zinc-500">
                    Try a free provider (local Ollama, OpenRouter :free models, Z.ai) before a
                    paid one. A paid provider is still used as a fallback when no free target
                    is available, so a task is never dropped.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <Switch
                  checked={settings.freeOnly}
                  onCheckedChange={(v) => void saveSettings({ freeOnly: v })}
                />
                <span className="text-xs text-zinc-300">
                  <span className="font-semibold text-zinc-100">Free-only mode</span>
                  <span className="block text-zinc-500">
                    The router may only use providers classified as free. A paid model is
                    never selected and never used as a fallback — if no free model is
                    available the task pauses with an explanation.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <Switch
                  checked={settings.autoFallback}
                  onCheckedChange={(v) => void saveSettings({ autoFallback: v })}
                />
                <span className="text-xs text-zinc-300">
                  <span className="font-semibold text-zinc-100">Automatic fallback</span>
                  <span className="block text-zinc-500">
                    When the primary model fails, try the next configured model of the same
                    role. With this off only the primary model is used.
                  </span>
                </span>
              </label>
            </div>
          </section>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
          {/* ---- provider list ---- */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
            <div className="px-3 py-2 border-b border-zinc-800 text-xs font-semibold text-zinc-400 uppercase">
              Providers ({providers.length})
            </div>
            {loading ? (
              <div className="p-4 text-xs text-zinc-500">Loading…</div>
            ) : providers.length === 0 ? (
              <div className="p-4 text-xs text-zinc-500">
                No provider available. Check the server logs — the provider catalog could not be
                loaded.
              </div>
            ) : (
              <div className="max-h-[520px] overflow-y-auto">
                {providers.map((p) => (
                  <button
                    key={p.provider}
                    onClick={() => setSelected(p.provider)}
                    className={`w-full text-left px-3 py-2 border-b border-zinc-800/60 flex items-center gap-2 ${
                      selected === p.provider
                        ? 'bg-zinc-800/80 text-emerald-300'
                        : 'text-zinc-400 hover:bg-zinc-800/40'
                    }`}
                  >
                    <span>{p.emoji}</span>
                    <span className="flex-1 truncate text-xs">{p.name}</span>
                    <Badge
                      variant="outline"
                      className={`text-[9px] ${costBadge[p.costClass] ?? costBadge.unknown}`}
                    >
                      {p.costClass}
                    </Badge>
                    {!p.configured && (
                      <span
                        className="text-[9px] text-amber-400/80"
                        title="No server-side configuration yet — add a key or settings below"
                      >
                        setup
                      </span>
                    )}
                    {p.enabled ? (
                      <span className="text-[10px] text-emerald-400">on</span>
                    ) : (
                      <span className="text-[10px] text-zinc-600">off</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ---- detail ---- */}
          <div className="space-y-4">
            {current ? (
              <>
                <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{current.emoji}</span>
                      <div>
                        <div className="text-sm font-semibold text-zinc-100">
                          {current.name}
                        </div>
                        <div className="text-[10px] text-zinc-500">
                          id: {current.provider}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-2 text-xs text-zinc-400">
                        <Switch
                          checked={current.enabled}
                          disabled={busy === `toggle:${current.provider}`}
                          onCheckedChange={(v) =>
                            void toggleEnabled(current.provider, v)
                          }
                        />
                        {current.enabled ? 'Enabled' : 'Disabled'}
                      </label>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void remove()}
                        disabled={busy === 'remove'}
                        aria-label="Remove provider configuration"
                        className="text-red-400 hover:text-red-300"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-zinc-400">API key</Label>
                      <Input
                        type="password"
                        value={apiKey}
                        placeholder={
                          current.hasKey
                            ? `stored (${current.keyHint}) — type to replace`
                            : 'not configured'
                        }
                        onChange={(e) => setApiKey(e.target.value)}
                        className="bg-zinc-800/60 border-zinc-700 text-sm"
                        autoComplete="off"
                      />
                      <p className="text-[10px] text-zinc-500 flex items-center gap-1">
                        <KeyRound className="h-3 w-3" />
                        {current.hasKey
                          ? 'Stored encrypted on the server. It is never sent back to the browser.'
                          : 'Keys are stored encrypted (AES-256-GCM) and never returned by the API.'}
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-zinc-400">Model</Label>
                      <div className="flex gap-2">
                        <Input
                          value={model}
                          onChange={(e) => setModel(e.target.value)}
                          placeholder="default model"
                          className="bg-zinc-800/60 border-zinc-700 text-sm"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void loadModels()}
                          disabled={modelsLoading}
                          className="shrink-0"
                        >
                          <ListChecks className="h-4 w-4" />
                        </Button>
                      </div>
                      {models.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1 max-h-20 overflow-y-auto">
                          {models.map((m) => (
                            <button
                              key={m.id}
                              onClick={() => setModel(m.id)}
                              className="text-[10px] bg-zinc-800/60 hover:bg-zinc-700 px-1.5 py-0.5 rounded text-zinc-300"
                            >
                              {m.id}
                              {m.free ? ' ★' : ''}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label className="text-xs text-zinc-400">Base URL</Label>
                      <Input
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder="https://api.example.com/v1"
                        className="bg-zinc-800/60 border-zinc-700 text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-zinc-400">Priority (lower = tried first)</Label>
                      <Input
                        type="number"
                        value={priority}
                        onChange={(e) => setPriority(Number(e.target.value) || 0)}
                        className="bg-zinc-800/60 border-zinc-700 text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-zinc-400">Cost class</Label>
                      <Select
                        value={costClass}
                        onValueChange={(v) => setCostClass(v as 'free' | 'paid' | 'unknown')}
                      >
                        <SelectTrigger className="bg-zinc-800/60 border-zinc-700 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-zinc-900 border-zinc-700">
                          <SelectItem value="free">free — no charge</SelectItem>
                          <SelectItem value="paid">paid — requires authorisation</SelectItem>
                          <SelectItem value="unknown">
                            unknown — treated as paid in free-only mode
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-zinc-400">Timeout (ms)</Label>
                      <Input
                        type="number"
                        value={timeoutMs}
                        onChange={(e) => setTimeoutMs(Number(e.target.value) || 5000)}
                        className="bg-zinc-800/60 border-zinc-700 text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-zinc-400">Retries per model</Label>
                      <Input
                        type="number"
                        value={maxRetries}
                        onChange={(e) => setMaxRetries(Number(e.target.value) || 0)}
                        className="bg-zinc-800/60 border-zinc-700 text-sm"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 mt-4">
                    <Button
                      onClick={() => void save()}
                      disabled={busy === 'save'}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white"
                    >
                      Save
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void test()}
                      disabled={busy === 'test'}
                    >
                      {busy === 'test' ? (
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <PlugZap className="h-4 w-4 mr-2" />
                      )}
                      Test connection
                    </Button>
                    {current.lastTestedAt && (
                      <span
                        className={`text-[11px] ${
                          current.lastTestOk ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        last test {current.lastTestOk ? 'OK' : 'FAILED'} ·{' '}
                        {new Date(current.lastTestedAt).toLocaleString()}
                        {current.lastError ? ` — ${current.lastError}` : ''}
                      </span>
                    )}
                  </div>
                </section>
              </>
            ) : (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 text-center text-sm text-zinc-500">
                Select a provider on the left.
              </div>
            )}

            {/* ---- per-agent preferences ---- */}
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <h3 className="text-sm font-semibold text-zinc-200 mb-3">
                Per-agent model preferences
              </h3>
              <div className="grid sm:grid-cols-2 gap-3">
                {ROLES.map((role) => {
                  const pref = preferences.find((p) => p.role === role);
                  return (
                    <div key={role} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                      <div className="text-xs font-semibold text-zinc-300 capitalize mb-2">
                        {role}
                      </div>
                      <div className="flex gap-2">
                        <Select
                          value={pref?.provider || ''}
                          onValueChange={(provider) =>
                            void savePreference(
                              role,
                              provider,
                              pref?.model || ''
                            )
                          }
                        >
                          <SelectTrigger className="bg-zinc-800/60 border-zinc-700 text-xs flex-1">
                            <SelectValue placeholder="task default" />
                          </SelectTrigger>
                          <SelectContent className="bg-zinc-900 border-zinc-700">
                            {providers.map((p) => (
                              <SelectItem key={p.provider} value={p.provider}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          defaultValue={pref?.model || ''}
                          placeholder="model"
                          onBlur={(e) => {
                            const model = e.target.value.trim();
                            if (model !== (pref?.model ?? '')) {
                              void savePreference(role, pref?.provider || '', model);
                            }
                          }}
                          className="bg-zinc-800/60 border-zinc-700 text-xs flex-1"
                        />
                      </div>
                      <p className="text-[10px] text-zinc-500 mt-1.5">
                        {pref
                          ? `configured: ${pref.provider} · ${pref.model || 'default model'}`
                          : 'not configured — the task-level model is used'}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* ---- routing order ---- */}
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <h3 className="text-sm font-semibold text-zinc-200 mb-2">
                Effective routing order
              </h3>
              <p className="text-[11px] text-zinc-500 mb-3">
                The order the router tries providers in. Disabled providers are never used.
              </p>
              <div className="space-y-1">
                {order.map((row) => (
                  <div
                    key={row.provider}
                    className="flex items-center gap-2 text-xs border-b border-zinc-800/40 py-1.5"
                  >
                    <span className="text-zinc-600 w-8">{row.priority}</span>
                    <span
                      className={row.enabled ? 'text-zinc-200' : 'text-zinc-600 line-through'}
                    >
                      {row.provider}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-[9px] ${costBadge[row.costClass] ?? costBadge.unknown}`}
                    >
                      {row.costClass}
                    </Badge>
                    <span className="text-zinc-600 text-[10px] ml-auto">
                      timeout {row.timeoutMs}ms · {row.maxRetries} retries
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
