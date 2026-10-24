// Jarvis 7-feature pack tests — memory (#4), REMEMBER protocol, jarvis
// routing additions (#5 approve/#2 screen), vision action parsing (#2),
// proactive guard-rails + morning summary (#5).
// Run: bun test tests/jarvis-features.test.ts
import { describe, expect, test, afterAll } from 'bun:test';
import { db } from '../src/lib/db';
import {
  saveMemory,
  findRelevantMemories,
  relevantMemoryContext,
  listMemory,
} from '../src/lib/agentic/memory';
import { parseActions } from '../src/lib/agentic/file-tools';
import {
  isApprovalAffirmative,
  wantsScreenTask,
  detectIntent,
} from '../src/lib/agentic/jarvis';
import {
  parseScreenAction,
  isReadOnlyAction,
  actionEndpoint,
  actionPayload,
  describeAction,
} from '../src/lib/agentic/vision';
import {
  inQuietHours,
  muteKind,
  isKindMuted,
  unmuteKind,
  proactiveNotify,
  buildMorningSummary,
  maybeMorningSummary,
} from '../src/lib/agentic/proactive';
import { registerMemoryTools } from '../src/lib/agentic/memory-tools';
import { registerConnectorTools } from '../src/lib/agentic/connector-tools';
import { listTools } from '../src/lib/agentic/tool-registry';
import { buildUpstreamStream, hasImages, type CoreChatMessage } from '../src/lib/llm-core';

afterAll(async () => {
  await db.memoryEntry.deleteMany({ where: { scope: 'user' } });
  await db.proactiveSuggestion.deleteMany({ where: { kind: { in: ['test_kind'] } } });
  await db.proactiveState.deleteMany({ where: { key: { startsWith: 'muted:' } } });
  await db.proactiveState.deleteMany({ where: { key: { startsWith: 'morning_summary:' } } });
  await db.notification.deleteMany({ where: { type: 'suggestion', title: { contains: 'test' } } });
});

// ---------------------------------------------------------------------------
// #4 Memory — relevant retrieval
// ---------------------------------------------------------------------------
describe('memory #4 — keyword-scored retrieval', () => {
  test('saves + retrieves by relevance (not the whole list)', async () => {
    await saveMemory({ scope: 'user', key: 'work start time', content: 'Ankit subah 9 baje kaam shuru karta hai', source: 'agent' });
    await saveMemory({ scope: 'user', key: 'favourite editor', content: 'VS Code use karta hai, dark theme', source: 'agent' });
    await saveMemory({ scope: 'user', key: 'city', content: 'Ankit Jaipur me rehta hai', source: 'user' });

    const hits = await findRelevantMemories('subah kaam kab shuru hota hai', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].key).toBe('work start time');

    // editor query should NOT surface the work-start memory first
    const editorHits = await findRelevantMemories('editor kaun sa use karta hai', 5);
    expect(editorHits[0].key).toBe('favourite editor');
  });

  test('relevantMemoryContext returns a bounded prompt block', async () => {
    const block = await relevantMemoryContext('kaam start time', 5);
    expect(block).toContain('WHAT YOU REMEMBER ABOUT THE USER');
    expect(block).toContain('work start time');
    // nothing matching → empty string (no injection)
    const none = await relevantMemoryContext('zzzqqqxxx unrelated query words', 5);
    expect(none).toBe('');
  });

  test('memory still refuses credentials (safety unchanged)', async () => {
    await saveMemory({ scope: 'user', key: 'ok-fact', content: 'chai peeta hai' }).catch(() => undefined);
    const rows = await listMemory({ scope: 'user' });
    expect(rows.every((r) => !/sk-[a-zA-Z0-9]{10,}/.test(r.content))).toBe(true);
  });

  test('memory tools register into the catalog', () => {
    registerMemoryTools();
    registerConnectorTools();
    const names = listTools().map((t) => t.name);
    expect(names).toContain('memory-remember');
    expect(names).toContain('memory-recall');
    expect(names).toContain('memory-forget');
    expect(names).toContain('calendar-list-events');
    expect(names).toContain('gmail-list-messages');
    // write tool is destructive (approval gate!)
    expect(listTools().find((t) => t.name === 'calendar-create-event')?.permission).toBe('destructive');
  });
});

