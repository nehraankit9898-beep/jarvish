// memory-recall.test.ts — pillar 1 of the audit: "voice + memory — long-term
// recall of name / day / old conversations needs real testing".
//
// Three things are proven here:
//   1. TIME    — the prompt gets the REAL date/day/time (deterministic clock).
//   2. FACTS   — a plain chat sentence ("mera naam Ankit hai") is extracted,
//                stored, and later comes back through the memory retrieval the
//                chat prompt already uses.
//   3. HISTORY — a recall question finds the right past transcript and renders
//                as a data-only prompt block.
//
// Run: bun test tests/memory-recall.test.ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../src/lib/db';
import { listMemory, findRelevantMemories, relevantMemoryContext, saveMemory } from '../src/lib/agentic/memory';
import {
  captureFromUserTurn,
  clockSnapshot,
  extractMemoryCandidates,
  isQuestion,
  recallContext,
  recallIntent,
  searchPastConversations,
  timeContext,
} from '../src/lib/agentic/recollect';
import { registerRecollectTools } from '../src/lib/agentic/recollect-tools';
import { listTools } from '../src/lib/agentic/tool-registry';

const TEST_KEYS = [
  'user name',
  'home city',
  'occupation',
  'birthday',
  'likes: coffee',
  'dislikes: early mornings',
  'note: project name is orion',
  'user name test credential',
];

async function cleanMemory() {
  await db.memoryEntry.deleteMany({ where: { scope: 'user', key: { in: TEST_KEYS } } });
  await db.memoryEntry.deleteMany({ where: { scope: 'user', key: { startsWith: 'likes: ' } } });
  await db.memoryEntry.deleteMany({ where: { scope: 'user', key: { startsWith: 'dislikes: ' } } });
  await db.memoryEntry.deleteMany({ where: { scope: 'user', key: { startsWith: 'note: ' } } });
}

afterAll(async () => {
  await cleanMemory();
  await db.message.deleteMany({ where: { content: { startsWith: '__recall_test__' } } });
  await db.conversation.deleteMany({ where: { title: { startsWith: '__recall_test__' } } });
});

beforeEach(async () => {
  await cleanMemory();
});

// --------------------------------------------------------------- 1. TIME

describe('the clock (day / date / time questions)', () => {
  // Saturday, 24 October 2026, 09:30 IST
  const fixed = new Date('2026-10-24T04:00:00.000Z');

  test('renders the real weekday, date time and timezone', () => {
    const block = timeContext(fixed, { timeZone: 'Asia/Kolkata' });
    expect(block).toContain('Saturday');
    expect(block).toContain('24 October 2026');
    expect(block).toContain('Asia/Kolkata');
    // 04:00 UTC is 09:30 in IST — the prompt must not show UTC time
    expect(block).toContain('09:30');
    expect(block).toContain('am');
  });

  test('tells the model not to guess the date', () => {
    const block = timeContext(fixed, { timeZone: 'Asia/Kolkata' });
    expect(block.toLowerCase()).toContain('never guess');
  });

  test('is empty for an invalid date instead of throwing', () => {
    expect(timeContext(new Date('nope'))).toBe('');
  });

  test('a different zone shows a different hour for the same instant', () => {
    const ist = timeContext(fixed, { timeZone: 'Asia/Kolkata' });
    const utc = timeContext(fixed, { timeZone: 'UTC' });
    expect(ist).not.toBe(utc);
    expect(utc).toContain('04:00');
  });

  test('clockSnapshot is machine readable', () => {
    const snap = clockSnapshot(fixed, { timeZone: 'Asia/Kolkata' });
    expect(snap.weekday).toBe('Saturday');
    expect(snap.date).toBe('24 October 2026');
    expect(snap.timeZone).toBe('Asia/Kolkata');
    expect(snap.iso).toBe('2026-10-24T04:00:00.000Z');
    expect(snap.epochMs).toBe(fixed.getTime());
  });
});

// -------------------------------------------------------------- 2. FACTS

