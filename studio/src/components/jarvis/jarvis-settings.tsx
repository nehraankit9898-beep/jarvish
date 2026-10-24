'use client';

/**
 * JarvisSettings — the JARVIS command-center settings modal.
 *
 * Four tabs, all wired to the REAL backend / existing secure storage:
 *  - AI BRAIN: per-provider key + model via the existing localStorage
 *    connections store (same store as the classic SettingsDialog) and
 *    POST /api/test-connection for real connectivity checks with visible
 *    errors. Keys are never echoed back and never logged.
 *  - VOICE: TTS engine status + toggle (POST /api/voice/speak fallback chain
 *    lives in useSpeechOutput), mic language, real voice-bridge status.
 *  - LISTENING: wake-word ("Hey Jarvis") toggle + sensitivity + real engine
 *    status (openWakeWord python bridge) and LIVE-mode availability.
 *  - ROUTING: GET/POST /api/settings (free-only, prefer-free, auto-fallback,
 *    default provider) + effective routing order from GET /api/providers.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { PROVIDERS, getProvider, type ProviderId } from '@/lib/providers';
import type {
  ConnectionConfig,
  ConnectionsMap,
} from '@/lib/api-keys-store';
import type { useVoiceInput, useSpeechOutput, useWakeWord, VoiceLang } from '@/hooks/use-speech';
import { ShieldCheck, Volume2, Radar, Route, ExternalLink } from 'lucide-react';

type Voice = ReturnType<typeof useVoiceInput>;
type Tts = ReturnType<typeof useSpeechOutput>;
type WakeStatus = ReturnType<typeof useWakeWord>['status'];

interface RoutingSettings {
  freeOnly?: boolean;
  preferFree?: boolean;
  autoFallback?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
}

export interface JarvisSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: ConnectionsMap;
  activeProvider: ProviderId;
  updateConnection: (id: ProviderId, config: Partial<ConnectionConfig> | undefined) => void;
  removeConnection: (id: ProviderId) => void;
  switchProvider: (id: ProviderId) => void;
  voice: Voice;
  tts: Tts;
  micLang: VoiceLang;
  setMicLang: (l: VoiceLang) => void;
  handsFree: boolean;
  toggleHandsFree: () => void;
  wakeSensitivity: number;
  changeWakeSensitivity: (v: number) => void;
  wakeStatus: WakeStatus;
  wakeError?: string | null;
  onOpenProvidersPanel: () => void;
}

export function JarvisSettings(props: JarvisSettingsProps) {
  const {
    open,
    onOpenChange,
    connections,
    activeProvider,
    updateConnection,
    removeConnection,
    switchProvider,
    voice,
    tts,
    micLang,
    setMicLang,
    handsFree,
    toggleHandsFree,
    wakeSensitivity,
    changeWakeSensitivity,
    wakeStatus,
    wakeError,
    onOpenProvidersPanel,
  } = props;

  /* ---------- AI BRAIN state ---------- */
  const [selProvider, setSelProvider] = useState<ProviderId>(activeProvider);
  const [draftKey, setDraftKey] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [draftBaseUrl, setDraftBaseUrl] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelProvider(activeProvider);
  }, [open, activeProvider]);

  useEffect(() => {
    const conn = connections[selProvider];
    const info = getProvider(selProvider);
    setDraftKey('');
    setDraftModel(conn?.model || info?.defaultModel || '');
    setDraftBaseUrl(conn?.baseUrl ?? '');
    setTestResult(null);
    setShowKey(false);
  }, [selProvider, connections]);

  const saveDraft = useCallback(
    (extra: Partial<ConnectionConfig> = {}) => {
      const info = getProvider(selProvider);
      updateConnection(selProvider, {
        apiKey: draftKey.trim() || connections[selProvider]?.apiKey || '',
        model: draftModel.trim(),
        baseUrl: draftBaseUrl.trim(),
        ...extra,
      });
      toast({
        title: `${info?.emoji ?? ''} ${info?.name ?? selProvider} saved`,
        description: 'Connection stored in this browser only.',
      });
    },
    [selProvider, draftKey, draftModel, draftBaseUrl, connections, updateConnection],
  );

  const testConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selProvider,
          apiKey: draftKey.trim() || connections[selProvider]?.apiKey || undefined,
          model: draftModel.trim() || undefined,
          baseUrl: draftBaseUrl.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; latencyMs?: number; model?: string };
      if (data.ok) {
        setTestResult({ ok: true, text: `Connected — ${data.model ?? (draftModel || 'default model')}${data.latencyMs != null ? ` · ${data.latencyMs}ms` : ''}` });
      } else {
        setTestResult({ ok: false, text: data.error || `Connection failed (HTTP ${res.status})` });
      }
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setTesting(false);
    }
  }, [selProvider, draftKey, draftModel, draftBaseUrl, connections]);

  /* ---------- ROUTING state ---------- */
  const [routing, setRouting] = useState<RoutingSettings | null>(null);
  const [routingOrder, setRoutingOrder] = useState<string[]>([]);
  const [savingRouting, setSavingRouting] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const [s, p] = await Promise.all([
          fetch('/api/settings').then((r) => (r.ok ? (r.json() as Promise<RoutingSettings>) : null)),
          fetch('/api/providers').then((r) => (r.ok ? (r.json() as Promise<{ order?: Array<{ provider: string; enabled: boolean }> }>) : null)),
        ]);
        if (s) setRouting(s);
        if (p?.order) setRoutingOrder(p.order.filter((o) => o.enabled).map((o) => o.provider));
      } catch {
        /* ignore */
      }
    })();
  }, [open]);

  const patchRouting = useCallback(async (patch: RoutingSettings) => {
    setSavingRouting(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as RoutingSettings;
      setRouting(next);
      toast({ title: 'Routing policy saved' });
    } catch (e) {
      toast({
        title: 'Could not save routing',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      });
    } finally {
      setSavingRouting(false);
    }
  }, []);

  const selInfo = getProvider(selProvider);
  const selConn = connections[selProvider];
  const needsBaseUrl = selProvider === 'ollama' || selProvider === 'custom';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto jv-panel border-[var(--jv-panel-line)]">
        <DialogHeader>
          <DialogTitle className="jv-brand text-cyan-200 text-base tracking-[0.3em]">SYSTEM CONFIG</DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            Keys stay in this browser (localStorage) or encrypted server-side — they are never sent anywhere else.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="brain" className="mt-1">
          <TabsList className="bg-zinc-900 border border-[var(--jv-panel-line)]">
            <TabsTrigger value="brain" className="text-xs">AI Brain</TabsTrigger>
            <TabsTrigger value="voice" className="text-xs">Voice</TabsTrigger>
            <TabsTrigger value="listening" className="text-xs">Listening</TabsTrigger>
            <TabsTrigger value="routing" className="text-xs">Routing</TabsTrigger>
          </TabsList>

          {/* ============ AI BRAIN ============ */}
          <TabsContent value="brain" className="mt-3 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {PROVIDERS.map((p) => {
                const c = connections[p.id];
                const active = selProvider === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelProvider(p.id)}
                    className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors ${
                      active
                        ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-100'
                        : 'border-[var(--jv-panel-line)] text-zinc-400 hover:border-cyan-400/30'
                    }`}
                  >
                    <span>{p.emoji}</span>
                    <span className="truncate flex-1">{p.name}</span>
                    {(c?.connected || p.kind === 'zai' || p.id === 'ollama') && (
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" aria-label="connected" />
                    )}
                    {p.free && (
                      <span className="text-[9px] font-mono uppercase text-cyan-400/80 shrink-0">free</span>
                    )}
                  </button>
                );
              })}
            </div>

            {selInfo && (
              <div className="rounded-xl border border-[var(--jv-panel-line)] p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-100">{selInfo.emoji} {selInfo.name}</p>
                    <p className="text-[11px] text-zinc-500">{selInfo.description}</p>
                  </div>
                  <Badge variant="outline" className={`text-[10px] ${selConn?.connected ? 'border-emerald-500/40 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>
                    {selConn?.connected ? 'connected' : 'not configured'}
                  </Badge>
                </div>

                {selInfo.kind !== 'zai' && (
                  <div className="space-y-1">
                    <Label className="text-xs text-zinc-400">API key {selProvider === 'ollama' ? '(optional)' : ''} — {selInfo.keyLabel}</Label>
                    <div className="flex gap-1.5">
                      <Input
                        type={showKey ? 'text' : 'password'}
                        value={draftKey}
                        onChange={(e) => setDraftKey(e.target.value)}
                        placeholder={selConn?.apiKey ? '•••••••• (saved — type to replace)' : selInfo.keyLabel}
                        className="font-mono text-xs bg-zinc-900"
                        autoComplete="off"
                      />
                      <Button type="button" size="sm" variant="ghost" className="text-[10px] text-zinc-400" onClick={() => setShowKey((v) => !v)}>
                        {showKey ? 'Hide' : 'Show'}
                      </Button>
                    </div>
                    <a href={selInfo.keyUrl || '#'} target="_blank" rel="noreferrer" className="text-[10px] text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1">
                      Get a key <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  </div>
                )}

                <div className="space-y-1">
                  <Label className="text-xs text-zinc-400">Model</Label>
                  <Input
                    list={`jv-models-${selProvider}`}
                    value={draftModel}
                    onChange={(e) => setDraftModel(e.target.value)}
                    placeholder={selInfo.defaultModel || 'model id'}
                    className="font-mono text-xs bg-zinc-900"
                  />
                  <datalist id={`jv-models-${selProvider}`}>
                    {selInfo.models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </div>

                {needsBaseUrl && (
                  <div className="space-y-1">
                    <Label className="text-xs text-zinc-400">Base URL</Label>
                    <Input
                      value={draftBaseUrl}
                      onChange={(e) => setDraftBaseUrl(e.target.value)}
                      placeholder={selProvider === 'ollama' ? 'http://localhost:11434/v1' : 'https://host/v1'}
                      className="font-mono text-xs bg-zinc-900"
                    />
                  </div>
                )}

                {testResult && (
                  <p className={`text-xs font-mono ${testResult.ok ? 'text-emerald-300' : 'text-red-300'}`} role="status">
                    {testResult.ok ? '✓ ' : '✗ '}
                    {testResult.text}
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="h-8 border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/10" disabled={testing} onClick={testConnection}>
                    {testing ? 'Testing…' : 'Test Connection'}
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 bg-cyan-600 hover:bg-cyan-500 text-white"
                    onClick={() => {
                      // honest connection state: only a passing test (or the
                      // keyless built-in/local providers) marks "connected"
                      const okTest = testResult?.ok === true;
                      const canConnect = okTest || selInfo.kind === 'zai' || selProvider === 'ollama';
                      saveDraft({
                        connected: canConnect,
                        testedAt: new Date().toISOString(),
                        lastError: testResult && !testResult.ok ? testResult.text : undefined,
                      });
                      if (!canConnect) {
                        toast({
                          title: 'Saved without a passing test',
                          description: 'Run Test Connection — chat will fail until the provider connects.',
                          variant: 'destructive',
                        });
                        return;
                      }
                      switchProvider(selProvider);
                    }}
                  >
                    Save &amp; Use
                  </Button>
                  {selConn && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-red-300 hover:text-red-200"
                      onClick={() => {
                        removeConnection(selProvider);
                        setTestResult(null);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>

                <p className="text-[10px] text-zinc-600 flex items-start gap-1.5">
                  <ShieldCheck className="h-3 w-3 mt-0.5 shrink-0 text-cyan-500" />
                  Server-side encrypted provider config, per-role model routing and free-only mode live in the{' '}
                  <button onClick={onOpenProvidersPanel} className="text-cyan-400 hover:text-cyan-300 underline">
                    Providers panel
                  </button>
                  .
                </p>
              </div>
            )}
          </TabsContent>

          {/* ============ VOICE ============ */}
          <TabsContent value="voice" className="mt-3 space-y-3">
            <div className="rounded-xl border border-[var(--jv-panel-line)] p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-100">Speak replies (TTS)</p>
                  <p className="text-[11px] text-zinc-500">
                    Server edge-tts when the voice bridge is up, browser voice otherwise.
                    {tts.engine ? ` Active engine: ${tts.engine}.` : ''}
                  </p>
                </div>
                <Switch checked={tts.enabled} onCheckedChange={(v) => tts.setEnabled(v)} disabled={!tts.supported} />
              </div>
              {!tts.supported && (
                <p className="text-xs text-red-300">Speech synthesis is not available in this browser.</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/10"
                  disabled={!tts.supported}
                  onClick={() => tts.speak('All systems online. I am listening.')}
                >
                  <Volume2 className="h-3.5 w-3.5 mr-1.5" /> Test voice
                </Button>
                {tts.speaking && <span className="text-[10px] font-mono text-cyan-300 jv-anim-blink">speaking…</span>}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--jv-panel-line)] p-3 space-y-3">
              <p className="text-sm text-zinc-100">Microphone language</p>
              <div className="flex gap-2">
                {(['hi-IN', 'en-IN'] as VoiceLang[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => setMicLang(l)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-mono ${
                      micLang === l ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-100' : 'border-[var(--jv-panel-line)] text-zinc-400'
                    }`}
                  >
                    {l === 'hi-IN' ? 'हिन्दी (hi-IN)' : 'English (en-IN)'}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-zinc-500">
                {voice.supported
                  ? 'Speech recognition supported in this browser.'
                  : 'Speech recognition NOT supported here — voice input unavailable (type instead).'}
              </p>
              {voice.error && <p className="text-xs text-red-300 font-mono">{voice.error}</p>}
            </div>

            <div className="rounded-xl border border-[var(--jv-panel-line)] p-3">
              <p className="text-sm text-zinc-100">Voice bridge (server edge-tts + wake engine)</p>
              <p className="text-[11px] text-zinc-500 mt-1 font-mono">
                {wakeStatus?.bridge
                  ? `${wakeStatus.bridge.running && wakeStatus.bridge.ready ? '● online' : '○ offline'} · wake engine: ${wakeStatus.bridge.wakeEngine ?? 'n/a'} · tts: ${wakeStatus.bridge.ttsAvailable ? 'ready' : 'unavailable'}`
                  : 'status unknown (bridge not polled yet)'}
              </p>
              {wakeStatus?.bridge && !wakeStatus.bridge.ttsAvailable && (
                <p className="text-[11px] text-amber-400 mt-1 font-mono">
                  Natural voice: pip install -r python-bridge/requirements-voice.txt
                </p>
              )}
              {wakeStatus?.bridge && !wakeStatus.bridge.running && (
                <p className="text-[11px] text-zinc-500 mt-1 font-mono">{wakeStatus.bridge.installHint}</p>
              )}
            </div>
          </TabsContent>

          {/* ============ LISTENING ============ */}
          <TabsContent value="listening" className="mt-3 space-y-3">
            <div className="rounded-xl border border-[var(--jv-panel-line)] p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-100 flex items-center gap-1.5">
                    <Radar className="h-4 w-4 text-cyan-300" /> Wake word — &quot;Hey JARVIS&quot;
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    Always-on listening for the wake phrase (openWakeWord via the python bridge).
                  </p>
                </div>
                <Switch checked={handsFree} onCheckedChange={() => toggleHandsFree()} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-400">
                  Sensitivity ({Math.round(wakeSensitivity * 100)}%) — lower = fewer false triggers
                </Label>
                <Slider
                  value={[wakeSensitivity]}
                  min={0.05}
                  max={1}
                  step={0.05}
                  onValueChange={(vals) => changeWakeSensitivity(vals[0] ?? 0.5)}
                  disabled={!handsFree}
                />
              </div>
              <div className="text-[11px] font-mono text-zinc-500 space-y-0.5">
                <p>
                  engine: {wakeStatus?.bridge?.wakeEngine ?? 'unknown'} · mic:{' '}
                  {wakeStatus?.wake
                    ? wakeStatus.wake.muted
                      ? 'muted'
                      : wakeStatus.wake.listening
                        ? 'listening'
                        : 'standby'
                    : 'not started'}
                </p>
                {wakeError && <p className="text-amber-400">wake: {String(wakeError)}</p>}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--jv-panel-line)] p-3">
              <p className="text-sm text-zinc-100">LIVE voice loop</p>
              <p className="text-[11px] text-zinc-500 mt-1">
                Continuous conversation: JARVIS listens, answers through your active provider and speaks the reply —
                works with every configured provider (no provider-specific realtime API required).
              </p>
              <p className={`text-[11px] font-mono mt-1 ${voice.supported ? 'text-emerald-300' : 'text-red-300'}`}>
                {voice.supported ? '● available in this browser' : '● unavailable — speech recognition not supported'}
              </p>
            </div>
          </TabsContent>

          {/* ============ ROUTING ============ */}
          <TabsContent value="routing" className="mt-3 space-y-3">
            <div className="rounded-xl border border-[var(--jv-panel-line)] p-3 space-y-3">
              {(
                [
                  ['freeOnly', 'Free-only mode', 'Paid models are never selected (they cost money).'],
                  ['preferFree', 'Free-tier first', 'Free providers get priority; paid only as fallback.'],
                  ['autoFallback', 'Automatic fallback', 'On failure the router walks down the provider order.'],
                ] as const
              ).map(([key, title, desc]) => (
                <div key={key} className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-zinc-100">{title}</p>
                    <p className="text-[11px] text-zinc-500">{desc}</p>
                  </div>
                  <Switch
                    checked={Boolean(routing?.[key])}
                    disabled={savingRouting || !routing}
                    onCheckedChange={(v) => patchRouting({ [key]: v } as RoutingSettings)}
                  />
                </div>
              ))}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-zinc-100">Default provider</p>
                  <p className="text-[11px] text-zinc-500">Used when a request has no explicit provider.</p>
                </div>
                <Select
                  value={routing?.defaultProvider ?? 'zai'}
                  onValueChange={(v) => patchRouting({ defaultProvider: v })}
                  disabled={savingRouting || !routing}
                >
                  <SelectTrigger className="w-44 h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-xs">
                        {p.emoji} {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--jv-panel-line)] p-3">
              <p className="text-sm text-zinc-100 mb-1.5 flex items-center gap-1.5">
                <Route className="h-4 w-4 text-cyan-300" /> Effective routing order
              </p>
              <ol className="text-[11px] font-mono text-zinc-400 space-y-0.5">
                {routingOrder.map((id, i) => (
                  <li key={id}>
                    {i + 1}. {getProvider(id)?.emoji ?? '·'} {getProvider(id)?.name ?? id}
                  </li>
                ))}
                {!routingOrder.length && <li className="text-zinc-600">No enabled providers — enable one in Providers.</li>}
              </ol>
              <button onClick={onOpenProvidersPanel} className="mt-2 text-[11px] text-cyan-400 hover:text-cyan-300 underline">
                Per-role model preferences → Providers panel
              </button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
