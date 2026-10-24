// offline-commands.ts — deterministic commands that work with NO cloud API.
//
// Before this module EVERY user message became either a chat completion or an
// agentic task that starts with a planning call to the LLM. With an expired
// key (or no internet) JARVIS could not even open YouTube or say which
// provider was broken: /api/chat returned an error, the UI showed a toast and
// the assistant stayed silent. Spec §7 requires a useful offline mode.
//
// Parsing here is PURE (no db, no network, no child process) so it is fully
// unit-testable; execution lives in offline-runner.ts and reuses the existing,
// permission-gated host machinery. An unknown command returns
// `{ matched: false }` and the caller falls back to the normal AI path —
// offline mode never pretends to have cloud-level reasoning.

import {
  buildActionState,
  createActionId,
  actionLabel,
  type ActionState,
} from '@/lib/action-lifecycle';
import type { ProviderErrorCategory } from '@/lib/provider-errors';

/**
 * Websites JARVIS may open offline. A target NOT in this map is refused (the
 * command falls through to the AI path) — a voice transcript must never be
 * able to open an arbitrary URL.
 */
export const OFFLINE_SITES: Record<string, string> = {
  youtube: 'https://www.youtube.com',
  'you tube': 'https://www.youtube.com',
  yt: 'https://www.youtube.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  mail: 'https://mail.google.com',
  'google mail': 'https://mail.google.com',
  drive: 'https://drive.google.com',
  'google drive': 'https://drive.google.com',
  maps: 'https://maps.google.com',
  'google maps': 'https://maps.google.com',
  calendar: 'https://calendar.google.com',
  'google calendar': 'https://calendar.google.com',
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
  stackoverflow: 'https://stackoverflow.com',
  'stack overflow': 'https://stackoverflow.com',
  wikipedia: 'https://www.wikipedia.org',
  chatgpt: 'https://chat.openai.com',
  openai: 'https://platform.openai.com',
  claude: 'https://claude.ai',
  gemini: 'https://gemini.google.com',
  openrouter: 'https://openrouter.ai',
  whatsapp: 'https://web.whatsapp.com',
  'whatsapp web': 'https://web.whatsapp.com',
  telegram: 'https://web.telegram.org',
  instagram: 'https://www.instagram.com',
  facebook: 'https://www.facebook.com',
  x: 'https://x.com',
  twitter: 'https://x.com',
  linkedin: 'https://www.linkedin.com',
  reddit: 'https://www.reddit.com',
  netflix: 'https://www.netflix.com',
  spotify: 'https://open.spotify.com',
  amazon: 'https://www.amazon.in',
  flipkart: 'https://www.flipkart.com',
  zomato: 'https://www.zomato.com',
  swiggy: 'https://www.swiggy.com',
  irctc: 'https://www.irctc.co.in',
  'news': 'https://news.google.com',
};

/**
 * Applications JARVIS may launch offline. Only well-known GUI apps, with the
 * executable/target per platform. Anything else needs the AI path (which goes
 * through the normal approval flow).
 */
export interface OfflineApp {
  label: string;
  target: string;
  /** platforms this shortcut is known to work on */
  platforms?: string[];
}

export const OFFLINE_APPS: Record<string, OfflineApp> = {
  notepad: { label: 'Notepad', target: 'notepad.exe', platforms: ['win32'] },
  'note pad': { label: 'Notepad', target: 'notepad.exe', platforms: ['win32'] },
  calculator: { label: 'Calculator', target: 'calc.exe', platforms: ['win32'] },
  calc: { label: 'Calculator', target: 'calc.exe', platforms: ['win32'] },
  calculatorapp: { label: 'Calculator', target: 'calc.exe', platforms: ['win32'] },
  paint: { label: 'Paint', target: 'mspaint.exe', platforms: ['win32'] },
  mspaint: { label: 'Paint', target: 'mspaint.exe', platforms: ['win32'] },
  explorer: { label: 'File Explorer', target: 'explorer.exe', platforms: ['win32'] },
  'file explorer': { label: 'File Explorer', target: 'explorer.exe', platforms: ['win32'] },
  files: { label: 'File Explorer', target: 'explorer.exe', platforms: ['win32'] },
  'task manager': { label: 'Task Manager', target: 'taskmgr.exe', platforms: ['win32'] },
  taskmgr: { label: 'Task Manager', target: 'taskmgr.exe', platforms: ['win32'] },
  settings: { label: 'Settings', target: 'ms-settings:', platforms: ['win32'] },
  'vs code': { label: 'VS Code', target: 'code', platforms: ['win32', 'darwin', 'linux'] },
  vscode: { label: 'VS Code', target: 'code', platforms: ['win32', 'darwin', 'linux'] },
  code: { label: 'VS Code', target: 'code', platforms: ['win32', 'darwin', 'linux'] },
  terminal: { label: 'Terminal', target: 'wt.exe', platforms: ['win32'] },
  'command prompt': { label: 'Command Prompt', target: 'cmd.exe', platforms: ['win32'] },
  chrome: { label: 'Chrome', target: 'chrome', platforms: ['win32', 'darwin', 'linux'] },
  'google chrome': { label: 'Chrome', target: 'chrome', platforms: ['win32', 'darwin', 'linux'] },
  finder: { label: 'Finder', target: 'open -a Finder', platforms: ['darwin'] },
};

