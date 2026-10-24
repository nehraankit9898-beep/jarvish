// vision.ts — Jarvis #2: the agent's EYES + hands for screen tasks.
//
// The loop (one "step" = one model call + at most ONE action):
//   1. screenshot (python bridge, pyautogui) → downscaled to ~1280px (sharp)
//   2. model: "goal ye hai, screen ye hai, agla EK kaam batao"
//   3. the reply is ONE JSON action (click / type / hotkey / scroll / open /
//      wait / done / cannot)
//   4. read-only actions run; EVERY mutating action goes through
//      requestHostAction — ask mode pe user approval deta hai (the SAME
//      queue the Laptop panel shows), and the loop blocks until the answer
//   5. fresh screenshot → repeat, until `done` or the step budget ends
//
// Safety rules baked in here (not in the prompt alone):
//   - window titles are checked EVERY step: payment/password/bank screens
//     stop the task before the model even sees the next screenshot
//   - max steps (default 25) — a loop can never spin forever
//   - every action is audit-logged; secrets in typed text get masked
//   - screenshots go to the CLOUD model — that is unavoidable for vision;
//     the UI + docs say it explicitly
//
// Cost/speed note (honest, per the spec): har step pe ek API call lagti
// hai — ek kaam me 10-20 calls (2-5 s/step). Local vision model i3 pe
// practical nahi hai.

import { db } from '@/lib/db';
import { desktopCall, isReadOnlyEndpoint } from './desktop-bridge';
import { requestHostAction, waitForHostApproval, type HostAction } from './host-control';
import { createNotification } from './notifications';
import { recordAudit } from './audit';
import { asciiText } from './text';
import { protect } from './secrets';

/** env Positive Int — '' / garbage / 0 silently breaking the budget is worse
 * than the default (NaN would make `step <= MAX` always false → every task
 * instantly fails; 0 would end every task before it starts). */
function envPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const SCREEN_MAX_STEPS = envPositiveInt(process.env.AGENTSCOPE_SCREEN_MAX_STEPS, 25);
export const SCREEN_WIDTH = envPositiveInt(process.env.AGENTSCOPE_SCREEN_WIDTH, 1280);

/** Screens Jarvis must NEVER touch (spec: "Password ya payment screen dikhe toh ruk jao"). */
const SENSITIVE_WINDOW_RE =
  /(password|passwd|login|sign[- ]?in|bank|upi|payment|pay|checkout|wallet|razorpay|paytm|gpay|phonepe|stripe|paypal|2fa|otp|vault|credential)/i;

export class ScreenTaskError extends Error {
  blocked?: boolean;
  constructor(message: string, blocked = false) {
    super(message);
    this.name = 'ScreenTaskError';
    this.blocked = blocked;
  }
}

// ---------- screenshot ----------

export interface ScreenImage {
  base64: string;
  mediaType: string;
  bytes: number;
  width: number;
}

/**
 * Capture + downscale the screen. 1280px keeps the payload small (cheap +
 * fast on an i3) while text on a 1080p screen stays readable for the model.
 */