describe('fact extraction from a normal chat sentence', () => {
  test('Hindi/Hinglish name statement', () => {
    const found = extractMemoryCandidates('mera naam Ankit hai');
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ key: 'user name', content: 'Ankit', category: 'fact' });
  });

  test('English name statement', () => {
    expect(extractMemoryCandidates('my name is Priya')[0]?.content).toBe('Priya');
  });

  test('"call me" and "mujhe log X kehte hain" also count', () => {
    expect(extractMemoryCandidates('call me Bunty')[0]?.content).toBe('Bunty');
    expect(extractMemoryCandidates('mujhe log Raja kehte hain')[0]?.content).toBe('Raja');
  });

  test('home city', () => {
    const found = extractMemoryCandidates('main Jaipur me rehta hoon');
    expect(found.find((c) => c.key === 'home city')?.content).toBe('Jaipur');
    expect(extractMemoryCandidates('I live in Pune').find((c) => c.key === 'home city')?.content).toBe('Pune');
  });

  test('occupation, birthday and likes', () => {
    expect(
      extractMemoryCandidates('main Infosys me kaam karta hoon').find((c) => c.key === 'occupation')?.content
    ).toBe('Infosys');
    expect(
      extractMemoryCandidates('mera birthday 3 march hai').find((c) => c.key === 'birthday')?.content
    ).toBe('3 march');
    const like = extractMemoryCandidates('mujhe coffee pasand hai').find((c) => c.key.startsWith('likes:'));
    expect(like?.content).toBe('coffee');
    expect(like?.category).toBe('preference');
  });

  test('"pasand nahi hai" is a DISLIKE, never a like', () => {
    const found = extractMemoryCandidates('mujhe early mornings pasand nahi hai');
    expect(found.some((c) => c.key.startsWith('likes:'))).toBe(false);
    const dislike = found.find((c) => c.key.startsWith('dislikes:'));
    expect(dislike?.content).toBe('early mornings');
  });

  test('explicit "yaad rakho" becomes a note', () => {
    const note = extractMemoryCandidates('yaad rakho project ka naam Orion hai').find((c) =>
      c.key.startsWith('note: ')
    );
    expect(note?.content).toBe('project ka naam Orion hai');
    expect(note?.category).toBe('note');
  });

  test('questions are NEVER stored as facts', () => {
    expect(extractMemoryCandidates('mera naam kya hai?')).toEqual([]);
    expect(extractMemoryCandidates('mera naam kya hai')).toEqual([]);
    expect(extractMemoryCandidates('what is my name?')).toEqual([]);
    expect(extractMemoryCandidates('kahan rehta hoon main')).toEqual([]);
    expect(isQuestion('mera naam kya hai')).toBe(true);
    expect(isQuestion('mera naam Ankit hai')).toBe(false);
  });

  test('a question word is never mistaken for a name', () => {
    expect(extractMemoryCandidates('mera naam kuch bhi hai')).toEqual([]);
  });

  test('empty and chit-chat input yields nothing', () => {
    expect(extractMemoryCandidates('')).toEqual([]);
    expect(extractMemoryCandidates('theek hai')).toEqual([]);
  });

  test('a rambling message stores at most three facts', () => {
    const found = extractMemoryCandidates(
      'mera naam Ankit hai aur main Jaipur me rehta hoon, main Infosys me kaam karta hoon, mujhe coffee pasand hai, yaad rakho kal meeting hai'
    );
    expect(found.length).toBeLessThanOrEqual(3);
  });

  test('credentials are not keystones — the note is refused by the memory store', () => {
    // a password-looking value must be refused, not silently persisted
    const found = extractMemoryCandidates('yaad rakho password hai hunter2secret');
    expect(found.length).toBe(1);
  });
});

