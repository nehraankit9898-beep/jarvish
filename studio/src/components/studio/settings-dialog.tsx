'use client';

import { useState } from 'react';
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
import type { ConnectionsMap } from '@/lib/api-keys-store';
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

  const provider = PROVIDERS.find((p) => p.id === selected)!;
  const saved = connections[selected];

  const draft = drafts[selected] ?? {
    apiKey: saved?.apiKey ?? '',
    // resolveModel: purana retired model (e.g. gemini-2.0-flash) dikhne par
    // current model fallback dega — Select me invalid value kabhi na aaye
    model: saved?.model
      ? resolveModel(provider, saved.model)
      : provider.defaultModel,
    baseUrl: saved?.baseUrl || provider.baseUrl,
  };

  const setDraft = (patch: Partial<typeof draft>) => {
    setDrafts((prev) => ({
      ...prev,
      [selected]: { ...draft, ...patch },
    }));
  };

  const handleSave = () => {
    // A provider is only "connected" when its key has been verified by a
    // successful test-connection call (or it needs no key at all). Merely
    // typing a key must not mark it connected.
    const testPassed = testStates[selected] === 'success';
    updateConnection(selected, {
      apiKey: draft.apiKey,
      model: draft.model,
      baseUrl: draft.baseUrl,
      connected:
        provider.kind === 'zai' || selected === 'ollama'
          ? true
          : selected === 'custom'
            ? Boolean(draft.baseUrl) && testPassed
            : testPassed,
    });
    toast({
      title: 'Saved ✓',
      description: `${provider.name} configuration saved in your browser.`,
    });
  };

  const handleTest = async () => {
    setTestStates((prev) => ({ ...prev, [selected]: 'testing' }));
    try {
      const res = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selected,
          apiKey: draft.apiKey,
          model: draft.model,
          baseUrl: draft.baseUrl,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setTestStates((prev) => ({ ...prev, [selected]: 'success' }));
        updateConnection(selected, {
          apiKey: draft.apiKey,
          model: draft.model,
          baseUrl: draft.baseUrl,
          connected: true,
          testedAt: new Date().toISOString(),
          lastError: undefined,
        });
        toast({
          title: 'Connection Successful ✓',
          description: json.message,
        });
      } else {
        setTestStates((prev) => ({ ...prev, [selected]: 'error' }));
        updateConnection(selected, {
          apiKey: draft.apiKey,
          model: draft.model,
          baseUrl: draft.baseUrl,
          connected: false,
          lastError: json.error,
        });
        toast({
          title: 'Connection Failed ✗',
          description: json.error,
          variant: 'destructive',
        });
      }
    } catch (err) {
      setTestStates((prev) => ({ ...prev, [selected]: 'error' }));
      const msg = err instanceof Error ? err.message : 'Network error';
      toast({ title: 'Connection Failed ✗', description: msg, variant: 'destructive' });
    }
  };

  const handleUse = () => {
    if (
      provider.kind !== 'zai' &&
      !draft.apiKey &&
      selected !== 'ollama' &&
      selected !== 'custom'
    ) {
      toast({
        title: 'API key chahiye',
        description: `${provider.name} ke liye pehle API key paste karo aur Test karo.`,
        variant: 'destructive',
      });
      return;
    }
    handleSave();
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
                Keys sirf aapke browser me save hoti hain
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
                          {conn?.connected ? 'Connected' : p.free ? 'Free' : 'Key required'}
                        </span>
                      </span>
                      {conn?.connected && (
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
                API keys aapke browser ke localStorage me rehti hain — server par kabhi store
                nahi hoti. Har request par sirf use hone ke liye bheji jaati hain.
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
                {isConnected ? (
                  <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Connected
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-zinc-400 border-zinc-700">
                    Not connected
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
                        placeholder={provider.keyLabel}
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

                {provider.models.length > 0 && (
                  <div className="space-y-2">
                    <Label className="text-zinc-300">Model</Label>
                    <Select
                      value={draft.model || provider.defaultModel}
                      onValueChange={(v) => setDraft({ model: v })}
                    >
                      <SelectTrigger className="bg-zinc-800 border-zinc-700 text-zinc-100">
                        <SelectValue placeholder="Select model" />
                      </SelectTrigger>
                      <SelectContent className="bg-zinc-900 border-zinc-700">
                        {provider.models.map((m) => (
                          <SelectItem key={m} value={m} className="text-zinc-100">
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                    onClick={handleSave}
                    variant="outline"
                    className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  >
                    Save
                  </Button>
                  <Button
                    onClick={handleUse}
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
                    Connection verified — API live hai!
                  </div>
                )}
                {(testState === 'error' || saved?.lastError) && testState !== 'testing' && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span className="break-all">
                      {saved?.lastError || 'Test failed. Key aur URL check karo.'}
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
