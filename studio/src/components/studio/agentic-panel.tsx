'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleX,
  FileText,
  FolderTree,
  GitCompare,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  TerminalSquare,
  Users,
  Zap,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { PROVIDERS, getProvider, resolveModel } from '@/lib/providers';
import type { AgenticEvent, PlanStep } from '@/lib/agentic/types';
import { AGENT_ROLES, AGENT_ROLE_LABEL, type AgentRole } from '@/lib/agentic/agent-config';
import type { ConnectionsMap } from '@/lib/api-keys-store';
import { DiffViewDialog, FileViewDialog } from './diff-view';

// ---------- API shapes ----------

interface CommandRecord {
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  approval?: string;
}

interface StepData {
  id: string;
  index: number;
  kind: string;
  title: string;
  description: string;
  status: string;
  attempts: number;
  logs: { at: string; kind: string; text: string }[];
  filesChanged: string[];
  commands: CommandRecord[];
  testResult: string | null;
  reviewVerdict: string | null;
}

interface AgentMessageData {
  id: string;
  fromAgent: string;
  toAgent: string;
  type: string;
  content: string;
  createdAt: string;
  provider?: string;
  model?: string;
}

interface ProgressCounts {
  total: number;
  passed: number;
  failed: number;
  denied: number;
  skipped: number;
  running: number;
  pending: number;
  done: number;
  percent: number;
}

interface TaskData {
  id: string;
  prompt: string;
  status: string;
  plan: PlanStep[];
  progress?: ProgressCounts;
  planGaps?: { kind: string; description: string; suggestion: string; severity: string }[];
  blockedReason?: string;
  currentStep: number;
  steps: StepData[];
  report: {
    summary: string;
    changedFiles: string[];
    commandsRun: CommandRecord[];
    testResults: { passed: number; failed: number; details: string }[];
    remainingBugs: string[];
    notes: string;
  } | null;
  error: string | null;
  pendingCommand: { stepIndex: number; command: string; reason: string } | null;
  events: AgenticEvent[];
  messages?: AgentMessageData[];
}

interface TaskListItem {
  id: string;
  prompt: string;
  status: string;
  updatedAt: string;
}

const STEP_KIND_META: Record<string, { emoji: string; label: string }> = {
  analyze: { emoji: '🔎', label: 'Analyze' },
  implement: { emoji: '⚙️', label: 'Implement' },
  test: { emoji: '🧪', label: 'Test' },
  review: { emoji: '🔍', label: 'Review' },
};

// EventSource cannot set custom headers, so the API token (when configured)
// is passed via the query string. NEXT_PUBLIC_AGENTSCOPE_API_TOKEN must be set
// in .env for the live stream to work when AGENTSCOPE_API_TOKEN is enabled.
const STREAM_TOKEN = process.env.NEXT_PUBLIC_AGENTSCOPE_API_TOKEN || '';

const EXAMPLES = [
  'Workspace me ek Python CLI calculator banao (add, sub, mul, div) aur uske tests bhi',
  'Ek Node.js script likho jo CSV file parse kare aur summary print kare, phir sample CSV se test karo',
  'Ek Python password generator banao (length + strength options) aur 3 test cases chalao',
];

const ROLE_EMOJI: Record<string, string> = {
  planner: '🧠',
  coder: '👨‍💻',
  tester: '🧪',
  reviewer: '🔍',
  researcher: '🔬',
  debugger: '🐛',
  security: '🛡️',
  docs: '📚',
  orchestrator: '🎛️',
};

type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'completed';

interface RoleAssignment {
  provider: string;
  model: string;
  fallbackProvider?: string;
  fallbackModel?: string;
}

const PHASE_META: Record<string, { label: string; cls: string; emoji: string }> = {
  queued: { label: 'Starting', cls: 'text-zinc-400', emoji: '⏳' },
  thinking: { label: 'Thinking', cls: 'text-sky-300', emoji: '🧠' },
  writing: { label: 'Writing files', cls: 'text-emerald-300', emoji: '✍️' },
  commands: { label: 'Running commands', cls: 'text-amber-300', emoji: '💻' },
  repair: { label: 'Repairing', cls: 'text-orange-300', emoji: '🔧' },
  snapshot: { label: 'Snapshot', cls: 'text-violet-300', emoji: '📸' },
  reviewing: { label: 'Reviewing', cls: 'text-indigo-300', emoji: '🔍' },
  done: { label: 'Done', cls: 'text-emerald-300', emoji: '✅' },
};

const WAVE_REASON_LABEL: Record<string, string> = {
  'read-only': 'read-only agents',
  'disjoint-writes': 'disjoint-scope writers',
  mixed: 'reader + writer',
  'serialized-write': 'single writer',
  single: 'single step',
};

