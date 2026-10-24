'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Bot,
  BrainCircuit,
  MessageSquare,
  MessageSquarePlus,
  MoreVertical,
  Pencil,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Users,
  Zap,
  Cpu,
  Database,
  Wrench,
  LayoutDashboard,
  Server,
  KeyRound,
  BookOpen,
  Clock,
  ScrollText,
  Target,
  Globe,
  Laptop,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Radar,
} from 'lucide-react';
import { AgenticPanel } from './agentic-panel';
import { ComparePanel } from './compare-panel';
import { AgentRegistryPanel } from './agent-registry-panel';
import { ToolRegistryPanel } from './tool-registry-panel';
import { ProvidersPanel } from './providers-panel';
import { MemoryPanel } from './memory-panel';
import { LaptopPanel } from './laptop-panel';
import { KnowledgePanel } from './knowledge-panel';
import { AutomationPanel } from './automation-panel';
import { AuditPanel } from './audit-panel';
import { SystemPanel } from './system-panel';
import { DashboardPanel } from './dashboard-panel';
import { GoalsPanel } from './goals-panel';
import { BrowserPanel } from './browser-panel';
import { NotificationsBell } from './notifications-bell';
import { PROVIDERS, getProvider, resolveModel } from '@/lib/providers';
import { useConnections } from '@/lib/api-keys-store';
import { installTokenFetch } from '@/lib/api-token';
import { toast } from '@/hooks/use-toast';
import { ChatMessage, TypingIndicator, type ChatMessageData } from './chat-message';
import type { AgentCreatePayload } from './agent-create-card';
import { SettingsDialog } from './settings-dialog';
import { AgentDialog, type AgentData } from './agent-dialog';
import { useVoiceInput, useSpeechOutput, useWakeWord, type SentenceChain, type VoiceLang } from '@/hooks/use-speech';
import { Slider } from '@/components/ui/slider';
import { buildActionAck } from '@/lib/agentic/jarvis';
import { JarvisDashboard } from '@/components/jarvis/jarvis-dashboard';
import { JarvisSettings } from '@/components/jarvis/jarvis-settings';
import { JarvisBoot } from '@/components/jarvis/jarvis-boot';
import type { JarvisVisualState } from '@/components/jarvis/jarvis-reactor';
import { perfSample, perfStart } from '@/lib/perf';
import { usePolling } from '@/hooks/use-polling';

interface ConversationItem {
  id: string;
  title: string;
  agentId?: string | null;
  updatedAt: string;
}

interface AgentItem {
  id: string;
  name: string;
  emoji: string;
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: number;
}

const FEATURES = [
  {
    icon: Zap,
    title: 'ReAct Agent Loop',
    desc: 'Har message par agent sochta hai → tool use karta hai → jawab deta hai. Yehi AgentScope ka core pattern hai.',
  },
  {
    icon: Users,
    title: 'AI khud agent banata hai',
    desc: 'Bas bolo "mere liye ek coding agent banao" — AI khud naam, emoji, personality design karke agent create kar dega. Chaaho to manually bhi bana sakte ho.',
  },
  {
    icon: Wrench,
    title: '10 Real API Connections',
    desc: 'OpenAI, Claude, Gemini, DeepSeek, Qwen, Kimi, Grok, Ollama ya koi bhi OpenAI-compatible endpoint.',
  },
];

type StudioMode =
  | 'jarvis'
  | 'chat'
  | 'agentic'
  | 'compare'
  | 'agent-registry'
  | 'tool-registry'
  | 'providers'
  | 'memory'
  | 'knowledge'
  | 'automation'
  | 'goals'
  | 'browser'
  | 'laptop'
  | 'audit'
  | 'system'
  | 'dashboard';

/** Sidebar navigation. `active` is the Tailwind class of the selected state. */
const NAV_ITEMS: {
  mode: StudioMode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: string;
}[] = [
  { mode: 'jarvis', label: 'JARVIS', icon: Bot, active: 'bg-cyan-600 hover:bg-cyan-500' },
  { mode: 'dashboard', label: 'Home', icon: LayoutDashboard, active: 'bg-emerald-600 hover:bg-emerald-500' },
  { mode: 'chat', label: 'Chat', icon: MessageSquarePlus, active: 'bg-emerald-600 hover:bg-emerald-500' },
  { mode: 'agentic', label: 'Agentic', icon: BrainCircuit, active: 'bg-emerald-600 hover:bg-emerald-500' },
  { mode: 'goals', label: 'Goals', icon: Target, active: 'bg-rose-600 hover:bg-rose-500' },
  { mode: 'browser', label: 'Browser', icon: Globe, active: 'bg-cyan-600 hover:bg-cyan-500' },
  { mode: 'laptop', label: 'Laptop', icon: Laptop, active: 'bg-emerald-600 hover:bg-emerald-500' },
  { mode: 'compare', label: 'Compare', icon: Zap, active: 'bg-amber-600 hover:bg-amber-500' },
  { mode: 'agent-registry', label: 'Agents', icon: Cpu, active: 'bg-sky-600 hover:bg-sky-500' },
  { mode: 'tool-registry', label: 'Tools', icon: Database, active: 'bg-purple-600 hover:bg-purple-500' },
  { mode: 'providers', label: 'Providers', icon: KeyRound, active: 'bg-cyan-600 hover:bg-cyan-500' },
  { mode: 'memory', label: 'Memory', icon: BrainCircuit, active: 'bg-sky-600 hover:bg-sky-500' },
  { mode: 'knowledge', label: 'Knowledge', icon: BookOpen, active: 'bg-amber-600 hover:bg-amber-500' },
  { mode: 'automation', label: 'Automation', icon: Clock, active: 'bg-violet-600 hover:bg-violet-500' },
  { mode: 'audit', label: 'Audit', icon: ScrollText, active: 'bg-zinc-600 hover:bg-zinc-500' },
  { mode: 'system', label: 'System', icon: Server, active: 'bg-emerald-600 hover:bg-emerald-500' },
];

/** Agentic task states that mean "work in flight" (drives reactor color). */
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

const JARVIS_STATE_LABEL: Record<JarvisVisualState, string> = {
  idle: 'STANDBY — ALL SYSTEMS NOMINAL',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  speaking: 'RESPONDING',
  error: 'SYSTEM FAULT — CHECK ALERTS',
};

