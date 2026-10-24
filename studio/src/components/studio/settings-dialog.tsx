'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  PlugZap,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { PROVIDERS, resolveModel, type ProviderId } from '@/lib/providers';
import {
  connectionSignature,
  isVerified,
  type ConnectionsMap,
} from '@/lib/api-keys-store';
import { toast } from '@/hooks/use-toast';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: ConnectionsMap;
  activeProvider: ProviderId;
  updateConnection: (
    id: ProviderId,
    config: Partial<ConnectionsMap[ProviderId]>
  ) => void;
  removeConnection: (id: ProviderId) => void;
  switchProvider: (id: ProviderId) => void;
}

type TestState = 'idle' | 'testing' | 'success' | 'error';

/** One row of the live model list (/api/providers/[id]/models). */
interface ModelOption {
  id: string;
  free?: boolean;
  chat?: boolean;
  note?: string;
  legacy?: boolean;
}
interface ModelList {
  models: ModelOption[];
  source: 'provider' | 'cache' | 'catalog';
  cached: boolean;
  fetchedAt?: string | null;
  note?: string;
  loading?: boolean;
  error?: string;
}

const MODEL_SOURCE_LABEL: Record<ModelList['source'], string> = {
  provider: 'Live from provider',
  cache: 'Cached list (10 min)',
  catalog: 'Built-in catalog (offline)',
};

