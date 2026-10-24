// screen-awareness.test.ts — continuous screen awareness.
// No real screen: every capture/decode is injected.
import { describe, expect, test } from 'bun:test';
import {
  ScreenWatcher,
  decodePngToRgba,
  dHashFromGray,
  hammingDistance,
  luma,
  perceptualHash,
} from '../src/lib/agentic/screen-awareness';

/** Build a solid-colour RGBA image with an optional bright square. */
function rgbaImage(
  width: number,
  height: number,
  opts: { base?: number; square?: { x: number; y: number; w: number; h: number; value: number } } = {}
): Uint8Array {
  const base = opts.base ?? 20;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let v = base;
      const sq = opts.square;
      if (sq && x >= sq.x && x < sq.x + sq.w && y >= sq.y && y < sq.y + sq.h) v = sq.value;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe('hashing', () => {
  test('luma uses Rec. 601 weights', () => {
    expect(luma(255, 255, 255)).toBeCloseTo(255, 5);
    expect(luma(0, 0, 0)).toBe(0);
    expect(luma(255, 0, 0)).toBeCloseTo(76.245, 3);
  });

  test('a flat image hashes to all zeros', () => {
    const hash = dHashFromGray(new Array(9 * 8).fill(100), 9, 8);
    expect(hash).toBe('0000000000000000');
  });

  test('a gradient hash is stable and 16 chars', () => {
    const gray = Array.from({ length: 9 * 8 }, (_, i) => (i % 9) * 10);
    const hash = dHashFromGray(gray, 9, 8);
    expect(hash).toHaveLength(16);
    expect(dHashFromGray(gray, 9, 8)).toBe(hash);
  });

  test('identical images have distance 0, different layouts do not', () => {
    const a = perceptualHash(rgbaImage(64, 64), 64, 64);
    const b = perceptualHash(rgbaImage(64, 64), 64, 64);
    const c = perceptualHash(rgbaImage(64, 64, { square: { x: 40, y: 8, w: 16, h: 16, value: 240 } }), 64, 64);
    expect(hammingDistance(a, b)).toBe(0);
    expect(hammingDistance(a, c)).toBeGreaterThan(0);
  });

  test('small brightness changes do not look like a layout change', () => {
    const a = perceptualHash(rgbaImage(64, 64, { base: 20 }), 64, 64);
    const b = perceptualHash(rgbaImage(64, 64, { base: 26 }), 64, 64);
    expect(hammingDistance(a, b)).toBe(0);
  });

  test('bad input is rejected', () => {
    expect(() => dHashFromGray([1, 2], 9, 8)).toThrow();
    expect(() => perceptualHash(new Uint8Array(4), 0, 0)).toThrow();
  });

  test('a real PNG decodes to RGBA (sharp path)', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
      .png()
      .toBuffer();
    const { rgba, width, height } = await decodePngToRgba(png, 16);
    expect(width).toBe(16);
    expect(height).toBe(16);
    expect(rgba.length).toBe(16 * 16 * 4);
  });
});

describe('watcher session', () => {
  const frameOf = (square?: { x: number; y: number; w: number; h: number; value: number }) => ({
    rgba: rgbaImage(64, 64, square ? { square } : {}),
    width: 64,
    height: 64,
  });

  function makeWatcher(sequence: ReturnType<typeof frameOf>[], opts: { threshold?: number } = {}) {
    let index = 0;
    const watcher = new ScreenWatcher({
      settings: { intervalMs: 1_000, threshold: opts.threshold ?? 4 },
      capture: async () => ({ png: Buffer.from([1]) }),
      decode: async () => sequence[Math.min(index++, sequence.length - 1)],
      sensitiveCheck: false,
    });
    return watcher;
  }

  test('the first frame is a baseline, the next identical frame is not a change', async () => {
    const watcher = makeWatcher([frameOf(), frameOf()]);
    watcher.start();
    try {
      const first = await watcher.tick();
      expect(first?.changed).toBe(true);
      expect(first?.distance).toBe(64);
      const second = await watcher.tick();
      expect(second?.changed).toBe(false);
      expect(second?.distance).toBe(0);
      expect(watcher.status().changes).toBe(0);
    } finally {
      watcher.stop();
    }
  });

  test('a layout change is detected and counted', async () => {
    const watcher = makeWatcher([frameOf(), frameOf({ x: 4, y: 4, w: 40, h: 40, value: 250 })]);
    watcher.start();
    try {
      await watcher.tick();
      const changed = await watcher.tick();
      expect(changed?.changed).toBe(true);
      expect(changed?.distance).toBeGreaterThanOrEqual(4);
      expect(watcher.status().changes).toBe(1);
      expect(watcher.status().lastChangeAt).not.toBeNull();
    } finally {
      watcher.stop();
    }
  });

  test('a tick outside a session does nothing', async () => {
    const watcher = makeWatcher([frameOf()]);
    expect(await watcher.tick()).toBeNull();
    expect(watcher.status().running).toBe(false);
  });

  test('a sensitive window pauses the session instead of capturing', async () => {
    let captures = 0;
    const watcher = new ScreenWatcher({
      capture: async () => {
        captures++;
        return { png: Buffer.from([1]) };
      },
      decode: async () => frameOf(),
      sensitiveCheck: true,
      sensitiveProbe: async () => 'Chase Bank — Login',
    });
    watcher.start();
    try {
      const frame = await watcher.tick();
      expect(frame).toBeNull();
      expect(captures).toBe(0);
      expect(watcher.status().paused).toBe(true);
      expect(watcher.status().pausedReason).toContain('sensitive');
    } finally {
      watcher.stop();
    }
  });

  test('a capture failure pauses instead of throwing', async () => {
    const watcher = new ScreenWatcher({
      capture: async () => {
        throw new Error('bridge down');
      },
      decode: async () => frameOf(),
      sensitiveCheck: false,
    });
    watcher.start();
    try {
      expect(await watcher.tick()).toBeNull();
      expect(watcher.status().pausedReason).toContain('bridge down');
    } finally {
      watcher.stop();
    }
  });

  test('history is bounded and start is idempotent', async () => {
    const watcher = new ScreenWatcher({
      settings: { historyLimit: 3, intervalMs: 1_000 },
      capture: async () => ({ png: Buffer.from([1]) }),
      decode: async () => frameOf(),
      sensitiveCheck: false,
    });
    watcher.start();
    watcher.start();
    try {
      for (let i = 0; i < 6; i++) await watcher.tick();
      expect(watcher.status().frames).toBe(6);
      expect(watcher.status().recent.length).toBeLessThanOrEqual(20);
    } finally {
      watcher.stop();
      expect(watcher.status().running).toBe(false);
    }
  });

  test('settings are clamped to a safe range', () => {
    const watcher = new ScreenWatcher({ settings: { intervalMs: 5, threshold: 999, historyLimit: 10_000, maxMinutes: 10_000 } });
    const s = watcher.status().settings;
    expect(s.intervalMs).toBe(1_000);
    expect(s.threshold).toBe(64);
    expect(s.historyLimit).toBe(500);
    expect(s.maxMinutes).toBe(240);
  });
});