/**
 * HUD clock. Lives in its own component ON PURPOSE: the 1 s tick used to
 * call setClock() in the Studio root, re-rendering the ENTIRE tree (all
 * panels, transcript markdown, reactor props) every second. Now only this
 * span re-renders.
 */
function StudioClock() {
  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString([], { hour12: false }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="hidden sm:block font-mono text-xs text-zinc-400 tabular-nums" aria-hidden>
      {clock || '--:--:--'}
    </span>
  );
}

export function Studio() {
  const {
    connections,
    activeProvider,
    loaded,
    updateConnection,
    removeConnection,
    switchProvider,
  } = useConnections();

  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentData | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // ---- JARVIS home: live voice loop + HUD rail + boot ----
  const [liveMode, setLiveMode] = useState(false);
  const liveRef = useRef(false);
  const sendRef = useRef<(text?: string) => void>(() => undefined);
  const [railOpen, setRailOpen] = useState(true);
  const [jarvisSettingsOpen, setJarvisSettingsOpen] = useState(false);
  const [bootDone, setBootDone] = useState(true);
  useEffect(() => {
    try {
      setBootDone(window.sessionStorage.getItem('jarvis-booted') === '1');
    } catch {
      /* private mode */
    }
  }, []);
  // ---- voice (Roadmap #6): mic input + spoken replies — browser-native ----
  // BUGFIX (settings must stick): mic language now persists like hands-free /
  // wake-sensitivity do — it used to reset to hi-IN on every page reload.
  const [micLang, setMicLang] = useState<VoiceLang>('hi-IN');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('agentscope-mic-lang');
      if (saved === 'hi-IN' || saved === 'en-IN') setMicLang(saved);
    } catch {
      /* private mode */
    }
  }, []);
  const changeMicLang = useCallback((l: VoiceLang) => {
    setMicLang(l);
    try {
      window.localStorage.setItem('agentscope-mic-lang', l);
    } catch {
      /* ignore */
    }
  }, []);
  const voice = useVoiceInput({
    lang: micLang,
    onFinal: (text) => {
      // LIVE loop: the transcript IS the command; otherwise append to composer
      if (liveRef.current) sendRef.current(text);
      else setInput((prev) => (prev ? `${prev} ${text}` : text));
    },
  });
  const tts = useSpeechOutput();
  // ---- Jarvis #1: hands-free wake word ("Hey Jarvis") ----------------
  // persisted in localStorage — ek baar on karne ke baad har visit pe chalu
  const [handsFree, setHandsFree] = useState(false);
  const [wakeSensitivity, setWakeSensitivity] = useState(0.5);
  const [wakePanelOpen, setWakePanelOpen] = useState(false);
  useEffect(() => {
    try {
      setHandsFree(window.localStorage.getItem('agentscope-handsfree') === '1');
      const s = Number(window.localStorage.getItem('agentscope-wake-sensitivity'));
      if (Number.isFinite(s) && s > 0 && s <= 1) setWakeSensitivity(s);
    } catch {
      /* private mode */
    }
  }, []);
  const wake = useWakeWord({
    enabled: handsFree,
    sensitivity: wakeSensitivity,
    // echo guard + double-capture guard: jab Jarvis bol raha ho ya mic
    // khula ho, wake word sunna band (spec #1 + #3)
    paused: tts.speaking || voice.listening,
    onWake: () => {
      setMode('jarvis');
      // BUGFIX (duplicate capture): a wake trigger that arrives while a mic
      // session is already open must not restart it — the restart aborted the
      // running recognition and threw away everything the user had said.
      if (!voice.listening) voice.start();
      toast({ title: 'Jarvis sun raha hai…', description: 'Boliye, kya kaam karna hai?' });
    },
  });
  const toggleHandsFree = useCallback(() => {
    // BUGFIX (React render-phase update): the toast + localStorage calls used
    // to live INSIDE the setState updater — React 19 runs updaters during the
    // render phase, so toggling hands-free logged "Cannot update a component
    // (`Toaster`) while rendering a different component (`Studio`)". All side
    // effects now happen after the state update.
    const next = !handsFree;
    setHandsFree(next);
    try {
      window.localStorage.setItem('agentscope-handsfree', next ? '1' : '0');
    } catch {
      /* ignore */
    }
    toast({
      title: next ? 'Hands-free ON' : 'Hands-free OFF',
      description: next
        ? 'Ab "Hey Jarvis" bolo — mic khud khulega. (openWakeWord chahiye: pip install -r python-bridge/requirements-voice.txt)'
        : 'Wake word sunna band.',
    });
  }, [handsFree]);
  const changeWakeSensitivity = useCallback((v: number) => {
    setWakeSensitivity(v);
    try {
      window.localStorage.setItem('agentscope-wake-sensitivity', String(v));
    } catch {
      /* ignore */
    }
  }, []);
  // ---- LIVE voice loop (provider-agnostic, through the real backend):
  // when enabled, the mic re-opens automatically whenever JARVIS is neither
  // streaming a reply nor speaking one. Final transcripts auto-send. ----
  const toggleLive = useCallback(() => {
    // BUGFIX (React render-phase update): same toast-inside-updater pattern
    // as toggleHandsFree — moved out of the setState updater.
    const next = !liveMode;
    if (next && !voice.supported) {
      toast({
        title: 'LIVE unavailable',
        description: 'Speech recognition is not supported in this browser — Chrome ya Edge use karo.',
        variant: 'destructive',
      });
      return;
    }
    setLiveMode(next);
    toast({
      title: next ? 'LIVE voice loop ON' : 'LIVE voice loop OFF',
      description: next
        ? 'Continuous listen → think → speak. Stop button ya LIVE chip se band karo.'
        : 'Continuous listening band.',
    });
  }, [liveMode, voice.supported]);
  useEffect(() => {
    if (!liveMode) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // BUGFIX (stuck listening loop): when the mic cannot start (permission
    // denied, hardware missing, network error) the retry below re-fired
    // voice.start() every ~600 ms forever. Once an error is visible the loop
    // stops retrying — the user sees the reason and can retry with one tap
    // (a successful start clears the error and the loop resumes).
    if (!streaming && !tts.speaking && !voice.listening && !voice.error) {
      timer = setTimeout(() => voice.start(), 600);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [liveMode, streaming, tts.speaking, voice.listening, voice.error, voice.start]);
  useEffect(() => {
    if (!liveMode && voice.listening) voice.stop();
  }, [liveMode, voice]);
  // Jarvis #5: morning summary ko BHI bolo (TTS on ho to) — ek hi baar per
  // notification, spoken-ids localStorage me track hote hain
  const spokenSummariesRef = useRef<Set<string>>(new Set());
  // the interval below lives for the whole session, but `tts.speak` is a new
  // callback whenever TTS is enabled/disabled — call the LATEST one through a
  // ref, or the first-render closure (enabled=false) silences the greeting
  const ttsRef = useRef(tts);
  ttsRef.current = tts;
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('agentscope-spoken-summaries');
      if (saved) spokenSummariesRef.current = new Set(JSON.parse(saved) as string[]);
    } catch {
      /* ignore */
    }
  }, []);
  const checkMorningSummary = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/notifications?limit=10', { signal });
      if (!res.ok) return;
      const items = (await res.json()) as Array<{
        id: string; read: boolean; body: string; data: Record<string, unknown>;
      }>;
      for (const n of items) {
        const isMorning =
          (n.data as { kind?: string })?.kind === 'morning_summary' &&
          !n.read &&
          !spokenSummariesRef.current.has(n.id);
        if (isMorning) {
          spokenSummariesRef.current.add(n.id);
          try {
            window.localStorage.setItem(
              'agentscope-spoken-summaries',
              JSON.stringify([...spokenSummariesRef.current].slice(-20))
            );
          } catch {
            /* ignore */
          }
          ttsRef.current.speak(n.body || 'Good morning');
        }
      }
    } catch {
      /* never break the app for a spoken greeting */
    }
  }, []);
  // Same 60 s cadence — skipped while the tab is hidden, never overlapping.
  usePolling(checkMorningSummary, 60_000);
  // ---- agentic mode state (chat mode untouched) ----
  // JARVIS command center is the landing mode; every classic panel stays
  // reachable from the rail.
  const [mode, setMode] = useState<StudioMode>('jarvis');
  const [agenticTaskId, setAgenticTaskId] = useState<string | null>(null);
  const [agenticTasks, setAgenticTasks] = useState<
    { id: string; prompt: string; status: string; updatedAt: string }[]
  >([]);
  const [pythonStatus, setPythonStatus] = useState<{
    ok: boolean;
    python: string | null;
    agentscope: string | null;
  } | null>(null);

  // ---- JARVIS reactor state machine ---------------------------------------
  // 'error' is a transient state flashed by real failures (chat/task errors);
  // everything else derives from actual app state — nothing simulated.
  const [jarvisError, setJarvisError] = useState(false);
  const jarvisErrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashJarvisError = useCallback(() => {
    setJarvisError(true);
    if (jarvisErrTimer.current) clearTimeout(jarvisErrTimer.current);
    jarvisErrTimer.current = setTimeout(() => setJarvisError(false), 2800);
  }, []);
  const taskRunning = agenticTasks.some((t) => ACTIVE_TASK_STATES.has(t.status));
  const jarvisState: JarvisVisualState = jarvisError
    ? 'error'
    : voice.listening
      ? 'listening'
      : streaming
        ? 'thinking'
        : taskRunning
          ? 'thinking'
          : tts.speaking
            ? 'speaking'
            : 'idle';
  const statusText = JARVIS_STATE_LABEL[jarvisState];
  useEffect(() => {
    document.documentElement.setAttribute('data-jarvis-state', jarvisState);
  }, [jarvisState]);
  // leaving the JARVIS screen ends the live loop (no hidden background mic)
  useEffect(() => {
    if (mode !== 'jarvis' && liveMode) setLiveMode(false);
  }, [mode, liveMode]);

  const providerInfo = getProvider(activeProvider) ?? PROVIDERS[0];
  const conn = connections[activeProvider];
  // resolveModel: retired saved model (e.g. gemini-2.0-flash) par bhi
  // current model dikhega aur API call me 404 nahi aayega
  const activeModel = resolveModel(providerInfo, conn?.model);
  const activeAgent = agents.find((a) => a.id === activeAgentId);

  // ---- data loading ----
  const loadConversations = useCallback(async () => {
    const res = await fetch('/api/conversations');
    if (res.ok) setConversations(await res.json());
  }, []);

  const loadAgents = useCallback(async () => {
    const res = await fetch('/api/agents');
    if (res.ok) setAgents(await res.json());
  }, []);

  const loadAgenticTasks = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch('/api/agentic/tasks', { signal });
    if (res.ok) setAgenticTasks(await res.json());
  }, []);

  useEffect(() => {
    loadConversations();
    loadAgents();
    // the API token (if the server requires one) is attached to every
    // same-origin /api request by this single wrapper
    installTokenFetch();
    // AgentScope Python availability (real bridge status)
    fetch('/api/agentscope/status')
      .then((r) => r.json())
      .then(setPythonStatus)
      .catch(() => setPythonStatus(null));
  }, [loadConversations, loadAgents]);
  // keep the task list (reactor state + sidebar) fresh so finished tasks
  // flip the status pill back to STANDBY without a manual refresh — skipped
  // while hidden, refreshed once on return
  usePolling(loadAgenticTasks, 15_000);

  useEffect(() => {
    // During streaming a chunk lands every ~50 ms — re-triggering an
    // animated scroll each time judders; 'auto' follows without animating.
    bottomRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' });
  }, [messages, streaming]);

  // ---- conversation actions ----
  const openConversation = async (id: string) => {
    setActiveConvId(id);
    setMobileSidebarOpen(false);
    const res = await fetch(`/api/conversations/${id}`);
    if (res.ok) {
      const conv = await res.json();
      setMessages(conv.messages ?? []);
    }
  };

  const newChat = async () => {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: activeAgentId }),
    });
    if (res.ok) {
      const conv = await res.json();
      setMessages([]);
      setActiveConvId(conv.id);
      await loadConversations();
      setMobileSidebarOpen(false);
    }
  };

  const deleteConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (activeConvId === id) {
      setActiveConvId(null);
      setMessages([]);
    }
    loadConversations();
    toast({ title: 'Chat deleted' });
  };

  // ---- AI self-creates agents (agent-creator protocol) ----
  const handleCreateAgentFromChat = async (
    payload: AgentCreatePayload
  ): Promise<boolean> => {
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          emoji: payload.emoji,
          systemPrompt: payload.systemPrompt,
          temperature: payload.temperature ?? 0.7,
        }),
      });
      if (!res.ok) throw new Error('Create failed');
      await loadAgents();
      toast({
        title: 'Agent created by AI ✓',
        description: `${payload.emoji} ${payload.name} sidebar me add ho gaya.`,
      });
      return true;
    } catch {
      toast({
        title: 'Agent create nahi hua',
        description: 'Dobara try karo ya + Create se manually banao.',
        variant: 'destructive',
      });
      return false;
    }
  };

  // ---- agent actions ----
  const saveAgent = async (agent: AgentData) => {
    if (agent.id) {
      await fetch(`/api/agents/${agent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      });
    } else {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      });
      if (res.ok) {
        const created = await res.json();
        setActiveAgentId(created.id);
      }
    }
    await loadAgents();
    toast({ title: 'Agent saved ✓', description: `${agent.emoji} ${agent.name} ready hai.` });
  };

  const deleteAgent = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/agents/${id}`, { method: 'DELETE' });
    if (activeAgentId === id) setActiveAgentId(null);
    loadAgents();
  };

  // ---- Jarvis router: a chat message that is a JOB becomes an Agentic task ----
  // The same message box handles conversation AND work. For work, we reuse the
  // existing task engine (plan -> approvals -> run) instead of duplicating it.
  const runAsTask = async (
    convId: string,
    shown: string,
    taskPrompt: string,
    suggestionId?: string,
    screenMode?: boolean
  ) => {
    setMessages((prev) => [...prev, { id: `tmp-${Date.now()}`, role: 'user', content: shown }]);
    setInput('');
    setStreaming(true);
    try {
      const entry: { apiKey?: string; baseUrl?: string } = {};
      if (conn?.apiKey?.trim()) entry.apiKey = conn.apiKey.trim();
      if (conn?.baseUrl?.trim()) entry.baseUrl = conn.baseUrl.trim();
      const credentials = entry.apiKey || entry.baseUrl ? { [activeProvider]: entry } : undefined;

      const created = await fetch('/api/agentic/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: taskPrompt,
          provider: activeProvider,
          model: activeModel,
          credentials,
          // Jarvis #5: "haan kar do" approved a suggestion — link it
          ...(suggestionId ? { suggestionId } : {}),
          // Jarvis #2: "screen dekh kar …" → the vision loop
          ...(screenMode ? { mode: 'screen' } : {}),
        }),
      });
      const task = await created.json();
      if (!created.ok) throw new Error(task.error || 'Task create fail');

      const started = await fetch(`/api/agentic/tasks/${task.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials }),
      });
      if (!started.ok) {
        const e = await started.json().catch(() => ({ error: '' }));
        throw new Error(e.error || `Run failed (HTTP ${started.status})`);
      }

      const ack = buildActionAck(task.id, task.plan ?? []);
      setMessages((prev) => [
        ...prev,
        { id: `tmp-a-${Date.now()}`, role: 'assistant', content: ack, provider: 'jarvis', model: 'task-router' },
      ]);
      await fetch('/api/jarvis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'log', conversationId: convId, userContent: shown, assistantContent: ack }),
      }).catch(() => undefined);
      tts.speak('Samajh gaya, kaam shuru kar diya.');
      await loadAgenticTasks();
      setAgenticTaskId(task.id);
      // JARVIS home stays on the reactor view (it shows live task progress);
      // other modes jump into the full Agentic panel as before.
      setMode((prev) => (prev === 'jarvis' ? prev : 'agentic'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Task start fail';
      flashJarvisError();
      setMessages((prev) => [
        ...prev,
        { id: `tmp-a-${Date.now()}`, role: 'assistant', content: `⚠️ Kaam shuru nahi ho paya: ${msg}` },
      ]);
      toast({ title: 'Task start failed', description: msg, variant: 'destructive' });
    } finally {
      setStreaming(false);
      loadConversations();
    }
  };

  // ---- chat + streaming ----
  // `overrideText` is used by the LIVE loop (voice transcript → send directly)
  // BUGFIX (duplicate commands): `streaming` state updates asynchronously, so
  // two rapid sends (double-click / Enter+click / wake+LIVE overlap) could
  // both pass the stale `!streaming` check. The ref guard is synchronous.
  const streamingRef = useRef(false);
  const sendMessage = async (overrideText?: string) => {
    const content = (overrideText ?? input).trim();
    if (!content || streamingRef.current) return;
    streamingRef.current = true;

    let convId = activeConvId;
    if (!convId) {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: activeAgentId }),
      });
      if (!res.ok) {
        toast({ title: 'Failed to create chat', variant: 'destructive' });
        streamingRef.current = false;
        return;
      }
      const conv = await res.json();
      convId = conv.id;
      setActiveConvId(conv.id);
      loadConversations();
    }

    // Jarvis router: decide chat vs job BEFORE anything is sent to the model.
    let chatContent = content;
    try {
      const intentTimer = perfStart('chat.intent');
      const ir = await fetch('/api/jarvis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'intent', content }),
      });
      intentTimer.stop();
      if (ir.ok) {
        const decision = (await ir.json()) as {
          intent: 'chat' | 'action';
          text?: string;
          viaSuggestion?: string;
          screenMode?: boolean;
        };
        if (decision.intent === 'action') {
          await runAsTask(
            convId!,
            content,
            decision.text || content,
            decision.viaSuggestion,
            decision.screenMode
          );
          streamingRef.current = false; // runAsTask owns its own streaming state
          return;
        }
        if (decision.text) chatContent = decision.text; // "/chat ..." prefix removed
      }
    } catch {
      // router unavailable -> behave exactly like before (plain chat)
    }

    const userMsg: ChatMessageData = { id: `tmp-${Date.now()}`, role: 'user', content: chatContent };
    const assistantMsg: ChatMessageData = {
      id: `tmp-a-${Date.now()}`,
      role: 'assistant',
      content: '',
      provider: activeProvider,
      model: activeModel,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setStreaming(true);
    abortRef.current = new AbortController();
    // Incremental voice: sentences speak AS they stream (null when TTS off).
    let voiceSession: SentenceChain | null = null;

    try {
      const chatTimer = perfStart('chat.total');
      voiceSession = tts.startStreamSpeak();
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          conversationId: convId,
          content: chatContent,
          agentId: activeAgentId,
          provider: activeProvider,
          apiKey: conn?.apiKey,
          model: activeModel,
          baseUrl: conn?.baseUrl,
          temperature: activeAgent?.temperature,
        }),
      });

      if (!res.ok) {
        // A provider 429 keeps its own retry hint (server maps it through).
        if (res.status === 429) {
          const data = (await res.json().catch(() => ({}))) as {
            retryAfterSec?: number;
          };
          const wait =
            typeof data.retryAfterSec === 'number' && data.retryAfterSec > 0
              ? ` ${Math.ceil(data.retryAfterSec)}s me dobara try karo.`
              : '';
          throw new Error(`Rate limit lag gayi.${wait}`);
        }
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let full = '';
      let pending = '';
      let lastFlush = 0;
      let ttftRecorded = false;
      const flush = () => {
        if (!pending) return;
        const text = pending;
        pending = '';
        lastFlush = Date.now();
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant') {
            next[next.length - 1] = { ...last, content: last.content + text };
          }
          return next;
        });
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        if (!ttftRecorded) {
          ttftRecorded = true;
          perfSample('chat.ttft', chatTimer.elapsed());
          // first paint must be instant — the user is staring at the screen
          lastFlush = 0;
        }
        full += chunk;
        pending += chunk;
        voiceSession?.feed(chunk);
        // Batch UI updates: a fast provider emits a chunk every few ms, and
        // every setState re-parses the whole reply as markdown. Capping
        // paints at ~20/sec is visually identical and stops i3 jank.
        if (Date.now() - lastFlush >= 50) flush();
      }
      flush(); // trailing partial batch
      chatTimer.stop();
      // voice mode: incremental session speaks during the stream; when TTS
      // was off at stream start, speak the whole reply if it got enabled
      // mid-stream (preserves the old end-of-stream behavior)
      if (voiceSession) voiceSession.done();
      else tts.speak(full);
    } catch (err) {
      // A failed/aborted reply must not keep talking (partial speech stops).
      try {
        voiceSession?.abort();
      } catch {
        /* ignore */
      }
      const msg =
        err instanceof Error && err.name !== 'AbortError'
          ? err.message
          : 'Request stopped';
      // On stream failure remove the empty placeholder assistant message so the
      // conversation history stays consistent (an unsent error string is never
      // persisted as an AI message). Surface the failure via toast instead.
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant' && !last.content) {
          next.pop();
        }
        return next;
      });
      if (err instanceof Error && err.name !== 'AbortError') {
        flashJarvisError();
        toast({ title: 'Connection error', description: msg, variant: 'destructive' });
      }
    } finally {
      setStreaming(false);
      streamingRef.current = false;
      abortRef.current = null;
      loadConversations();
    }
  };

  const stopStreaming = () => {
    abortRef.current?.abort();
  };

  // latest sendMessage for the LIVE loop (avoids stale closures)
  sendRef.current = sendMessage;

  const handleAgentDialogSave = async (agent: AgentData) => {
    await saveAgent(agent);
    setAgentDialogOpen(false);
    setEditingAgent(null);
  };

  if (!loaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-400">
        <div className="flex items-center gap-3">
          <Sparkles className="h-5 w-5 animate-pulse text-cyan-400" />
          Initializing J.A.R.V.I.S…
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* JARVIS boot sequence (once per browser session, real system checks) */}
      {!bootDone && <JarvisBoot onDone={() => setBootDone(true)} />}

      {/* ============ JARVIS navigation rail (collapsible) ============ */}
      <aside
        className={`${
          mobileSidebarOpen ? 'fixed inset-y-0 left-0 z-40' : 'hidden'
        } lg:flex ${railOpen ? 'w-64' : 'w-[68px]'} shrink-0 flex-col border-r border-[var(--jv-panel-line)] bg-[rgba(4,12,20,0.92)] backdrop-blur transition-[width] duration-200`}
      >
        <div className="p-3 border-b border-[var(--jv-panel-line)] flex items-center gap-2.5">
          <button
            onClick={() => {
              setMode('jarvis');
              setMobileSidebarOpen(false);
            }}
            className="flex items-center gap-2.5 min-w-0 flex-1"
            aria-label="JARVIS home"
          >
            <span className="h-9 w-9 rounded-full border border-cyan-400/50 bg-cyan-400/10 flex items-center justify-center shrink-0">
              <span className="h-2.5 w-2.5 rounded-full bg-cyan-300 shadow-[0_0_10px_#1fd4ff] jv-anim-blink" />
            </span>
            {railOpen && (
              <span className="min-w-0">
                <span className="jv-brand text-sm text-cyan-100 block truncate">J.A.R.V.I.S</span>
                <span className="text-[10px] text-zinc-500 font-mono block truncate">AGENTSCOPE STUDIO</span>
              </span>
            )}
          </button>
          <button
            onClick={() => setRailOpen((v) => !v)}
            className="hidden lg:block text-zinc-500 hover:text-cyan-300 text-lg leading-none px-1"
            aria-label="Toggle navigation rail"
            title="Toggle navigation rail"
          >
            {railOpen ? '«' : '»'}
          </button>
        </div>

        <nav className="p-2 space-y-0.5 overflow-y-auto shrink-0" aria-label="Modules">
          {NAV_ITEMS.map((item) => {
            const active = mode === item.mode;
            return (
              <button
                key={item.mode}
                onClick={() => {
                  setMode(item.mode);
                  setMobileSidebarOpen(false);
                }}
                title={item.label}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  railOpen ? '' : 'justify-center'
                } ${
                  active
                    ? 'bg-cyan-500/15 text-cyan-200 border border-cyan-400/30'
                    : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200 border border-transparent'
                }`}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {railOpen && <span className="truncate">{item.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* Context lists (agents / tasks / chats) — visible when expanded */}
        {railOpen && (
        <div className="p-3 space-y-3 flex-1 overflow-hidden flex flex-col">

          {/* Agents */}
          <div className="min-h-0 flex flex-col">
            <div className="flex items-center justify-between px-1 mb-1.5">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
                Agents
              </span>
              <button
                onClick={() => {
                  setEditingAgent(null);
                  setAgentDialogOpen(true);
                }}
                className="text-xs text-emerald-400 hover:text-emerald-300"
              >
                + Create
              </button>
            </div>
            <ScrollArea className="max-h-44">
              <div className="space-y-1 pr-2">
                <button
                  onClick={() => setActiveAgentId(null)}
                  className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                    activeAgentId === null
                      ? 'bg-zinc-800 text-emerald-300'
                      : 'text-zinc-400 hover:bg-zinc-800/60'
                  }`}
                >
                  <Bot className="h-4 w-4" /> Default Assistant
                </button>
                {agents.map((a) => (
                  <div
                    key={a.id}
                    onClick={() => setActiveAgentId(a.id)}
                    className={`group w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm cursor-pointer transition-colors ${
                      activeAgentId === a.id
                        ? 'bg-zinc-800 text-emerald-300'
                        : 'text-zinc-400 hover:bg-zinc-800/60'
                    }`}
                  >
                    <span>{a.emoji}</span>
                    <span className="flex-1 truncate text-left">{a.name}</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="opacity-0 group-hover:opacity-100 h-6 w-6 flex items-center justify-center rounded hover:bg-zinc-700"
                          aria-label={`Options for ${a.name}`}
                        >
                          <MoreVertical className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="bg-zinc-900 border-zinc-700">
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingAgent({ ...a });
                            setAgentDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-400"
                          onClick={(e) => deleteAgent(a.id, e as unknown as React.MouseEvent)}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Agentic Tasks */}
          {mode === 'agentic' && (
            <div className="min-h-0 flex flex-col">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide px-1 mb-1.5">
                Agentic Tasks
              </span>
              <ScrollArea className="max-h-40">
                <div className="space-y-1 pr-2">
                  {agenticTasks.length === 0 && (
                    <p className="text-xs text-zinc-600 px-2 py-2">
                      Koi task nahi — Agentic mode me banao.
                    </p>
                  )}
                  {agenticTasks.map((t) => (
                    <div
                      key={t.id}
                      onClick={() => setAgenticTaskId(t.id)}
                      className={`group w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm cursor-pointer transition-colors ${
                        agenticTaskId === t.id
                          ? 'bg-zinc-800 text-emerald-300'
                          : 'text-zinc-400 hover:bg-zinc-800/60'
                      }`}
                    >
                      <BrainCircuit className="h-3.5 w-3.5 shrink-0" />
                      <span className="flex-1 truncate text-left">{t.prompt}</span>
                      <span className="text-[10px] text-zinc-500 shrink-0">{t.status}</span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Conversations */}
          <div className={mode !== 'chat' && mode !== 'agentic' ? 'min-h-0 flex flex-col opacity-50' : 'min-h-0 flex-1 flex flex-col'}>
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide px-1 mb-1.5">
              Chats
            </span>
            <ScrollArea className="flex-1">
              <div className="space-y-1 pr-2">
                {conversations.length === 0 && (
                  <p className="text-xs text-zinc-600 px-2 py-3">
                    Abhi koi chat nahi. &quot;New Chat&quot; dabao aur shuru karo.
                  </p>
                )}
                {conversations.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => openConversation(c.id)}
                    className={`group w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm cursor-pointer transition-colors ${
                      activeConvId === c.id
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-400 hover:bg-zinc-800/60'
                    }`}
                  >
                    <span className="flex-1 truncate text-left">{c.title}</span>
                    <button
                      onClick={(e) => deleteConversation(c.id, e)}
                      className="opacity-0 group-hover:opacity-100 h-6 w-6 flex items-center justify-center rounded hover:bg-red-500/20 text-red-400"
                      aria-label="Delete chat"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
        )}
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* JARVIS HUD top bar */}
        <header className="h-14 shrink-0 border-b border-[var(--jv-panel-line)] bg-[rgba(4,12,20,0.7)] backdrop-blur flex items-center gap-2 sm:gap-3 px-3 sm:px-4">
          <button
            onClick={() => setMobileSidebarOpen((v) => !v)}
            className="lg:hidden text-zinc-400 hover:text-cyan-200"
            aria-label="Toggle navigation"
          >
            <Bot className="h-5 w-5" />
          </button>

          {/* live status pill — real reactor state */}
          <div
            className="hidden md:flex items-center gap-2 rounded-full border px-3 py-1"
            style={{
              borderColor: 'var(--jv-accent-line)',
              background: 'var(--jv-accent-soft)',
            }}
            data-testid="jarvis-status-pill"
          >
            <span
              className="h-2 w-2 rounded-full jv-anim-blink"
              style={{ background: 'var(--jv-accent)' }}
            />
            <span
              className="text-[10px] font-mono tracking-[0.2em] uppercase"
              style={{ color: 'var(--jv-accent)' }}
            >
              {statusText}
            </span>
          </div>

          <StudioClock />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 rounded-lg border border-[var(--jv-panel-line)] bg-[rgba(6,17,27,0.8)] px-3 py-1.5 hover:border-cyan-400/40 transition-colors min-w-0">
                <span>{providerInfo.emoji}</span>
                <span className="text-sm font-medium hidden sm:inline truncate max-w-36">{providerInfo.name}</span>
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 border-cyan-500/30 text-cyan-300"
                >
                  {activeModel || 'default'}
                </Badge>
                {conn?.connected && (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="bg-popover border-[var(--jv-panel-line)] w-64">
              {PROVIDERS.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => {
                    if (connections[p.id]?.connected || p.kind === 'zai' || p.id === 'ollama') {
                      switchProvider(p.id);
                      toast({ title: `${p.emoji} ${p.name} activated` });
                    } else {
                      toast({
                        title: `${p.name} connected nahi hai`,
                        description: 'Settings me jaake API key add karo.',
                        variant: 'destructive',
                      });
                      setJarvisSettingsOpen(true);
                    }
                  }}
                  className="gap-2"
                >
                  <span>{p.emoji}</span>
                  <span className="flex-1">{p.name}</span>
                  {connections[p.id]?.connected && (
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {activeAgent && (
            <Badge variant="outline" className="border-cyan-500/30 text-cyan-200 hidden md:inline-flex">
              {activeAgent.emoji} {activeAgent.name}
            </Badge>
          )}

          {pythonStatus && (
            <Badge
              variant="outline"
              className={`hidden xl:inline-flex text-[10px] ${
                pythonStatus.ok
                  ? 'border-sky-500/40 text-sky-300'
                  : 'border-zinc-700 text-zinc-500'
              }`}
              title={pythonStatus.ok ? 'AgentScope Python connected' : pythonStatus.python ? 'Python mila par agentscope install nahi hai' : 'Python nahi mila'}
            >
              🐍 AgentScope: {pythonStatus.ok ? `v${pythonStatus.agentscope}` : 'not installed'}
            </Badge>
          )}

          <div className="flex-1" />
          <NotificationsBell />
          <Button
            onClick={() => setJarvisSettingsOpen(true)}
            variant="outline"
            size="sm"
            className="border-[var(--jv-panel-line)] text-zinc-300 hover:bg-zinc-800 hover:text-cyan-200"
          >
            <Settings2 className="h-4 w-4 mr-1.5" />
            <span className="hidden sm:inline">Config</span>
          </Button>
        </header>

        {/* Chat area */}
        <main className="flex-1 overflow-hidden flex flex-col">
          {mode === 'jarvis' ? (
            <JarvisDashboard
              state={jarvisState}
              statusText={statusText}
              messages={messages}
              streaming={streaming}
              input={input}
              setInput={setInput}
              onSend={(text) => void sendMessage(text)}
              onStop={() => {
                stopStreaming();
                tts.stopSpeaking();
              }}
              voice={voice}
              tts={tts}
              handsFree={handsFree}
              toggleHandsFree={toggleHandsFree}
              micLang={micLang}
              toggleMicLang={() => changeMicLang(micLang === 'hi-IN' ? 'en-IN' : 'hi-IN')}
              liveMode={liveMode}
              toggleLive={toggleLive}
              wakeStatus={wake.status}
              wakeError={wake.error}
              agenticTaskId={agenticTaskId}
              agenticTasks={agenticTasks}
              pythonStatus={pythonStatus}
              providerLabel={providerInfo.name}
              activeModel={activeModel}
              onOpenSettings={() => setJarvisSettingsOpen(true)}
              onNewChat={() => void newChat()}
              onOpenAgentic={(taskId) => {
                setAgenticTaskId(taskId);
                setMode('agentic');
              }}
            />
          ) : mode === 'compare' ? (
            <ComparePanel onOpenSettings={() => setSettingsOpen(true)} />
          ) : mode === 'agentic' ? (
            <AgenticPanel
              provider={activeProvider}
              model={activeModel}
              apiKey={conn?.apiKey}
              baseUrl={conn?.baseUrl}
              connections={connections}
              activeTaskId={agenticTaskId}
              onSelectTask={setAgenticTaskId}
            />
          ) : mode === 'goals' ? (
            <GoalsPanel
              onOpenTask={(taskId) => {
                setAgenticTaskId(taskId);
                setMode('agentic');
              }}
            />
          ) : mode === 'browser' ? (
            <BrowserPanel />
          ) : mode === 'agent-registry' ? (
            <AgentRegistryPanel />
          ) : mode === 'tool-registry' ? (
            <ToolRegistryPanel />
          ) : mode === 'providers' ? (
            <ProvidersPanel />
          ) : mode === 'laptop' ? (
            <LaptopPanel />
          ) : mode === 'memory' ? (
            <MemoryPanel />
          ) : mode === 'knowledge' ? (
            <KnowledgePanel />
          ) : mode === 'automation' ? (
            <AutomationPanel />
          ) : mode === 'audit' ? (
            <AuditPanel />
          ) : mode === 'system' ? (
            <SystemPanel />
          ) : mode === 'dashboard' ? (
            <DashboardPanel />
          ) : messages.length === 0 ? (
            <div className="flex-1 overflow-y-auto">
              <div className="max-w-3xl mx-auto px-4 py-12">
                <div className="text-center mb-10">
                  <div className="h-16 w-16 mx-auto rounded-2xl bg-emerald-500/15 ring-1 ring-emerald-500/40 flex items-center justify-center mb-4">
                    <Sparkles className="h-8 w-8 text-emerald-400" />
                  </div>
                  <h2 className="text-2xl font-bold mb-2">
                    AgentScope Studio me swagat hai 👋
                  </h2>
                  <p className="text-zinc-400 text-sm max-w-md mx-auto">
                    Real streaming chat, custom agents aur 10+ LLM providers — sab ek jagah.
                    Neeche type karke shuru karo ya agent banao.
                  </p>
                </div>
                <div className="grid sm:grid-cols-3 gap-3 mb-8">
                  {FEATURES.map((f) => (
                    <div
                      key={f.title}
                      className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"
                    >
                      <f.icon className="h-5 w-5 text-emerald-400 mb-2" />
                      <h3 className="text-sm font-semibold mb-1">{f.title}</h3>
                      <p className="text-xs text-zinc-500 leading-relaxed">{f.desc}</p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {['Kya kar sakta ho tum?', 'Mere liye ek agent banao 🤖', 'Ek chhota Python game likho', 'Hindi me ek kahani sunao'].map(
                    (s) => (
                      <button
                        key={s}
                        onClick={() => setInput(s)}
                        className="text-sm px-3.5 py-2 rounded-full border border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-300 transition-colors"
                      >
                        {s}
                      </button>
                    )
                  )}
                </div>
              </div>
            </div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="py-6 space-y-5 px-4">
                {messages.map((m, i) => (
                  <ChatMessage
                    key={m.id}
                    message={m}
                    agentEmoji={activeAgent?.emoji}
                    streaming={streaming && i === messages.length - 1 && m.role === 'assistant'}
                    onCreateAgent={handleCreateAgentFromChat}
                  />
                ))}
                <div ref={bottomRef} />
              </div>
            </ScrollArea>
          )}

          {/* Input — only in chat mode; every other panel owns its own input */}
          {mode === 'chat' && (
            <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/30 backdrop-blur p-3 sm:p-4">
              <div className="max-w-3xl mx-auto">
                {voice.listening && (
                  <div className="mb-1.5 flex items-center gap-2 text-xs text-emerald-400">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                    {voice.interim ? `Sunte hain: ${voice.interim}` : 'Boliye… (mic band karne ke liye button dabao)'}
                  </div>
                )}
                {voice.error && <div className="mb-1.5 text-xs text-red-400">{voice.error}</div>}
                {wake.error && handsFree && (
                  <div className="mb-1.5 text-xs text-amber-400">
                    Wake word: {wake.error}
                  </div>
                )}
                <div className="flex items-end gap-2 rounded-2xl border border-zinc-700 bg-zinc-900 p-2 focus-within:border-emerald-500/50 transition-colors">
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    placeholder="Message likho… (Enter = send, Shift+Enter = new line)"
                    className="flex-1 min-h-[44px] max-h-40 resize-none border-0 bg-transparent focus-visible:ring-0 text-sm"
                    rows={1}
                  />
                  {voice.supported && (
                    <Button
                      onClick={() => (voice.listening ? voice.stop() : voice.start())}
                      size="icon"
                      className={`h-10 w-10 shrink-0 rounded-xl ${
                        voice.listening
                          ? 'animate-pulse bg-red-500/30 text-red-300 hover:bg-red-500/40'
                          : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                      }`}
                      aria-label={voice.listening ? 'Stop mic' : 'Bolo (voice input)'}
                      title={`Voice input (${micLang}) — ${micLang === 'hi-IN' ? 'Hindi' : 'English'}`}
                    >
                      {voice.listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    </Button>
                  )}
                  {/* Jarvis #1: hands-free wake word ("Hey Jarvis") */}
                  <div className="relative shrink-0">
                    <Button
                      onClick={toggleHandsFree}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setWakePanelOpen((v) => !v);
                      }}
                      size="icon"
                      className={`h-10 w-10 rounded-xl ${
                        handsFree
                          ? 'bg-emerald-600/30 text-emerald-300 hover:bg-emerald-600/40'
                          : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                      }`}
                      aria-label={handsFree ? 'Hands-free ON — click to turn off' : 'Hands-free OFF — click to turn on'}
                      title={`Hands-free ("Hey Jarvis") — ${handsFree ? 'ON' : 'OFF'} · right-click = settings`}
                    >
                      <Radar className={`h-4 w-4 ${handsFree && wake.status?.wake?.listening ? 'animate-pulse' : ''}`} />
                    </Button>
                    {handsFree && (
                      <span
                        className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-zinc-900 ${
                          wake.status?.wake?.muted
                            ? 'bg-zinc-500'
                            : wake.status?.wake?.listening
                              ? 'bg-emerald-400'
                              : 'bg-amber-400'
                        }`}
                        aria-hidden
                      />
                    )}
                    {wakePanelOpen && (
                      <div className="absolute bottom-12 right-0 z-50 w-72 rounded-xl border border-zinc-700 bg-zinc-900 p-3 shadow-xl">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-zinc-200">Wake word settings</span>
                          <button
                            onClick={() => setWakePanelOpen(false)}
                            className="text-zinc-500 hover:text-zinc-300 text-xs"
                            aria-label="Close wake settings"
                          >
                            ✕
                          </button>
                        </div>
                        <label className="text-[11px] text-zinc-400 mb-1 block">
                          Sensitivity ({Math.round(wakeSensitivity * 100)}%) — galat trigger kam zyada
                        </label>
                        <Slider
                          value={[wakeSensitivity]}
                          min={0.05}
                          max={1}
                          step={0.05}
                          onValueChange={(vals) => changeWakeSensitivity(vals[0] ?? 0.5)}
                        />
                        <div className="mt-2 space-y-1 text-[10px] text-zinc-500">
                          <div>
                            Engine: {wake.status?.bridge?.wakeEngine ?? '…'} · mic:{' '}
                            {wake.status?.wake?.muted ? 'muted (tray)' : wake.status?.wake?.listening ? 'sun raha hai' : 'band'}
                          </div>
                          <div>
                            False triggers kam karne ke liye sensitivity ghatao. TV/gaane ke saath test karo.
                          </div>
                          {wake.status?.bridge && !wake.status.bridge.ttsAvailable && (
                            <div className="text-amber-500">Natural voice ke liye: pip install -r python-bridge/requirements-voice.txt</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <Button
                    onClick={() => setMicLang((l) => (l === 'hi-IN' ? 'en-IN' : 'hi-IN'))}
                    size="icon"
                    variant="ghost"
                    className="h-10 w-10 shrink-0 rounded-xl text-zinc-400 hover:text-zinc-200"
                    aria-label="Switch voice language"
                    title={`Mic language: ${micLang === 'hi-IN' ? 'Hindi' : 'English'} (click to switch)`}
                  >
                    <span className="text-[10px] font-bold">{micLang === 'hi-IN' ? 'हिं' : 'EN'}</span>
                  </Button>
                  {tts.supported && (
                    <Button
                      onClick={() => {
                        if (tts.enabled) tts.stopSpeaking();
                        tts.setEnabled(!tts.enabled);
                      }}
                      size="icon"
                      variant="ghost"
                      className={`h-10 w-10 shrink-0 rounded-xl ${
                        tts.enabled ? 'text-emerald-400 hover:text-emerald-300' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                      aria-label="Speak replies"
                      title={tts.enabled ? 'Jawab bolna band karo' : 'Assistant ke jawab bolwake suno (TTS)'}
                    >
                      {tts.enabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                    </Button>
                  )}
                  {streaming ? (
                    <Button
                      onClick={stopStreaming}
                      size="icon"
                      className="h-10 w-10 shrink-0 rounded-xl bg-red-500/20 text-red-400 hover:bg-red-500/30"
                      aria-label="Stop"
                    >
                      <Square className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void sendMessage()}
                      disabled={!input.trim()}
                      size="icon"
                      className="h-10 w-10 shrink-0 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white"
                      aria-label="Send"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <p className="text-[10px] text-zinc-600 text-center mt-2">
                  Streaming via {providerInfo.name}
                  {providerInfo.kind === 'zai' && ' — free built-in engine, no key needed'}
                </p>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Dialogs */}
      <JarvisSettings
        open={jarvisSettingsOpen}
        onOpenChange={setJarvisSettingsOpen}
        connections={connections}
        activeProvider={activeProvider}
        updateConnection={updateConnection}
        removeConnection={removeConnection}
        switchProvider={switchProvider}
        voice={voice}
        tts={tts}
        micLang={micLang}
        setMicLang={setMicLang}
        handsFree={handsFree}
        toggleHandsFree={toggleHandsFree}
        wakeSensitivity={wakeSensitivity}
        changeWakeSensitivity={changeWakeSensitivity}
        wakeStatus={wake.status}
        wakeError={wake.error}
        onOpenProvidersPanel={() => {
          setJarvisSettingsOpen(false);
          setMode('providers');
        }}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        connections={connections}
        activeProvider={activeProvider}
        updateConnection={updateConnection}
        removeConnection={removeConnection}
        switchProvider={switchProvider}
      />
      <AgentDialog
        open={agentDialogOpen}
        onOpenChange={setAgentDialogOpen}
        initial={editingAgent}
        onSave={handleAgentDialogSave}
      />
    </div>
  );
}