export async function captureScreenImage(width = SCREEN_WIDTH): Promise<ScreenImage> {
  const shot = await desktopCall('screenshot', {});
  if (!shot.ok || !shot.imageBase64) {
    throw new ScreenTaskError(
      shot.error || 'Screenshot failed — is the desktop bridge running?'
    );
  }
  const raw = Buffer.from(shot.imageBase64, 'base64');
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(raw).metadata();
    const out = await sharp(raw)
      .resize({ width: Math.min(width, meta.width || width), withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toBuffer();
    const outMeta = await sharp(out).metadata();
    return {
      base64: out.toString('base64'),
      mediaType: 'image/png',
      bytes: out.length,
      width: outMeta.width ?? width,
    };
  } catch {
    // sharp missing → send the raw shot (bigger, but still works)
    return { base64: raw.toString('base64'), mediaType: 'image/png', bytes: raw.length, width: 0 };
  }
}

/** Current window titles — the payment/password tripwire. */
export async function sensitiveWindowDetected(): Promise<string | null> {
  const res = await desktopCall('list_windows', {});
  if (!res.ok || !Array.isArray(res.data)) return null; // can't check ≠ sensitive
  const titles = (res.data as { title?: string }[])
    .map((w) => String(w.title ?? ''))
    .filter(Boolean);
  for (const title of titles) {
    if (SENSITIVE_WINDOW_RE.test(title)) return title;
  }
  return null;
}

// ---------- the model's action protocol ----------

export interface ScreenAction {
  action:
    | 'click' | 'double_click' | 'right_click'
    | 'type' | 'hotkey' | 'scroll' | 'open'
    | 'wait' | 'done' | 'cannot';
  x?: number;
  y?: number;
  text?: string;
  keys?: string;
  dx?: number;
  dy?: number;
  target?: string;
  ms?: number;
  summary?: string;
  reason?: string;
  note?: string;
}

const ALLOWED_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'type', 'hotkey', 'scroll',
  'open', 'wait', 'done', 'cannot',
]);

/**
 * Parse ONE JSON action out of the model reply (fenced or raw, first {...}
 * wins). Defensive: a chhota model can wrap it in prose.
 */
