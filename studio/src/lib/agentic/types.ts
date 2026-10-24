// types.ts — shared types for the agentic engine

export type StepKind =
  | 'analyze'
  | 'implement'
  | 'test'
  | 'review'
  | 'fix'
  | 'command'
  | 'research'
  | 'debug'
  | 'security'
  | 'docs';
export type StepStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'passed'
  | 'failed'
  | 'denied'
  | 'skipped'
  | 'paused';
/**
 * The persistent task lifecycle.
 *
 *   queued ──▶ planning ──▶ running ⇄ awaiting_approval
 *                  │            │            │
 *                  │            └──▶ verifying ──▶ done
 *                  └──▶ failed / cancelled
 *
 * `paused` is a user-driven hold that any non-terminal state can enter and
 * that `running` can resume from.
 *
 * `retry_wait` — a TRANSIENT failure (network/timeout) occurred; the
 * background runtime re-queues the task after a delay instead of failing it.
 *
 * `blocked` — an external prerequisite is missing (credential, dependency,
 * capacity); the task waits until the user fixes it or the runtime detects
 * the blocker is gone. Both are ACTIVE states the runtime can recover from.
 */
export type TaskStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'awaiting_approval'
  | 'verifying'
  | 'retry_wait'
  | 'blocked'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

/** Every status the engine can persist, in lifecycle order. */
export const TASK_LIFECYCLE = [
  'queued',
  'planning',
  'running',
  'awaiting_approval',
  'verifying',
  'retry_wait',
  'blocked',
  'paused',
  'done',
  'failed',
  'cancelled',
] as const;

/** Statuses from which the engine will never move on its own. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'done',
  'failed',
  'cancelled',
];

/** Statuses in which a task still owns the workspace / an LLM budget. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  'queued',
  'planning',
  'running',
  'awaiting_approval',
  'verifying',
  'retry_wait',
  'blocked',
  'paused',
];

/** Human readable labels — used by the UI so no status is shown raw. */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: 'Queued',
  planning: 'Planning',
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  verifying: 'Verifying',
  retry_wait: 'Retrying soon',
  blocked: 'Blocked',
  paused: 'Paused',
  done: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Aliases accepted from clients / older rows. */
const TASK_STATUS_ALIASES: Record<string, TaskStatus> = {
  completed: 'done',
  complete: 'done',
  success: 'done',
  error: 'failed',
  canceled: 'cancelled',
  abort: 'cancelled',
};

/**
 * Normalize an arbitrary status string into a known lifecycle value.
 * Unknown values become 'failed' — never silently 'done'.
 */
export function normalizeTaskStatus(raw: unknown): TaskStatus {
  if (typeof raw !== 'string') return 'failed';
  const key = raw.trim().toLowerCase();
  if ((TASK_LIFECYCLE as readonly string[]).includes(key)) {
    return key as TaskStatus;
  }
  return TASK_STATUS_ALIASES[key] ?? 'failed';
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.includes(normalizeTaskStatus(status));
}

export function isActiveStatus(status: string): boolean {
  return ACTIVE_TASK_STATUSES.includes(normalizeTaskStatus(status));
}

export interface StepDependency {
  stepIndex: number; // 1-based index of the dependency step
  type: 'blocks' | 'parallel_safe'; // 'blocks' = must finish first, 'parallel_safe' = can run in parallel
}

export interface PlanStep {
  index: number;
  title: string;
  description: string;
  kind: StepKind;
  acceptance: string; // kaise pata chalega ki step pass hua
  dependencies?: StepDependency[]; // steps this depends on
  timeoutMs?: number; // per-step timeout override
  retryBudget?: number; // per-step retry budget override
  /**
   * Files this step INTENDS to write (workspace-relative).
   *
   * The parallel scheduler only lets two writing steps share a wave when
   * their declared scopes are disjoint — this is what makes concurrent
   * writers safe. A writing step without `files` always runs alone.
   */
  files?: string[];
}

export interface CommandRecord {
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  approval?: 'auto' | 'approved' | 'denied';
  at: string;
}

export interface FileChangeRecord {
  path: string;
  action: 'create' | 'edit' | 'delete';
  bytes: number;
}

export interface LogEntry {
  at: string;
  kind:
    | 'info'
    | 'llm'
    | 'file'
    | 'command'
    | 'test'
    | 'review'
    | 'approval'
    | 'error'
    | 'diff';
  text: string;
}

