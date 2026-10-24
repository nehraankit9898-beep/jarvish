// Action lifecycle + spoken-feedback tests (pure logic, no DOM, no network).
// Run: bun test tests/action-lifecycle.test.ts
import { describe, expect, test } from 'bun:test';
import {
  TerminalSpeechGate,
  buildActionState,
  createActionId,
  isTerminalPhase,
  phaseFromTaskStatus,
  phaseSentence,
  speechSafe,
  taskFinalSentence,
} from '../src/lib/action-lifecycle';
import {
  buildProviderFailure,
  categoryLabel,
  sanitizeProviderMessage,
  spokenProviderFailure,
} from '../src/lib/provider-errors';

describe('lifecycle phases', () => {
  test('a new action starts at RECEIVED and is not terminal', () => {
    const state = buildActionState({
      id: 'a1',
      kind: 'task',
      phase: 'received',
      label: 'YouTube kholna',
    });
    expect(state.phase).toBe('received');
    expect(isTerminalPhase(state.phase)).toBe(false);
    expect(state.at).toBeTruthy();
  });

  test('received / understood / running sentences are acknowledgements, not results', () => {
    expect(phaseSentence('received', { kind: 'task', label: 'X' })).toContain('samajh gaya');
    expect(phaseSentence('understood', { kind: 'task', label: 'YouTube kholna' })).toContain('shuru');
    expect(phaseSentence('running', { kind: 'task', label: 'YouTube kholna' })).toContain('chal raha');
    // none of the in-progress phases may claim success
    for (const phase of ['received', 'understood', 'running'] as const) {
      expect(phaseSentence(phase, { kind: 'task', label: 'X' })).not.toContain('successfully');
    }
  });

  test('success, failure and cancellation are distinguishable', () => {
    expect(phaseSentence('succeeded', { kind: 'open_site', label: 'YouTube kholna' })).toContain(
      'successfully'
    );
    expect(phaseSentence('failed', { kind: 'open_site', label: 'YouTube kholna', detail: 'boom' })).toContain(
      'boom'
    );
    expect(phaseSentence('cancelled', { kind: 'task', label: 'Kaam' })).toContain('cancel');
    expect(phaseSentence('needs_approval', { kind: 'open_site', label: 'YouTube kholna' })).toContain(
      'permission'
    );
  });

  test('a failure sentence never claims success', () => {
    const sentence = phaseSentence('failed', { kind: 'task', label: 'Task', detail: 'API key invalid' });
    expect(sentence).not.toContain('successfully');
    expect(sentence).toContain('API key invalid');
  });
});

describe('final announcement exactly once', () => {
  test('the gate accepts the first terminal state and refuses repeats', () => {
    const gate = new TerminalSpeechGate();
    const state = buildActionState({ id: 'task-1', kind: 'task', phase: 'succeeded', label: 'X' });
    expect(gate.claim(state)).toBe(true);
    expect(gate.claim(state)).toBe(false); // poller saw the same status again
    expect(gate.hasSpoken('task-1')).toBe(true);
  });

  test('a second action with the same text still speaks', () => {
    const gate = new TerminalSpeechGate();
    expect(
      gate.claim(buildActionState({ id: 'a', kind: 'task', phase: 'failed', label: 'X' }))
    ).toBe(true);
    expect(
      gate.claim(buildActionState({ id: 'b', kind: 'task', phase: 'failed', label: 'X' }))
    ).toBe(true);
  });

  test('non-terminal phases never pass the gate', () => {
    const gate = new TerminalSpeechGate();
    for (const phase of ['received', 'understood', 'running', 'needs_approval'] as const) {
      expect(gate.claim({ id: 'x', phase })).toBe(false);
    }
  });

  test('reset() allows a new session to speak again', () => {
    const gate = new TerminalSpeechGate();
    const state = buildActionState({ id: 'z', kind: 'task', phase: 'succeeded', label: 'X' });
    gate.claim(state);
    gate.reset();
    expect(gate.claim(state)).toBe(true);
  });
});

