// action-lifecycle.ts — ONE lifecycle for every user command.
//
// The product requirement is simple and was not implemented anywhere:
//
//   RECEIVED → UNDERSTOOD → RUNNING → SUCCEEDED / FAILED / CANCELLED
//
// …and EVERY command must produce an acknowledgement and a final, spoken
// status — including commands that never touch an AI API. Before this module
// an agentic task spoke "Samajh gaya, kaam shuru kar diya" and then went
// silent forever: success and failure were only visible if the user opened
// the task panel, and a failed chat produced a toast but no voice.
//
// This file is PURE (no React, no fetch, no node) so the exact same rules run
// in the browser, on the server and in the automated tests.

export type ActionPhase =
  | 'received'
  | 'understood'
  | 'running'
  | 'needs_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export const PHASES: ActionPhase[] = [
  'received',
  'understood',
  'running',
  'needs_approval',
  'succeeded',
  'failed',
  'cancelled',
];

export const TERMINAL_PHASES: ReadonlySet<ActionPhase> = new Set<ActionPhase>([
  'succeeded',
  'failed',
  'cancelled',
]);

export function isTerminalPhase(phase: ActionPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export type ActionKind = 'chat' | 'task' | 'open_site' | 'open_app' | 'status' | 'command';

export interface ActionState {
  id: string;
  kind: ActionKind;
  phase: ActionPhase;
  /** short label of what is happening, e.g. "YouTube kholna" */
  label: string;
  /** the exact sentence JARVIS says for this phase */
  spoken: string;
  /** extra detail for the transcript / audit (never a secret) */
  detail?: string;
  at: string;
}

let counter = 0;

/** A stable id for one user command (unique per page load / server process). */
export function createActionId(prefix = 'act'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function clip(text: string, max = 220): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Speak-safe label: what the user asked for, without markdown/URLs.
 * Used inside every phase sentence.
 */
export function actionLabel(raw: string, fallback = 'command'): string {
  const text = speechSafe(raw);
  if (!text) return fallback;
  return clip(text, 70);
}

/** Strip markdown/URL noise so the voice never reads "```" or "https://…". */
export function speechSafe(text: string): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' (link) ')
    .replace(/[*_>#|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PhaseTextInput {
  kind: ActionKind;
  label: string;
  /** present for failures / approvals */
  detail?: string;
}

/**
 * The Hinglish sentences for each phase. Deliberately short: JARVIS is a
 * desktop assistant, not an audiobook.
 */
export function phaseSentence(phase: ActionPhase, input: PhaseTextInput): string {
  const label = input.label || 'command';
  const detail = clip(input.detail ?? '', 180);
  switch (phase) {
    case 'received':
      return 'Haan, main aapki command samajh gaya.';
    case 'understood':
      return input.kind === 'chat'
        ? 'Theek hai, main jawab taiyar kar raha hoon.'
        : `${label} — kaam shuru kar raha hoon.`;
    case 'running':
      return input.kind === 'chat' ? 'Jawab aa raha hai.' : `${label} chal raha hai.`;
    case 'needs_approval':
      return `${label} ke liye aapki permission chahiye${detail ? `: ${detail}` : ''}. Panel me approve kariye.`;
    case 'succeeded':
      return input.kind === 'chat'
        ? 'Jawab taiyar hai.'
        : `${label} successfully ho gaya.`;
    case 'failed':
      return input.kind === 'chat'
        ? `Jawab nahi mil paya.${detail ? ` Error: ${detail}` : ''}`
        : `${label} fail ho gaya.${detail ? ` Error: ${detail}` : ''}`;
    case 'cancelled':
      return `${label} cancel kar diya.`;
    default:
      return label;
  }
}

/** Build one lifecycle state, with the phase sentence already resolved. */
export function buildActionState(input: {
  id: string;
  kind: ActionKind;
  phase: ActionPhase;
  label: string;
  detail?: string;
  /** override the sentence (e.g. a provider-specific failure line) */
  spoken?: string;
}): ActionState {
  return {
    id: input.id,
    kind: input.kind,
    phase: input.phase,
    label: input.label,
    spoken: input.spoken ?? phaseSentence(input.phase, input),
    ...(input.detail ? { detail: clip(input.detail, 300) } : {}),
    at: new Date().toISOString(),
  };
}

/**
 * Guarantees exactly ONE final announcement per action.
 *
 * Two things used to double-speak: React StrictMode double-invoking effects,
 * and a poller that observes the same terminal status on every tick. The gate
 * accepts the first terminal state for an id and refuses the rest; a new
 * action id (or a non-terminal phase) passes through untouched.
 */
export class TerminalSpeechGate {
  private spoken = new Set<string>();

  /** true when this state is terminal and has not been announced yet */
  claim(state: Pick<ActionState, 'id' | 'phase'>): boolean {
    if (!isTerminalPhase(state.phase)) return false;
    const key = `${state.id}:${state.phase}`;
    if (this.spoken.has(key)) return false;
    this.spoken.add(key);
    // bound memory: keep the most recent ids only
    if (this.spoken.size > 200) {
      const first = this.spoken.values().next().value;
      if (first) this.spoken.delete(first);
    }
    return true;
  }

  /** Was a final sentence already spoken for this action? */
  hasSpoken(id: string): boolean {
    for (const key of this.spoken) if (key.startsWith(`${id}:`)) return true;
    return false;
  }

  reset(): void {
    this.spoken.clear();
  }
}

/**
 * Map a task status (the agentic engine's vocabulary) onto the lifecycle.
 * Unknown/in-progress states map to 'running' so nothing is ever announced as
 * finished before it is.
 */
export function phaseFromTaskStatus(status: string): ActionPhase {
  const s = String(status ?? '').toLowerCase();
  if (s === 'done' || s === 'completed' || s === 'succeeded') return 'succeeded';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'awaiting_approval') return 'needs_approval';
  if (s === 'planning' || s === 'running' || s === 'paused' || s === 'queued') return 'running';
  return 'running';
}

/**
 * The final sentence for a task, including the REAL error text (already
 * sanitised by the caller). Never claims success for an unfinished task.
 */
export function taskFinalSentence(input: {
  status: string;
  label: string;
  error?: string;
  detailCount?: number;
}): string {
  const phase = phaseFromTaskStatus(input.status);
  if (phase === 'succeeded') {
    return input.detailCount
      ? `${input.label} poora ho gaya — ${input.detailCount} step complete.`
      : `${input.label} poora ho gaya.`;
  }
  if (phase === 'cancelled') return `${input.label} cancel kar diya.`;
  if (phase === 'failed') {
    const reason = clip(input.error ?? '', 180);
    return reason
      ? `${input.label} fail ho gaya. Error: ${reason}`
      : `${input.label} fail ho gaya, lekin provider ne wajah nahi bataayi — task panel dekhiye.`;
  }
  return `${input.label} abhi chal raha hai.`;
}
