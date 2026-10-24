// jarvis.ts — "one place to talk" router for the Chat box.
//
// The Chat box used to be a plain LLM conversation: it could talk about the
// laptop tools but never use them (the tools only run inside the Agentic task
// engine). This module decides, for every message typed in Chat, whether it is
//
//   - 'chat'   → ordinary conversation / a question → goes to /api/chat
//   - 'action' → a job for the laptop/browser/file tools → goes to the
//                Agentic task engine (plan → approvals → run)
//
// The decision is deliberately RULE-BASED (Hinglish + English keywords):
//   * it is instant and free (no extra model call on an i3 laptop),
//   * it works with any model, even a small local one,
//   * it is easy to test and to explain to the user.
// Explicit overrides always win:  "/do ..." or "jarvis ..." forces an action,
// "/chat ..." forces a normal chat reply.

export type JarvisIntent = 'chat' | 'action';

export interface JarvisDecision {
  intent: JarvisIntent;
  /** short human-readable reason (shown in tests / debugging) */
  reason: string;
  /** the message with any override prefix removed */
  text: string;
}

/** minimum length the task planner accepts (see /api/agentic/tasks) */
export const MIN_TASK_PROMPT = 8;

const FORCE_ACTION = /^\s*(?:\/do\b|\/task\b|jarvis[\s,:-]+)/i;
const FORCE_CHAT = /^\s*\/chat\b/i;

// Questions ABOUT the assistant ("ye kya kya kar sakta h") are conversation,
// not a job — even though they contain words like "kar" or "file".
const CAPABILITY_QUESTION =
  /(kya\s+kya\s+kar|kya\s+kar\s+sakt|kya\s+kar\s+sak|what\s+can\s+you|what\s+do\s+you\s+do|kaun\s+(?:sa|se)\s+kaam|tum\s+kya|aap\s+kya\s+kar|capabilit|features?\s+(?:kya|batao|list)|help\s+me\s+understand)/i;

const ACTION_VERB =
  /\b(khol(?:o|na|do|dena)?|open|launch|chalao|chala\s*do|start|download(?:\s*kar)?|delete|remove|hata(?:o|na|do)?|mita(?:o|na|do)?|dhundh(?:o|na)?|dhoond(?:o|na)?|dhund(?:o|na)?|find|search|move|copy|rename|bana(?:o|na|do)|create|make|likh(?:o|na)?\s+(?:do|ke)|write|save|rakh(?:o|na)?|bhej(?:o|na|do)?|send|click|dabao|press|type|scroll|screenshot|clean|saaf|organize|sort|list|dikhao|show|check|scan|band\s*kar|close|mute|unmute|lock|schedule|remind|yaad\s+dila|run|daal(?:o|na|do|dena)?|dal\s*do|transfer|shift|merge|compress|extract|upload|print|install|uninstall|backup)\b/i;

const LAPTOP_OBJECT =
  /\b(files?|folders?|directory|downloads?|desktop|documents?|pdf|photos?|images?|videos?|history|chrome|browser|website|site|url|link|tab|screenshot|screen|app|application|notepad|calculator|window|mouse|keyboard|clipboard|volume|brightness|email|mail|telegram|whatsapp|calendar|reminder|task|recycle\s*bin|trash|zip|excel|word|ppt|powerpoint|spotify|music)\b/i;

/** true when the user asks what the assistant can do (answered with the capability prompt) */
export function isCapabilityQuestion(text: string): boolean {
  return CAPABILITY_QUESTION.test(text);
}

