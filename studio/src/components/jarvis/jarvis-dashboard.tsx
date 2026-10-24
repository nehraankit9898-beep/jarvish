'use client';

/**
 * JarvisDashboard — the JARVIS home mode (main screen).
 *
 * Every panel on this screen binds to the REAL backend:
 *  - Uplink        → GET /api/providers (enabled / configured / last test)
 *  - System meters → GET /api/system/status + GET /api/health (uptime, DB counts)
 *  - Current task  → GET /api/agentic/tasks + SSE /api/agentic/tasks/{id}/stream
 *  - Task approvals→ POST /api/agentic/tasks/{id}/resume {approvedCommands:[cmd]}
 *                    (identical payload to agentic-panel.tsx)
 *  - Host approvals→ GET /api/host + POST /api/host {op:'approve'|'deny', id}
 *  - Kill switch   → GET /api/laptop + POST /api/laptop {op:'resume'}
 *  - Activity      → GET /api/audit + live task events
 *  - Transcript    → the existing conversation state (same /api/chat stream
 *                    and /api/jarvis intent router as Chat mode)
 *
 * Nothing here is simulated. Unsupported capabilities render an explicit
 * unavailable state (e.g. mic unsupported, voice bridge offline).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { JarvisReactor, type JarvisVisualState } from './jarvis-reactor';
import {
  Mic,
  MicOff,
  Radar,
  Send,
  Square,
  Volume2,
  VolumeX,
  Settings2,
  MessageSquarePlus,
  BrainCircuit,
  ShieldAlert,
  Radio,
  Activity as ActivityIcon,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import type { ChatMessageData } from '../studio/chat-message';
import type { useVoiceInput, useSpeechOutput, useWakeWord, VoiceLang } from '@/hooks/use-speech';

const STREAM_TOKEN = (process.env.NEXT_PUBLIC_AGENTSCOPE_API_TOKEN as string | undefined) ?? '';

type Voice = ReturnType<typeof useVoiceInput>;
type Tts = ReturnType<typeof useSpeechOutput>;
type WakeStatus = ReturnType<typeof useWakeWord>['status'];

export interface JarvisTaskListItem {
  id: string;
  prompt: string;
  status: string;
  updatedAt: string;
}

export interface JarvisDashboardProps {
  state: JarvisVisualState;
  statusText: string;
  messages: ChatMessageData[];
  streaming: boolean;
  input: string;
  setInput: (v: string) => void;
  onSend: (text?: string) => void;
  onStop: () => void;
  voice: Voice;
  tts: Tts;
  handsFree: boolean;
  toggleHandsFree: () => void;
  micLang: VoiceLang;
  toggleMicLang: () => void;
  liveMode: boolean;
  toggleLive: () => void;
  wakeStatus: WakeStatus;
  wakeError?: string | null;
  agenticTaskId: string | null;
  agenticTasks: JarvisTaskListItem[];
  pythonStatus: { ok: boolean; python: string | null; agentscope: string | null } | null;
  providerLabel: string;
  activeModel: string;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onOpenAgentic: (taskId: string) => void;
}

/* ---------------- loose API types (shapes mirrored from backend) ---------- */

interface ProviderDto {
  provider: string;
  name: string;
  emoji: string;
  enabled: boolean;
  costClass: string;
  hasKey: boolean;
  configured: boolean;
  lastTestOk: boolean | null;
  lastError: string;
}
interface SystemSnapshot {
  ok: boolean;
  database?: { ok: boolean; counts?: Record<string, number> };
  python?: { ok: boolean; agentscope?: string | null };
  tools?: { total: number; healthy: number; broken: number };
  runtime?: { node: string; platform: string; uptime?: number };
}
interface HealthSnapshot {
  status: string;
  uptimeSeconds?: number;
  checks?: { database?: { ok: boolean; latencyMs?: number } };
}
interface HostPending {
  id: string;
  summary?: string;
  reason?: string;
  permission?: string;
  actor?: string;
  createdAt?: string;
  expiresAt?: string;
}
interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  category: string;
  result: string;
}
interface TaskDetail {
  id: string;
  prompt: string;
  status: string;
  currentStep?: number | null;
  plan?: Array<{ index: number; title: string }>;
  steps?: Array<{ index: number; title: string; status: string }>;
  pendingCommand?: { command: string; reason: string } | null;
  error?: string | null;
}
interface AgenticEvent {
  type: string;
  seq?: number;
  at: string;
  stepIndex?: number;
  data?: Record<string, unknown>;
}