export type OfflineCommand =
  | { kind: 'open_site'; site: string; url: string; label: string }
  | { kind: 'open_app'; app: string; target: string; label: string; platforms?: string[] }
  | { kind: 'status' }
  | { kind: 'last_error' }
  | { kind: 'cancel' }
  | { kind: 'help' };

export interface OfflineParseResult {
  matched: boolean;
  command?: OfflineCommand;
  /** short human label ("YouTube kholna") for the lifecycle messages */
  label?: string;
  /** why an apparently supported phrase was not matched */
  reason?: string;
}

const ACTION_VERB_EN = /^(?:please\s+)?(?:can you\s+)?(?:open|launch|start|run)\s+(.+)$/i;
const ACTION_VERB_HI =
  /^(.+?)\s+(?:ko\s+)?(?:khol(?:\s*(?:o|do|na|iye|de|dena|dijiye))?|open(?:\s*(?:karo|kar\s*do|kar|karna))?|chala(?:\s*(?:o|do|dena))?|chalu\s*kar(?:\s*(?:o|do|na))?|start\s*kar(?:\s*(?:o|do|na))?)\s*$/i;
const POLITE_PREFIX =
  /^(?:hey\s+jarvis|jarvis|ok\s+jarvis|please|plz|kindly|abhi|jaldi|zara|thoda|mera\s+liye)\s*[,:-]?\s*/i;

const STATUS_RE =
  /\b(?:status|system\s+status|connection\s+status|provider\s+status|kaun\s*sa\s+provider|kaunsa\s+provider|kaun\s+connect|kya\s+haal|halat|health|connected\s+ho|online\s+ho|internet\s+hai|api\s+chal\s+rahi)\b/i;
const LAST_ERROR_RE =
  /\b(?:last\s+error|pichhl[ai]\s+error|pichle\s+error|error\s+kya|kya\s+error|what\s+was\s+the\s+error|error\s+batao|error\s+repeat|wahi\s+error)\b/i;
const CANCEL_RE =
  /^(?:cancel|stop|abort|ruko|ruk\s+jao|band\s+karo|rok\s+do|cancel\s+karo|task\s+cancel)\b/i;
const HELP_RE =
  /\b(?:help|madad|kya\s+kar\s+sakte\s+ho|commands?|kya\s+kya\s+kar\s+sakta|offline\s+command)\b/i;