export interface AgenticEvent {
  type:
    | 'plan'
    | 'plan_gap'
    | 'step_start'
    | 'log'
    | 'llm'
    | 'file_write'
    | 'command'
    | 'approval_required'
    | 'approval_result'
    | 'test_result'
    | 'review'
    | 'step_done'
    | 'error'
    | 'report'
    | 'done'
    | 'cancelled'
    | 'paused'
    | 'resumed'
    | 'timeout'
    // --- multi-agent additions ---
    | 'model_routed'
    | 'agent_message'
    | 'agent_status'
    | 'stream_status'
    // --- background runtime additions ---
    | 'retry_scheduled'
    | 'blocked'
    | 'unblocked'
    | 'browser'
    | 'takeover'
    // --- parallel execution + live progress additions ---
    | 'wave_start'
    | 'step_progress'
    | 'progress';
  taskId: string;
  at: string;
  stepIndex?: number;
  /** monotonic per-task sequence number — also used as the SSE event id */
  seq?: number;
  data?: unknown;
}

/** Type of an agent-to-agent message. */
export type AgentMessageType =
  | 'task'
  | 'result'
  | 'question'
  | 'review'
  | 'error';

/**
 * A structured agent-to-agent message.
 * Every message carries the task it belongs to, the conversation it is part
 * of, the sender, the receiver and a correlation id that ties a reply back to
 * the request that caused it.
 */
export interface AgentMessage {
  id: string;
  taskId: string;
  conversationId: string;
  fromAgent: string;
  toAgent: string;
  type: AgentMessageType;
  correlationId: string;
  content: string;
  createdAt: string;
  /** monotonic per-task sequence number */
  seq?: number;
  /** which role sent the message (planner | coder | tester | reviewer | orchestrator) */
  role?: string;
  /** model that produced the content (never a secret) */
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

/** Participants of an agent-to-agent conversation. */
export type AgentParticipant =
  | 'planner'
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'researcher'
  | 'debugger'
  | 'security'
  | 'docs'
  | 'orchestrator';

/**
 * Who may see whose messages.
 * - 'none'        → an agent only sees messages addressed to it (default)
 * - 'participants' → an agent sees the whole conversation of the participants
 */
export type MessageVisibility = 'none' | 'participants';

export interface FinalReport {
  summary: string;
  changedFiles: string[];
  commandsRun: CommandRecord[];
  testResults: { passed: number; failed: number; details: string }[];
  remainingBugs: string[];
  notes: string;
}

export interface PendingApproval {
  stepIndex: number;
  command: string;
  reason: string;
  commandIndex?: number;
}

export interface TaskConfig {
  timeoutMs?: number; // overall task timeout (null = no timeout)
  retryBudget?: number; // total retry budget across all steps
  maxSteps?: number; // max plan steps
  maxFixAttempts?: number; // max fix attempts per step
  autoPauseOnFailure?: boolean; // pause instead of fail on step failure
  /** delay before the background runtime re-queues a retry_wait task */
  retryDelayMs?: number;
  /** true for goal tasks: survive across sessions, higher limits */
  longRunning?: boolean;
  /** how many agents may work at the same time (1 = fully serial, max 4) */
  parallelism?: number;
  /** let two writing steps with DISJOINT declared file scopes overlap */
  parallelWrites?: boolean;
}

/**
 * Live phase of a running step — what the agent is doing right now.
 * Emitted with every `step_progress` event so the UI can show real progress
 * instead of a spinner.
 */
export type StepPhase =
  | 'queued'
  | 'thinking' // the role model is producing the step content
  | 'writing' // files are being applied to the workspace
  | 'commands' // the step's verification commands are running
  | 'repair' // a failed attempt is being repaired (targeted fix)
  | 'snapshot' // the step is being committed to the workspace git snapshot
  | 'reviewing' // the reviewer is judging the diff
  | 'done';

/** A detected plan gap (missing prerequisite the planner missed). */
export interface PlanGap {
  kind:
    | 'missing_tests'
    | 'missing_env'
    | 'missing_migration'
    | 'missing_credentials'
    | 'missing_rollback'
    | 'missing_health_check'
    | 'missing_verification'
    | 'coverage';
  description: string;
  suggestion: string;
  severity: 'warning' | 'critical';
}

export interface TaskState {
  id: string;
  prompt: string;
  status: TaskStatus;
  plan: PlanStep[];
  currentStep: number;
  report: FinalReport | null;
  error: string | null;
  workspacePath: string;
  provider: string;
  model: string;
  events: AgenticEvent[];
  pendingCommand: PendingApproval | null;
  config: TaskConfig; // task-level config (timeout, retry budget, etc.)
  startedAt?: string; // when execution started (for timeout tracking)
}

// Coder/Tester LLM output protocol markers
export const FILE_MARKER = '### FILE:';
export const RUN_MARKER = '### RUN:';
export const REMEMBER_MARKER = '### REMEMBER:';
export const END_MARKER = '### END';

export interface ParsedAction {
  files: { path: string; content: string }[];
  commands: string[];
  /**
   * Durable facts the agent wants to remember (Jarvis #4). Parsed from
   *   ### REMEMBER: key :: content
   * Saved as user-scope memory by the orchestrator AFTER the step (never
   * by the model itself) so masking + validation stay server-side.
   */
  memories: { key: string; content: string }[];
  notes: string;
}