export function parseScreenAction(reply: string): ScreenAction | null {
  const text = String(reply ?? '');
  const candidates: string[] = [];
  // fenced ```json blocks first
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push(m[1]);
  }
  // then the outermost braces
  const brace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (brace !== -1 && lastBrace > brace) candidates.push(text.slice(brace, lastBrace + 1));
  // finally the raw reply
  candidates.push(text);

  for (const cand of candidates) {
    try {
      const obj = JSON.parse(cand.trim()) as Record<string, unknown>;
      const action = String(obj.action ?? '').toLowerCase().replace(/[\s-]+/g, '_');
      if (!ALLOWED_ACTIONS.has(action)) continue;
      const act: ScreenAction = {
        action: action as ScreenAction['action'],
        x: numOrUndef(obj.x),
        y: numOrUndef(obj.y),
        text: strOrUndef(obj.text),
        keys: strOrUndef(obj.keys),
        dx: numOrUndef(obj.dx),
        dy: numOrUndef(obj.dy),
        target: strOrUndef(obj.target),
        ms: numOrUndef(obj.ms),
        summary: strOrUndef(obj.summary),
        reason: strOrUndef(obj.reason),
        note: strOrUndef(obj.note),
      };
      if (!isPlausibleAction(act)) continue; // malformed → model gets another try
      return act;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Reject well-formed-JSON but USELESS actions before they reach the approval
 * gate. The desktop bridge clicks at the CURRENT cursor position when x/y are
 * missing, and `Number(null) === 0` would turn x:null into a click on the
 * top-left corner — so coordinate actions MUST carry real finite x AND y.
 * Returning null makes the loop ask the model again with a clear error.
 */
function isPlausibleAction(a: ScreenAction): boolean {
  switch (a.action) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return typeof a.x === 'number' && typeof a.y === 'number' && a.x >= 0 && a.y >= 0;
    case 'type':
      return typeof a.text === 'string' && a.text.length > 0;
    case 'hotkey':
      return typeof a.keys === 'string' && a.keys.length > 0;
    case 'open':
      return typeof a.target === 'string' && a.target.length > 0;
    default:
      return true; // wait / done / cannot / scroll need nothing
  }
}

function numOrUndef(v: unknown): number | undefined {
  // null/''/false would coerce to 0 — a coordinate that means "top-left
  // corner" to the bridge — so only accept values that are actually numbers
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function strOrUndef(v: unknown): string | undefined {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 2000) : undefined;
}

/** Mutating actions need the user's approval; these run free. */
export function isReadOnlyAction(a: ScreenAction): boolean {
  return a.action === 'wait' || a.action === 'done' || a.action === 'cannot';
}

/** Which desktop-bridge endpoint does this action map to? */
export function actionEndpoint(a: ScreenAction): string | null {
  switch (a.action) {
    case 'click': return 'click';
    case 'double_click': return 'click';
    case 'right_click': return 'click';
    case 'type': return 'type_text';
    case 'hotkey': return 'hotkey';
    case 'scroll': return 'scroll';
    case 'open': return 'open_app';
    default: return null;
  }
}

export function actionPayload(a: ScreenAction): Record<string, unknown> {
  const kind: string = a.action;
  // click / double_click / right_click all go to the bridge's `click` endpoint
  if (kind === 'click' || kind === 'double_click' || kind === 'right_click') {
    return {
      x: a.x,
      y: a.y,
      button: kind === 'right_click' ? 'right' : 'left',
      clicks: kind === 'double_click' ? 2 : 1,
    };
  }
  switch (a.action) {
    case 'type':
      return { text: a.text ?? '' };
    case 'hotkey':
      return { keys: a.keys ?? '' };
    case 'scroll':
      return { dx: a.dx ?? 0, dy: a.dy ?? 0 };
    case 'open':
      return { target: a.target ?? '' };
    default:
      return {};
  }
}

export function describeAction(a: ScreenAction): string {
  switch (a.action) {
    case 'click': return `click (${Math.round(a.x ?? -1)}, ${Math.round(a.y ?? -1)})`;
    case 'double_click': return `double-click (${Math.round(a.x ?? -1)}, ${Math.round(a.y ?? -1)})`;
    case 'right_click': return `right-click (${Math.round(a.x ?? -1)}, ${Math.round(a.y ?? -1)})`;
    case 'type': return `type "${(a.text ?? '').slice(0, 60)}"`;
    case 'hotkey': return `hotkey ${a.keys ?? ''}`;
    case 'scroll': return `scroll dx=${a.dx ?? 0} dy=${a.dy ?? 0}`;
    case 'open': return `open "${a.target ?? ''}"`;
    case 'wait': return `wait ${a.ms ?? 1000}ms`;
    case 'done': return `done: ${(a.summary ?? '').slice(0, 120)}`;
    case 'cannot': return `cannot: ${(a.reason ?? '').slice(0, 120)}`;
  }
}

// ---------- the system prompt ----------

export const SCREEN_TASK_SYSTEM_PROMPT = `
You are Jarvis, a careful computer-use agent. You get ONE screenshot per step and must answer with EXACTLY ONE JSON action — no prose before or after.

Answer format (only these actions exist):
{"action":"click","x":123,"y":456,"note":"why"}
{"action":"double_click","x":123,"y":456}
{"action":"right_click","x":123,"y":456}
{"action":"type","text":"hello"}
{"action":"hotkey","keys":"ctrl,s"}
{"action":"scroll","dx":0,"dy":-300}
{"action":"open","target":"notepad"}
{"action":"wait","ms":1500}
{"action":"done","summary":"kaam ho gaya — …"}
{"action":"cannot","reason":"payment screen hai / goal unclear / …"}

HARD RULES:
1. Coordinates come from the CURRENT screenshot only. Estimate the centre of the target element.
2. ONE action per reply. Never describe multiple steps.
3. If the screen shows a login, password, OTP, bank or PAYMENT page: reply {"action":"cannot","reason":"sensitive screen"} immediately — never type, never click.
4. Never type passwords, card numbers, OTPs or secrets. Ever.
5. Prefer the keyboard when reliable (Win key, Alt+Tab, ctrl+f). Prefer "open" to launch apps instead of hunting icons.
6. If the goal is already achieved, reply done with a short summary. If it is impossible from this screen, reply cannot with the reason.
7. Reply in the SAME language the user's goal was written in (the summary only).
`.trim();

// ---------- event emit helpers (same SSE shapes as the orchestrator) ----------

export type ScreenEmit = (event: {
  type: string;
  taskId: string;
  at: string;
  stepIndex?: number;
  data: Record<string, unknown>;
}) => void;