/** local progress computation (same rules as the server: terminal steps only) */
function localProgress(steps: { status: string }[]): ProgressCounts {
  const counts: ProgressCounts = {
    total: steps.length,
    passed: 0,
    failed: 0,
    denied: 0,
    skipped: 0,
    running: 0,
    pending: 0,
    done: 0,
    percent: 0,
  };
  for (const s of steps) {
    if (s.status === 'passed') counts.passed++;
    else if (s.status === 'failed') counts.failed++;
    else if (s.status === 'denied') counts.denied++;
    else if (s.status === 'skipped') counts.skipped++;
    else if (s.status === 'running' || s.status === 'awaiting_approval') counts.running++;
    else counts.pending++;
  }
  counts.done = counts.passed + counts.failed + counts.denied + counts.skipped;
  counts.percent = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
  return counts;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

interface LiveAgentView {
  index: number;
  title: string;
  kind: string;
  status: string;
  phase: string;
  detail?: string;
  attempt?: number;
  elapsedMs: number;
}

/**
 * The live board: who is working RIGHT NOW, on what, and since when.
 *
 * Data comes from two places so it survives a refresh:
 *  - `task.steps` (persisted status, authoritative),
 *  - `step_progress` events (phase + elapsed, replayed from the event log).
 * The elapsed timer keeps ticking locally between events.
 */
interface LiveStepRow {
  index: number;
  title: string;
  kind: string;
  status: string;
  phase: string;
  detail?: string;
  attempt?: number;
  elapsedMs: number;
  lastAt: number;
}

function LiveBoard({
  task,
  events,
  tick,
  parallelism,
  parallelWrites,
  editable,
  busy,
  onParallelism,
  onParallelWrites,
}: {
  task: TaskData;
  events: AgenticEvent[];
  tick: number;
  parallelism: number;
  parallelWrites: boolean;
  editable: boolean;
  busy: boolean;
  onParallelism: (value: number) => void;
  onParallelWrites: (value: boolean) => void;
}) {
  /**
   * One row per plan step, built from BOTH sources:
   *  - `task.steps` (persisted, refreshed on load / after a control action),
   *  - the live event log (`step_start` / `step_progress` / `step_done`),
   *    which is the only thing that moves while a run is in flight.
   * Events win because they are newer; the persisted row is the fallback for
   * a task that was loaded but never streamed.
   */
  const derived = useMemo(() => {
    const map = new Map<number, LiveStepRow>();

    for (const s of task.steps) {
      map.set(s.index - 1, {
        index: s.index,
        title: s.title,
        kind: s.kind,
        status: s.status,
        phase: 'queued',
        elapsedMs: 0,
        lastAt: 0,
      });
    }

    for (const e of events) {
      if (typeof e.stepIndex !== 'number') continue;
      const current = map.get(e.stepIndex);
      const d = (e.data ?? {}) as {
        phase?: string;
        detail?: string;
        elapsedMs?: number;
        attempt?: number;
        title?: string;
        kind?: string;
        status?: string;
      };
      const base: LiveStepRow = current ?? {
        index: e.stepIndex + 1,
        title: d.title ?? `Step ${e.stepIndex + 1}`,
        kind: d.kind ?? 'implement',
        status: 'pending',
        phase: 'queued',
        elapsedMs: 0,
        lastAt: 0,
      };
      if (e.type === 'step_start') {
        map.set(e.stepIndex, {
          ...base,
          title: d.title ?? base.title,
          kind: d.kind ?? base.kind,
          status: 'running',
          phase: 'queued',
          attempt: d.attempt,
          elapsedMs: 0,
          lastAt: new Date(e.at).getTime(),
        });
      } else if (e.type === 'step_progress') {
        map.set(e.stepIndex, {
          ...base,
          status: base.status === 'awaiting_approval' ? base.status : 'running',
          phase: d.phase ?? base.phase,
          detail: d.detail ?? base.detail,
          attempt: d.attempt ?? base.attempt,
          elapsedMs: Number(d.elapsedMs ?? base.elapsedMs),
          lastAt: new Date(e.at).getTime(),
        });
      } else if (e.type === 'step_done') {
        map.set(e.stepIndex, {
          ...base,
          status: d.status ?? 'passed',
          phase: d.status === 'passed' ? 'done' : 'failed',
          elapsedMs: base.elapsedMs,
          lastAt: new Date(e.at).getTime(),
        });
      }
    }

    return Array.from(map.values()).sort((a, b) => a.index - b.index);
  }, [task.steps, events]);

  /** the newest server-computed progress snapshot (falls back to local) */
  const progress = useMemo<ProgressCounts>(() => {
    const last = [...events].reverse().find((e) => e.type === 'progress');
    if (last?.data) {
      const d = last.data as Partial<ProgressCounts>;
      if (typeof d.total === 'number') return { ...localProgress([]), ...d } as ProgressCounts;
    }
    if (task.progress) return task.progress;
    return localProgress(derived);
  }, [events, task.progress, derived]);

  const agents = derived.filter(
    (d) => d.status === 'running' || d.status === 'awaiting_approval'
  );
  const queued = derived.filter((d) => d.status === 'pending').length;
  const busyCount = agents.filter((a) => a.status === 'running').length;

  return (
    <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Zap className="h-3.5 w-3.5 text-sky-300" />
        <p className="text-xs font-semibold text-sky-200 flex-1">
          ⚡ Live agents — {busyCount}/{parallelism} busy
        </p>
        <span className="text-[10px] text-zinc-400">
          {progress.done}/{progress.total} steps · {progress.percent}%
        </span>
      </div>

      <Progress value={progress.percent} className="h-1.5 mb-2" />

      <div className="flex flex-wrap gap-1.5 mb-2 text-[10px]">
        <span className="px-1.5 py-0.5 rounded bg-zinc-800/70 text-emerald-300">
          ✅ {progress.passed} passed
        </span>
        {progress.running > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-zinc-800/70 text-sky-300">
            ⏳ {progress.running} running
          </span>
        )}
        {queued > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-zinc-800/70 text-zinc-400">
            · {queued} queued
          </span>
        )}
        {progress.failed > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-zinc-800/70 text-red-300">
            ❌ {progress.failed} failed
          </span>
        )}
        {progress.skipped > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-zinc-800/70 text-zinc-400">
            ⤳ {progress.skipped} skipped
          </span>
        )}
      </div>

      {agents.length === 0 ? (
        <p className="text-[10px] text-zinc-500">
          Koi agent abhi nahi chal raha — Run dabao ya paused task ko resume karo.
        </p>
      ) : (
        <div className="space-y-1.5">
          {agents.map((a) => {
            const meta = PHASE_META[a.phase] ?? PHASE_META.queued;
            const elapsed = a.elapsedMs + (a.lastAt ? Math.max(0, Date.now() - a.lastAt) : 0);
            return (
              <div
                key={a.index}
                className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px]">{STEP_KIND_META[a.kind]?.emoji ?? '🤖'}</span>
                  <span className="text-[11px] text-zinc-200 flex-1 truncate">
                    #{a.index} {a.title}
                  </span>
                  <span className={`text-[10px] ${meta.cls}`}>
                    {meta.emoji} {a.status === 'awaiting_approval' ? 'Approval' : meta.label}
                  </span>
                  <span className="text-[10px] font-mono text-zinc-500 tabular-nums">
                    {formatElapsed(elapsed)}
                  </span>
                </div>
                {a.detail && (
                  <p className="text-[10px] text-zinc-500 mt-0.5 truncate">
                    {a.detail}
                    {a.attempt ? ` · attempt ${a.attempt + 1}` : ''}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editable && (
        <div className="mt-2.5 pt-2 border-t border-sky-500/20 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-400">Agents</span>
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                disabled={busy}
                onClick={() => onParallelism(n)}
                className={`h-5 w-5 rounded text-[10px] border ${
                  parallelism === n
                    ? 'bg-sky-600 border-sky-500 text-white'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                } disabled:opacity-50`}
                title={n === 1 ? 'Serial (ek waqt me ek agent)' : `${n} agents ek saath`}
              >
                {n}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
            <Switch
              checked={parallelWrites}
              disabled={busy}
              onCheckedChange={onParallelWrites}
              className="scale-75"
            />
            Parallel writes (sirf disjoint scopes)
          </label>
          <span className="text-[10px] text-zinc-600">
            Writes hamesha lock ke andar — overlap sirf thinking me.
          </span>
        </div>
      )}
    </div>
  );
}

export function AgenticPanel({
  provider,
  model,
  apiKey,
  baseUrl,
  connections,
  activeTaskId,
  onSelectTask,
}: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  connections?: ConnectionsMap;
  activeTaskId: string | null;
  onSelectTask: (id: string | null) => void;
}) {
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [task, setTask] = useState<TaskData | null>(null);
  const [prompt, setPrompt] = useState('');
  const [projectRoot, setProjectRoot] = useState('');
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState(false);
  const [liveEvents, setLiveEvents] = useState<AgenticEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmCommand, setConfirmCommand] = useState<{
    command: string;
    reason: string;
    kind: 'orchestrator' | 'terminal';
  } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [fileView, setFileView] = useState<{ path: string; content: string } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [terminalCmd, setTerminalCmd] = useState('');
  const [terminalOut, setTerminalOut] = useState<string | null>(null);
  const [tree, setTree] = useState<{ path: string; size: number; isDir: boolean }[]>([]);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [perAgentModels, setPerAgentModels] = useState(false);
  /** parallel execution: how many agents may work at the same time */
  const [parallelism, setParallelism] = useState(3);
  /** let writing steps with disjoint declared scopes overlap */
  const [parallelWrites, setParallelWrites] = useState(true);
  /** ticking clock for the live board's elapsed timers */
  const [tick, setTick] = useState(0);
  const [routing, setRouting] = useState<Record<AgentRole, RoleAssignment>>(() =>
    defaultRouting(provider, model)
  );
  const abortRef = useRef<AbortController | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const loadSeqRef = useRef(0);
  const lastSeqRef = useRef(0);

  const connMap = connections ?? {};

  // keep the default assignment in sync with the active connection
  useEffect(() => {
    setRouting((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const role of AGENT_ROLES) {
        if (!perAgentModels && next[role].provider !== provider) {
          next[role] = { provider, model };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [provider, model, perAgentModels]);

  const loadTasks = useCallback(async () => {
    const res = await fetch('/api/agentic/tasks');
    if (res.ok) setTasks(await res.json());
  }, []);

  const loadTask = useCallback(async (id: string) => {
    // guard against out-of-order responses when the user switches tasks fast
    const seq = ++loadSeqRef.current;
    const res = await fetch(`/api/agentic/tasks/${id}`);
    if (res.ok) {
      const data = (await res.json()) as TaskData;
      if (seq !== loadSeqRef.current) return;
      setTask(data);
      const events = data.events ?? [];
      setLiveEvents(events);
      lastSeqRef.current = events.reduce(
        (max, e) => (typeof e.seq === 'number' && e.seq > max ? e.seq : max),
        0
      );
    }
    const treeRes = await fetch(`/api/agentic/tasks/${id}/workspace`);
    if (treeRes.ok) {
      const t = await treeRes.json();
      if (seq !== loadSeqRef.current) return;
      setTree(t.tree ?? []);
    }
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    if (activeTaskId) loadTask(activeTaskId);
    else {
      setTask(null);
      setLiveEvents([]);
      setTree([]);
      lastSeqRef.current = 0;
    }
  }, [activeTaskId, loadTask]);

  useEffect(() => {
    timelineRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveEvents]);

  // the live board shows a running timer — tick once per second while the
  // task is active (no timer at all on a finished task)
  const hasRunningStep =
    (task?.steps ?? []).some((s) => s.status === 'running') ||
    (task ? ['running', 'verifying', 'planning', 'awaiting_approval'].includes(task.status) : false);
  useEffect(() => {
    if (!hasRunningStep) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasRunningStep]);

  // ---------- realtime stream (reconnectable) ----------

  useEffect(() => {
    if (!task?.id) {
      setStreamState('idle');
      return;
    }
    let cancelled = false;
    let source: EventSource | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      setStreamState(retry === 0 ? 'connecting' : 'reconnecting');
      const url = `/api/agentic/tasks/${task.id}/stream?after=${lastSeqRef.current}${STREAM_TOKEN ? `&token=${encodeURIComponent(STREAM_TOKEN)}` : ''}`;
      const es = new EventSource(url);
      source = es;

      es.onopen = () => {
        if (cancelled) return;
        retry = 0;
        setStreamState('live');
      };

      es.onmessage = (message) => {
        if (cancelled) return;
        let event: AgenticEvent;
        try {
          event = JSON.parse(message.data) as AgenticEvent;
        } catch {
          return;
        }
        if (typeof event.seq === 'number' && event.seq > lastSeqRef.current) {
          lastSeqRef.current = event.seq;
        }
        setLiveEvents((prev) =>
          prev.some((e) => typeof e.seq === 'number' && e.seq === event.seq)
            ? prev
            : [...prev, event]
        );
        if (event.type === 'approval_required') {
          const data = event.data as { command: string; reason: string };
          setConfirmCommand({
            command: data.command,
            reason: data.reason,
            kind: 'orchestrator',
          });
        }
        if (event.type === 'stream_status') {
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
  }, [task?.id]);

  // ---------- routing / credentials ----------

  /** only the credentials of the providers that are actually used are sent */
  const credentials = useMemo(() => {
    const used = new Set<string>();
    for (const role of AGENT_ROLES) {
      const a = routing[role];
      if (!a) continue;
      used.add(a.provider);
      if (a.fallbackProvider) used.add(a.fallbackProvider);
    }
    const out: Record<string, { apiKey?: string; baseUrl?: string }> = {};
    for (const id of used) {
      const c = connMap[id as keyof ConnectionsMap];
      if (!c) continue;
      // build ONE entry — assigning twice would drop the apiKey when a
      // provider has both an apiKey and a baseUrl
      const entry: { apiKey?: string; baseUrl?: string } = {};
      if (c.apiKey?.trim()) entry.apiKey = c.apiKey.trim();
      if (c.baseUrl?.trim()) entry.baseUrl = c.baseUrl.trim();
      if (entry.apiKey || entry.baseUrl) out[id] = entry;
    }
    return out;
  }, [routing, connMap]);

  const agentConfig = useMemo(() => {
    const agents: Record<string, unknown> = {};
    for (const role of AGENT_ROLES) {
      const a = routing[role];
      if (!a?.provider) continue;
      const entry: Record<string, unknown> = {
        provider: a.provider,
        model: a.model,
      };
      if (a.fallbackProvider) {
        entry.fallback = {
          provider: a.fallbackProvider,
          model: a.fallbackModel ?? '',
        };
      }
      agents[role] = entry;
    }
    return { agents };
  }, [routing]);

  // ---------- orchestration ----------

  const createTask = async () => {
    const p = prompt.trim();
    if (!p || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/agentic/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: p,
          provider,
          model,
          agentConfig: perAgentModels ? agentConfig : undefined,
          credentials,
          projectRoot: projectRoot.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Task create fail');
      setTask(data);
      setLiveEvents(data.events ?? []);
      onSelectTask(data.id);
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Task create fail');
    } finally {
      setCreating(false);
    }
  };

  const startRun = useCallback(
    async (decision?: 'approve' | 'deny', command?: string) => {
      if (!task || running) return;
      setRunning(true);
      setError(null);
      if (decision) setConfirmCommand(null);
      try {
        const res = await fetch(`/api/agentic/tasks/${task.id}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(decision ? { decision, command } : {}),
            agentConfig: perAgentModels ? agentConfig : undefined,
            credentials,
            parallelism,
            parallelWrites,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Run failed' }));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        await loadTask(task.id);
        await loadTasks();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Run failed');
      } finally {
        setRunning(false);
      }
    },
    [task, running, loadTask, loadTasks, agentConfig, credentials, perAgentModels, parallelism, parallelWrites]
  );

  /**
   * Resume a PAUSED or AWAITING_APPROVAL task.
   *
   * `approvedCommand` is the destructive command the user just approved —
   * it is handed to the engine as an approved command so it is executed
   * instead of being denied. With no argument the task is simply resumed
   * (and a still-pending command counts as denied).
   */
  const resumeTask = useCallback(
    async (approvedCommand?: string) => {
      if (!task || running) return;
      setRunning(true);
      setError(null);
      setConfirmCommand(null);
      try {
        const res = await fetch(`/api/agentic/tasks/${task.id}/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            approvedCommands: approvedCommand ? [approvedCommand] : [],
            agentConfig: perAgentModels ? agentConfig : undefined,
            credentials,
            parallelism,
            parallelWrites,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Resume failed' }));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        await loadTask(task.id);
        await loadTasks();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Resume failed');
      } finally {
        setRunning(false);
      }
    },
    [task, running, loadTask, loadTasks, agentConfig, credentials, perAgentModels, parallelism, parallelWrites]
  );

  const pauseTask = async () => {
    if (!task) return;
    try {
      const res = await fetch(`/api/agentic/tasks/${task.id}/pause`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Pause failed');
      setRunning(false);
      await loadTask(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pause failed');
    }
  };

  const cancelTask = async () => {
    if (!task) return;
    try {
      const res = await fetch(`/api/agentic/tasks/${task.id}/cancel`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Cancel failed');
      setRunning(false);
      await loadTask(task.id);
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    }
  };

  const retryTask = async () => {
    if (!task) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/agentic/tasks/${task.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentConfig: perAgentModels ? agentConfig : undefined,
          credentials,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Retry failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await loadTask(task.id);
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRunning(false);
    }
  };

  const rollback = async () => {
    if (!task) return;
    try {
      const res = await fetch(`/api/agentic/tasks/${task.id}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'baseline' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await loadTask(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback fail');
    }
  };

  const openDiff = async () => {
    if (!task) return;
    setDiffOpen(true);
    setDiffLoading(true);
    try {
      const res = await fetch(`/api/agentic/tasks/${task.id}/diff`);
      const data = await res.json();
      setDiff(data.diff ?? data.error ?? '');
    } finally {
      setDiffLoading(false);
    }
  };

  const openFile = async (path: string) => {
    if (!task) return;
    setFileView({ path, content: '' });
    setFileLoading(true);
    try {
      const res = await fetch(
        `/api/agentic/tasks/${task.id}/workspace?path=${encodeURIComponent(path)}`
      );
      const data = await res.json();
      setFileView({ path, content: data.content ?? data.error ?? '' });
    } finally {
      setFileLoading(false);
    }
  };

  const runTerminal = async (approve = false) => {
    if (!task || !terminalCmd.trim()) return;
    setConfirmCommand(null);
    try {
      const res = await fetch(`/api/agentic/tasks/${task.id}/workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: terminalCmd.trim(), approve }),
      });
      const data = await res.json();
      if (res.status === 403 && data.needsApproval) {
        setConfirmCommand({
          command: terminalCmd.trim(),
          reason: data.error,
          kind: 'terminal',
        });
        return;
      }
      setTerminalOut(
        `$ ${terminalCmd.trim()}\nexit=${data.exitCode ?? '?'} (${data.durationMs ?? 0}ms)\n\n${data.output ?? data.error ?? ''}`
      );
      await loadTask(task.id);
    } catch (err) {
      setTerminalOut(`Error: ${err instanceof Error ? err.message : 'fail'}`);
    }
  };

  const statusMeta: Record<string, { label: string; className: string }> = {
    queued: { label: '⏳ Queued', className: 'text-zinc-300 border-zinc-600' },
    planning: { label: '🧠 Planning…', className: 'text-sky-300 border-sky-500/40' },
    awaiting_approval: { label: '⏸ Approval chahiye', className: 'text-amber-300 border-amber-500/40' },
    running: { label: '▶ Running', className: 'text-emerald-300 border-emerald-500/40' },
    verifying: { label: '🔍 Verifying…', className: 'text-cyan-300 border-cyan-500/40' },
    paused: { label: '⏯ Paused', className: 'text-amber-300 border-amber-500/40' },
    done: { label: '✅ Completed', className: 'text-emerald-300 border-emerald-500/40' },
    failed: { label: '❌ Failed', className: 'text-red-300 border-red-500/40' },
    cancelled: { label: '🚫 Cancelled', className: 'text-zinc-400 border-zinc-600' },
  };

  const pendingApproval =
    confirmCommand?.kind === 'orchestrator'
      ? confirmCommand
      : task?.status === 'awaiting_approval' && task.pendingCommand
        ? {
            command: task.pendingCommand.command,
            reason: task.pendingCommand.reason,
            kind: 'orchestrator' as const,
          }
        : null;

  const canStart =
    task && ['awaiting_approval'].includes(task.status) && !task.pendingCommand;
  const canResume =
    task &&
    (task.status === 'paused' ||
      task.status === 'failed' ||
      (task.status === 'awaiting_approval' && task.pendingCommand));
  const canPause = task && (task.status === 'running' || task.status === 'verifying');
  const canCancel = task && ['queued', 'running', 'verifying', 'paused', 'planning', 'awaiting_approval', 'failed', 'cancelled'].includes(task.status);

  /** the model each role actually used (from the routing events) */
  const roleModels = useMemo(() => {
    const map: Record<string, { provider: string; model: string }> = {};
    for (const ev of liveEvents) {
      if (ev.type === 'model_routed') {
        const d = ev.data as { role?: string; provider?: string; model?: string; ok?: boolean };
        if (d?.role && d?.provider) {
          map[d.role] = { provider: d.provider, model: d.model ?? '' };
        }
      }
    }
    return map;
  }, [liveEvents]);

  const messages = useMemo(() => {
    const fromEvents: AgentMessageData[] = [];
    for (const ev of liveEvents) {
      if (ev.type === 'agent_message') {
        fromEvents.push(ev.data as AgentMessageData);
      }
    }
    return fromEvents;
  }, [liveEvents]);

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Left: task input + workspace */}
      <div className="w-full lg:w-[420px] shrink-0 border-r border-zinc-800 flex flex-col min-h-0">
        <div className="p-4 space-y-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-emerald-400" />
            <h2 className="font-bold">Agentic Task</h2>
            <Badge
              variant="outline"
              className={`ml-auto text-[10px] ${task ? statusMeta[task.status]?.className ?? '' : 'text-zinc-500 border-zinc-700'}`}
            >
              {task ? statusMeta[task.status]?.label ?? task.status : 'koi task nahi'}
            </Badge>
          </div>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="High-level task likho… jaise: 'Workspace me ek Python calculator banao tests ke saath'"
            className="min-h-[90px] bg-zinc-900 border-zinc-700 text-sm"
          />
          <div className="space-y-1">
            <label
              htmlFor="agentic-project-root"
              className="flex items-center gap-1.5 text-[11px] text-zinc-400"
            >
              <FolderTree className="h-3.5 w-3.5 text-amber-400" />
              Project folder (optional) — the agent retrieves relevant code
              from its index before each step
            </label>
            <Input
              id="agentic-project-root"
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              placeholder="C:\\Users\\you\\projects\\my-app"
              className="h-8 bg-zinc-900 border-zinc-700 text-xs font-mono"
            />
          </div>
          <div className="flex gap-2">
            <Button
              onClick={createTask}
              disabled={!prompt.trim() || creating || running}
              className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white"
            >
              {creating ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              Plan banao
            </Button>
            {task && (
              <Button
                variant="outline"
                size="icon"
                onClick={() => onSelectTask(null)}
                className="border-zinc-700"
                aria-label="Naya task"
              >
                <XCircle className="h-4 w-4" />
              </Button>
            )}
          </div>
          {!task && (
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => setPrompt(ex)}
                  className="text-[11px] px-2.5 py-1.5 rounded-full border border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-emerald-500/40 hover:text-emerald-300 transition-colors text-left"
                >
                  {ex.slice(0, 46)}…
                </button>
              ))}
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-xs p-2.5">
              {error}
            </div>
          )}
        </div>

        {/* Agent roster / per-role model routing */}
        <div className="p-4 border-b border-zinc-800 space-y-2">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-sky-300" />
            <h3 className="text-xs font-bold text-zinc-200">Agents</h3>
            <button
              onClick={() => setPerAgentModels((v) => !v)}
              className="ml-auto text-[10px] px-2 py-1 rounded-full border border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-sky-500/40 hover:text-sky-300"
            >
              {perAgentModels ? 'Per-agent models: ON' : 'Per-agent models: OFF'}
            </button>
          </div>
          {AGENT_ROLES.map((role) => {
            const assignment = routing[role];
            const info = getProvider(assignment.provider);
            const used = roleModels[role];
            return (
              <div key={role} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2 space-y-1.5">
                <div className="flex items-center gap-2 text-[11px]">
                  <span>{ROLE_EMOJI[role]}</span>
                  <span className="font-semibold text-zinc-200">
                    {AGENT_ROLE_LABEL[role]}
                  </span>
                  <span className="ml-auto text-[10px] text-zinc-500 truncate max-w-[190px]">
                    {used
                      ? `→ ${used.provider} · ${used.model}`
                      : `${info?.name ?? assignment.provider} · ${assignment.model || info?.defaultModel}`}
                  </span>
                </div>
                {perAgentModels && (
                  <div className="flex gap-1.5">
                    <select
                      value={assignment.provider}
                      onChange={(e) => {
                        const nextProvider = e.target.value;
                        const nextInfo = getProvider(nextProvider);
                        setRouting((prev) => ({
                          ...prev,
                          [role]: {
                            ...prev[role],
                            provider: nextProvider,
                            model: resolveModel(nextInfo, prev[role].model),
                          },
                        }));
                      }}
                      className="flex-1 bg-black/40 border border-zinc-700 rounded text-[10px] px-1.5 py-1 text-zinc-300"
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.emoji} {p.name}
                        </option>
                      ))}
                    </select>
                    <input
                      list={`models-${role}`}
                      value={assignment.model}
                      onChange={(e) =>
                        setRouting((prev) => ({
                          ...prev,
                          [role]: { ...prev[role], model: e.target.value },
                        }))
                      }
                      placeholder="model"
                      className="flex-1 bg-black/40 border border-zinc-700 rounded text-[10px] px-1.5 py-1 text-zinc-300 font-mono"
                    />
                    <datalist id={`models-${role}`}>
                      {(getProvider(assignment.provider)?.models ?? []).map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-[10px] text-zinc-600">
            Har role apna provider/model use karta hai. API keys sirf request me
            jaati hain — kabhi store ya log nahi hoti.
          </p>
        </div>

        {/* Plan + steps */}
        {task && (
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-4 space-y-3">
              <LiveBoard
                task={task}
                events={liveEvents}
                tick={tick}
                parallelism={parallelism}
                parallelWrites={parallelWrites}
                editable={!running && !['running', 'verifying'].includes(task.status)}
                busy={running}
                onParallelism={setParallelism}
                onParallelWrites={setParallelWrites}
              />
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
                <p className="text-xs font-semibold text-emerald-300 mb-2">
                  📋 Plan ({task.plan.length} steps) — step {Math.min(task.currentStep + 1, task.plan.length)}
                </p>
                <div className="space-y-1.5">
                  {task.plan.map((s) => {
                    const st = task.steps.find((x) => x.index === s.index);
                    const status = st?.status ?? 'pending';
                    const icon =
                      status === 'passed'
                        ? '✅'
                        : status === 'failed'
                          ? '❌'
                          : status === 'running'
                            ? '⏳'
                            : status === 'awaiting_approval'
                              ? '⏸'
                              : status === 'denied'
                                ? '🚫'
                                : status === 'skipped'
                                  ? '⤳'
                                  : '·';
                    const deps = (s.dependencies ?? [])
                      .filter((d) => d.type === 'blocks')
                      .map((d) => d.stepIndex);
                    return (
                      <div key={s.index} className="flex items-start gap-2 text-xs">
                        <span className="shrink-0">{icon}</span>
                        <div>
                          <span className="text-zinc-300">
                            {STEP_KIND_META[s.kind]?.emoji} {s.title}
                          </span>
                          {deps.length > 0 && (
                            <span className="ml-1.5 text-[10px] text-sky-400">
                              ⛓ after {deps.join(', ')}
                            </span>
                          )}
                          {s.files && s.files.length > 0 && (
                            <p className="text-[10px] text-violet-300/80 mt-0.5 font-mono truncate">
                              ⚡ writes: {s.files.join(', ')}
                            </p>
                          )}
                          {s.acceptance && (
                            <p className="text-zinc-500 text-[10px] mt-0.5">
                              {s.acceptance}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  {canStart && !running && (
                    <Button
                      size="sm"
                      onClick={() => startRun()}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white h-8"
                    >
                      <Play className="h-3.5 w-3.5 mr-1.5" /> Approve & Run
                    </Button>
                  )}
                  {canResume && !running && (
                    <Button
                      size="sm"
                      onClick={() => resumeTask()}
                      className="bg-amber-600 hover:bg-amber-500 text-white h-8"
                    >
                      <Play className="h-3.5 w-3.5 mr-1.5" /> Resume
                    </Button>
                  )}
                  {canPause && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={pauseTask}
                      className="h-8"
                    >
                      <Pause className="h-3.5 w-3.5 mr-1.5" /> Pause
                    </Button>
                  )}
                  {!running && task && task.status === 'failed' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={retryTask}
                      className="h-8 border-zinc-700 text-zinc-300 hover:text-zinc-100"
                    >
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
                    </Button>
                  )}
                  {!running && task && ['failed', 'cancelled', 'paused'].includes(task.status) && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={cancelTask}
                      className="h-8 border-zinc-700 text-zinc-300 hover:text-zinc-100"
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1.5" /> Cancel
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={openDiff}
                    className="h-8 border-zinc-700 text-zinc-300"
                  >
                    <GitCompare className="h-3.5 w-3.5 mr-1.5" /> Diff
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={rollback}
                    className="h-8 border-zinc-700 text-amber-300 hover:text-amber-200"
                  >
                    <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Rollback
                  </Button>
                </div>
              </div>

              {/* per-step details */}
              {task.steps
                .filter((s) => s.commands.length || s.filesChanged.length || s.status === 'failed')
                .map((s) => (
                  <div
                    key={s.id}
                    className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3"
                  >
                    <button
                      className="w-full flex items-center gap-2 text-left"
                      onClick={() =>
                        setExpanded((p) => ({ ...p, [s.index]: !p[s.index] }))
                      }
                    >
                      <span className="text-xs font-semibold text-zinc-200 flex-1">
                        {STEP_KIND_META[s.kind]?.emoji} Step {s.index}: {s.title}
                        {s.attempts > 0 && (
                          <span className="text-amber-400 ml-1.5 text-[10px]">
                            ({s.attempts} attempts)
                          </span>
                        )}
                      </span>
                      {expanded[s.index] ? (
                        <ChevronUp className="h-3.5 w-3.5 text-zinc-500" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
                      )}
                    </button>
                    {expanded[s.index] && (
                      <div className="mt-2 space-y-2">
                        {s.filesChanged.length > 0 && (
                          <div className="text-[11px]">
                            <p className="text-zinc-500 mb-1">Files:</p>
                            {s.filesChanged.map((f) => (
                              <button
                                key={f}
                                onClick={() => openFile(f)}
                                className="flex items-center gap-1.5 text-emerald-300 hover:text-emerald-200 font-mono"
                              >
                                <FileText className="h-3 w-3" /> {f}
                              </button>
                            ))}
                          </div>
                        )}
                        {s.commands.map((c, ci) => (
                          <div
                            key={ci}
                            className="rounded-lg bg-black/50 border border-zinc-800 p-2 font-mono text-[10px]"
                          >
                            <p className={c.exitCode === 0 ? 'text-emerald-300' : 'text-red-300'}>
                              $ {c.command}{' '}
                              <span className="text-zinc-600">
                                exit={c.exitCode} · {c.durationMs}ms
                                {c.approval ? ` · ${c.approval}` : ''}
                              </span>
                            </p>
                            {c.output && (
                              <pre className="mt-1 text-zinc-400 whitespace-pre-wrap max-h-32 overflow-auto">
                                {c.output.slice(0, 1200)}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

              {/* workspace tree */}
              {tree.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                  <p className="text-xs font-semibold text-zinc-300 mb-2 flex items-center gap-1.5">
                    <TerminalSquare className="h-3.5 w-3.5" /> Workspace files
                  </p>
                  <div className="space-y-0.5">
                    {tree
                      .filter((f) => !f.isDir)
                      .map((f) => (
                        <button
                          key={f.path}
                          onClick={() => openFile(f.path)}
                          className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-400 hover:text-emerald-300 w-full text-left"
                        >
                          <FileText className="h-3 w-3 shrink-0" />
                          <span className="truncate">{f.path}</span>
                          <span className="ml-auto text-zinc-600">{f.size}B</span>
                        </button>
                      ))}
                  </div>
                </div>
              )}

              {/* manual terminal */}
              {task && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                  <p className="text-xs font-semibold text-zinc-300 mb-2">
                    ⌨️ Manual command (workspace me)
                  </p>
                  <div className="flex gap-2">
                    <Input
                      value={terminalCmd}
                      onChange={(e) => setTerminalCmd(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && runTerminal()}
                      placeholder="ls -la"
                      className="h-9 bg-black/40 border-zinc-700 font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runTerminal()}
                      className="h-9 border-zinc-700"
                    >
                      Run
                    </Button>
                  </div>
                  {terminalOut && (
                    <pre className="mt-2 rounded-lg bg-black/50 border border-zinc-800 p-2 font-mono text-[10px] text-zinc-400 whitespace-pre-wrap max-h-40 overflow-auto">
                      {terminalOut}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        )}

        {!task && (
          <div className="flex-1 overflow-y-auto p-4">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
              Purane Tasks
            </p>
            <div className="space-y-1.5">
              {tasks.length === 0 && (
                <p className="text-xs text-zinc-600">Abhi koi agentic task nahi.</p>
              )}
              {tasks.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onSelectTask(t.id)}
                  className="w-full text-left rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5 hover:border-emerald-500/40 transition-colors"
                >
                  <p className="text-xs text-zinc-300 truncate">{t.prompt}</p>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    {statusMeta[t.status]?.label ?? t.status} ·{' '}
                    {new Date(t.updatedAt).toLocaleString()}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right: live timeline + report */}
      <div className="hidden lg:flex flex-1 flex-col min-h-0">
        <div className="h-14 shrink-0 border-b border-zinc-800 flex items-center gap-2 px-4">
          <span className="text-sm font-semibold text-zinc-300">
            Live Execution Timeline
          </span>
          {streamState === 'live' && (
            <Badge variant="outline" className="text-[10px] text-emerald-300 border-emerald-500/40">
              <Wifi className="h-3 w-3 mr-1" /> live
            </Badge>
          )}
          {(streamState === 'connecting' || streamState === 'reconnecting') && (
            <Badge variant="outline" className="text-[10px] text-amber-300 border-amber-500/40">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" /> {streamState}
            </Badge>
          )}
          {streamState === 'completed' && (
            <Badge variant="outline" className="text-[10px] text-zinc-400 border-zinc-600">
              <WifiOff className="h-3 w-3 mr-1" /> stream closed
            </Badge>
          )}
          {task && (
            <span className="ml-auto text-[10px] text-zinc-500 font-mono">
              task: {statusMeta[task.status]?.label ?? task.status}
            </span>
          )}
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 space-y-2" ref={timelineRef}>
            {liveEvents.length === 0 && (
              <div className="text-sm text-zinc-600 py-16 text-center">
                Task start karo — Planner → Coder → Tester → Reviewer ka live
                timeline yahan dikhega.
              </div>
            )}
            {liveEvents.map((ev, i) => (
              <TimelineEvent key={ev.seq ?? i} event={ev} onOpenFile={openFile} />
            ))}
            {messages.length > 0 && (
              <div className="mt-6 space-y-2">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Agent conversation
                </p>
                {messages.map((m) => (
                  <AgentMessageCard key={m.id} message={m} />
                ))}
              </div>
            )}
            {task?.report && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 mt-4">
                <p className="text-sm font-bold text-emerald-300 mb-2">
                  📊 Final Report
                </p>
                <p className="text-xs text-zinc-300 mb-3">{task.report.summary}</p>
                <div className="grid sm:grid-cols-2 gap-3 text-[11px]">
                  <div>
                    <p className="text-zinc-500 mb-1">
                      Changed files ({task.report.changedFiles.length}):
                    </p>
                    {task.report.changedFiles.map((f) => (
                      <button
                        key={f}
                        onClick={() => openFile(f)}
                        className="block font-mono text-emerald-300 hover:text-emerald-200 truncate w-full text-left"
                      >
                        {f}
                      </button>
                    ))}
                    {task.report.changedFiles.length === 0 && (
                      <p className="text-zinc-600">—</p>
                    )}
                  </div>
                  <div>
                    <p className="text-zinc-500">
                      Tests:{' '}
                      {task.report.testResults.reduce((a, t) => a + t.passed, 0)}{' '}
                      passed /{' '}
                      {task.report.testResults.reduce((a, t) => a + t.failed, 0)}{' '}
                      failed
                    </p>
                    <p className="text-zinc-500">
                      Commands run: {task.report.commandsRun.length}
                    </p>
                    {task.report.remainingBugs.length > 0 && (
                      <div className="mt-2">
                        <p className="text-red-300 mb-1">Remaining bugs:</p>
                        {task.report.remainingBugs.map((b, bi) => (
                          <p key={bi} className="text-red-200/80 text-[10px]">
                            • {b}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <p className="text-[10px] text-zinc-500 mt-3">{task.report.notes}</p>
              </div>
            )}
            <div />
          </div>
        </ScrollArea>
      </div>

      {/* Approval dialog */}
      <AlertDialog
        open={Boolean(pendingApproval) || confirmCommand?.kind === 'terminal'}
        onOpenChange={(v) => {
          if (!v) setConfirmCommand(null);
        }}
      >
        <AlertDialogContent className="bg-zinc-950 border-zinc-800">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-amber-300">
              <ShieldAlert className="h-5 w-5" /> Destructive command — approval
              chahiye
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <pre className="rounded-lg bg-black/60 border border-zinc-800 p-2.5 font-mono text-[11px] text-amber-200 whitespace-pre-wrap">
                  {pendingApproval?.command ?? confirmCommand?.command}
                </pre>
                <p className="text-zinc-400 text-xs">
                  {pendingApproval?.reason ?? confirmCommand?.reason}
                </p>
                <p className="text-zinc-500 text-[11px]">
                  Ye command isolated workspace me chalegi, lekin data delete/overwrite
                  kar sakti hai. Tumhare approve karne par hi chalegi.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (confirmCommand?.kind === 'orchestrator') {
                  resumeTask();
                } else {
                  setConfirmCommand(null);
                }
              }}
              className="border-zinc-700 text-zinc-300"
            >
              Deny
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmCommand?.kind === 'orchestrator') {
                  resumeTask(confirmCommand.command);
                } else {
                  runTerminal(true);
                }
              }}
              className="bg-amber-600 hover:bg-amber-500 text-white"
            >
              Approve & Run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DiffViewDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        diff={diff}
        loading={diffLoading}
      />
      <FileViewDialog
        open={Boolean(fileView)}
        onOpenChange={(v) => !v && setFileView(null)}
        path={fileView?.path ?? ''}
        content={fileView?.content ?? ''}
        loading={fileLoading}
      />
    </div>
  );
}

function defaultRouting(
  provider: string,
  model: string
): Record<AgentRole, RoleAssignment> {
  const out = {} as Record<AgentRole, RoleAssignment>;
  for (const role of AGENT_ROLES) {
    out[role] = { provider, model };
  }
  return out;
}

function AgentMessageCard({ message }: { message: AgentMessageData }) {
  const tone =
    message.type === 'error'
      ? 'border-red-500/40 bg-red-500/10'
      : message.type === 'review'
        ? 'border-sky-500/40 bg-sky-500/10'
        : message.type === 'result'
          ? 'border-emerald-500/40 bg-emerald-500/10'
          : 'border-zinc-800 bg-zinc-900/60';
  return (
    <div className={`rounded-lg border p-2.5 text-[11px] ${tone}`}>
      <p className="flex items-center gap-1.5 font-semibold text-zinc-200">
        <span>{ROLE_EMOJI[message.fromAgent] ?? '🤖'}</span>
        {message.fromAgent}
        <span className="text-zinc-500">→</span>
        {message.toAgent}
        <span className="ml-auto text-[9px] uppercase tracking-wide text-zinc-500">
          {message.type}
        </span>
      </p>
      {message.provider && (
        <p className="text-[9px] text-zinc-500 mt-0.5 font-mono">
          {message.provider} · {message.model}
        </p>
      )}
      <pre className="mt-1 text-[10px] text-zinc-400 whitespace-pre-wrap max-h-40 overflow-auto">
        {message.content?.slice(0, 1500)}
      </pre>
    </div>
  );
}

function TimelineEvent({
  event,
  onOpenFile,
}: {
  event: AgenticEvent;
  onOpenFile: (path: string) => void;
}) {
  const at = new Date(event.at).toLocaleTimeString();
  const d = event.data as Record<string, unknown> | undefined;

  switch (event.type) {
    case 'llm': {
      const role = String(d?.role ?? '');
      const label =
        role === 'planner'
          ? '🧠 Planner soch raha hai…'
          : role === 'coder'
            ? '👨‍💻 Coder kaam kar raha hai…'
            : role === 'tester'
              ? '🧪 Tester verify kar raha hai…'
              : '🔍 Reviewer check kar raha hai…';
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          <span className="text-sky-300">
            {label}
            {d?.provider ? (
              <span className="ml-1.5 text-[10px] text-zinc-500 font-mono">
                {String(d.provider)} · {String(d.model ?? '')}
                {typeof d.latencyMs === 'number' ? ` · ${d.latencyMs}ms` : ''}
              </span>
            ) : null}
          </span>
        </div>
      );
    }
    case 'model_routed': {
      const ok = d?.ok !== false;
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          <span className={ok ? 'text-zinc-400' : 'text-red-300'}>
            {ok ? '🧭' : '⚠️'} routed {String(d?.role ?? '')} →{' '}
            <span className="font-mono text-zinc-200">
              {String(d?.provider ?? '')} · {String(d?.model ?? '')}
            </span>
            {d?.fallbackUsed ? (
              <span className="ml-1.5 text-[10px] text-amber-300">fallback</span>
            ) : null}
            {typeof d?.latencyMs === 'number' ? (
              <span className="ml-1.5 text-[10px] text-zinc-600">{d.latencyMs}ms</span>
            ) : null}
            {d?.error ? (
              <span className="ml-1.5 text-[10px] text-red-300">
                {String(d.error).slice(0, 120)}
              </span>
            ) : null}
          </span>
        </div>
      );
    }
    case 'agent_message':
      // rendered separately in the "Agent conversation" section
      return null;
    case 'file_write': {
      const data = d as { path?: string; bytes?: number; action?: string } | undefined;
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          <button
            onClick={() => data?.path && onOpenFile(data.path)}
            className="text-emerald-300 hover:text-emerald-200 font-mono"
          >
            📝 {data?.action}: {data?.path}{' '}
            <span className="text-zinc-500">({data?.bytes} bytes)</span>
          </button>
        </div>
      );
    }
    case 'command': {
      const data = d as
        | { command?: string; exitCode?: number; durationMs?: number; output?: string; phase?: string }
        | undefined;
      if (data?.phase === 'start') {
        return (
          <div className="flex items-start gap-2 text-xs">
            <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
            <span className="text-zinc-300 font-mono">⏳ $ {data?.command}</span>
          </div>
        );
      }
      const ok = data?.exitCode === 0;
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          <div className="min-w-0 flex-1">
            <p className={`font-mono ${ok ? 'text-emerald-300' : 'text-red-300'}`}>
              {ok ? '✓' : '✗'} $ {data?.command}
              <span className="text-zinc-600">
                {' '}
                exit={data?.exitCode} · {data?.durationMs}ms
              </span>
            </p>
            {data?.output && (
              <pre className="mt-1 rounded bg-black/50 border border-zinc-800 p-2 font-mono text-[10px] text-zinc-400 whitespace-pre-wrap max-h-40 overflow-auto">
                {String(data.output).slice(0, 1500)}
              </pre>
            )}
          </div>
        </div>
      );
    }
    case 'test_result': {
      const data = d as { command?: string; passed?: boolean; output?: string } | undefined;
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          <div className="min-w-0 flex-1">
            <p className={data?.passed ? 'text-emerald-300' : 'text-red-300'}>
              {data?.passed ? '🧪 TEST PASS' : '🧪 TEST FAIL'} —{' '}
              <span className="font-mono">{data?.command}</span>
            </p>
            {data?.output && (
              <pre className="mt-1 rounded bg-black/50 border border-zinc-800 p-2 font-mono text-[10px] text-zinc-400 whitespace-pre-wrap max-h-32 overflow-auto">
                {String(data.output).slice(0, 1000)}
              </pre>
            )}
          </div>
        </div>
      );
    }
    case 'approval_required':
      return (
        <div className="flex items-center gap-2 text-xs text-amber-300 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5">
          <ShieldAlert className="h-4 w-4" />
          Approval wait ho raha hai — dialog me decide karo
        </div>
      );
    case 'approval_result': {
      const data = d as { decision?: string; command?: string } | undefined;
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          <span className={data?.decision === 'approved' ? 'text-emerald-300' : 'text-red-300'}>
            {data?.decision === 'approved' ? '👍 Approved' : '👎 Denied'}:{' '}
            <span className="font-mono">{data?.command}</span>
          </span>
        </div>
      );
    }
    case 'wave_start': {
      const data = d as
        | {
            wave?: { index: number; title: string; kind: string }[];
            reason?: string;
            limit?: number;
            writers?: number;
          }
        | undefined;
      const steps = data?.wave ?? [];
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          <span className="text-sky-300">
            <Zap className="h-3.5 w-3.5 inline mr-1" />
            Wave: {steps.length} agent(s)
            {steps.length > 1 ? ' parallel' : ''}
            {data?.reason ? ` · ${WAVE_REASON_LABEL[data.reason] ?? data.reason}` : ''}
            {data?.writers ? ` · ${data.writers} writer(s)` : ''}
            <span className="text-zinc-500">
              {' '}
              {steps.map((s) => `#${s.index}`).join(', ')}
            </span>
          </span>
        </div>
      );
    }
    case 'step_progress': {
      const data = d as
        | { phase?: string; detail?: string; elapsedMs?: number; agent?: string }
        | undefined;
      const meta = PHASE_META[data?.phase ?? 'queued'] ?? PHASE_META.queued;
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          <span className={`${meta.cls} text-[11px]`}>
            {meta.emoji} {meta.label}
            {data?.detail ? <span className="text-zinc-500"> — {data.detail}</span> : null}
            {typeof data?.elapsedMs === 'number' ? (
              <span className="text-zinc-600 font-mono"> ({formatElapsed(data.elapsedMs)})</span>
            ) : null}
          </span>
        </div>
      );
    }
    case 'progress': {
      const data = d as ProgressCounts | undefined;
      if (!data) return null;
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          <span className="text-zinc-400 text-[11px]">
            📊 Progress {data.percent}% — {data.passed} passed · {data.running} running ·{' '}
            {data.pending} queued
          </span>
        </div>
      );
    }
    case 'step_done': {
      const data = d as { status?: string; snapshot?: string; title?: string; reason?: string } | undefined;
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          <span
            className={
              data?.status === 'passed'
                ? 'text-emerald-300'
                : data?.status === 'skipped'
                  ? 'text-zinc-400'
                  : 'text-red-300'
            }
          >
            {data?.status === 'passed' ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 inline mr-1" />
                Step complete · git snapshot <code>{data?.snapshot}</code>
              </>
            ) : data?.status === 'skipped' ? (
              <>⤳ Step skipped — {data?.reason}</>
            ) : (
              <>
                <CircleX className="h-3.5 w-3.5 inline mr-1" />
                Step failed
              </>
            )}
          </span>
        </div>
      );
    }
    case 'review': {
      const data = d as { verdict?: string; summary?: string; issues?: string[] } | undefined;
      return (
        <div
          className={`rounded-lg border p-2.5 text-xs ${
            data?.verdict === 'pass'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-red-500/40 bg-red-500/10 text-red-200'
          }`}
        >
          <p className="font-semibold">
            {data?.verdict === 'pass' ? '🔍 Review: PASS' : '🔍 Review: FAIL'}
          </p>
          {data?.summary && <p className="mt-1 text-[11px] opacity-80">{data.summary}</p>}
          {data?.issues?.map((is, i) => (
            <p key={i} className="text-[10px] mt-0.5 opacity-70">• {is}</p>
          ))}
        </div>
      );
    }
    case 'log':
      return (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          <span className="text-zinc-300">{String(d?.text ?? '')}</span>
        </div>
      );
    case 'plan':
      return (
        <div className="flex items-start gap-2 text-xs text-emerald-300">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          📋 Plan ready — approval ka intezaar
        </div>
      );
    case 'error':
      return (
        <div className="flex items-start gap-2 text-xs text-red-300">
          <span className="text-zinc-600 font-mono text-[10px] mt-0.5">{at}</span>
          ❌ {String((d as { message?: string })?.message ?? 'Error')}
        </div>
      );
    case 'stream_status':
      return (
        <div className="flex items-center gap-2 text-xs text-zinc-400 border-t border-zinc-800 pt-2 mt-2">
          {String(d?.status ?? '')}
        </div>
      );
    case 'done':
      return (
        <div className="flex items-center gap-2 text-xs text-emerald-300 font-semibold">
          🎉 Task complete!
        </div>
      );
    default:
      return null;
  }
}
