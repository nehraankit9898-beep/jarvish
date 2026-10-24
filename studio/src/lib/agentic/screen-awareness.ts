// screen-awareness.ts — continuous screen awareness (not just one screenshot).
//
// WHAT IT DOES
//   A session takes a screenshot on a fixed cadence, reduces it to a perceptual
//   hash (dHash over a 9x8 grayscale downscale) and reports a CHANGE only when
//   the picture really moved (Hamming distance over a threshold). That is what
//   makes "JARVIS ko pata hai screen par kya ho raha hai" cheap: a change event
//   is the trigger, and the existing vision loop (vision.ts) is the interpreter
//   — this module never burns a model call by itself.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   * No always-on capture without a session: the watcher starts only when the
//     user starts it and stops on a kill-switch / stop call.
//   * It never stores the screenshots. Only the hash + a tiny summary is kept,
//     in memory, bounded.
//   * It never types or clicks. Watching is read-only.
//
// SAFETY
//   * Sensitive-window detection (bank/password/payment) pauses the session.
//   * The capture function is injectable, so tests never touch a real screen.
//   * Bounded history, bounded session length.

import { captureScreenImage, sensitiveWindowDetected } from './vision';

export interface ScreenFrame {
  /** 64-bit dHash as 16 hex chars */
  hash: string;
  at: number;
  /** how different this frame is from the previous one (0-64) */
  distance: number;
  /** true when the change crossed the threshold */
  changed: boolean;
  /** window title blocked the capture, if any */
  blockedBy?: string;
}

export type CaptureFn = () => Promise<{ png: Buffer } | null>;

// ---------------------------------------------------------------------------
// perceptual hashing (pure functions — the part the tests pin down)
// ---------------------------------------------------------------------------

/** Rec. 601 luma. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * dHash of a grayscale grid: each pixel is compared to its right neighbour.
 * A 9x8 grid → 64 bits → 16 hex chars. Robust to small brightness shifts,
 * sensitive to layout changes (a window opening, a page scrolling).
 */
export function dHashFromGray(gray: number[], width: number, height: number): string {
  if (width < 2 || height < 1 || gray.length < width * height) {
    throw new Error('dHash needs at least a 9x8 grayscale grid');
  }
  let bits = '';
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = gray[y * width + x];
      const right = gray[y * width + x + 1];
      bits += left > right ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.padEnd(16, '0').slice(0, 16);
}

/** Downscale RGBA pixels to a 9x8 grayscale grid, then hash it. */
export function perceptualHash(rgba: Uint8Array, width: number, height: number): string {
  if (!width || !height || rgba.length < width * height * 4) {
    throw new Error('perceptualHash needs RGBA pixels');
  }
  const gw = 9;
  const gh = 8;
  const gray: number[] = [];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      // box-average the source cells that fall into this grid cell
      const x0 = Math.floor((gx * width) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / gw));
      const y0 = Math.floor((gy * height) / gh);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / gh));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          sum += luma(rgba[i], rgba[i + 1], rgba[i + 2]);
          count++;
        }
      }
      gray.push(count ? sum / count : 0);
    }
  }
  return dHashFromGray(gray, gw, gh);
}

/** Number of differing bits between two equal-length hex hashes. */
export function hammingDistance(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let distance = 0;
  for (let i = 0; i < len; i++) {
    const xor = Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16);
    if (!Number.isFinite(xor)) continue;
    distance += ((xor & 1) ? 1 : 0) + ((xor & 2) ? 1 : 0) + ((xor & 4) ? 1 : 0) + ((xor & 8) ? 1 : 0);
  }
  return distance + Math.abs(a.length - b.length) * 4;
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

export interface ScreenSessionSettings {
  /** capture cadence in ms (2 s … 60 s) */
  intervalMs: number;
  /** Hamming distance that counts as a change (0-64, default 6) */
  threshold: number;
  /** how many frames to remember */
  historyLimit: number;
  /** stop after N minutes (default 30) — a watcher is never immortal */
  maxMinutes: number;
}

const DEFAULTS: ScreenSessionSettings = {
  intervalMs: 5_000,
  threshold: 6,
  historyLimit: 50,
  maxMinutes: 30,
};

export interface ScreenSessionStatus {
  running: boolean;
  startedAt: number | null;
  frames: number;
  changes: number;
  lastChangeAt: number | null;
  paused: boolean;
  pausedReason: string;
  settings: ScreenSessionSettings;
  recent: ScreenFrame[];
}

/** Decode a PNG to raw RGBA using sharp (already a dependency). */
export async function decodePngToRgba(png: Buffer, size = 128): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(png)
    .resize({ width: size, height: size, fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8Array(data), width: info.width, height: info.height };
}

/** Default capture: the same desktop bridge the vision loop uses. */
const defaultCapture: CaptureFn = async () => {
  const shot = await captureScreenImage(1280);
  return { png: Buffer.from(shot.base64, 'base64') };
};

