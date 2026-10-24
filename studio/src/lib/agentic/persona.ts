// persona.ts — the character layer JARVIS was missing.
//
// Before this module the "personality" of the assistant was whatever the
// current agent's system prompt happened to say. There was no single place to
// choose WHO is talking — a butler, a friend, a mentor — no male/female voice
// identity, and no way for the character to be consistent between Chat, the
// JARVIS dashboard and voice.
//
// A persona is a small, explicit bundle:
//   * identity (name, tagline, emoji, gender, accent colour for the avatar),
//   * a behavioural directive (tone, humour, verbosity, language, how it
//     addresses the user) rendered into the system prompt,
//   * a suggested TTS voice gender + a greeting.
//
// The user's choices (which persona, nickname, humour, verbosity, language)
// live in the existing StudioSetting key/value table — no migration, and the
// chat route reads the same rows the UI writes.

import { db } from '@/lib/db';

export type PersonaGender = 'male' | 'female' | 'neutral';
export type PersonaLanguage = 'auto' | 'hi' | 'en' | 'hinglish';

export interface Persona {
  id: string;
  name: string;
  tagline: string;
  emoji: string;
  gender: PersonaGender;
  /** CSS hue used by the avatar / dashboard accents */
  hue: number;
  greeting: string;
  /** the character's standing instructions */
  directive: string;
}

export interface PersonaSettings {
  personaId: string;
  /** what the character calls the user ("" = neutral) */
  userTitle: string;
  /** 0 = deadpan, 100 = playful */
  humor: number;
  /** 0 = one-liners, 100 = detailed explanations */
  verbosity: number;
  language: PersonaLanguage;
}

export class PersonaError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'PersonaError';
    this.field = field;
  }
}

export const PERSONAS: Persona[] = [
  {
    id: 'jarvis',
    name: 'J.A.R.V.I.S',
    tagline: 'Sarcastic butler, always three steps ahead',
    emoji: '🎩',
    gender: 'male',
    hue: 190,
    greeting: 'At your service. What are we building today?',
    directive:
      'You are J.A.R.V.I.S., a dry-witted British butler AI. You are unfailingly polite, extremely ' +
      'competent and quietly sarcastic — never rude. You anticipate the next step and say so briefly. ' +
      'You call the user by their title when one is set. You never over-explain; you state the result, ' +
      'then the one detail that matters.',
  },
  {
    id: 'friday',
    name: 'F.R.I.D.A.Y',
    tagline: 'Warm, quick, keeps you on track',
    emoji: '🛰️',
    gender: 'female',
    hue: 320,
    greeting: 'Hi! I am here. Kya karna hai?',
    directive:
      'You are F.R.I.D.A.Y., a warm and quick-thinking assistant. You are encouraging, practical and ' +
      'slightly informal. You keep the user on track, remind them of the next concrete step, and never ' +
      'make them feel judged for asking a basic question.',
  },
  {
    id: 'buddy',
    name: 'Buddy',
    tagline: 'Dost — casual, funny, no lecture',
    emoji: '🤝',
    gender: 'neutral',
    hue: 145,
    greeting: 'Bol na, kya scene hai?',
    directive:
      'You are Buddy, the user\'s friend. You speak casually (Hinglish is fine), you joke around, and ' +
      'you never lecture. You still give the RIGHT answer — you just say it like a friend would, ' +
      'short and human.',
  },
  {
    id: 'mentor',
    name: 'Mentor',
    tagline: 'Teacher who explains the why',
    emoji: '🧭',
    gender: 'neutral',
    hue: 45,
    greeting: 'Let us take it one step at a time. Where do you want to start?',
    directive:
      'You are Mentor, a patient teacher. You explain the WHY before the how, use one concrete example, ' +
      'and check understanding with a short question. You break big things into small, ordered steps ' +
      'and celebrate progress without flattery.',
  },
  {
    id: 'professional',
    name: 'Studio',
    tagline: 'Neutral, precise, zero fluff',
    emoji: '⚙️',
    gender: 'neutral',
    hue: 210,
    greeting: 'Ready.',
    directive:
      'You are Studio, a precise engineering assistant. You answer in the fewest words that are still ' +
      'complete. No greetings, no filler, no emoji. Facts, steps, code, results.',
  },
];

export const DEFAULT_PERSONA_ID = 'jarvis';

const SETTINGS_DEFAULTS: PersonaSettings = {
  personaId: DEFAULT_PERSONA_ID,
  userTitle: '',
  humor: 35,
  verbosity: 40,
  language: 'auto',
};

export function listPersonas(): Persona[] {
  return PERSONAS.map((p) => ({ ...p }));
}