const ACTIVE_TASK_STATES = new Set([
  'queued',
  'planning',
  'running',
  'awaiting_approval',
  'verifying',
  'retry_wait',
  'blocked',
  'paused',
]);

function fmtUptime(sec?: number) {
  if (!sec || sec < 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function eventLine(ev: AgenticEvent): string {
  const d = ev.data ?? {};
  switch (ev.type) {
    case 'plan':
      return `🧠 plan ready · ${String((d as { steps?: unknown[] }).steps?.length ?? '?')} steps`;
    case 'step_start':
      return `▶ step ${Number(ev.stepIndex ?? 0) + 1}: ${String(d?.title ?? '')}`;
    case 'step_done':
      return `✓ step ${Number(ev.stepIndex ?? 0) + 1} done`;
    case 'file_write':
      return `📝 ${String(d?.action ?? 'write')}: ${String(d?.path ?? '')}`;
    case 'command':
      return d?.phase === 'start'
        ? `⏳ $ ${String(d?.command ?? '')}`
        : `${Number(d?.exitCode) === 0 ? '✓' : '✗'} $ ${String(d?.command ?? '')}`;
    case 'test_result':
      return `${d?.passed ? '🧪 TEST PASS' : '🧪 TEST FAIL'}`;
    case 'approval_required':
      return `🛡 approval needed: ${String(d?.command ?? '')}`;
    case 'approval_result':
      return `🛡 approval: ${String(d?.decision ?? d?.approved ?? '')}`;
    case 'llm':
      return `◌ ${String(d?.role ?? 'model')} → ${String(d?.provider ?? '')}/${String(d?.model ?? '')}`;
    case 'model_routed':
      return d?.ok === false
        ? `⚠ route failed: ${String(d?.error ?? '').slice(0, 80)}`
        : `🧭 routed ${String(d?.role ?? '')} → ${String(d?.provider ?? '')}`;
    case 'review':
      return `🔍 review: ${String(d?.verdict ?? '')}`;
    case 'error':
      return `✗ ${String(d?.error ?? d?.message ?? 'error').slice(0, 90)}`;
    case 'done':
      return '✔ task complete';
    case 'cancelled':
      return '■ task cancelled';
    case 'paused':
      return '⏸ paused';
    case 'resumed':
      return '▶ resumed';
    default:
      return '';
  }
}

/* ================================ component =============================== */

export function JarvisDashboard(props: JarvisDashboardProps) {
  const {
    state,
    statusText,
    messages,
    streaming,
    input,
    setInput,
    onSend,
    onStop,
    voice,
    tts,
    handsFree,
    toggleHandsFree,
    micLang,
    toggleMicLang,
    liveMode,
    toggleLive,
    wakeStatus,
    wakeError,
    agenticTaskId,
    agenticTasks,
    pythonStatus,
    providerLabel,
    activeModel,
    onOpenSettings,
    onNewChat,
    onOpenAgentic,
  } = props;

  const logRef = useRef<HTMLDivElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  /* ---- real system snapshots ---- */
  const [system, setSystem] = useState<SystemSnapshot | null>(null);
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [hostPending, setHostPending] = useState<HostPending[]>([]);
  const [hostMode, setHostMode] = useState<string>('');
  const [killed, setKilled] = useState<boolean | null>(null);
  const [voiceBridgeReady, setVoiceBridgeReady] = useState<boolean | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);

  const refreshSystem = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        fetch('/api/system/status').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/health').then((r) => (r.ok ? r.json() : null)),
      ]);
      if (s) setSystem(s as SystemSnapshot);
      if (h) setHealth(h as HealthSnapshot);
    } catch {
      /* keep last snapshot */
    }
  }, []);

  const refreshProviders = useCallback(async () => {
    try {
      const res = await fetch('/api/providers');
      if (res.ok) {
        const data = (await res.json()) as { providers?: ProviderDto[] };
        setProviders(data.providers ?? []);
      }
    } catch {
      /* keep last */
    }
  }, []);

  const refreshHost = useCallback(async () => {
    try {
      const res = await fetch('/api/host');
      if (res.ok) {
        const data = (await res.json()) as { mode?: string; pending?: HostPending[] };
        setHostMode(data.mode ?? '');
        setHostPending(data.pending ?? []);
      }
      const lap = await fetch('/api/laptop');
      if (lap.ok) {
        const data = (await lap.json()) as { killed?: boolean; voice?: { ready?: boolean } };
        setKilled(Boolean(data.killed));
        setVoiceBridgeReady(Boolean(data.voice?.ready));
      }
    } catch {
      /* keep last */
    }
  }, []);

  const refreshAudit = useCallback(async () => {
    try {
      const res = await fetch('/api/audit?limit=10');
      if (res.ok) setAudit((await res.json()) as AuditRow[]);
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    refreshSystem();
    refreshProviders();
    refreshHost();
    refreshAudit();
    const t1 = setInterval(refreshSystem, 60_000);
    const t2 = setInterval(refreshProviders, 30_000);
    const t3 = setInterval(refreshHost, 5_000);
    const t4 = setInterval(refreshAudit, 30_000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
      clearInterval(t4);
    };
  }, [refreshSystem, refreshProviders, refreshHost, refreshAudit]);

  /* ---- current task: pick the active one (or the selected one) ---- */
  const activeTaskItem = useMemo(() => {
    const active = agenticTasks.filter((t) => ACTIVE_TASK_STATES.has(t.status));
    if (agenticTaskId) {
      const sel = agenticTasks.find((t) => t.id === agenticTaskId);
      if (sel && (ACTIVE_TASK_STATES.has(sel.status) || !active.length)) return sel;
    }
    return active[0] ?? null;
  }, [agenticTasks, agenticTaskId]);

  /* ---- live task view: detail + SSE events ---- */
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [taskEvents, setTaskEvents] = useState<AgenticEvent[]>([]);
  const [streamState, setStreamState] = useState<
    'idle' | 'live' | 'connecting' | 'reconnecting' | 'completed'
  >('idle');
  const lastSeqRef = useRef(0);
  const [taskBusy, setTaskBusy] = useState(false);

  const loadTaskDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/agentic/tasks/${id}`);
      if (res.ok) {
        const data = (await res.json()) as TaskDetail & { events?: AgenticEvent[] };
        setTaskDetail(data);
        const evs = data.events ?? [];
        setTaskEvents(evs.slice(-40));
        lastSeqRef.current = evs.reduce(
          (max, e) => (typeof e.seq === 'number' && e.seq > max ? e.seq : max),
          0,
        );
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!activeTaskItem) {
      setTaskDetail(null);
      setTaskEvents([]);
      setStreamState('idle');
      return;
    }
    void loadTaskDetail(activeTaskItem.id);
  }, [activeTaskItem?.id, activeTaskItem?.status, loadTaskDetail, activeTaskItem]);

  useEffect(() => {
    const id = activeTaskItem?.id;
    if (!id) return;
    let cancelled = false;
    let source: EventSource | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      setStreamState(retry === 0 ? 'connecting' : 'reconnecting');
      const url = `/api/agentic/tasks/${id}/stream?after=${lastSeqRef.current}${STREAM_TOKEN ? `&token=${encodeURIComponent(STREAM_TOKEN)}` : ''}`;
      const es = new EventSource(url);
      source = es;
      es.onopen = () => {
        if (!cancelled) {
          retry = 0;
          setStreamState('live');
        }
      };
      es.onmessage = (message) => {
        if (cancelled) return;
        let ev: AgenticEvent;
        try {
          ev = JSON.parse(message.data) as AgenticEvent;
        } catch {
          return;
        }
        if (typeof ev.seq === 'number' && ev.seq > lastSeqRef.current) {
          lastSeqRef.current = ev.seq;
        }
        setTaskEvents((prev) =>
          prev.some((e) => e.seq === ev.seq) ? prev : [...prev.slice(-39), ev],
        );
        if (ev.type === 'approval_required' || ev.type === 'approval_result' || ev.type === 'step_done' || ev.type === 'done') {
          void loadTaskDetail(id);
        }
        if (ev.type === 'stream_status') {
          setStreamState('completed');
          es.close();
        }
      };
      es.onerror = () => {
        es.close();
        if (cancelled) return;
        setStreamState('reconnecting');
        retry += 1;
        timer = setTimeout(connect, Math.min(8000, 700 * retry));
      };
    };
    connect();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, [activeTaskItem?.id, activeTaskItem, loadTaskDetail]);

  /* ---- transcript autoscroll ---- */
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming, voice.interim]);

  /* ---- task actions (same payloads as agentic-panel) ---- */
  const respondApproval = useCallback(
    async (approved: boolean) => {
      const task = taskDetail;
      if (!task?.pendingCommand || taskBusy) return;
      setTaskBusy(true);
      try {
        const res = await fetch(`/api/agentic/tasks/${task.id}/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            approvedCommands: approved ? [task.pendingCommand.command] : [],
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: 'Resume failed' }))) as { error?: string };
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        toast({
          title: approved ? 'Command approved' : 'Command denied',
          description: approved ? task.pendingCommand.command : 'Task continues without the command.',
        });
        setTaskDetail((prev) => (prev ? { ...prev, pendingCommand: null } : prev));
        void loadTaskDetail(task.id);
      } catch (e) {
        toast({
          title: 'Approval failed',
          description: e instanceof Error ? e.message : 'unknown error',
          variant: 'destructive',
        });
      } finally {
        setTaskBusy(false);
      }
    },
    [taskDetail, taskBusy, loadTaskDetail],
  );

  const cancelTask = useCallback(async () => {
    const task = taskDetail;
    if (!task || taskBusy) return;
    setTaskBusy(true);
    try {
      const res = await fetch(`/api/agentic/tasks/${task.id}/cancel`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: 'Task cancelled' });
      void loadTaskDetail(task.id);
    } catch (e) {
      toast({
        title: 'Cancel failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      });
    } finally {
      setTaskBusy(false);
    }
  }, [taskDetail, taskBusy, loadTaskDetail]);

  const decideHost = useCallback(async (id: string, op: 'approve' | 'deny') => {
    try {
      const res = await fetch('/api/host', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, id }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: '' }))) as { error?: string };
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      toast({ title: op === 'approve' ? 'Action approved' : 'Action denied' });
      setHostPending((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      toast({
        title: 'Decision failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      });
    }
  }, []);

  const resumeAfterKill = useCallback(async () => {
    try {
      const res = await fetch('/api/laptop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'resume' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: 'Kill switch released' });
      setKilled(false);
    } catch (e) {
      toast({
        title: 'Resume failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      });
    }
  }, []);

  /* ---- derived displays ---- */
  const counts = system?.database?.counts ?? {};
  const uplink = useMemo(() => {
    const enabled = providers.filter((p) => p.enabled);
    const tested = enabled.filter((p) => p.lastTestOk === true).length;
    const withKey = enabled.filter((p) => p.hasKey || p.provider === 'zai' || p.provider === 'ollama');
    return {
      enabled,
      pct: enabled.length ? Math.round((Math.max(tested, withKey.length) / enabled.length) * 100) : 0,
      configured: enabled.filter((p) => p.configured).length,
    };
  }, [providers]);

  const taskProgress = useMemo(() => {
    const steps = taskDetail?.steps ?? [];
    const total = taskDetail?.plan?.length ?? steps.length ?? 0;
    const done = steps.filter((s) => ['passed', 'done', 'skipped'].includes(s.status)).length;
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
  }, [taskDetail]);

  const activity = useMemo(() => {
    const evLines = taskEvents
      .map((e) => ({ at: e.at, text: eventLine(e), live: true }))
      .filter((l) => l.text);
    const auditLines = audit.map((a) => ({
      at: a.at,
      text: `${a.result === 'ok' ? '•' : '⚠'} ${a.actor}: ${a.action}`,
      live: false,
    }));
    return [...evLines, ...auditLines]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 14);
  }, [taskEvents, audit]);

  const interimLine = voice.listening
    ? voice.interim || 'Boliye… (mic band karne ke liye button dabao)'
    : null;

  return (
    <div className="relative flex-1 min-h-0 flex flex-col" data-jarvis-screen="">
      {/* ---------- reactor backdrop ---------- */}
      <div className="absolute inset-0 pointer-events-none" aria-hidden>
        <JarvisReactor state={state} className="absolute inset-0" />
        <div className="absolute inset-0 jv-scanlines" />
        <div className="absolute inset-0 jv-vignette" />
      </div>

      {/* ---------- scrollable content ---------- */}
      <div className="relative z-10 flex-1 min-h-0 overflow-y-auto">
        <div className="min-h-full flex flex-col">
          {/* reactor zone */}
          <div className="relative flex-1 min-h-[300px] sm:min-h-[360px] flex flex-col items-center justify-end pointer-events-none">
            {/* left stats rail (desktop) */}
            <div className="hidden lg:flex flex-col gap-3 absolute left-5 top-5 w-44 pointer-events-auto">
              <Meter label="UPLINK" value={uplink.pct} note={`${uplink.configured}/${uplink.enabled.length || providers.length} providers`} />
              <Meter
                label="ENGINE"
                value={pythonStatus?.ok ? 100 : pythonStatus?.python ? 40 : 0}
                note={pythonStatus?.ok ? `agentscope v${pythonStatus.agentscope}` : 'node engine'}
              />
              <div className="jv-panel rounded-lg p-3">
                <p className="jv-hud-label mb-1">Uptime</p>
                <p className="font-mono text-sm text-zinc-200">{fmtUptime(health?.uptimeSeconds)}</p>
                <p className="jv-hud-label mt-2 mb-1">DB</p>
                <p className="font-mono text-xs text-zinc-400">
                  {counts.tasks ?? 0} tasks · {counts.conversations ?? 0} chats
                </p>
                <p className="jv-hud-label mt-2 mb-1">Tools</p>
                <p className="font-mono text-xs text-zinc-400">
                  {system?.tools ? `${system.tools.healthy}/${system.tools.total} healthy` : '—'}
                </p>
              </div>
            </div>

            {/* right rail (xl): uplink + approvals + activity */}
            <div className="hidden xl:flex flex-col gap-3 absolute right-5 top-5 bottom-24 w-80 pointer-events-auto">
              <section className="jv-panel rounded-lg p-3">
                <header className="flex items-center justify-between mb-2">
                  <p className="jv-hud-label">Uplink · providers</p>
                  <button onClick={onOpenSettings} className="text-[10px] text-cyan-300 hover:text-cyan-200 uppercase tracking-wider">
                    Setup
                  </button>
                </header>
                <ul className="space-y-1 max-h-40 overflow-y-auto">
                  {uplink.enabled.slice(0, 8).map((p) => (
                    <li key={p.provider} className="flex items-center gap-2 text-xs">
                      <span
                        className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                          p.lastTestOk === true
                            ? 'bg-emerald-400'
                            : p.lastTestOk === false
                              ? 'bg-red-400'
                              : p.hasKey || p.provider === 'zai' || p.provider === 'ollama'
                                ? 'bg-cyan-400'
                                : 'bg-zinc-600'
                        }`}
                      />
                      <span className="truncate text-zinc-300">
                        {p.emoji} {p.name}
                      </span>
                      <span className="ml-auto text-[10px] font-mono text-zinc-500 uppercase">{p.costClass}</span>
                    </li>
                  ))}
                  {!uplink.enabled.length && (
                    <li className="text-xs text-zinc-500">No providers enabled — open Setup.</li>
                  )}
                </ul>
              </section>

              <section className="jv-panel rounded-lg p-3 min-h-0 flex flex-col">
                <p className="jv-hud-label mb-2">Realtime activity</p>
                <ul className="space-y-1 overflow-y-auto max-h-56 text-[11px] font-mono">
                  {activity.map((l, i) => (
                    <li key={`${l.at}-${i}`} className={l.live ? 'text-cyan-300' : 'text-zinc-500'}>
                      <span className="text-zinc-600">{new Date(l.at).toLocaleTimeString()} </span>
                      {l.text}
                    </li>
                  ))}
                  {!activity.length && <li className="text-zinc-600">No recent activity yet.</li>}
                </ul>
              </section>
            </div>

            {/* status caption */}
            <div className="relative z-10 mb-2 text-center pointer-events-auto px-4">
              <p className={`text-xs sm:text-sm font-mono tracking-[0.3em] uppercase jv-glow ${state === 'error' ? 'text-red-300' : 'text-cyan-200'}`}>
                {statusText}
              </p>
              <p className="mt-1 text-[10px] font-mono text-zinc-500">
                {providerLabel} · {activeModel || 'default model'}
                {tts.enabled ? ' · voice on' : ''}
                {handsFree ? ' · wake word armed' : ''}
                {liveMode ? ' · LIVE' : ''}
              </p>
            </div>

            {/* current task card */}
            {taskDetail && (
              <div className="relative z-10 w-full max-w-2xl px-4 mb-2 pointer-events-auto">
                <div className="jv-panel rounded-xl p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <BrainCircuit className="h-4 w-4 text-cyan-300 shrink-0" />
                    <span className="text-xs text-zinc-300 truncate flex-1 min-w-[10rem]">
                      {taskDetail.prompt}
                    </span>
                    <span className="text-[10px] font-mono uppercase tracking-wider text-amber-300">
                      {taskDetail.status}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500" title={`SSE ${streamState}`}>
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full mr-1 ${
                          streamState === 'live'
                            ? 'bg-emerald-400 jv-anim-blink'
                            : streamState === 'completed'
                              ? 'bg-zinc-500'
                              : 'bg-amber-400'
                        }`}
                      />
                      {streamState === 'live' ? 'LIVE' : streamState}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className="h-full bg-cyan-400 transition-all duration-500"
                        style={{ width: `${taskProgress.pct}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-zinc-400 shrink-0">
                      {taskProgress.done}/{taskProgress.total} steps
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px] text-zinc-400 hover:text-zinc-200"
                      onClick={() => onOpenAgentic(taskDetail.id)}
                    >
                      Open
                    </Button>
                    {ACTIVE_TASK_STATES.has(taskDetail.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={taskBusy}
                        className="h-6 px-2 text-[10px] text-red-300 hover:text-red-200"
                        onClick={cancelTask}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ---------- console ---------- */}
          <div className="relative z-10 w-full max-w-3xl mx-auto px-3 sm:px-4 pb-4 pointer-events-auto">
            {/* kill switch banner */}
            {killed && (
              <div className="mb-2 rounded-lg border border-red-500/40 bg-red-950/40 p-3 flex items-center gap-3 jv-anim-fade-up">
                <ShieldAlert className="h-4 w-4 text-red-300 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-red-200">KILL SWITCH ENGAGED</p>
                  <p className="text-[10px] text-red-300/80">
                    All laptop actions are refused. Release from here or the Laptop tab.
                  </p>
                </div>
                <Button size="sm" variant="outline" className="h-7 border-red-500/50 text-red-200 hover:bg-red-500/20" onClick={resumeAfterKill}>
                  Resume
                </Button>
              </div>
            )}

            {/* host approvals */}
            {hostPending.length > 0 && (
              <div className="mb-2 jv-panel rounded-lg p-3 jv-anim-fade-up">
                <p className="jv-hud-label mb-2 flex items-center gap-1.5">
                  <ShieldAlert className="h-3.5 w-3.5 text-amber-300" /> Waiting for your approval · host mode: {hostMode || '?'}
                </p>
                <ul className="space-y-2">
                  {hostPending.map((p) => (
                    <li key={p.id} className="rounded border border-amber-500/30 bg-amber-500/5 p-2">
                      <p className="text-xs text-zinc-200 break-words">{p.summary || p.reason || p.id}</p>
                      <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                        {p.permission} · expires {p.expiresAt ? new Date(p.expiresAt).toLocaleTimeString() : '—'}
                      </p>
                      <div className="mt-1.5 flex gap-2">
                        <Button size="sm" className="h-6 px-2 text-[10px] bg-cyan-600 hover:bg-cyan-500 text-white" onClick={() => decideHost(p.id, 'approve')}>
                          Approve &amp; run
                        </Button>
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] border-zinc-700 text-zinc-300" onClick={() => decideHost(p.id, 'deny')}>
                          Deny
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* task command approval */}
            {taskDetail?.pendingCommand && (
              <div className="mb-2 jv-panel rounded-lg p-3 border-amber-500/40 jv-anim-fade-up">
                <p className="jv-hud-label mb-1.5 text-amber-300">Command approval required</p>
                <pre className="text-xs font-mono text-zinc-200 whitespace-pre-wrap break-words bg-black/40 rounded p-2 border border-zinc-800">
                  {taskDetail.pendingCommand.command}
                </pre>
                <p className="text-[10px] text-zinc-500 mt-1">{taskDetail.pendingCommand.reason}</p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" disabled={taskBusy} className="h-7 px-3 text-xs bg-cyan-600 hover:bg-cyan-500 text-white" onClick={() => respondApproval(true)}>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve &amp; run
                  </Button>
                  <Button size="sm" variant="outline" disabled={taskBusy} className="h-7 px-3 text-xs border-zinc-700 text-zinc-300" onClick={() => respondApproval(false)}>
                    <XCircle className="h-3.5 w-3.5 mr-1" /> Deny
                  </Button>
                </div>
              </div>
            )}

            {/* transcript */}
            <div ref={logRef} className="jv-panel rounded-2xl px-3 pt-2 pb-1 max-h-52 overflow-y-auto">
              {messages.length === 0 && !streaming && (
                <p className="text-[11px] text-zinc-500 font-mono py-2 text-center">
                  Transcript empty — type a command below or say &quot;Hey JARVIS&quot;.
                </p>
              )}
              <div className="space-y-2 py-1">
                {messages.map((m, i) => (
                  <div key={m.id} className="text-xs leading-relaxed">
                    {m.role === 'user' ? (
                      <p className="text-zinc-400">
                        <span className="font-mono text-[10px] tracking-widest text-cyan-500 mr-2">YOU ▸</span>
                        <span className="break-words">{m.content}</span>
                      </p>
                    ) : (
                      <div className="text-zinc-200">
                        <span className={`font-mono text-[10px] tracking-widest mr-2 ${state === 'error' ? 'text-red-400' : 'text-cyan-300'}`}>JARVIS ▸</span>
                        <div className="inline-block align-top max-w-full break-words [&_p]:inline [&_code]:text-cyan-200 [&_code]:bg-cyan-500/10 [&_code]:px-1 [&_code]:rounded [&_pre]:my-1 [&_pre]:bg-black/50 [&_pre]:border [&_pre]:border-zinc-800 [&_pre]:rounded-lg [&_pre]:p-2 [&_pre]:text-[10px] [&_pre_code]:bg-transparent">
                          <ReactMarkdown
                            components={{
                              a: ({ children, href }) => (
                                <a href={href} target="_blank" rel="noreferrer" className="text-cyan-300 underline">
                                  {children}
                                </a>
                              ),
                            }}
                          >
                            {m.content || (streaming && i === messages.length - 1 ? '…' : '')}
                          </ReactMarkdown>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {streaming && <TypingDots />}
                <div ref={transcriptEndRef} />
              </div>
            </div>

            {/* interim speech line */}
            {interimLine && (
              <p className="mt-1.5 px-1 text-xs text-emerald-300 font-mono italic jv-anim-fade-up">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 jv-anim-blink mr-1.5 align-middle" />
                {interimLine}
              </p>
            )}
            {voice.error && <p className="mt-1.5 px-1 text-xs text-red-400 font-mono">{voice.error}</p>}
            {wakeError && handsFree && (
              <p className="mt-1.5 px-1 text-xs text-amber-400 font-mono">Wake word: {String(wakeError)}</p>
            )}
            {tts.supported && !tts.enabled && (
              <p className="mt-1.5 px-1 text-[10px] text-zinc-600 font-mono">
                Voice output off — speaker button to enable{voiceBridgeReady === false ? ' · edge-tts bridge offline (browser voice will be used)' : ''}
              </p>
            )}

            {/* chips */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip onClick={onOpenSettings}>
                <Settings2 className="h-3 w-3" /> API Setup
              </Chip>
              <Chip onClick={toggleHandsFree} active={handsFree}>
                <Radar className={`h-3 w-3 ${handsFree && wakeStatus?.wake?.listening ? 'animate-pulse' : ''}`} /> Hey JARVIS
              </Chip>
              <Chip onClick={toggleLive} active={liveMode} tone="green" disabled={!voice.supported}>
                <Radio className="h-3 w-3" /> {voice.supported ? 'LIVE' : 'LIVE (no mic)'}
              </Chip>
              <Chip onClick={onNewChat}>
                <MessageSquarePlus className="h-3 w-3" /> New Chat
              </Chip>
            </div>

            {/* composer */}
            <form
              className="mt-2 flex items-end gap-2 rounded-2xl border border-[var(--jv-panel-line)] bg-[rgba(4,12,20,0.86)] backdrop-blur p-2 focus-within:border-[var(--jv-accent-line)] transition-colors"
              onSubmit={(e) => {
                e.preventDefault();
                onSend();
              }}
            >
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onSend();
                  }
                }}
                placeholder="Command JARVIS… (Enter = send · Shift+Enter = new line)"
                className="flex-1 min-h-[44px] max-h-32 resize-none border-0 bg-transparent focus-visible:ring-0 text-sm"
                rows={1}
                aria-label="Command input"
              />
              {voice.supported && (
                <IconBtn
                  onClick={() => (voice.listening ? voice.stop() : voice.start())}
                  label={voice.listening ? 'Stop mic' : 'Speak (voice input)'}
                  active={voice.listening}
                  danger={voice.listening}
                >
                  {voice.listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </IconBtn>
              )}
              <IconBtn onClick={toggleMicLang} label={`Mic language: ${micLang}`} ghost>
                <span className="text-[10px] font-bold">{micLang === 'hi-IN' ? 'हिं' : 'EN'}</span>
              </IconBtn>
              {tts.supported && (
                <IconBtn
                  onClick={() => {
                    if (tts.enabled) tts.stopSpeaking();
                    tts.setEnabled(!tts.enabled);
                  }}
                  label="Speak replies (TTS)"
                  active={tts.enabled}
                  ghost
                >
                  {tts.enabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                </IconBtn>
              )}
              {streaming || tts.speaking ? (
                <IconBtn onClick={onStop} label="Stop response" danger>
                  <Square className="h-4 w-4" />
                </IconBtn>
              ) : (
                <IconBtn onClick={() => onSend()} label="Send" active disabled={!input.trim()}>
                  <Send className="h-4 w-4" />
                </IconBtn>
              )}
            </form>
            <p className="mt-1.5 text-[10px] text-zinc-600 text-center font-mono">
              {streaming
                ? 'responding — STOP interrupts the stream'
                : liveMode
                  ? 'LIVE: continuous listen → think → speak loop'
                  : 'routed by the Jarvis intent engine · chat or agentic task'}
            </p>
          </div>
        </div>
      </div>

      {/* mobile compact status strip */}
      <div className="xl:hidden lg:hidden absolute top-2 right-2 z-10 flex gap-1.5 pointer-events-none">
        <span className="jv-panel rounded-full px-2 py-1 text-[9px] font-mono text-zinc-400 pointer-events-auto" title="Enabled providers">
          <ActivityIcon className="h-3 w-3 inline mr-1 text-cyan-300" />
          {uplink.enabled.length} up
        </span>
        {hostPending.length > 0 && (
          <span className="jv-panel rounded-full px-2 py-1 text-[9px] font-mono text-amber-300">
            {hostPending.length} approval{hostPending.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------- small parts ------------------------------ */

function Meter({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="jv-panel rounded-lg p-3">
      <div className="flex items-center justify-between mb-1.5">
        <p className="jv-hud-label">{label}</p>
        <span className="font-mono text-[10px] text-zinc-300">{value}%</span>
      </div>
      <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
        <div className="h-full bg-cyan-400 transition-all duration-700" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      {note && <p className="mt-1 text-[9px] font-mono text-zinc-600">{note}</p>}
    </div>
  );
}

function Chip({
  children,
  onClick,
  active,
  tone = 'cyan',
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  tone?: 'cyan' | 'green';
  disabled?: boolean;
}) {
  const activeCls =
    tone === 'green'
      ? 'border-emerald-400/60 text-emerald-300 bg-emerald-400/10'
      : 'border-cyan-400/60 text-cyan-200 bg-cyan-400/10';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-mono transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active ? activeCls : 'border-[var(--jv-panel-line)] text-zinc-400 hover:text-cyan-200 hover:border-cyan-400/40'
      }`}
    >
      {children}
    </button>
  );
}

function IconBtn({
  children,
  onClick,
  label,
  active,
  ghost,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  active?: boolean;
  ghost?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      size="icon"
      variant={ghost ? 'ghost' : 'default'}
      aria-label={label}
      title={label}
      className={`h-10 w-10 shrink-0 rounded-xl ${
        danger
          ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
          : active
            ? 'bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30'
            : ghost
              ? 'text-zinc-400 hover:text-cyan-200'
              : 'bg-cyan-600 hover:bg-cyan-500 text-white'
      }`}
    >
      {children}
    </Button>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 pl-1" aria-label="JARVIS is responding">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1 w-1 rounded-full bg-cyan-300 jv-anim-blink"
          style={{ animationDelay: `${i * 0.3}s` }}
        />
      ))}
    </span>
  );
}