// Jarvis #5: "Suggestion approve karna — 'Haan kar do' bolne par kaam chale."
// When the user answers affirmatively and an open suggestion exists, the
// /api/jarvis intent route swaps in that suggestion's actionPrompt, so a
// spoken "haan kar do" approves the card exactly like the Accept button.
const APPROVAL_AFFIRMATIVE =
  /^\s*(?:haan(?:ji)?|han(?:ji)?|ha\s+bhai|yes|yeah|yep|ok(?:ay)?|okaa?y|theek\s+(?:hai|he)|thik\s+(?:hai|he)|kar\s*(?:do|dena|de)|kardo|karo|approve(?:\s*kar(?:\s*do|o)?)?|go\s+ahead|do\s+it|chalo|bilkul|sahi\s+hai)\s*[.!।]*\s*$/i;

/** true when the message is a bare "haan kar do"-style approval answer */
export function isApprovalAffirmative(text: string): boolean {
  return APPROVAL_AFFIRMATIVE.test(String(text ?? '').trim());
}

// Jarvis #2: vision — "screen dekh kar click karo" type kaam. The trigger is
// deliberately CONSERVATIVE: the message must ask Jarvis to LOOK at the
// screen and act on what it sees, not just mention a screenshot (plain
// "screenshot lo" stays a normal desktop tool step).
const SCREEN_TASK_PATTERN =
  /(screen\s*(?:par|pe|dekh(?:o|kar|ke)?|task|se)|dekh(?:o|kar|ke)\s*(?:aur|phir|ke)?\s*(?:click|type|likh|khol)|screenshot\s*(?:le\s*)?kar(?:ke)?|screenshot\s*dekh|click\s*kar(?:o|ke)?\s*screen|screen\s*click|notepad\s*(?:kholo|me(?:in)?\s*likh))/i;

/** true when the user wants a VISION screen-task (screenshot loop) */
export function wantsScreenTask(text: string): boolean {
  const t = String(text ?? '');
  if (!t) return false;
  // explicit /chat override wins
  if (/^\s*\/chat\b/i.test(t)) return false;
  return SCREEN_TASK_PATTERN.test(t);
}

/**
 * Decide whether a Chat message is conversation or a job for the tools.
 * Pure function — no I/O — so it can be unit-tested directly.
 */
export function detectIntent(raw: string): JarvisDecision {
  const original = (raw ?? '').trim();

  if (FORCE_CHAT.test(original)) {
    return { intent: 'chat', reason: 'forced by /chat', text: original.replace(FORCE_CHAT, '').trim() };
  }
  if (FORCE_ACTION.test(original)) {
    const text = original.replace(FORCE_ACTION, '').trim();
    return { intent: 'action', reason: 'forced by /do or "jarvis"', text };
  }

  if (!original) return { intent: 'chat', reason: 'empty', text: original };
  if (CAPABILITY_QUESTION.test(original)) {
    return { intent: 'chat', reason: 'question about capabilities', text: original };
  }

  const hasVerb = ACTION_VERB.test(original);
  const hasObject = LAPTOP_OBJECT.test(original);
  if (hasVerb && hasObject) {
    return { intent: 'action', reason: 'action verb + laptop object', text: original };
  }
  return { intent: 'chat', reason: 'no action pattern', text: original };
}

/**
 * Appended to the system prompt when the user asks what the assistant can do,
 * so a small model answers with the real feature list instead of a generic
 * "I am a helpful assistant".
 */