export function SettingsDialog({
  open,
  onOpenChange,
  connections,
  activeProvider,
  updateConnection,
  removeConnection,
  switchProvider,
}: SettingsDialogProps) {
  const [selected, setSelected] = useState<ProviderId>(activeProvider);
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<
    Record<string, { apiKey: string; model: string; baseUrl: string }>
  >({});
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const [testMessages, setTestMessages] = useState<
    Record<string, { ok: boolean; message: string; hint?: string; category?: string }>
  >({});
  const [modelLists, setModelLists] = useState<Record<string, ModelList>>({});
  const [serverKeys, setServerKeys] = useState<
    Record<string, { hasKey: boolean; keyHint: string; lastTestOk: boolean | null; lastError: string }>
  >({});
  const [saving, setSaving] = useState(false);

  const provider = PROVIDERS.find((p) => p.id === selected)!;
  const saved = connections[selected];

  const draft = drafts[selected] ?? {
    apiKey: saved?.apiKey ?? '',
    // resolveModel: purana retired model (e.g. gemini-2.0-flash) dikhne par
    // current model fallback dega — Select me invalid value kabhi na aaye
    model: saved?.model ? resolveModel(provider, saved.model) : provider.defaultModel,
    baseUrl: saved?.baseUrl || provider.baseUrl,
  };

  const draftSignature = connectionSignature({
    apiKey: draft.apiKey,
    keyHint: saved?.keyHint,
    model: draft.model,
    baseUrl: draft.baseUrl,
  });
  // "Connected" is only true when a test passed for EXACTLY this draft.
  const verifiedNow = Boolean(saved?.connected && saved?.testedSign === draftSignature);
  const serverInfo = serverKeys[selected];
  const keyConfigured = Boolean(draft.apiKey || serverInfo?.hasKey || saved?.serverStored);

  /** Any edit invalidates the previous test result (spec §9). */
  const setDraft = (patch: Partial<typeof draft>) => {
    setDrafts((prev) => ({ ...prev, [selected]: { ...draft, ...patch } }));
    setTestStates((prev) => ({ ...prev, [selected]: 'idle' }));
    updateConnection(selected, { connected: false, testedAt: undefined });
  };

  // Load the SERVER-side state once (which keys are stored encrypted) so the
  // dialog tells the truth even after localStorage was cleared.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/providers');
        if (!res.ok) return;
        const data = (await res.json()) as {
          providers?: Array<{
            provider: string;
            hasKey: boolean;
            keyHint: string;
            lastTestOk: boolean | null;
            lastError: string;
          }>;
        };
        if (!alive || !Array.isArray(data.providers)) return;
        const map: typeof serverKeys = {};
        for (const p of data.providers) {
          map[p.provider] = {
            hasKey: Boolean(p.hasKey),
            keyHint: p.keyHint ?? '',
            lastTestOk: p.lastTestOk ?? null,
            lastError: p.lastError ?? '',
          };
        }
        setServerKeys(map);
      } catch {
        /* offline — the local state is still shown */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const loadModels = useCallback(
    async (id: ProviderId, opts: { refresh?: boolean } = {}) => {
      const info = PROVIDERS.find((p) => p.id === id);
      if (!info) return;
      const current = drafts[id] ?? {
        apiKey: connections[id]?.apiKey ?? '',
        model: connections[id]?.model ?? info.defaultModel,
        baseUrl: connections[id]?.baseUrl || info.baseUrl,
      };
      setModelLists((prev) => ({
        ...prev,
        [id]: { ...(prev[id] ?? { models: [], source: 'catalog', cached: false }), loading: true },
      }));
      try {
        // POST, not GET: an unsaved key must never travel in a URL.
        const res = await fetch(`/api/providers/${id}/models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: current.apiKey || undefined,
            baseUrl: current.baseUrl || undefined,
            model: current.model || undefined,
            refresh: opts.refresh === true,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          models?: ModelOption[];
          source?: ModelList['source'];
          cached?: boolean;
          fetchedAt?: string | null;
          note?: string;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setModelLists((prev) => ({
          ...prev,
          [id]: {
            models: data.models ?? [],
            source: data.source ?? 'catalog',
            cached: Boolean(data.cached),
            fetchedAt: data.fetchedAt ?? null,
            note: data.note,
            error: data.error,
            loading: false,
          },
        }));
      } catch (err) {
        setModelLists((prev) => ({
          ...prev,
          [id]: {
            ...(prev[id] ?? { models: [], source: 'catalog', cached: false }),
            loading: false,
            error: err instanceof Error ? err.message : 'Could not load models',
          },
        }));
      }
    },
    [connections, drafts]
  );

  // fetch the live list the first time a provider is opened
  useEffect(() => {
    if (!open) return;
    if (modelLists[selected]?.models?.length || modelLists[selected]?.loading) return;
    void loadModels(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, open]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    const testPassed = testStates[selected] === 'success';
    const signature = connectionSignature({
      apiKey: draft.apiKey,
      keyHint: saved?.keyHint,
      model: draft.model,
      baseUrl: draft.baseUrl,
    });
    // 1) persist the configuration SERVER-SIDE (key encrypted, never echoed).
    let keyHint = saved?.keyHint ?? serverInfo?.keyHint ?? '';
    let serverStored = saved?.serverStored ?? serverInfo?.hasKey ?? false;
    try {
      const res = await fetch(`/api/providers/${selected}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selected,
          model: draft.model,
          baseUrl: draft.baseUrl,
          enabled: true,
          // An EMPTY field never overwrites a stored key: send the key only
          // when the user actually typed one.
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        hasKey?: boolean;
        keyHint?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.hasKey) {
        serverStored = true;
        keyHint = data.keyHint ?? '';
      }
    } catch (err) {
      // The browser copy still works for chat, so this is a warning, not a
      // hard failure — but it must be VISIBLE.
      toast({
        title: 'Saved in browser only',
        description:
          (err instanceof Error ? err.message : 'server save failed') +
          ' — the key could not be stored encrypted on the server.',
        variant: 'destructive',
      });
    }

    updateConnection(selected, {
      // the secret does not stay in localStorage once the server has it
      apiKey: serverStored ? '' : draft.apiKey,
      keyHint,
      serverStored,
      model: draft.model,
      baseUrl: draft.baseUrl,
      connected: testPassed,
      testedSign: testPassed ? signature : undefined,
      testedAt: testPassed ? new Date().toISOString() : saved?.testedAt,
      lastError: testPassed ? undefined : saved?.lastError,
    });
    setServerKeys((prev) => ({
      ...prev,
      [selected]: {
        hasKey: serverStored,
        keyHint,
        lastTestOk: testPassed ? true : (prev[selected]?.lastTestOk ?? null),
        lastError: prev[selected]?.lastError ?? '',
      },
    }));
    setSaving(false);
    toast({
      title: 'Saved ✓',
      description: testPassed
        ? `${provider.name} configuration saved and verified.`
        : `${provider.name} configuration saved. Connection NOT verified — run Test connection.`,
    });
  };

  const handleTest = async () => {
    setTestStates((prev) => ({ ...prev, [selected]: 'testing' }));
    setTestMessages((prev) => ({ ...prev, [selected]: { ok: false, message: '' } }));
    try {
      // The dedicated provider route: it falls back to the stored key and
      // persists the REAL result server-side.
      const res = await fetch(`/api/providers/${selected}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: draft.apiKey || undefined,
          model: draft.model,
          baseUrl: draft.baseUrl,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
        hint?: string;
        errorCategory?: string;
        model?: string;
        notice?: { reason?: string };
      };
      if (json.ok) {
        const signature = connectionSignature({
          apiKey: draft.apiKey,
          keyHint: saved?.keyHint,
          model: draft.model,
          baseUrl: draft.baseUrl,
        });
        setTestStates((prev) => ({ ...prev, [selected]: 'success' }));
        setTestMessages((prev) => ({
          ...prev,
          [selected]: { ok: true, message: json.message ?? 'Connected', category: 'connected' },
        }));
        updateConnection(selected, {
          model: draft.model,
          baseUrl: draft.baseUrl,
          connected: true,
          testedSign: signature,
          testedAt: new Date().toISOString(),
          lastError: undefined,
        });
        toast({ title: 'Connection verified ✓', description: json.message });
        if (json.notice?.reason) {
          toast({ title: 'Model note', description: json.notice.reason });
        }
        // a verified key is worth persisting right away (encrypted server-side)
        if (draft.apiKey.trim()) void handleSave();
        void loadModels(selected, { refresh: true });
      } else {
        setTestStates((prev) => ({ ...prev, [selected]: 'error' }));
        setTestMessages((prev) => ({
          ...prev,
          [selected]: {
            ok: false,
            message: json.error ?? 'Connection failed',
            hint: json.hint,
            category: json.errorCategory,
          },
        }));
        updateConnection(selected, {
          model: draft.model,
          baseUrl: draft.baseUrl,
          connected: false,
          testedSign: undefined,
          lastError: json.error,
        });
        toast({
          title: `Connection failed${json.errorCategory ? ` (${json.errorCategory})` : ''}`,
          description: json.error ?? 'Unknown error',
          variant: 'destructive',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setTestStates((prev) => ({ ...prev, [selected]: 'error' }));
      setTestMessages((prev) => ({ ...prev, [selected]: { ok: false, message: msg } }));
      updateConnection(selected, { connected: false, lastError: msg });
      toast({ title: 'Connection failed', description: msg, variant: 'destructive' });
    }
  };

  const handleUse = async () => {
    if (provider.kind !== 'zai' && !provider.id.startsWith('ollama') && !keyConfigured && selected !== 'custom') {
      toast({
        title: 'API key chahiye',
        description: `${provider.name} ke liye pehle API key paste karo aur Test karo.`,
        variant: 'destructive',
      });
      return;
    }
    if (!verifiedNow && !(provider.kind === 'zai' || selected === 'ollama')) {
      toast({
        title: 'Connection verify nahi hui',
        description: 'Pehle "Test connection" dabao — phir provider activate karenge.',
        variant: 'destructive',
      });
      return;
    }
    await handleSave();
    switchProvider(selected);
    toast({
      title: `${provider.emoji} ${provider.name} activated`,
      description: 'Ab saare chats is provider se honge.',
    });
  };

  const testState = testStates[selected] ?? 'idle';
  const isConnected = saved?.connected;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl h-[85vh] p-0 bg-zinc-900 border-zinc-800 text-zinc-100">
        <div className="flex h-full">
          {/* Left: provider list */}
          <div className="w-60 shrink-0 border-r border-zinc-800 flex flex-col">
            <div className="p-4">
              <DialogTitle className="text-base">API Connections</DialogTitle>
              <DialogDescription className="text-xs text-zinc-400 mt-1">
                Keys encrypted server-side save hoti hain
              </DialogDescription>
            </div>
            <ScrollArea className="flex-1 px-2 pb-2">
              <div className="space-y-1">
                {PROVIDERS.map((p) => {
                  const conn = connections[p.id];
                  const isActive = activeProvider === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => setSelected(p.id)}
                      className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        selected === p.id
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'hover:bg-zinc-800 text-zinc-300'
                      }`}
                    >
                      <span className="text-lg">{p.emoji}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium truncate">{p.name}</span>
                        <span className="block text-[11px] text-zinc-500 truncate">
                          {isVerified(conn)
                            ? 'Verified'
                            : serverKeys[p.id]?.hasKey || conn?.apiKey
                              ? 'Configured'
                              : p.free
                                ? 'Free'
                                : 'Key required'}
                        </span>
                      </span>
                      {isVerified(conn) && (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      )}
                      {isActive && (
                        <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
            <Separator className="bg-zinc-800" />
            <div className="p-3 flex items-start gap-2 text-[11px] text-zinc-500">
              <ShieldCheck className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
              <span>
                API keys server par AES-256-GCM se encrypted save hoti hain (key hint ke alawa
                browser me kuch nahi rehta). Purani browser-stored key pehli baar Save/Test par
                server par migrate ho jaati hai.
              </span>
            </div>
          </div>

          {/* Right: provider detail */}
          <div className="flex-1 flex flex-col min-w-0">
            <DialogHeader className="p-6 pb-4 space-y-2">
              <div className="flex items-center gap-3">
                <span className="text-3xl">{provider.emoji}</span>
                <div className="flex-1 min-w-0">
                  <DialogTitle className="text-lg">{provider.name}</DialogTitle>
                  <DialogDescription className="text-sm text-zinc-400">
                    {provider.description}
                  </DialogDescription>
                </div>
                {verifiedNow ? (
                  <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Connected &amp; verified
                  </Badge>
                ) : keyConfigured ? (
                  <Badge variant="outline" className="text-amber-300 border-amber-500/40">
                    <AlertCircle className="h-3 w-3 mr-1" /> Configured — not verified
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-zinc-400 border-zinc-700">
                    Not configured
                  </Badge>
                )}
              </div>
              {activeProvider === selected && (
                <div className="flex items-center gap-2 text-xs text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Ye abhi active provider hai — chats isi se ja rahe hain
                </div>
              )}
            </DialogHeader>

            <ScrollArea className="flex-1 px-6 pb-4">
              <div className="space-y-5">
                {provider.kind === 'zai' && (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
                    <div className="flex items-center gap-2 text-emerald-300 font-medium text-sm">
                      <PlugZap className="h-4 w-4" />
                      Zero setup — ye built-in engine hai
                    </div>
                    <p className="text-sm text-zinc-300 mt-2 leading-relaxed">
                      Is provider me koi API key ya account nahi chahiye. Ye already kaam kar
                      raha hai — bas neeche &quot;Use this provider&quot; dabao aur chat shuru
                      karo. Baaki providers ko connect karna ho to unki key paste karo.
                    </p>
                  </div>
                )}

                {provider.id === 'ollama' && (
                  <div className="rounded-xl border border-zinc-700 bg-zinc-800/50 p-4 text-sm text-zinc-300 space-y-2">
                    <p className="font-medium text-zinc-200">Local setup steps:</p>
                    <ol className="list-decimal list-inside space-y-1 text-zinc-400">
                      <li>ollama.com se install karo</li>
                      <li>
                        Terminal me: <code className="text-emerald-300">ollama pull llama3.2</code>
                      </li>
                      <li>Ollama chalu rakho (port 11434)</li>
                      <li>Yahan &quot;Test Connection&quot; dabao</li>
                    </ol>
                  </div>
                )}

                {provider.kind !== 'zai' && provider.id !== 'ollama' && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-zinc-300">API Key</Label>
                      {provider.keyUrl && (
                        <a
                          href={provider.keyUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"
                        >
                          Get key here <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="relative">
                      <Input
                        type={showKey[selected] ? 'text' : 'password'}
                        value={draft.apiKey}
                        onChange={(e) => setDraft({ apiKey: e.target.value })}
                        placeholder={
                          serverInfo?.hasKey
                            ? `Saved on server ${serverInfo.keyHint || ''} — leave empty to keep it`
                            : provider.keyLabel
                        }
                        autoComplete="off"
                        className="pr-10 bg-zinc-800 border-zinc-700 text-zinc-100 font-mono text-sm"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setShowKey((prev) => ({ ...prev, [selected]: !prev[selected] }))
                        }
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                        aria-label="Toggle key visibility"
                      >
                        {showKey[selected] ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {(selected === 'custom' || selected === 'ollama') && (
                  <div className="space-y-2">
                    <Label className="text-zinc-300">Base URL</Label>
                    <Input
                      value={draft.baseUrl}
                      onChange={(e) => setDraft({ baseUrl: e.target.value })}
                      placeholder="https://your-host/v1"
                      className="bg-zinc-800 border-zinc-700 text-zinc-100 font-mono text-sm"
                    />
                    <p className="text-xs text-zinc-500">
                      OpenAI-compatible endpoint, e.g. http://localhost:11434/v1
                    </p>
                  </div>
                )}

                {provider.id !== 'custom' && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-zinc-300">Model</Label>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-zinc-500">
                          {modelLists[selected]?.loading
                            ? 'loading…'
                            : MODEL_SOURCE_LABEL[modelLists[selected]?.source ?? 'catalog']}
                          {modelLists[selected]?.fetchedAt
                            ? ` · ${new Date(modelLists[selected]!.fetchedAt as string).toLocaleTimeString()}`
                            : ''}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px] text-zinc-400 hover:text-emerald-300"
                          disabled={modelLists[selected]?.loading}
                          onClick={() => void loadModels(selected, { refresh: true })}
                        >
                          Refresh
                        </Button>
                      </div>
                    </div>
                    <Select
                      value={draft.model || provider.defaultModel}
                      onValueChange={(v) => setDraft({ model: v })}
                    >
                      <SelectTrigger className="bg-zinc-800 border-zinc-700 text-zinc-100">
                        <SelectValue placeholder="Select model" />
                      </SelectTrigger>
                      <SelectContent className="bg-zinc-900 border-zinc-700 max-h-72">
                        {/* the SAVED value stays selectable even when a live
                            list replaced the catalog (never a blank picker) */}
                        {(modelLists[selected]?.models?.length
                          ? modelLists[selected]!.models
                          : provider.models.map((id): ModelOption => ({ id }))
                        ).map((m) => (
                          <SelectItem key={m.id} value={m.id} className="text-zinc-100">
                            <span className="font-mono text-xs">{m.id}</span>
                            {m.free ? (
                              <span className="ml-2 text-[10px] text-emerald-400">free</span>
                            ) : null}
                            {m.legacy ? (
                              <span className="ml-2 text-[10px] text-amber-400">legacy</span>
                            ) : null}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {modelLists[selected]?.models?.find((m) => m.id === draft.model)?.note ? (
                      <p className="text-[11px] text-amber-400/90">
                        {modelLists[selected]!.models.find((m) => m.id === draft.model)!.note}
                      </p>
                    ) : null}
                    {(modelLists[selected]?.note || modelLists[selected]?.error) && (
                      <p className="text-[11px] text-zinc-500 break-words">
                        {modelLists[selected]?.error || modelLists[selected]?.note}
                      </p>
                    )}
                  </div>
                )}

                {selected === 'custom' && (
                  <div className="space-y-2">
                    <Label className="text-zinc-300">Model name</Label>
                    <Input
                      value={draft.model}
                      onChange={(e) => setDraft({ model: e.target.value })}
                      placeholder="e.g. my-model"
                      className="bg-zinc-800 border-zinc-700 text-zinc-100 font-mono text-sm"
                    />
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    onClick={handleTest}
                    disabled={testState === 'testing'}
                    className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700"
                  >
                    {testState === 'testing' ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Testing…
                      </>
                    ) : (
                      <>
                        <PlugZap className="h-4 w-4 mr-2" /> Test Connection
                      </>
                    )}
                  </Button>
                  <Button
                    onClick={() => void handleSave()}
                    disabled={saving}
                    variant="outline"
                    className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  >
                    {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    Save
                  </Button>
                  <Button
                    onClick={() => void handleUse()}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white"
                  >
                    Use this provider
                  </Button>
                  {selected !== 'zai' && saved && (
                    <Button
                      onClick={() => {
                        removeConnection(selected);
                        setDrafts((prev) => ({
                          ...prev,
                          [selected]: {
                            apiKey: '',
                            model: provider.defaultModel,
                            baseUrl: provider.baseUrl,
                          },
                        }));
                        setTestStates((prev) => ({ ...prev, [selected]: 'idle' }));
                        toast({ title: 'Disconnected', description: `${provider.name} removed.` });
                      }}
                      variant="ghost"
                      className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                    >
                      <Trash2 className="h-4 w-4 mr-1" /> Remove
                    </Button>
                  )}
                </div>

                {testState === 'success' && (
                  <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
                    <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                    <span className="break-words">
                      {testMessages[selected]?.message || 'Connection verified — API live hai!'}
                    </span>
                  </div>
                )}
                {(testState === 'error' || saved?.lastError) && testState !== 'testing' && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span className="break-all">
                      {testState === 'error'
                        ? testMessages[selected]?.message || 'Test failed.'
                        : saved?.lastError || 'Test failed. Key aur URL check karo.'}
                      {testState === 'error' && testMessages[selected]?.category ? (
                        <span className="block mt-1 text-[11px] text-red-400/80 font-mono">
                          status: {testMessages[selected]?.category}
                        </span>
                      ) : null}
                      {testState === 'error' && testMessages[selected]?.hint ? (
                        <span className="block mt-1 text-[11px] text-red-300/80">
                          {testMessages[selected]?.hint}
                        </span>
                      ) : null}
                    </span>
                  </div>
                )}

                <Separator className="bg-zinc-800" />

                <div className="text-xs text-zinc-500 space-y-1.5">
                  <p className="font-medium text-zinc-400">How it connects:</p>
                  <p>{provider.docsNote}</p>
                  {provider.kind === 'openai-compatible' && (
                    <p className="font-mono text-[11px] text-zinc-600 break-all">
                      POST {draft.baseUrl || provider.baseUrl || 'https://your-host/v1'}
                      /chat/completions
                    </p>
                  )}
                  {provider.kind === 'anthropic' && (
                    <p className="font-mono text-[11px] text-zinc-600 break-all">
                      POST https://api.anthropic.com/v1/messages
                    </p>
                  )}
                  {provider.kind === 'gemini' && (
                    <p className="font-mono text-[11px] text-zinc-600 break-all">
                      POST .../models/{'{model}'}:streamGenerateContent
                    </p>
                  )}
                </div>
              </div>
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
