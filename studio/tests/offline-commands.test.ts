// Offline command parser tests — the deterministic "no cloud API" layer.
// Run: bun test tests/offline-commands.test.ts
import { describe, expect, test } from 'bun:test';
import {
  OFFLINE_APPS,
  OFFLINE_HELP_TEXT,
  OFFLINE_SITES,
  approvalSentence,
  buildOfflineResult,
  offlineAcknowledgement,
  offlineLifecycle,
  openFailureSentence,
  openSuccessSentence,
  parseOfflineCommand,
} from '../src/lib/agentic/offline-commands';

const win = { platform: 'win32' as const };

describe('opening allowlisted websites', () => {
  test('Hinglish: "YouTube kholo"', () => {
    const r = parseOfflineCommand('YouTube kholo', win);
    expect(r.matched).toBe(true);
    expect(r.command).toEqual(
      expect.objectContaining({ kind: 'open_site', url: OFFLINE_SITES.youtube })
    );
    expect(r.label).toContain('Youtube');
  });

  test('English: "open gmail"', () => {
    const r = parseOfflineCommand('open gmail', win);
    expect(r.matched).toBe(true);
    expect(r.command).toEqual(
      expect.objectContaining({ kind: 'open_site', url: OFFLINE_SITES.gmail })
    );
  });

  test('politeness prefixes are ignored', () => {
    for (const phrase of [
      'Jarvis, YouTube kholo',
      'hey jarvis open youtube',
      'please open youtube',
      'zara youtube khol do',
    ]) {
      expect(parseOfflineCommand(phrase, win).matched).toBe(true);
    }
  });

  test('a bare domain resolves through the allowlist', () => {
    const r = parseOfflineCommand('youtube.com kholo', win);
    expect(r.matched).toBe(true);
    expect(r.command).toEqual(expect.objectContaining({ kind: 'open_site' }));

    const https = parseOfflineCommand('open https://gmail.com/mail', win);
    expect(https.matched).toBe(true);
    expect(https.command).toEqual(expect.objectContaining({ url: OFFLINE_SITES.gmail }));
  });

  test('an arbitrary URL is REFUSED (a voice transcript cannot open any site)', () => {
    const r = parseOfflineCommand('open https://evil.example.com/payload', win);
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('not an allowlisted');
  });

  test('an arbitrary app is refused', () => {
    expect(parseOfflineCommand('open some-random-tool', win).matched).toBe(false);
  });
});

describe('opening allowlisted applications', () => {
  test('notepad on Windows', () => {
    const r = parseOfflineCommand('notepad kholo', win);
    expect(r.matched).toBe(true);
    expect(r.command).toEqual(
      expect.objectContaining({ kind: 'open_app', target: OFFLINE_APPS.notepad.target })
    );
  });

  test('a Windows-only app is not offered on another platform', () => {
    const r = parseOfflineCommand('notepad kholo', { platform: 'linux' });
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('only defined for');
  });

  test('VS Code is available everywhere it is defined', () => {
    const r = parseOfflineCommand('vs code kholo', { platform: 'linux' });
    expect(r.matched).toBe(true);
    expect(r.command).toEqual(expect.objectContaining({ kind: 'open_app', target: 'code' }));
  });
});

describe('status / last error / cancel / help', () => {
  test('status phrases (Hindi + English)', () => {
    for (const phrase of [
      'status',
      'system status',
      'kya haal hai',
      'provider status batao',
      'kaunsa provider connect hai',
    ]) {
      const r = parseOfflineCommand(phrase, win);
      expect(r.matched).toBe(true);
      expect(r.command?.kind).toBe('status');
    }
  });

  test('last error phrases', () => {
    for (const phrase of ['last error', 'pichhli error batao', 'kya error aaya tha', 'what was the error']) {
      const r = parseOfflineCommand(phrase, win);
      expect(r.matched).toBe(true);
      expect(r.command?.kind).toBe('last_error');
    }
  });

  test('cancel phrases', () => {
    for (const phrase of ['cancel', 'stop', 'ruko', 'band karo', 'cancel karo']) {
      const r = parseOfflineCommand(phrase, win);
      expect(r.matched).toBe(true);
      expect(r.command?.kind).toBe('cancel');
    }
  });

  test('help', () => {
    const r = parseOfflineCommand('help', win);
    expect(r.command?.kind).toBe('help');
    expect(OFFLINE_HELP_TEXT).toContain('YouTube kholo');
    expect(OFFLINE_HELP_TEXT).toContain('AI provider');
  });

  test('"open" alone is not a command', () => {
    expect(parseOfflineCommand('open', win).matched).toBe(false);
    expect(parseOfflineCommand('', win).matched).toBe(false);
  });

  test('normal chat is NOT hijacked by the offline layer', () => {
    for (const phrase of [
      'aaj ka mausam kaisa hai',
      'mujhe ek python function likho',
      'explain quantum computing',
      'what is the capital of france',
    ]) {
      expect(parseOfflineCommand(phrase, win).matched).toBe(false);
    }
  });
});

describe('spoken feedback for offline actions', () => {
  test('acknowledgement never claims success', () => {
    const ack = offlineAcknowledgement('YouTube kholna');
    expect(ack).toContain('samajh gaya');
    expect(ack).not.toContain('successfully');
  });

  test('success and failure sentences differ', () => {
    expect(openSuccessSentence('YouTube kholna')).toBe('YouTube successfully open ho gaya.');
    expect(openFailureSentence('YouTube kholna', 'permission denied')).toContain('permission denied');
    expect(openFailureSentence('YouTube kholna', 'permission denied')).not.toContain('successfully');
  });

  test('an approval request is explicit', () => {
    expect(approvalSentence('YouTube kholna')).toContain('permission');
  });

  test('the lifecycle records every phase and ends terminal', () => {
    const states = offlineLifecycle('cmd-1', 'YouTube kholna', 'succeeded');
    expect(states.map((s) => s.phase)).toEqual([
      'received',
      'understood',
      'running',
      'succeeded',
    ]);
    const failed = offlineLifecycle('cmd-2', 'X', 'failed', 'boom');
    expect(failed.at(-1)!.phase).toBe('failed');
    expect(failed.at(-1)!.spoken).toContain('boom');
  });

  test('result object marks needs_approval as not-ok-but-not-failed', () => {
    const pending = buildOfflineResult({
      command: 'open_site',
      outcome: 'needs_approval',
      spoken: 'permission chahiye',
      approvalId: 'ap-1',
      label: 'YouTube kholna',
    });
    expect(pending.ok).toBe(true);
    expect(pending.outcome).toBe('needs_approval');
    expect(pending.approvalId).toBe('ap-1');

    const failed = buildOfflineResult({
      command: 'open_site',
      outcome: 'failed',
      spoken: 'fail',
      label: 'YouTube kholna',
      errorCategory: 'unknown',
    });
    expect(failed.ok).toBe(false);
    expect(failed.errorCategory).toBe('unknown');
  });
});
