// Run: bun test tests/jarvis-laptop-extras.test.ts
// Guards the Jarvis laptop extras (power / brightness / wifi / windows / webcam / recording).
import { describe, expect, test } from 'bun:test';
import { isReadOnlyEndpoint, isValidEndpoint } from '../src/lib/agentic/desktop-bridge';
import { classifyHostAction } from '../src/lib/agentic/host-control';

const MUTATING = ['close_window', 'window_state', 'brightness', 'wifi_set', 'power', 'webcam_capture', 'screen_record'];
const READONLY = ['wifi_status', 'system_info'];

describe('jarvis laptop extras — endpoint whitelist', () => {
  test('mutating extras are valid but never read-only', () => {
    for (const ep of MUTATING) {
      expect(isValidEndpoint(ep)).toBe(true);
      expect(isReadOnlyEndpoint(ep)).toBe(false);
    }
  });
  test('read-only extras are valid and read-only', () => {
    for (const ep of READONLY) {
      expect(isValidEndpoint(ep)).toBe(true);
      expect(isReadOnlyEndpoint(ep)).toBe(true);
    }
  });
  test('privacy-sensitive endpoints can never be read-only (no auto-run)', () => {
    expect(isReadOnlyEndpoint('webcam_capture')).toBe(false);
    expect(isReadOnlyEndpoint('screen_record')).toBe(false);
    expect(isReadOnlyEndpoint('power')).toBe(false);
  });
});

describe('jarvis laptop extras — approval classification', () => {
  test('every mutating extra is destructive (fresh approval, even in trusted mode)', () => {
    for (const ep of MUTATING) {
      const cls = classifyHostAction({ kind: 'desktop', endpoint: ep, payload: {} });
      expect(cls.permission).toBe('destructive');
      expect(cls.autoRunInTrusted).toBeFalsy();
    }
  });
  test('read-only extras are not destructive', () => {
    for (const ep of READONLY) {
      const cls = classifyHostAction({ kind: 'desktop', endpoint: ep, payload: {} });
      expect(cls.permission).not.toBe('destructive');
    }
  });
});