export class ScreenWatcher {
  private settings: ScreenSessionSettings;
  private capture: CaptureFn;
  private decode: (png: Buffer) => Promise<{ rgba: Uint8Array; width: number; height: number }>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private startedAt: number | null = null;
  private lastHash: string | null = null;
  private frames = 0;
  private changeCount = 0;
  private lastChangeAt: number | null = null;
  private paused = false;
  private pausedReason = '';
  private history: ScreenFrame[] = [];
  private listenSensitive = true;

  constructor(opts: {
    capture?: CaptureFn;
    decode?: (png: Buffer) => Promise<{ rgba: Uint8Array; width: number; height: number }>;
    settings?: Partial<ScreenSessionSettings>;
    /** tests disable the window-title tripwire (it needs the desktop bridge) */
    sensitiveCheck?: boolean;
    sensitiveProbe?: () => Promise<string | null>;
  } = {}) {
    this.settings = { ...DEFAULTS, ...opts.settings };
    this.settings.intervalMs = Math.min(Math.max(1_000, this.settings.intervalMs), 60_000);
    this.settings.threshold = Math.min(Math.max(1, this.settings.threshold), 64);
    this.settings.historyLimit = Math.min(Math.max(1, this.settings.historyLimit), 500);
    this.settings.maxMinutes = Math.min(Math.max(1, this.settings.maxMinutes), 240);
    this.capture = opts.capture ?? defaultCapture;
    this.decode = opts.decode ?? ((png) => decodePngToRgba(png));
    this.listenSensitive = opts.sensitiveCheck ?? false;
    this.sensitiveProbe = opts.sensitiveProbe ?? sensitiveWindowDetected;
  }

  private sensitiveProbe: () => Promise<string | null>;

  status(): ScreenSessionStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      frames: this.frames,
      changes: this.changeCount,
      lastChangeAt: this.lastChangeAt,
      paused: this.paused,
      pausedReason: this.pausedReason,
      settings: { ...this.settings },
      recent: this.history.slice(-20),
    };
  }

  /** Start watching. A second start is a no-op (idempotent). */
  start(): ScreenSessionStatus {
    if (this.running) return this.status();
    this.running = true;
    this.startedAt = Date.now();
    this.paused = false;
    this.pausedReason = '';
    this.lastHash = null;
    this.schedule(0);
    return this.status();
  }

  stop(reason = 'stopped by the user'): ScreenSessionStatus {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pausedReason = reason;
    return this.status();
  }

  /** One capture cycle. Public so a test (or the API) can step it manually. */
  async tick(): Promise<ScreenFrame | null> {
    if (!this.running) return null;

    if (this.startedAt && Date.now() - this.startedAt > this.settings.maxMinutes * 60_000) {
      this.stop('session time limit reached');
      return null;
    }

    if (this.listenSensitive) {
      try {
        const blocked = await this.sensitiveProbe();
        if (blocked) {
          // never look at a bank/password screen
          this.paused = true;
          this.pausedReason = `paused: sensitive window "${blocked}"`;
          return null;
        }
      } catch {
        /* the probe is best-effort */
      }
    }
    this.paused = false;

    let png: Buffer | null = null;
    try {
      const shot = await this.capture();
      png = shot?.png ?? null;
    } catch (err) {
      this.paused = true;
      this.pausedReason = `capture failed: ${err instanceof Error ? err.message : 'unknown error'}`;
      return null;
    }
    if (!png) return null;

    let hash: string;
    try {
      const { rgba, width, height } = await this.decode(png);
      hash = perceptualHash(rgba, width, height);
    } catch (err) {
      this.paused = true;
      this.pausedReason = `decode failed: ${err instanceof Error ? err.message : 'unknown error'}`;
      return null;
    }

    const distance = this.lastHash ? hammingDistance(this.lastHash, hash) : 64;
    const changed = this.lastHash === null ? true : distance >= this.settings.threshold;
    this.frames++;
    if (changed && this.lastHash !== null) {
      this.changeCount++;
      this.lastChangeAt = Date.now();
    }
    this.lastHash = hash;

    const frame: ScreenFrame = { hash, at: Date.now(), distance, changed };
    this.history.push(frame);
    if (this.history.length > this.settings.historyLimit) {
      this.history.splice(0, this.history.length - this.settings.historyLimit);
    }
    return frame;
  }

  private schedule(delay = this.settings.intervalMs): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.tick().catch(() => undefined);
      this.schedule();
    }, delay);
    // never keep the process alive just for the watcher
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
}

/** One shared watcher for the Studio process (the API routes use this). */
let shared: ScreenWatcher | null = null;

export function screenWatcher(): ScreenWatcher {
  if (!shared) shared = new ScreenWatcher({ sensitiveCheck: true });
  return shared;
}

/** Tests: replace the shared watcher. */
export function setScreenWatcher(watcher: ScreenWatcher | null): void {
  shared = watcher;
}