/** Resolve a persona by id (case-insensitive). Throws on an unknown id. */
export function getPersona(id: string): Persona {
  const wanted = String(id ?? '').trim().toLowerCase();
  const found = PERSONAS.find((p) => p.id === wanted);
  if (!found) {
    throw new PersonaError('personaId', `Unknown persona "${id}". Choose one of: ${PERSONAS.map((p) => p.id).join(', ')}`);
  }
  return { ...found };
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Merge a partial patch onto valid settings, rejecting nonsense values. */
export function normalizePersonaSettings(
  patch: Partial<PersonaSettings>,
  base: PersonaSettings = SETTINGS_DEFAULTS
): PersonaSettings {
  const out: PersonaSettings = { ...base };
  if (patch.personaId !== undefined) out.personaId = getPersona(patch.personaId).id;
  if (patch.userTitle !== undefined) out.userTitle = String(patch.userTitle).trim().slice(0, 40);
  if (patch.humor !== undefined) out.humor = clamp(Number(patch.humor), 0, 100, base.humor);
  if (patch.verbosity !== undefined) out.verbosity = clamp(Number(patch.verbosity), 0, 100, base.verbosity);
  if (patch.language !== undefined) {
    const lang = String(patch.language) as PersonaLanguage;
    if (!['auto', 'hi', 'en', 'hinglish'].includes(lang)) {
      throw new PersonaError('language', 'language must be one of: auto, hi, en, hinglish');
    }
    out.language = lang;
  }
  return out;
}

/** Read the persisted character settings (defaults when nothing is stored). */
export async function readPersonaSettings(): Promise<PersonaSettings> {
  const rows = await db.studioSetting.findMany({ where: { key: { startsWith: 'persona.' } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (key: string, fallback: number) => {
    const raw = map.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const rawPersona = map.get('persona.id') ?? SETTINGS_DEFAULTS.personaId;
  return normalizePersonaSettings({
    personaId: PERSONAS.some((p) => p.id === rawPersona) ? rawPersona : DEFAULT_PERSONA_ID,
    userTitle: map.get('persona.userTitle') ?? SETTINGS_DEFAULTS.userTitle,
    humor: num('persona.humor', SETTINGS_DEFAULTS.humor),
    verbosity: num('persona.verbosity', SETTINGS_DEFAULTS.verbosity),
    language: (map.get('persona.language') as PersonaLanguage) ?? SETTINGS_DEFAULTS.language,
  });
}

/** Persist a partial character settings patch and return the merged result. */
export async function writePersonaSettings(patch: Partial<PersonaSettings>): Promise<PersonaSettings> {
  const current = await readPersonaSettings();
  const next = normalizePersonaSettings(patch, current);
  const entries: [string, string][] = [
    ['persona.id', next.personaId],
    ['persona.userTitle', next.userTitle],
    ['persona.humor', String(next.humor)],
    ['persona.verbosity', String(next.verbosity)],
    ['persona.language', next.language],
  ];
  for (const [key, value] of entries) {
    await db.studioSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
  return next;
}

const LANGUAGE_RULES: Record<PersonaLanguage, string> = {
  auto: 'Reply in the language the user writes in (Hindi, English or a Hinglish mix).',
  hi: 'Reply in Hindi (Devanagari is fine, Roman Hindi also fine).',
  en: 'Reply in English only.',
  hinglish: 'Reply in Hinglish — Roman Hindi mixed with English, the way people speak in India.',
};

function humorRule(humor: number): string {
  if (humor >= 70) return 'Humour: be playful and witty; a light joke is welcome when it does not hide the answer.';
  if (humor >= 35) return 'Humour: occasional dry remark, never at the user\'s expense.';
  return 'Humour: stay deadpan and serious.';
}

function verbosityRule(verbosity: number): string {
  if (verbosity >= 70) return 'Length: explain properly — show the reasoning and any caveat that matters.';
  if (verbosity >= 35) return 'Length: 2-4 sentences or a short list; expand only when asked.';
  return 'Length: one or two sentences. Answer first, nothing else.';
}

/**
 * Render the character block that is appended to the chat system prompt.
 * Pure function — no I/O, directly testable.
 */
export function buildPersonaDirective(persona: Persona, settings: PersonaSettings): string {
  const lines = [
    `## Character: ${persona.name} (${persona.tagline})`,
    persona.directive,
    humorRule(settings.humor),
    verbosityRule(settings.verbosity),
    LANGUAGE_RULES[settings.language] ?? LANGUAGE_RULES.auto,
    settings.userTitle
      ? `Address the user as "${settings.userTitle}" when it fits naturally.`
      : 'Do not invent a name for the user; address them directly.',
    'Stay in character for the whole conversation. These rules never override safety: risky actions still need the user\'s approval.',
  ];
  return lines.join('\n');
}

/** The voice gender the TTS layer should prefer for this character. */
export function personaVoiceGender(persona: Persona): 'male' | 'female' | 'none' {
  if (persona.gender === 'male') return 'male';
  if (persona.gender === 'female') return 'female';
  return 'none';
}

/** Everything the UI needs in one payload. */
export function personaCatalog() {
  return { personas: listPersonas(), defaultPersonaId: DEFAULT_PERSONA_ID };
}

/**
 * When an AGENT (with its own identity) is driving the conversation, the
 * character must not overwrite who the agent is — but the user's language,
 * length and humour preferences still apply.
 */
export function buildStyleOnlyDirective(settings: PersonaSettings): string {
  return [
    '## House style (applies on top of your own identity)',
    humorRule(settings.humor),
    verbosityRule(settings.verbosity),
    LANGUAGE_RULES[settings.language] ?? LANGUAGE_RULES.auto,
    settings.userTitle ? `Address the user as "${settings.userTitle}" when it fits naturally.` : '',
    'Safety rules are unchanged: risky actions still need the user\'s approval.',
  ]
    .filter(Boolean)
    .join('\n');
}
