'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Laptop,
  RefreshCw,
  Check,
  X,
  ShieldAlert,
  OctagonX,
  Play,
  Power,
  Download,
  Search,
  Globe,
  Send,
  FolderTree,
  MousePointer2,
  Volume2,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface Pending {
  id: string;
  actor: string;
  permission: 'safe' | 'review' | 'destructive' | 'forbidden';
  reason: string;
  summary: string;
  createdAt: string;
  expiresAt: string;
}

interface HostStatus {
  mode: 'locked' | 'ask' | 'trusted';
  trustedDirs: string[];
  pending: Pending[];
}

interface SafetyInfo {
  killed: boolean;
  killReason: string;
  killAt: string;
  killSource: string;
  hotkey: string;
  hostMode: string;
  desktopMode: string;
  platform: string;
  pyautoguiFailsafe: boolean;
}

interface BridgeStatus {
  mode: string;
  running: boolean;
  ready: boolean;
  port: number;
  pid: number | null;
  uptimeSec: number;
  lastError: string;
  installHint: string;
}

interface LaptopStatus {
  safety: SafetyInfo;
  killed: boolean;
  host: { mode: string; trustedDirs: string[] };
  roots: Array<{ path: string; label: string }>;
  bridge: BridgeStatus;
  downloads: Array<{ name: string; path: string; size: number; modifiedAt: string }>;
  telegram: { configured: boolean; polling: boolean; lastError: string; allowedIds: number };
  voice?: {
    enabled: boolean;
    running: boolean;
    ready: boolean;
    port: number;
    wakeEngine: string;
    ttsAvailable: boolean;
    lastError: string;
    installHint: string;
  };
}

interface HistoryEntry {
  url: string;
  title: string;
  visitCount: number;
  lastVisitAt: string | null;
}

const MODE_TEXT: Record<HostStatus['mode'], string> = {
  locked: 'Locked — the agent cannot touch your laptop.',
  ask: 'Ask — the agent may read; every write, command, delete or e-mail waits for your approval.',
  trusted: 'Trusted — new files and routine commands inside the trusted folders run without a prompt. Delete, overwrite and e-mail still ask.',
};

