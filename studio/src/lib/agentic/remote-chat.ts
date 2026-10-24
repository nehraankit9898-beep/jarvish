// remote-chat.ts — the conversation behind Stonic Remote.
//
// A phone turn is the SAME assistant the PC has: same character settings, same
// memory, same capability list. What changes is the channel — short spoken
// answers, no markdown, no code blocks — because the reply is read aloud.
//
// Everything is injectable (responder, memory, persona) so the whole turn can
// be tested without a model call and without the database.

import type { CoreChatMessage } from '@/lib/llm-core';
import { JARVIS_CAPABILITIES_PROMPT } from './jarvis';
import {
  buildPersonaDirective,
  getPersona,
  readPersonaSettings,
  type PersonaSettings,
} from './persona';
import { relevantMemoryContext } from './memory';

export interface RemoteTurn {
  role: 'user' | 'assistant';
  content: string;
  at: number;
}

export type Responder = (messages: CoreChatMessage[]) => Promise<string>;

const MAX_TURNS = 20;
const MAX_TURN_CHARS = 2_000;
const MAX_PROMPT_CHARS = 12_000;

/**
 * Per-session conversation history (bounded, in memory like the session).
 *
 * Kept on globalThis for the same reason as the session store: Next.js bundles
 * every route separately, so a module-level Map would not be the same Map in
 * /api/remote/message and /api/remote/end.
 */
const HISTORY_KEY = '__agentscope_remote_histories__';

const histories: Map<string, RemoteTurn[]> =
  ((globalThis as unknown as Record<string, Map<string, RemoteTurn[]> | undefined>)[HISTORY_KEY] ??=
    new Map<string, RemoteTurn[]>());

export function historyFor(sessionId: string): RemoteTurn[] {
  return histories.get(sessionId) ?? [];
}

export function recordTurn(sessionId: string, role: RemoteTurn['role'], content: string, at = Date.now()): void {
  const turns = histories.get(sessionId) ?? [];
  turns.push({ role, content: String(content).slice(0, MAX_TURN_CHARS), at });
  // keep the tail: the newest turns matter, and the array must never grow
  if (turns.length > MAX_TURNS * 2) turns.splice(0, turns.length - MAX_TURNS * 2);
  histories.set(sessionId, turns);
}

export function clearRemoteHistory(sessionId: string): void {
  histories.delete(sessionId);
}

/**
 * Spoken replies: strip what a voice should not read out (code, tables,
 * links) and keep it short. Used for the TTS text on the phone.
 */
export function speechReady(text: string, maxChars = 600): string {
  let out = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' code block. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    out = stop > maxChars * 0.5 ? cut.slice(0, stop + 1) : cut;
  }
  return out;
}

export interface PromptInputs {
  personaSettings?: PersonaSettings;
  memoryBlock?: string;
  includeCapabilities?: boolean;
}

/** The system prompt the phone turn runs on. Pure (except for the persona read). */
export function buildRemoteSystemPrompt(inputs: PromptInputs = {}): string {
  const settings = inputs.personaSettings;
  const persona = settings ? getPersona(settings.personaId) : getPersona('jarvis');
  const parts = [
    buildPersonaDirective(persona, settings ?? {
      personaId: persona.id,
      userTitle: '',
      humor: 35,
      verbosity: 30,
      language: 'auto',
    }),
    '## This channel is a PHONE',
    '- The reply is spoken aloud and read on a small screen, so: no markdown, no code blocks, no tables, no long lists.',
    '- Keep it to at most three short sentences unless the user explicitly asks for detail.',
    '- If a task needs approval (delete, install, payment, email), say that it is waiting in the Studio on the PC — never pretend it ran.',
    inputs.includeCapabilities === false ? '' : JARVIS_CAPABILITIES_PROMPT,
    inputs.memoryBlock ?? '',
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** Build the message array for one turn (history + the new user message). */
export function buildRemoteMessages(sessionId: string, text: string, systemPrompt: string): CoreChatMessage[] {
  const history = historyFor(sessionId);
  const messages: CoreChatMessage[] = [{ role: 'system', content: systemPrompt }];
  let budget = MAX_PROMPT_CHARS;
  const tail: CoreChatMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.content.length > budget) break;
    budget -= turn.content.length;
    tail.unshift({ role: turn.role, content: turn.content });
  }
  return [...messages, ...tail, { role: 'user', content: String(text).slice(0, MAX_TURN_CHARS) }];
}

export interface RunTurnOptions {
  sessionId: string;
  text: string;
  /** the model call (injectable for tests) */
  responder: Responder;
  personaSettings?: PersonaSettings;
  memoryBlock?: string;
  includeCapabilities?: boolean;
  /** called before the model call, after history is read */
  onUserTurn?: (text: string) => void;
}

/**
 * Run one remote turn: build the prompt, call the model, remember both sides.
 * Throws a plain Error with a user-safe message when the model fails.
 */
export async function runRemoteTurn(opts: RunTurnOptions): Promise<{ reply: string; spoken: string }> {
  const text = String(opts.text ?? '').trim();
  if (!text) throw new Error('Kuch bolo ya likho — the message is empty.');
  if (text.length > MAX_TURN_CHARS) throw new Error('Message is too long for the phone channel.');

  let settings = opts.personaSettings;
  if (!settings) {
    settings = await readPersonaSettings().catch(() => undefined);
  }
  let memoryBlock = opts.memoryBlock;
  if (memoryBlock === undefined) {
    memoryBlock = await relevantMemoryContext(text, 6).catch(() => '');
  }

  const systemPrompt = buildRemoteSystemPrompt({
    personaSettings: settings,
    memoryBlock,
    includeCapabilities: opts.includeCapabilities,
  });
  const messages = buildRemoteMessages(opts.sessionId, text, systemPrompt);

  opts.onUserTurn?.(text);
  recordTurn(opts.sessionId, 'user', text);

  const reply = await opts.responder(messages);
  const clean = String(reply ?? '').trim();
  if (!clean) throw new Error('The model returned an empty reply.');

  recordTurn(opts.sessionId, 'assistant', clean);
  return { reply: clean, spoken: speechReady(clean) };
}