export const JARVIS_CAPABILITIES_PROMPT = `
## What this Studio can really do (answer from this list, in the user's language)
You are the voice/chat front-end of AgentScope Studio. Plain conversation is answered here.
When the user asks for a JOB (files, downloads, browser, history, apps, screenshots, mouse/keyboard,
scheduling), the Studio automatically turns the message into an Agentic task, plans it and runs it
with these tools — the user does NOT have to switch tabs or repeat anything:
- Files: list/read/write files in the allowed folders (Desktop, Documents, Downloads); delete goes to the Recycle Bin and always asks approval.
- Documents: PDF, Word (docx), Excel (xlsx), PowerPoint (pptx), OpenDocument, RTF aur EPUB ka TEXT padh sakta hai (document-read). Scanned PDF ke liye OCR nahi hai — wo saaf bata deta hai. Documents ko knowledge base me daal kar baad me search bhi kar sakta hai (document-index).
- File search: naam se ya file ke ANDAR ke text se file dhoond sakta hai, line number ke saath (file-search).
- Weather: kisi bhi sheher ka aaj ka mausam + 3 din ka outlook (weather-now) — koi API key nahi chahiye.
- News: taaza headlines, kisi bhi topic par (news-headlines) — public RSS se, key nahi chahiye.
- World Monitor: duniya bhar ke live hotspots globe par + headlines (World tab).
- PC slow? "pc-diagnose" asli CPU/RAM/disk numbers se batata hai kya atka hua hai aur kya karna hai.
- Character: JARVIS / F.R.I.D.A.Y / dost / mentor — Character tab se chuno; tone, humour, reply length aur language wahi se set hoti hai.
- Music: "music-play" YouTube/Spotify par gaana kholta hai, "music-control" se play/pause/next/prev/mute.
- Folder: "folder-create" se naya folder; WhatsApp message "whatsapp-send" se likh kar tayyar hota hai (Send aap dabate ho).
- Screen awareness: "screen-watch" se screen badalne par pata chalta hai (read-only, bank/password screen par khud ruk jata hai).
- Stonic Remote: phone se is PC ke JARVIS se baat — Remote tab ka 6-digit code phone par /remote page me daalo; mic se bolo ya likho, jawab phone par bol kar sunaya jata hai. Same WiFi par seedha, bahar se tunnel se.
- Downloads: download a file from a URL into Downloads; watch the Downloads folder.
- Browser: open websites, read pages, fill forms (payment pages stop and ask the user); search Chrome history.
- Desktop (only when AGENTSCOPE_DESKTOP_MODE is ask/trusted): screenshot, mouse, keyboard, open apps, windows, clipboard.
- Vision (screen tasks): jab aap "screen dekh kar ..." bolte ho, Jarvis screenshot dekh kar ek-ek action (click/type) approval ke saath karta hai. Payment/password screen dikhe to khud ruk jata hai. Har step me thoda time lagta hai (2-5s).
- Memory: aapki baatein yaad rakhta hai ("subah 9 baje kaam shuru karta hoon") aur naye kaam me wahi yaad use karta hai. Memory panel me sab dekh/edit/delete kar sakte ho.
- Voice: "Hey Jarvis" wake word (Hands-free button, needs python-bridge/requirements-voice.txt), natural Hindi/English voice (edge-tts), mic se Hindi/English input.
- Calendar/Gmail (Google connector): "kal ki meetings batao", "aaj ke important mails", "4 baje reminder lagao" (reminder banane se pehle approval). System panel → Connectors me connect karo.
- Automation: schedule recurring jobs; Telegram control from the phone; e-mail; roz subah ka summary (morning briefing).
- Safety: risky actions always wait for the user's approval; a kill switch stops everything.
Tip to mention: start a message with "jarvis ..." or "/do ..." to force a task, "/chat ..." to force a normal reply.
`.trim();

/** the chat message the user sees after a task was started from Chat */
export function buildActionAck(
  taskId: string,
  steps: { index?: number; title?: string }[]
): string {
  const list = steps
    .slice(0, 8)
    .map((s, i) => `${i + 1}. ${(s.title ?? '').trim() || 'Step'}`)
    .join('\n');
  const more = steps.length > 8 ? `\n…aur ${steps.length - 8} steps` : '';
  return (
    `✅ Samajh gaya — ye kaam maine Agentic engine ko de diya aur shuru kar diya.\n\n` +
    (list ? `**Plan:**\n${list}${more}\n\n` : '') +
    `Jahan zaroori hoga (delete, email, risky command) main aapse approval maangunga. ` +
    `Live progress aur approval ke liye Agentic tab khul gaya hai. (Task: \`${taskId.slice(0, 8)}\`)`
  );
}
