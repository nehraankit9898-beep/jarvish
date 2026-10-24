// persona.test.ts — the character layer (who is talking).
import { afterAll, describe, expect, test } from 'bun:test';
import { db } from '../src/lib/db';
import {
  PERSONAS,
  buildPersonaDirective,
  buildStyleOnlyDirective,
  getPersona,
  listPersonas,
  normalizePersonaSettings,
  personaVoiceGender,
  readPersonaSettings,
  writePersonaSettings,
  PersonaError,
} from '../src/lib/agentic/persona';

afterAll(async () => {
  await db.studioSetting.deleteMany({ where: { key: { startsWith: 'persona.' } } });
});

describe('catalog', () => {
  test('every persona has a unique id and a directive', () => {
    const ids = new Set<string>();
    for (const persona of listPersonas()) {
      expect(persona.id.length).toBeGreaterThan(1);
      expect(persona.directive.length).toBeGreaterThan(40);
      expect(persona.emoji.length).toBeGreaterThan(0);
      ids.add(persona.id);
    }
    expect(ids.size).toBe(PERSONAS.length);
  });

  test('male / female / neutral characters exist', () => {
    const genders = new Set(PERSONAS.map((p) => p.gender));
    expect(genders.has('male')).toBe(true);
    expect(genders.has('female')).toBe(true);
    expect(genders.has('neutral')).toBe(true);
  });

  test('the JARVIS character is the default and maps to a male voice', () => {
    const jarvis = getPersona('jarvis');
    expect(jarvis.name).toContain('J.A.R.V.I.S');
    expect(personaVoiceGender(jarvis)).toBe('male');
    expect(personaVoiceGender(getPersona('friday'))).toBe('female');
    expect(personaVoiceGender(getPersona('buddy'))).toBe('none');
  });

  test('an unknown persona is rejected with the valid options', () => {
    expect(() => getPersona('batman')).toThrow(PersonaError);
    try {
      getPersona('batman');
    } catch (err) {
      expect((err as Error).message).toContain('jarvis');
    }
  });

  test('the id is case-insensitive', () => {
    expect(getPersona('FRIDAY').id).toBe('friday');
  });
});

describe('directive', () => {
  const base = normalizePersonaSettings({});

  test('contains identity, humour, length and language rules', () => {
    const text = buildPersonaDirective(getPersona('mentor'), base);
    expect(text).toContain('Character: Mentor');
    expect(text).toContain('Humour:');
    expect(text).toContain('Length:');
    expect(text).toContain('language');
    expect(text).toContain('approval');
  });

  test('a high humour setting changes the rule', () => {
    const playful = buildPersonaDirective(getPersona('buddy'), { ...base, humor: 90 });
    const dry = buildPersonaDirective(getPersona('buddy'), { ...base, humor: 0 });
    expect(playful).toContain('playful');
    expect(dry).toContain('deadpan');
  });

  test('verbosity is reflected', () => {
    expect(buildPersonaDirective(getPersona('jarvis'), { ...base, verbosity: 90 })).toContain('explain properly');
    expect(buildPersonaDirective(getPersona('jarvis'), { ...base, verbosity: 5 })).toContain('one or two sentences');
  });

  test('a user title is used, and never invented', () => {
    expect(buildPersonaDirective(getPersona('jarvis'), { ...base, userTitle: 'Sir' })).toContain('"Sir"');
    expect(buildPersonaDirective(getPersona('jarvis'), { ...base, userTitle: '' })).toContain('Do not invent a name');
  });

  test('the style-only variant keeps an agent identity intact', () => {
    const text = buildStyleOnlyDirective({ ...base, language: 'hi' });
    expect(text).toContain('House style');
    expect(text).toContain('Hindi');
    expect(text).not.toContain('J.A.R.V.I.S');
  });
});

describe('settings', () => {
  test('values are clamped to a sane range', () => {
    const out = normalizePersonaSettings({ humor: 999, verbosity: -20 });
    expect(out.humor).toBe(100);
    expect(out.verbosity).toBe(0);
    expect(normalizePersonaSettings({ humor: Number.NaN }).humor).toBe(35);
  });

  test('an invalid language is rejected', () => {
    expect(() => normalizePersonaSettings({ language: 'klingon' as never })).toThrow(PersonaError);
  });

  test('the title is trimmed and length-capped', () => {
    const out = normalizePersonaSettings({ userTitle: '   ' + 'x'.repeat(80) + '  ' });
    expect(out.userTitle.length).toBe(40);
  });

  test('settings round-trip through the database', async () => {
    const saved = await writePersonaSettings({
      personaId: 'friday',
      userTitle: 'Ankit',
      humor: 70,
      verbosity: 80,
      language: 'hinglish',
    });
    expect(saved.personaId).toBe('friday');
    const read = await readPersonaSettings();
    expect(read).toEqual(saved);
  });

  test('a partial patch keeps the other values', async () => {
    await writePersonaSettings({ personaId: 'mentor', humor: 10 });
    const next = await writePersonaSettings({ verbosity: 90 });
    expect(next.personaId).toBe('mentor');
    expect(next.humor).toBe(10);
    expect(next.verbosity).toBe(90);
  });

  test('a stored persona id that no longer exists falls back to the default', async () => {
    await db.studioSetting.upsert({
      where: { key: 'persona.id' },
      update: { value: 'deleted-character' },
      create: { key: 'persona.id', value: 'deleted-character' },
    });
    const read = await readPersonaSettings();
    expect(read.personaId).toBe('jarvis');
  });
});