function normalize(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[?!.,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip a polite prefix ("jarvis", "please", …) that carries no meaning. */
function stripPoliteness(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(POLITE_PREFIX, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/** `youtube.com` / `www.youtube.com` / `https://youtube.com/…` → `youtube` */
function siteKeyFromDomain(target: string): string | null {
  const bare = target
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim();
  if (!bare.includes('.')) return null;
  const host = bare.split('.')[0];
  return OFFLINE_SITES[host] ? host : null;
}

/**
 * Parse one user command into a deterministic offline action.
 * `{ matched: false }` means "not an offline command — use the AI path".
 */
export function parseOfflineCommand(
  raw: string,
  opts: { platform?: NodeJS.Platform | string } = {}
): OfflineParseResult {
  const normalized = normalize(raw);
  if (!normalized) return { matched: false };
  const text = stripPoliteness(normalized);

  // ---- non-launch commands (checked first: "status" must never be an app) --
  if (CANCEL_RE.test(text)) {
    return { matched: true, command: { kind: 'cancel' }, label: 'Cancel' };
  }
  if (LAST_ERROR_RE.test(text)) {
    return { matched: true, command: { kind: 'last_error' }, label: 'Last error' };
  }
  if (HELP_RE.test(text)) {
    return { matched: true, command: { kind: 'help' }, label: 'Help' };
  }
  if (STATUS_RE.test(text) && !ACTION_VERB_EN.test(text) && !ACTION_VERB_HI.test(text)) {
    return { matched: true, command: { kind: 'status' }, label: 'Status' };
  }

  // ---- launch commands ----
  const launchMatch = ACTION_VERB_EN.exec(text) ?? ACTION_VERB_HI.exec(text);
  if (!launchMatch) return { matched: false };

  const target = stripPoliteness(launchMatch[1].trim())
    .replace(/\s+(?:please|plz)$/i, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .trim();
  if (!target) return { matched: false, reason: 'no target in the launch command' };

  // 1) exact allowlisted site name ("youtube", "whatsapp web")
  const site = OFFLINE_SITES[target];
  if (site) {
    return {
      matched: true,
      command: {
        kind: 'open_site',
        site: target,
        url: site,
        label: `${capitalize(target)} kholna`,
      },
      label: `${capitalize(target)} kholna`,
    };
  }

  // 2) allowlisted domain ("youtube.com", "https://gmail.com")
  const fromDomain = siteKeyFromDomain(target);
  if (fromDomain) {
    return {
      matched: true,
      command: {
        kind: 'open_site',
        site: fromDomain,
        url: OFFLINE_SITES[fromDomain],
        label: `${capitalize(fromDomain)} kholna`,
      },
      label: `${capitalize(fromDomain)} kholna`,
    };
  }

  // 3) allowlisted application
  const key = target.replace(/\s+(?:app|application)\s*$/i, '').trim();
  const app = OFFLINE_APPS[key] ?? OFFLINE_APPS[key.replace(/\s+/g, ' ')];
  if (app) {
    const platform = String(opts.platform ?? 'win32');
    if (app.platforms && !app.platforms.includes(platform)) {
      return {
        matched: false,
        reason: `"${app.label}" shortcut is only defined for ${app.platforms.join('/')}`,
      };
    }
    return {
      matched: true,
      command: {
        kind: 'open_app',
        app: key,
        target: app.target,
        label: `${app.label} kholna`,
        platforms: app.platforms,
      },
      label: `${app.label} kholna`,
    };
  }

  // Anything else (an arbitrary URL, an unknown app) needs the AI path: it is
  // NOT allowed to run from a deterministic command.
  return { matched: false, reason: `"${target}" is not an allowlisted site or app` };
}

function capitalize(text: string): string {
  return text
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Result + phrasing helpers (pure — used by the runner and the UI)
// ---------------------------------------------------------------------------

export type OfflineOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs_approval'
  | 'unsupported';

export interface OfflineResult {
  ok: boolean;
  outcome: OfflineOutcome;
  /** exact sentence to speak AND show in the transcript */
  spoken: string;
  /** machine-readable detail for the UI/audit (no secrets) */
  detail: string;
  actionId: string;
  command: OfflineCommand['kind'];
  label: string;
  errorCategory?: ProviderErrorCategory | string;
  /** set when the action is waiting for the user's approval */
  approvalId?: string;
  /** present when the host refused the action (permission model) */
  refused?: boolean;
  at: string;
}

/** "Haan, main aapki command samajh gaya." + the running sentence. */
export function offlineAcknowledgement(label: string): string {
  return `Haan, main aapki command samajh gaya. ${capitalize(label)} shuru kar raha hoon.`;
}

export function buildOfflineResult(input: {
  command: OfflineCommand | OfflineCommand['kind'];
  outcome: OfflineOutcome;
  spoken: string;
  detail?: string;
  actionId?: string;
  approvalId?: string;
  errorCategory?: string;
  refused?: boolean;
  /** overrides the label derived from the command */
  label?: string;
}): OfflineResult {
  const kind = typeof input.command === 'string' ? input.command : input.command.kind;
  const derived =
    typeof input.command === 'string'
      ? kind
      : 'label' in input.command && typeof input.command.label === 'string'
        ? input.command.label
        : kind;
  return {
    ok: input.outcome === 'succeeded' || input.outcome === 'needs_approval',
    outcome: input.outcome,
    spoken: input.spoken,
    detail: input.detail ?? '',
    actionId: input.actionId ?? createActionId('offline'),
    command: kind,
    label: input.label ?? derived,
    errorCategory: input.errorCategory,
    approvalId: input.approvalId,
    refused: input.refused,
    at: new Date().toISOString(),
  };
}

/** The lifecycle states for one offline command (for the transcript/audit). */
export function offlineLifecycle(
  actionId: string,
  label: string,
  outcome: OfflineOutcome,
  detail?: string
): ActionState[] {
  const kind = 'command';
  const base = { id: actionId, kind, label } as const;
  const states: ActionState[] = [
    buildActionState({ ...base, phase: 'received' }),
    buildActionState({ ...base, phase: 'understood' }),
    buildActionState({ ...base, phase: 'running' }),
  ];
  const phase =
    outcome === 'succeeded'
      ? 'succeeded'
      : outcome === 'cancelled'
        ? 'cancelled'
        : outcome === 'needs_approval'
          ? 'needs_approval'
          : 'failed';
  states.push(buildActionState({ ...base, phase, detail }));
  return states;
}

/** The fixed help text — no model involved. */
export const OFFLINE_HELP_TEXT =
  'Offline me main yeh kar sakta hoon: (1) allowlisted website kholna — jaise "YouTube kholo"; ' +
  '(2) allowlisted app kholna — jaise "Notepad kholo"; (3) "status" — provider aur voice ki halat; ' +
  '(4) "last error" — pichhli error dobara; (5) "cancel" — chalu task rokna. ' +
  'Iske aage reasoning ke liye AI provider chahiye.';

/** Spoken label for a site/app, e.g. "YouTube" → "YouTube successfully open ho gaya." */
export function openSuccessSentence(label: string): string {
  const name = label.replace(/\s+kholna$/i, '').trim();
  return `${name} successfully open ho gaya.`;
}

export function openFailureSentence(label: string, detail: string): string {
  const name = label.replace(/\s+kholna$/i, '').trim();
  return `${name} open nahi ho paya. Error: ${actionLabel(detail, 'unknown error')}`;
}

export function approvalSentence(label: string): string {
  const name = label.replace(/\s+kholna$/i, '').trim();
  return `${name} kholne ke liye aapki permission chahiye. Panel me approve kariye.`;
}