describe('task status → phase', () => {
  test('maps the engine vocabulary', () => {
    expect(phaseFromTaskStatus('done')).toBe('succeeded');
    expect(phaseFromTaskStatus('failed')).toBe('failed');
    expect(phaseFromTaskStatus('cancelled')).toBe('cancelled');
    expect(phaseFromTaskStatus('awaiting_approval')).toBe('needs_approval');
    expect(phaseFromTaskStatus('running')).toBe('running');
    expect(phaseFromTaskStatus('planning')).toBe('running');
    // an unknown status must NOT be announced as success
    expect(phaseFromTaskStatus('something-new')).toBe('running');
  });

  test('a task that is still running is never announced as finished', () => {
    const sentence = taskFinalSentence({ status: 'running', label: 'Report banana' });
    expect(sentence).toContain('chal raha');
    expect(sentence).not.toContain('poora ho gaya');
  });

  test('success and failure sentences differ and carry the real error', () => {
    expect(taskFinalSentence({ status: 'done', label: 'Report', detailCount: 3 })).toContain('3 step');
    const failed = taskFinalSentence({ status: 'failed', label: 'Report', error: 'provider 401' });
    expect(failed).toContain('fail');
    expect(failed).toContain('provider 401');
    // a failure without a reason is honest instead of inventing one
    const unknown = taskFinalSentence({ status: 'failed', label: 'Report' });
    expect(unknown).toContain('wajah nahi bataayi');
  });
});

describe('speech safety', () => {
  test('markdown, code and URLs are not read aloud', () => {
    const clean = speechSafe('## Title\n```js\nconst a = 1\n```\nSee https://example.com **now**');
    expect(clean).not.toContain('```');
    expect(clean).not.toContain('http');
    expect(clean).not.toContain('**');
    expect(clean).toContain('Title');
  });

  test('empty input is handled without throwing', () => {
    expect(speechSafe('')).toBe('');
    expect(speechSafe(undefined as unknown as string)).toBe('');
  });

  test('ids are unique', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createActionId('t')));
    expect(ids.size).toBe(50);
  });
});

describe('provider failure → spoken feedback (spec examples)', () => {
  test('invalid key is spoken as an auth failure', () => {
    const failure = buildProviderFailure({ category: 'auth', status: 401, providerName: 'Gemini' });
    const spoken = spokenProviderFailure('Gemini', failure);
    expect(spoken).toContain('API key');
    expect(spoken).toContain('Gemini');
  });

  test('an unavailable model is named', () => {
    const failure = buildProviderFailure({
      category: 'model_unavailable',
      status: 404,
      providerName: 'OpenRouter',
      model: 'gone/model:free',
    });
    expect(failure.message).toContain('gone/model:free');
    expect(spokenProviderFailure('OpenRouter', failure)).toContain('model available nahi');
  });

  test('a network failure points at the offline commands', () => {
    const failure = buildProviderFailure({ category: 'network', providerName: 'Gemini' });
    const spoken = spokenProviderFailure('Gemini', failure);
    expect(spoken).toContain('Internet');
    expect(spoken).toContain('Offline');
  });

  test('every category has a label and every failure carries a hint + timestamp', () => {
    for (const category of [
      'not_configured',
      'auth',
      'model_unavailable',
      'rate_limit',
      'server',
      'network',
      'timeout',
      'blocked',
      'empty_response',
      'config',
      'unknown',
    ] as const) {
      expect(categoryLabel(category).length).toBeGreaterThan(3);
      const failure = buildProviderFailure({ category });
      expect(failure.ok).toBe(false);
      expect(failure.hint).toBeTruthy();
      expect(Date.parse(failure.at)).toBeGreaterThan(0);
    }
  });

  test('secrets never reach the message, the hint or the audit', () => {
    const key = 'AIzaSyD-EXAMPLE-0123456789abcdefg';
    const failure = buildProviderFailure({
      category: 'auth',
      status: 401,
      detail: `Incorrect API key provided: ${key}`,
      secrets: [key],
      providerName: 'Gemini',
    });
    expect(failure.message).not.toContain(key);
    expect(JSON.stringify(failure)).not.toContain(key);
  });

  test('sanitizer masks the common key shapes', () => {
    const raw =
      'key=AIzaSyD-EXAMPLE-0123456789abcdefg bearer Bearer sk-or-v1-abcdef1234567890 x-api-key: nvapi-abcdef1234567890';
    const clean = sanitizeProviderMessage(raw);
    expect(clean).not.toContain('AIzaSyD');
    expect(clean).not.toContain('sk-or-v1-abcdef');
    expect(clean).not.toContain('nvapi-abcdef');
    expect(clean).toContain('[redacted]');
  });

  test('rate limiting mentions the retry window', () => {
    const failure = buildProviderFailure({ category: 'rate_limit', status: 429, retryAfterSec: 30 });
    expect(failure.message).toContain('30s');
  });
});