// ---------------------------------------------------------------------------
// #4 REMEMBER protocol — the step agents' "yaad rakho" marker
// ---------------------------------------------------------------------------
describe('REMEMBER protocol parsing', () => {
  test('parses key :: content pairs', () => {
    const actions = parseActions('Kaam ho gaya.\n### REMEMBER: work start time :: Ankit 9 baje shuru karta hai\n### END');
    expect(actions.memories).toHaveLength(1);
    expect(actions.memories[0].key).toBe('work start time');
    expect(actions.memories[0].content).toBe('Ankit 9 baje shuru karta hai');
  });

  test('content with colons survives the :: separator', () => {
    const actions = parseActions('### REMEMBER: meeting :: kal 10:30 AM standup hai');
    expect(actions.memories[0].content).toBe('kal 10:30 AM standup hai');
  });

  test('no key → derived from the first words', () => {
    const actions = parseActions('### REMEMBER: weekend pe bike chalata hai');
    expect(actions.memories).toHaveLength(1);
    expect(actions.memories[0].key.length).toBeGreaterThan(0);
    expect(actions.memories[0].content).toContain('bike');
  });

  test('FILE/RUN parsing is unchanged (no regression)', () => {
    const actions = parseActions('### FILE: a.txt\nhello\n### RUN: ls -la\n### END');
    expect(actions.files).toHaveLength(1);
    expect(actions.commands).toEqual(['ls -la']);
    expect(actions.memories).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #5 approve-by-voice + #2 screen-task routing (pure functions)
// ---------------------------------------------------------------------------
describe('jarvis routing additions', () => {
  test('isApprovalAffirmative: haan/kar do/yes approve', () => {
    for (const t of ['haan', 'haanji', 'kar do', 'kardo', 'yes', 'ok', 'theek hai', 'approve kar do', 'bilkul']) {
      expect(isApprovalAffirmative(t)).toBe(true);
    }
    for (const t of ['na', 'nahi', 'mat karo', 'downloads saaf kar do']) {
      expect(isApprovalAffirmative(t)).toBe(false);
    }
  });

  test('wantsScreenTask: conservative trigger', () => {
    for (const t of [
      'screen dekh kar notepad me hello likho',
      'notepad kholo aur hello likho',
      'screenshot lekar batao ye kya hai',
      'screen pe save button click karo',
    ]) {
      expect(wantsScreenTask(t)).toBe(true);
    }
    for (const t of ['downloads ki files list karo', 'chrome history dhundo', 'screenshot lo']) {
      expect(wantsScreenTask(t)).toBe(false);
    }
    // /chat override wins
    expect(wantsScreenTask('/chat screen dekh kar kya karna hai batao')).toBe(false);
  });

  test('plain "screenshot lo" stays a normal desktop action (not vision)', () => {
    expect(detectIntent('screenshot lo').intent).toBe('action');
    expect(wantsScreenTask('screenshot lo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #2 vision — action parsing + safety helpers
// ---------------------------------------------------------------------------
describe('screen action parsing (#2)', () => {
  test('plain JSON', () => {
    const a = parseScreenAction('{"action":"click","x":120,"y":240,"note":"Save button"}');
    expect(a?.action).toBe('click');
    expect(a?.x).toBe(120);
    expect(a?.y).toBe(240);
  });

  test('fenced JSON inside prose', () => {
    const a = parseScreenAction('Sochta hoon...\n```json\n{"action":"type","text":"hello"}\n```\nHo gaya.');
    expect(a?.action).toBe('type');
    expect(a?.text).toBe('hello');
  });

  test('done / cannot / wait parse', () => {
    expect(parseScreenAction('{"action":"done","summary":"kaam ho gaya"}')?.action).toBe('done');
    expect(parseScreenAction('{"action":"cannot","reason":"payment screen"}')?.action).toBe('cannot');
    expect(parseScreenAction('{"action":"wait","ms":1500}')?.ms).toBe(1500);
  });

  test('garbage replies → null (the loop retries)', () => {
    expect(parseScreenAction('mujhe nahi pata')).toBeNull();
    expect(parseScreenAction('{"action":"delete_everything"}')).toBeNull();
  });

  test('read-only vs mutating + endpoint mapping', () => {
    expect(isReadOnlyAction({ action: 'done' })).toBe(true);
    expect(isReadOnlyAction({ action: 'wait' })).toBe(true);
    expect(isReadOnlyAction({ action: 'click', x: 1, y: 2 })).toBe(false);
    expect(isReadOnlyAction({ action: 'type', text: 'x' })).toBe(false);

    expect(actionEndpoint({ action: 'click', x: 1, y: 2 })).toBe('click');
    expect(actionEndpoint({ action: 'type', text: 'x' })).toBe('type_text');
    expect(actionEndpoint({ action: 'hotkey', keys: 'ctrl,s' })).toBe('hotkey');
    expect(actionEndpoint({ action: 'open', target: 'notepad' })).toBe('open_app');
    expect(actionEndpoint({ action: 'wait' })).toBeNull();

    expect(actionPayload({ action: 'click', x: 5, y: 6 })).toEqual({ x: 5, y: 6, button: 'left', clicks: 1 });
    expect(actionPayload({ action: 'double_click', x: 5, y: 6 }).clicks).toBe(2);
    expect(actionPayload({ action: 'right_click', x: 5, y: 6 }).button).toBe('right');
    expect(describeAction({ action: 'hotkey', keys: 'ctrl,s' })).toContain('ctrl,s');
  });
});

// ---------------------------------------------------------------------------
// #5 proactive — guard-rails + morning summary
// ---------------------------------------------------------------------------
describe('proactive guard-rails', () => {
  test('quiet-hours window parsing (incl. midnight cross)', () => {
    const saved = process.env.AGENTSCOPE_QUIET_HOURS;
    try {
      process.env.AGENTSCOPE_QUIET_HOURS = '23:00-07:30';
      expect(inQuietHours(new Date('2026-01-01T23:30:00'))).toBe(true);
      expect(inQuietHours(new Date('2026-01-01T03:00:00'))).toBe(true);
      expect(inQuietHours(new Date('2026-01-01T12:00:00'))).toBe(false);

      process.env.AGENTSCOPE_QUIET_HOURS = '13:00-14:00';
      expect(inQuietHours(new Date('2026-01-01T13:30:00'))).toBe(true);
      expect(inQuietHours(new Date('2026-01-01T15:00:00'))).toBe(false);

      process.env.AGENTSCOPE_QUIET_HOURS = 'off';
      expect(inQuietHours(new Date('2026-01-01T23:30:00'))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AGENTSCOPE_QUIET_HOURS;
      else process.env.AGENTSCOPE_QUIET_HOURS = saved;
    }
  });

  test('muted kind suppresses proactiveNotify ("aage se mat batao")', async () => {
    await muteKind('test_kind');
    expect(await isKindMuted('test_kind')).toBe(true);
    const res = await proactiveNotify({ kind: 'test_kind', title: 'test — should be muted' });
    expect(res.created).toBe(false);
    expect(res.reason).toContain('muted');
    await unmuteKind('test_kind');
    expect(await isKindMuted('test_kind')).toBe(false);
  });

  test('morning summary builds a digest + fires once per day', async () => {
    const digest = await buildMorningSummary(new Date('2026-01-05T10:00:00'));
    expect(digest).toContain('summary');

    const saved = process.env.AGENTSCOPE_MORNING_SUMMARY;
    try {
      process.env.AGENTSCOPE_MORNING_SUMMARY = '00:00'; // 00:00 is already past at any hour
      const first = await maybeMorningSummary(new Date('2026-01-05T10:00:00'));
      expect(first.sent).toBe(true);
      const second = await maybeMorningSummary(new Date('2026-01-05T10:05:00'));
      expect(second.sent).toBe(false);
      expect(second.reason).toBe('already sent today');

      // 'off' disables completely
      process.env.AGENTSCOPE_MORNING_SUMMARY = 'off';
      const off = await maybeMorningSummary(new Date('2026-01-06T10:00:00'));
      expect(off.sent).toBe(false);
      expect(off.reason).toBe('disabled');
    } finally {
      if (saved === undefined) delete process.env.AGENTSCOPE_MORNING_SUMMARY;
      else process.env.AGENTSCOPE_MORNING_SUMMARY = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// #2 llm-core — additive image support
// ---------------------------------------------------------------------------
describe('llm-core image fields', () => {
  test('hasImages detects images; plain messages stay compatible', () => {
    const plain: CoreChatMessage[] = [{ role: 'user', content: 'hello' }];
    expect(hasImages(plain)).toBe(false);
    const withImg: CoreChatMessage[] = [
      { role: 'user', content: 'ye screen hai', images: [{ base64: 'QUJD', mediaType: 'image/png' }] },
    ];
    expect(hasImages(withImg)).toBe(true);
  });
});
