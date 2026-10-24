// Jarvis router tests — chat vs job decision (pure function, no I/O).
// Run: bun test tests/jarvis.test.ts
import { describe, expect, test } from 'bun:test';
import {
  buildActionAck,
  detectIntent,
  isCapabilityQuestion,
  JARVIS_CAPABILITIES_PROMPT,
} from '../src/lib/agentic/jarvis';

describe('detectIntent — jobs for the tools', () => {
  const jobs = [
    'Downloads folder me jo PDF files hain unhe ek folder me daal do',
    'chrome history me kal ka kuch dhundo',
    'Desktop ki saari screenshots delete kar do',
    'notepad kholo aur hello likho',
    'open the downloads folder and list the files',
    'is website se file download karo',
    'roz 9 baje downloads saaf karne ka schedule lagao',
  ];
  for (const j of jobs) {
    test(`action: ${j}`, () => {
      expect(detectIntent(j).intent).toBe('action');
    });
  }
});

describe('detectIntent — ordinary conversation stays chat', () => {
  const chats = [
    'hi',
    'Hello! kaise ho',
    'python me list kya hoti hai',
    'tum kaun ho',
    'explain how recursion works',
    'mujhe ek kavita likh ke do',
  ];
  for (const c of chats) {
    test(`chat: ${c}`, () => {
      expect(detectIntent(c).intent).toBe('chat');
    });
  }

  test('capability questions are chat (answered with the real feature list)', () => {
    for (const q of ['ye kya kya kar sakta h', 'what can you do with my files?', 'tum kya kya kar sakte ho']) {
      expect(detectIntent(q).intent).toBe('chat');
      expect(isCapabilityQuestion(q)).toBe(true);
    }
  });
});

describe('detectIntent — explicit overrides', () => {
  test('"jarvis ..." and "/do ..." force an action and strip the prefix', () => {
    const a = detectIntent('jarvis, hello world');
    expect(a.intent).toBe('action');
    expect(a.text).toBe('hello world');
    expect(detectIntent('/do kuch bhi karo').intent).toBe('action');
  });
  test('"/chat ..." forces chat even when it looks like a job', () => {
    const d = detectIntent('/chat downloads folder ki files delete kar do');
    expect(d.intent).toBe('chat');
    expect(d.text).toBe('downloads folder ki files delete kar do');
  });
  test('empty input is chat', () => {
    expect(detectIntent('   ').intent).toBe('chat');
  });
});

describe('capability prompt + ack message', () => {
  test('capability prompt lists the real tools and the safety rules', () => {
    expect(JARVIS_CAPABILITIES_PROMPT).toContain('Recycle Bin');
    expect(JARVIS_CAPABILITIES_PROMPT).toContain('approval');
    // Jarvis pack: vision ab REAL hai (screen tasks), aur naye features bhi
    expect(JARVIS_CAPABILITIES_PROMPT).toContain('Vision (screen tasks)');
    expect(JARVIS_CAPABILITIES_PROMPT).toContain('Hey Jarvis');
    expect(JARVIS_CAPABILITIES_PROMPT).toContain('Memory');
    expect(JARVIS_CAPABILITIES_PROMPT).toContain('Calendar/Gmail');
  });
  test('ack lists plan steps, truncates long plans, never leaks the full task id', () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({ index: i, title: `Step ${i + 1}` }));
    const ack = buildActionAck('abcdefgh-1234-5678', steps);
    expect(ack).toContain('1. Step 1');
    expect(ack).toContain('8. Step 8');
    expect(ack).not.toContain('9. Step 9');
    expect(ack).toContain('aur 2 steps');
    expect(ack).toContain('abcdefgh');
    expect(ack).not.toContain('abcdefgh-1234');
  });
});