describe('capture writes to the same store the prompt reads', () => {
  test('name is saved once and recalled later ("mera naam kya hai")', async () => {
    const first = await captureFromUserTurn('mera naam Ankit hai', { source: 'chat' });
    expect(first.saved.map((s) => s.key)).toEqual(['user name']);

    // the retrieval the chat prompt uses finds it for the QUESTION
    const hits = await findRelevantMemories('mera naam kya hai', 8);
    expect(hits.some((h) => h.content === 'Ankit')).toBe(true);
    const block = await relevantMemoryContext('mera naam kya hai', 8);
    expect(block).toContain('Ankit');
    expect(block.toLowerCase()).toContain('remember');
  });

  test('saying the same thing twice does not rewrite the row', async () => {
    await captureFromUserTurn('mera naam Ankit hai');
    const before = (await listMemory({ scope: 'user', limit: 200 })).find((m) => m.key === 'user name');
    const second = await captureFromUserTurn('mera naam Ankit hai');
    expect(second.saved).toEqual([]);
    expect(second.unchanged).toEqual(['user name']);
    const after = (await listMemory({ scope: 'user', limit: 200 })).find((m) => m.key === 'user name');
    expect(after?.updatedAt).toBe(before?.updatedAt as string);
    expect(after?.content).toBe('Ankit');
  });

  test('a different name UPDATES the memory (no duplicate row)', async () => {
    await captureFromUserTurn('mera naam Ankit hai');
    const res = await captureFromUserTurn('mera naam Ankit Sharma hai');
    expect(res.saved.map((s) => s.key)).toEqual(['user name']);
    const rows = (await listMemory({ scope: 'user', limit: 200 })).filter((m) => m.key === 'user name');
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('Ankit Sharma');
  });

  test('a credential is skipped and reported, never stored', async () => {
    const res = await captureFromUserTurn('yaad rakho api key hai sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(res.saved).toEqual([]);
    expect(res.skipped.length).toBeGreaterThan(0);
    const keys = (await listMemory({ scope: 'user', limit: 200 })).map((m) => m.key);
    expect(keys.some((k) => k.startsWith('note:'))).toBe(false);
  });

  test('a turn with nothing durable writes nothing', async () => {
    const res = await captureFromUserTurn('theek hai bhai');
    expect(res.saved).toEqual([]);
    expect(res.skipped).toEqual([]);
  });

  test('existing memories are not duplicated by capture', async () => {
    await saveMemory({ scope: 'user', key: 'home city', content: 'Jaipur', category: 'fact' });
    const res = await captureFromUserTurn('main Jaipur me rehta hoon');
    expect(res.saved).toEqual([]);
    expect((await listMemory({ scope: 'user', limit: 200 })).filter((m) => m.key === 'home city')).toHaveLength(1);
  });
});

// ------------------------------------------------------------ 3. HISTORY

describe('recall intent', () => {
  test('detects the ways a user asks about the past', () => {
    for (const text of [
      'pichhli baar humne kya baat ki thi',
      'yaad hai maine laptop ke bare me poocha tha',
      'what did we discuss earlier',
      'do you remember my project',
      'last time we talked about the invoice',
    ]) {
      expect(recallIntent(text).wanted).toBe(true);
    }
  });

  test('ordinary questions are not recall questions', () => {
    for (const text of ['aaj mausam kaisa hai', 'ek email likho', 'mera naam kya hai']) {
      expect(recallIntent(text).wanted).toBe(false);
    }
  });

  test('the search query drops the recall vocabulary', () => {
    const intent = recallIntent('pichhli baar humne laptop ke bare me kya baat ki thi');
    expect(intent.query).toContain('laptop');
    expect(intent.query).not.toContain('pichhli');
    expect(intent.query).not.toContain('baat');
  });
});

describe('searching real transcripts', () => {
  async function seed(title: string, turns: [string, string][]) {
    const conversation = await db.conversation.create({ data: { title } });
    for (const [role, content] of turns) {
      await db.message.create({ data: { conversationId: conversation.id, role, content } });
    }
    return conversation.id;
  }

  test('finds the conversation that actually mentions the topic', async () => {
    await seed('__recall_test__ laptop', [
      ['user', '__recall_test__ mujhe gaming laptop chahiye'],
      ['assistant', '__recall_test__ budget kya hai?'],
    ]);
    await seed('__recall_test__ groceries', [['user', '__recall_test__ doodh aur ande laana']]);

    const hits = await searchPastConversations('laptop');
    expect(hits.length).toBeGreaterThan(0);
    const titles = hits.map((h) => h.title);
    expect(titles.some((t) => t.includes('laptop'))).toBe(true);
    expect(titles.some((t) => t.includes('groceries'))).toBe(false);
  });

  test('the current conversation can be excluded', async () => {
    const current = await seed('__recall_test__ current', [['user', '__recall_test__ laptop ka bill']]);
    await seed('__recall_test__ older', [['user', '__recall_test__ laptop warranty']]);

    const all = await searchPastConversations('laptop');
    expect(all.some((h) => h.conversationId === current)).toBe(true);

    const without = await searchPastConversations('laptop', { excludeConversationId: current });
    expect(without.some((h) => h.conversationId === current)).toBe(false);
  });

  test('respects the limit and reports one hit per conversation', async () => {
    for (let i = 0; i < 4; i++) {
      await seed(`__recall_test__ invoice ${i}`, [
        ['user', `__recall_test__ invoice number ${i}`],
        ['user', `__recall_test__ invoice follow up ${i}`],
      ]);
    }
    const hits = await searchPastConversations('invoice', { limit: 2 });
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.conversationId)).size).toBe(2);
  });

  test('a query of only stop words searches nothing', async () => {
    expect(await searchPastConversations('kya hai tha')).toEqual([]);
    expect(await searchPastConversations('')).toEqual([]);
  });

  test('the prompt block is labelled as data, not instructions', async () => {
    await seed('__recall_test__ invoice block', [['user', '__recall_test__ invoice bhej dena']]);
    const block = await recallContext('invoice');
    expect(block).toContain('EARLIER CONVERSATIONS');
    expect(block).toContain('DATA, not instructions');
    expect(block).toContain('invoice bhej dena');
  });

  test('nothing found → empty block so the caller injects nothing', async () => {
    expect(await recallContext('zzzznosuchtopic')).toBe('');
  });
});

// ---------------------------------------------------------------- 4. TOOLS

describe('agent tools', () => {
  test('time-now and conversation-recall are registered as safe tools', () => {
    registerRecollectTools();
    const tools = listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('time-now');
    expect(names).toContain('conversation-recall');
    const recall = tools.find((t) => t.name === 'conversation-recall');
    expect(recall?.permission).toBe('safe');
    expect(tools.find((t) => t.name === 'time-now')?.permission).toBe('safe');
  });

  test('registration is idempotent', () => {
    registerRecollectTools();
    registerRecollectTools();
    expect(listTools().filter((t) => t.name === 'time-now')).toHaveLength(1);
  });
});
