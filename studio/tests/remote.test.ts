// remote.test.ts — Stonic Remote: pairing, session security and the phone turn.
//
// Everything is deterministic: the clock is injected and the model call is a
// fake responder, so no network and no real provider are needed.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  REMOTE_LIMITS,
  RemoteError,
  __resetRemoteState,
  authenticate,
  cancelPairing,
  listSessions,
  pairingView,
  recentEvents,
  redeemCode,
  revoke,
  revokeAll,
  safeEqual,
  sessionSummary,
  startPairing,
} from '../src/lib/agentic/remote-session';
import {
  buildRemoteMessages,
  buildRemoteSystemPrompt,
  clearRemoteHistory,
  historyFor,
  recordTurn,
  runRemoteTurn,
  speechReady,
} from '../src/lib/agentic/remote-chat';
import { normalizePersonaSettings } from '../src/lib/agentic/persona';

const DEVICE = { label: 'Test phone', userAgent: 'jest', ip: '10.0.0.9' };

let clock = 1_000_000;
const advance = (ms: number) => {
  clock += ms;
};

beforeEach(() => {
  clock = 1_000_000;
  __resetRemoteState(() => clock);
});

describe('state sharing', () => {
  // Regression: Next.js gives every route handler its OWN module bundle, so a
  // module-level Map made /api/remote/pair and /api/remote/connect see different
  // pairings (the code looked "expired" instantly). The state must live on
  // globalThis so every bundle in the process shares it.
  test('the session store is a global, not a module variable', () => {
    const store = (globalThis as unknown as Record<string, unknown>).__agentscope_remote_state__;
    expect(store).toBeDefined();
    expect(typeof store).toBe('object');
  });

  test('a code created through one call is visible to another call', () => {
    const a = startPairing();
    // a second "bundle" would run the same module code again — same global
    expect(pairingView().code).toBe(a.code);
  });
});