function fmtBytes(n: number): string {
  if (n > 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n > 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function LaptopPanel() {
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [laptop, setLaptop] = useState<LaptopStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // downloads form
  const [dlUrl, setDlUrl] = useState('');
  // history search
  const [histQuery, setHistQuery] = useState('');
  const [histDays, setHistDays] = useState(30);
  const [histBusy, setHistBusy] = useState(false);
  const [histEntries, setHistEntries] = useState<HistoryEntry[] | null>(null);
  const [histNote, setHistNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/host');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      setStatus(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
    try {
      const res = await fetch('/api/laptop');
      if (res.ok) setLaptop(await res.json());
    } catch {
      /* the laptop status is additive — host approvals still show */
    }
  }, []);

  useEffect(() => {
    // approvals expire after 10 minutes and arrive while you work — keep the list fresh
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 3000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const decide = async (id: string, op: 'approve' | 'deny') => {
    setBusy(id);
    try {
      const res = await fetch('/api/host', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, id }),
      });
      const out = await res.json();
      if (!res.ok || out.ok === false) throw new Error(out.error || 'Failed');
      if (op === 'approve') {
        const r = out.result;
        toast({
          title: r?.ok ? 'Done' : 'Ran, but it reported an error',
          description: (r?.error || (typeof r?.data === 'object' ? JSON.stringify(r.data).slice(0, 200) : '')) as string,
          variant: r?.ok ? undefined : 'destructive',
        });
      } else {
        toast({ title: 'Denied — nothing was run' });
      }
    } catch (e) {
      toast({ title: 'Failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(null);
      void load();
    }
  };

  const laptopOp = async (op: string, body: Record<string, unknown> = {}, okTitle: string): Promise<boolean> => {
    setBusy(op);
    try {
      const res = await fetch('/api/laptop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, ...body }),
      });
      const out = await res.json();
      if (!res.ok || (out.ok === false && !out.approval)) throw new Error(out.error || 'Failed');
      if (out.approval) {
        toast({ title: 'Approval queue me gaya', description: 'Approvals section me approve karo.' });
      } else {
        toast({ title: okTitle, description: out.error || undefined, variant: out.ok === false ? 'destructive' : undefined });
      }
      return true;
    } catch (e) {
      toast({ title: `${op} failed`, description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
      return false;
    } finally {
      setBusy(null);
      void load();
    }
  };

  const searchHistory = async () => {
    setHistBusy(true);
    try {
      const res = await fetch('/api/laptop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'history-search', query: histQuery, days: histDays, limit: 25 }),
      });
      const out = await res.json();
      if (out.ok === false) throw new Error(out.error || 'Search failed');
      setHistEntries(out.entries ?? []);
      setHistNote(out.note ?? null);
    } catch (e) {
      toast({ title: 'History search failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
      setHistEntries([]);
    } finally {
      setHistBusy(false);
    }
  };

  const killed = laptop?.killed ?? false;
  const safety = laptop?.safety;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-zinc-100">
          <Laptop className="h-5 w-5 text-emerald-400" />
          <h2 className="text-lg font-semibold">Laptop control</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          <RefreshCw className="mr-1 h-4 w-4" /> Refresh
        </Button>
      </div>

      {error && <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</div>}

      {/* ---- KILL SWITCH (Roadmap #1) ---- */}
      {killed ? (
        <div className="rounded-md border border-red-700 bg-red-950/60 p-4">
          <div className="flex items-center gap-2 text-red-200">
            <OctagonX className="h-5 w-5" />
            <span className="font-semibold">KILL SWITCH ENGAGED — sab laptop actions band hain</span>
          </div>
          <div className="mt-1 text-xs text-red-300/80">
            {safety?.killSource ? `Source: ${safety.killSource}` : ''} {safety?.killAt ? `· ${new Date(safety.killAt).toLocaleString()}` : ''}
            {safety?.killReason ? ` · ${safety.killReason}` : ''}
          </div>
          <Button
            size="sm"
            disabled={busy === 'resume'}
            onClick={() => void laptopOp('resume', {}, 'Kill switch released')}
            className="mt-3 bg-emerald-600 hover:bg-emerald-500"
          >
            <Play className="mr-1 h-4 w-4" /> Resume agent control
          </Button>
        </div>
      ) : (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-zinc-300">
                <OctagonX className="h-4 w-4 text-zinc-500" />
                <span>Kill switch — turant sab rok do</span>
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">
                Global hotkey: <code className="text-zinc-400">{safety?.hotkey ?? 'ctrl+shift+f12'}</code> · pyautogui fail-safe ON (mouse top-left corner) · Telegram <code>/kill</code>
              </div>
            </div>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy === 'kill'}
              onClick={() => void laptopOp('kill', {}, 'KILL engaged — everything stopped')}
            >
              <OctagonX className="mr-1 h-4 w-4" /> KILL
            </Button>
          </div>
        </div>
      )}

      {status && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-300">
          <div className="mb-1 flex items-center gap-2">
            <Badge variant="outline" className="uppercase">{status.mode}</Badge>
            <span>{MODE_TEXT[status.mode]}</span>
          </div>
          <div className="text-xs text-zinc-500">
            Change it with <code>AGENTSCOPE_HOST_MODE</code> (locked / ask / trusted) and{' '}
            <code>AGENTSCOPE_HOST_TRUSTED_DIRS</code> in <code>.env</code>, then restart.
          </div>
          {status.trustedDirs.length > 0 && (
            <div className="mt-2 text-xs text-zinc-400">Trusted folders: {status.trustedDirs.join(' · ')}</div>
          )}
        </div>
      )}

      {/* ---- ALLOWED ROOTS (Roadmap #2) ---- */}
      {laptop && laptop.roots.length > 0 && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
          <div className="flex items-center gap-2 text-zinc-300">
            <FolderTree className="h-4 w-4 text-sky-400" />
            <span>Allowed roots — agent inhi folders me freely kaam kar sakta hai</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {laptop.roots.map((r) => (
              <Badge key={r.path} variant="outline" className="border-sky-500/30 text-sky-300 text-[10px]">
                {r.label}
              </Badge>
            ))}
          </div>
          <div className="mt-1.5 text-xs text-zinc-500">
            Delete hamesha Recycle Bin me jaata hai (send2trash). Customize: <code>AGENTSCOPE_ALLOWED_ROOTS</code>.
          </div>
        </div>
      )}

      {/* ---- DESKTOP BRIDGE (Roadmap #7/#8) ---- */}
      {laptop && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-zinc-300">
                <MousePointer2 className="h-4 w-4 text-amber-400" />
                <span>Desktop bridge (mouse/keyboard/screen) — mode: <Badge variant="outline" className="text-[10px] uppercase">{laptop.bridge.mode}</Badge></span>
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">
                {laptop.bridge.ready
                  ? `Ready on 127.0.0.1:${laptop.bridge.port} · pid ${laptop.bridge.pid} · ${laptop.bridge.uptimeSec}s`
                  : laptop.bridge.running
                    ? `Starting… ${laptop.bridge.lastError}`
                    : laptop.bridge.lastError || 'Stopped — locked mode me bridge start nahi hota'}
              </div>
              {laptop.bridge.lastError && !laptop.bridge.ready && (
                <div className="mt-1 text-xs text-amber-400/80">Hint: {laptop.bridge.installHint}</div>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy === 'bridge-start' || laptop.bridge.mode === 'locked'}
                onClick={() => void laptopOp('bridge-start', {}, 'Desktop bridge started')}
              >
                <Power className="mr-1 h-4 w-4" /> Start
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === 'bridge-stop'}
                onClick={() => void laptopOp('bridge-stop', {}, 'Desktop bridge stopped')}
              >
                Stop
              </Button>
            </div>
          </div>
          {laptop.bridge.mode === 'locked' && (
            <div className="mt-1.5 text-xs text-zinc-500">
              Enable karne ke liye <code>.env</code> me <code>AGENTSCOPE_DESKTOP_MODE=ask</code> +{' '}
              <code>pip install -r python-bridge/requirements-desktop.txt</code>, phir restart.
            </div>
          )}
        </div>
      )}

      {/* ---- REAL CHROME CDP (Roadmap #5) ---- */}
      <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-zinc-300">
              <Globe className="h-4 w-4 text-cyan-400" />
              <span>Aapka asli Chrome (logins ke saath)</span>
            </div>
            <div className="mt-0.5 text-xs text-zinc-500">
              Chrome ko debug port se kholo: <code className="text-zinc-400">chrome.exe --remote-debugging-port=9222</code>, phir connect karo. Browser panel me wo session dikhega.
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy === 'cdp-connect'}
            onClick={() => void laptopOp('cdp-connect', {}, 'Chrome connected')}
            className="shrink-0"
          >
            Connect
          </Button>
        </div>
      </div>

      {/* ---- DOWNLOADS (Roadmap #3) ---- */}
      {laptop && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
          <div className="flex items-center gap-2 text-zinc-300">
            <Download className="h-4 w-4 text-emerald-400" />
            <span>Downloads — naye files par notification milta hai</span>
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              value={dlUrl}
              onChange={(e) => setDlUrl(e.target.value)}
              placeholder="https://example.com/file.pdf"
              className="bg-zinc-800/60 border-zinc-700 text-xs"
            />
            <Button
              size="sm"
              disabled={busy === 'download' || !dlUrl.trim()}
              onClick={async () => {
                const ok = await laptopOp('download', { url: dlUrl.trim() }, 'Download queued');
                if (ok) setDlUrl('');
              }}
              className="shrink-0"
            >
              <Download className="mr-1 h-4 w-4" /> Download
            </Button>
          </div>
          {laptop.downloads.length > 0 && (
            <div className="mt-2 space-y-1">
              {laptop.downloads.slice(0, 6).map((d) => (
                <div key={d.path} className="flex items-center justify-between gap-2 text-xs text-zinc-400">
                  <span className="truncate" title={d.path}>{d.name}</span>
                  <span className="shrink-0 text-zinc-600">{fmtBytes(d.size)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- BROWSER HISTORY (Roadmap #4) ---- */}
      <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
        <div className="flex items-center gap-2 text-zinc-300">
          <Search className="h-4 w-4 text-violet-400" />
          <span>Browser history search (Chrome/Edge — sirf titles + URLs)</span>
        </div>
        <div className="mt-2 flex gap-2">
          <Input
            value={histQuery}
            onChange={(e) => setHistQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !histBusy && void searchHistory()}
            placeholder="kya dhundhna hai (khali = recent)"
            className="bg-zinc-800/60 border-zinc-700 text-xs"
          />
          <Input
            type="number"
            min={1}
            max={365}
            value={histDays}
            onChange={(e) => setHistDays(Number(e.target.value) || 30)}
            className="w-20 bg-zinc-800/60 border-zinc-700 text-xs"
            title="Days to look back"
          />
          <Button size="sm" variant="outline" disabled={histBusy} onClick={() => void searchHistory()} className="shrink-0">
            {histBusy ? '…' : 'Search'}
          </Button>
        </div>
        {histNote && <div className="mt-1.5 text-xs text-zinc-500">{histNote}</div>}
        {histEntries && histEntries.length > 0 && (
          <div className="mt-2 space-y-1">
            {histEntries.slice(0, 10).map((h, i) => (
              <div key={`${h.url}-${i}`} className="text-xs">
                <div className="truncate text-zinc-300">{h.title || h.url}</div>
                <div className="truncate text-zinc-600">
                  {h.lastVisitAt ? new Date(h.lastVisitAt).toLocaleString() : ''} · {h.visitCount} visits
                </div>
              </div>
            ))}
          </div>
        )}
        {histEntries && histEntries.length === 0 && (
          <div className="mt-2 text-xs text-zinc-600">Kuch nahi mila (ya Chrome history file nahi mili).</div>
        )}
      </div>

      {/* ---- VOICE BRIDGE (Jarvis #3 + #1) ---- */}
      {laptop?.voice && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-zinc-300">
                <Volume2 className="h-4 w-4 text-emerald-400" />
                <span>Voice bridge (natural TTS + "Hey Jarvis")</span>
                <Badge
                  variant="outline"
                  className={`text-[10px] ${
                    laptop.voice.ready
                      ? 'border-emerald-500/40 text-emerald-300'
                      : laptop.voice.running
                        ? 'border-amber-500/40 text-amber-300'
                        : 'border-zinc-700 text-zinc-500'
                  }`}
                >
                  {laptop.voice.ready ? 'ready' : laptop.voice.running ? 'starting' : 'idle (on-demand)'}
                </Badge>
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">
                TTS: {laptop.voice.ttsAvailable ? 'edge-tts OK (Hindi + English)' : 'edge-tts nahi mila'} · wake engine:{' '}
                {laptop.voice.wakeEngine} · port {laptop.voice.port}
                {laptop.voice.lastError ? ` — ${laptop.voice.lastError.slice(0, 100)}` : ''}
              </div>
              {!laptop.voice.ttsAvailable && (
                <div className="mt-1 text-[11px] text-amber-400/80">{laptop.voice.installHint}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---- TELEGRAM (Roadmap #9) ---- */}
      {laptop && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-zinc-300">
                <Send className="h-4 w-4 text-sky-400" />
                <span>Phone se control (Telegram bot)</span>
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">
                {laptop.telegram.configured
                  ? laptop.telegram.polling
                    ? `Polling · ${laptop.telegram.allowedIds} allowed ID(s)`
                    : `Configured but stopped${laptop.telegram.lastError ? ` — ${laptop.telegram.lastError.slice(0, 120)}` : ''}`
                  : 'Setup: @BotFather se bot token lo, phir .env me AGENTSCOPE_TELEGRAM_BOT_TOKEN + AGENTSCOPE_TELEGRAM_ALLOWED_IDS=<aapki-numeric-id> dalo.'}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy === 'telegram-start' || !laptop.telegram.configured}
                onClick={() => void laptopOp('telegram-start', {}, 'Telegram bot started')}
              >
                Start
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === 'telegram-stop' || !laptop.telegram.polling}
                onClick={() => void laptopOp('telegram-stop', {}, 'Telegram bot stopped')}
              >
                Stop
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---- APPROVALS (existing — unchanged) ---- */}
      <h3 className="text-sm font-medium text-zinc-400">Waiting for your approval ({status?.pending.length ?? 0})</h3>

      {status && status.pending.length === 0 && (
        <div className="rounded-md border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
          Nothing is waiting. When the agent wants to run a command, write a file, delete something or send an e-mail, it shows up here.
        </div>
      )}

      {status?.pending.map((p) => (
        <div key={p.id} className="rounded-md border border-amber-900/60 bg-amber-950/20 p-3">
          <div className="mb-2 flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="min-w-0">
              <div className="break-words font-mono text-sm text-zinc-100">{p.summary}</div>
              <div className="mt-1 text-xs text-zinc-400">
                {p.permission} · {p.reason} · asked by {p.actor} · expires {new Date(p.expiresAt).toLocaleTimeString()}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy === p.id} onClick={() => void decide(p.id, 'approve')} className="bg-emerald-600 hover:bg-emerald-500">
              <Check className="mr-1 h-4 w-4" /> Approve &amp; run
            </Button>
            <Button size="sm" variant="outline" disabled={busy === p.id} onClick={() => void decide(p.id, 'deny')}>
              <X className="mr-1 h-4 w-4" /> Deny
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