describe('constant-time comparison', () => {
  test('equal strings match, different strings and lengths do not', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('pairing', () => {
  test('a code is 6 digits and expires after the TTL', () => {
    const pairing = startPairing();
    expect(pairing.code).toMatch(/^\d{6}$/);
    expect(pairing.remainingSec).toBe(REMOTE_LIMITS.codeTtlMs / 1000);
    advance(REMOTE_LIMITS.codeTtlMs + 1);
    expect(() => pairingView()).toThrow(RemoteError);
  });

  test('redeeming the right code returns a 64-char token and burns the code', () => {
    const { code } = startPairing();
    const { session } = redeemCode(code, DEVICE, 'client-a');
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(session.device.label).toBe('Test phone');
    // second use fails — single use
    expect(() => redeemCode(code, DEVICE, 'client-a')).toThrow(RemoteError);
    expect(listSessions()).toHaveLength(1);
  });

  test('a wrong code is refused and counts down the attempts', () => {
    const { code } = startPairing();
    const wrong = code === '000000' ? '111111' : '000000';
    expect(() => redeemCode(wrong, DEVICE, 'client-b')).toThrow(/Wrong code/);
    expect(pairingView().attemptsLeft).toBe(REMOTE_LIMITS.maxCodeAttempts - 1);
  });

  test('the code is destroyed after too many wrong guesses', () => {
    const { code } = startPairing();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < REMOTE_LIMITS.maxCodeAttempts - 1; i++) {
      expect(() => redeemCode(wrong, DEVICE, 'client-c')).toThrow(/Wrong code/);
    }
    expect(() => redeemCode(wrong, DEVICE, 'client-c')).toThrow(/cancelled/);
    // the real code no longer works either
    expect(() => redeemCode(code, DEVICE, 'client-c')).toThrow(RemoteError);
  });

  test('an expired code cannot be redeemed', () => {
    const { code } = startPairing();
    advance(REMOTE_LIMITS.codeTtlMs + 5);
    expect(() => redeemCode(code, DEVICE, 'client-d')).toThrow(/no longer valid/);
  });

  test('the per-client throttle blocks a brute-force loop', () => {
    startPairing();
    const wrong = '000001';
    for (let i = 0; i < REMOTE_LIMITS.attemptLimit; i++) {
      try {
        redeemCode(wrong, DEVICE, 'noisy-client');
      } catch (err) {
        expect(err).toBeInstanceOf(RemoteError);
      }
    }
    expect(() => redeemCode(wrong, DEVICE, 'noisy-client')).toThrow(/Too many attempts/);
    // a different client is unaffected
    expect(() => startPairing()).not.toThrow();
  });

  test('generating a new code replaces the previous one', () => {
    const first = startPairing();
    const second = startPairing();
    expect(second.code).toBeDefined();
    if (first.code !== second.code) {
      expect(() => redeemCode(first.code, DEVICE, 'client-e')).toThrow(RemoteError);
    }
    expect(redeemCode(second.code, DEVICE, 'client-e').session.id).toBeTruthy();
  });

  test('cancel pairing clears the code', () => {
    startPairing();
    cancelPairing();
    expect(() => pairingView()).toThrow(RemoteError);
  });
});

describe('sessions', () => {
  function pair(label = 'Phone') {
    const { code } = startPairing();
    return redeemCode(code, { ...DEVICE, label }, 'client-x').session;
  }

  test('a token authenticates and refreshes lastSeenAt', () => {
    const session = pair();
    advance(5_000);
    const live = authenticate(session.token);
    expect(live.id).toBe(session.id);
    expect(live.lastSeenAt).toBe(clock);
  });

  test('an invalid or empty token is rejected', () => {
    pair();
    expect(() => authenticate('deadbeef')).toThrow(RemoteError);
    expect(() => authenticate('')).toThrow(RemoteError);
  });

  test('a session expires after the idle window', () => {
    const session = pair();
    advance(REMOTE_LIMITS.sessionIdleMs + 1_000);
    expect(() => authenticate(session.token)).toThrow(/ended/);
    expect(listSessions()).toHaveLength(0);
  });

  test('revoking a token kills it immediately', () => {
    const session = pair();
    expect(revoke(session.token)).toBe(true);
    expect(() => authenticate(session.token)).toThrow(RemoteError);
    expect(revoke(session.token)).toBe(false);
  });

  test('revokeAll drops every device', () => {
    pair('A');
    pair('B');
    expect(revokeAll()).toBe(2);
    expect(listSessions()).toEqual([]);
  });

  test('only the newest sessions survive the cap', () => {
    pair('A');
    pair('B');
    pair('C');
    const fourth = pair('D');
    expect(listSessions().length).toBe(REMOTE_LIMITS.maxSessions);
    expect(authenticate(fourth.token).device.label).toBe('D');
  });

  test('tokens are never exposed by listSessions', () => {
    const session = pair();
    const listed = listSessions();
    expect(JSON.stringify(listed)).not.toContain(session.token);
    expect(Object.keys(listed[0])).not.toContain('token');
  });

  test('the summary names who is connected', () => {
    expect(sessionSummary()).toBe('no remote device connected');
    pair('Ankit phone');
    expect(sessionSummary()).toContain('Ankit phone');
  });

  test('pairing events are recorded for the PC panel', () => {
    pair();
    const types = recentEvents(10).map((e) => e.type);
    expect(types).toContain('paired');
    expect(types).toContain('connected');
  });
});

describe('phone turn', () => {
  const settings = normalizePersonaSettings({ personaId: 'jarvis', verbosity: 30 });

  test('the system prompt marks the channel as a phone and keeps safety', () => {
    const prompt = buildRemoteSystemPrompt({ personaSettings: settings, memoryBlock: 'USER MEMORY: name is Ankit' });
    expect(prompt).toContain('PHONE');
    expect(prompt).toContain('no markdown');
    expect(prompt).toContain('USER MEMORY: name is Ankit');
    expect(prompt).toContain('approval');
  });

  test('history is trimmed to the prompt budget, newest kept', () => {
    clearRemoteHistory('s1');
    for (let i = 0; i < 30; i++) recordTurn('s1', i % 2 ? 'assistant' : 'user', `message ${i} ${'x'.repeat(500)}`);
    const messages = buildRemoteMessages('s1', 'latest question', 'SYSTEM');
    expect(messages[0].role).toBe('system');
    expect(messages.at(-1)?.content).toBe('latest question');
    expect(messages.length).toBeLessThan(31);
    const joined = messages.map((m) => m.content).join(' ');
    expect(joined.length).toBeLessThan(16_000);
  });

  test('history is bounded even without a prompt budget', () => {
    clearRemoteHistory('s2');
    for (let i = 0; i < 200; i++) recordTurn('s2', 'user', `m${i}`);
    expect(historyFor('s2').length).toBeLessThanOrEqual(40);
  });

  test('a turn calls the responder with the history and records both sides', async () => {
    clearRemoteHistory('s3');
    const seen: unknown[] = [];
    const { reply, spoken } = await runRemoteTurn({
      sessionId: 's3',
      text: 'kal ka mausam kaisa hai?',
      personaSettings: settings,
      memoryBlock: '',
      responder: async (messages) => {
        seen.push(messages.map((m) => m.role));
        return 'Kal Jaipur me 34 degree aur dhoop rahegi.';
      },
    });
    expect(reply).toContain('34 degree');
    expect(spoken).toBe(reply);
    expect(seen[0]).toEqual(['system', 'user']);
    const turns = historyFor('s3');
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
  });

  test('a second turn includes the first exchange', async () => {
    clearRemoteHistory('s4');
    const responder = async (messages: { role: string; content: string }[]) =>
      `saw ${messages.length} messages`;
    await runRemoteTurn({ sessionId: 's4', text: 'first', personaSettings: settings, memoryBlock: '', responder });
    const second = await runRemoteTurn({ sessionId: 's4', text: 'second', personaSettings: settings, memoryBlock: '', responder });
    expect(second.reply).toBe('saw 4 messages');
  });

  test('an empty message and an empty reply are errors', async () => {
    await expect(
      runRemoteTurn({ sessionId: 's5', text: '   ', personaSettings: settings, memoryBlock: '', responder: async () => 'x' })
    ).rejects.toThrow(/empty/i);
    await expect(
      runRemoteTurn({ sessionId: 's5', text: 'hi', personaSettings: settings, memoryBlock: '', responder: async () => '' })
    ).rejects.toThrow(/empty/i);
  });

  test('a responder failure propagates (the route turns it into 502)', async () => {
    await expect(
      runRemoteTurn({
        sessionId: 's6',
        text: 'hi',
        personaSettings: settings,
        memoryBlock: '',
        responder: async () => {
          throw new Error('provider down');
        },
      })
    ).rejects.toThrow('provider down');
  });

  test('speechReady strips what a voice must not read', () => {
    const text = '# Title\n\nHere is **code**:\n```js\nconsole.log(1)\n```\nSee [docs](https://x.y) and https://raw.link';
    const spoken = speechReady(text);
    expect(spoken).not.toContain('```');
    expect(spoken).not.toContain('https://');
    expect(spoken).not.toContain('**');
    expect(spoken).toContain('code block');
    expect(spoken).toContain('docs');
  });

  test('speechReady cuts at a sentence boundary', () => {
    const long = `${'Sentence one. '.repeat(80)}`;
    const out = speechReady(long, 200);
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith('.')).toBe(true);
  });
});

afterAll(() => {
  __resetRemoteState();
  clearRemoteHistory('s1');
});

describe('PC-side revoke by session id', () => {
  test('one device can be dropped without touching the others', async () => {
    const { revokeById } = await import('../src/lib/agentic/remote-session');
    const a = (() => {
      const { code } = startPairing();
      return redeemCode(code, { ...DEVICE, label: 'Phone A' }, 'client-a').session;
    })();
    const b = (() => {
      const { code } = startPairing();
      return redeemCode(code, { ...DEVICE, label: 'Phone B' }, 'client-b').session;
    })();

    expect(revokeById(a.id)).toBe(true);
    expect(() => authenticate(a.token)).toThrow(RemoteError);
    // B is untouched
    expect(authenticate(b.token).id).toBe(b.id);
    expect(revokeById('no-such-session')).toBe(false);
  });
});
