// perf.ts — tiny timing collector for JARVIS latency diagnostics (Rule 8).
//
// Why this exists: "feels faster" is not evidence. Chat, TTS and the voice
// loop record marks here (client AND server safe — no dependencies, no DOM),
// and the benchmark tests + manual matrix read the numbers back out.
//
// Design constraints (low-end PC):
//   - bounded memory: a fixed-size ring buffer (oldest entries overwritten),
//   - zero cost when idle: recording one mark is a few property writes,
//   - no PII: only durations and labels are stored, never prompts or keys.

export interface PerfSample {
  /** e.g. 'chat.ttft', 'chat.total', 'tts.firstAudio', 'voice.stt' */
  label: string;
  /** milliseconds */
  ms: number;
  /** unix epoch ms when the sample was recorded */
  at: number;
}

/** hard cap on retained samples — memory cannot grow without bound */
export const PERF_BUFFER_SIZE = 300;

const buffer: PerfSample[] = [];
let dropped = 0;

/** clock indirection so tests can use fake time */
let clock: () => number = () => Date.now();
export function setPerfClock(fn: () => number): void {
  clock = fn;
}
function now(): number {
  return clock();
}

/** Record one duration sample. Never throws. */
export function perfSample(label: string, ms: number): void {
  try {
    if (!Number.isFinite(ms) || ms < 0) return;
    buffer.push({ label: String(label).slice(0, 64), ms, at: now() });
    if (buffer.length > PERF_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - PERF_BUFFER_SIZE);
      dropped++;
    }
  } catch {
    /* diagnostics must never break the app */
  }
}

/**
 * Start a stopwatch. `stop()` records the elapsed ms under `label` and
 * returns it; `elapsed()` peeks without recording (for TTFT-then-total).
 */
export function perfStart(label: string): {
  stop: () => number;
  elapsed: () => number;
} {
  const t0 = now();
  return {
    stop: () => {
      const ms = now() - t0;
      perfSample(label, ms);
      return ms;
    },
    elapsed: () => now() - t0,
  };
}

/** All samples for a label, oldest first (a copy — mutating is safe). */
export function perfSamples(label: string): number[] {
  return buffer.filter((s) => s.label === label).map((s) => s.ms);
}

/** How many samples were dropped by the ring buffer (diagnostic health). */
export function perfDropped(): number {
  return dropped;
}

/** Clear all samples (tests / manual benchmark runs). */
export function perfClear(): void {
  buffer.length = 0;
  dropped = 0;
}

export interface PerfStats {
  count: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

/** Median + P95 over a set of durations. Returns null when empty. */
export function perfStats(values: number[]): PerfStats | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const sum = sorted.reduce((n, v) => n + v, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    median: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/** Stats for one label, or null when nothing was recorded yet. */
export function perfSummary(label: string): PerfStats | null {
  return perfStats(perfSamples(label));
}

/**
 * One-line human summary, e.g. "chat.ttft n=20 median=412ms p95=890ms".
 * Used by the manual benchmark matrix and console diagnostics.
 */
export function perfLine(label: string): string {
  const s = perfSummary(label);
  if (!s) return `${label}: n=0 (no samples)`;
  const r = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
  return `${label}: n=${s.count} median=${r(s.median)}ms p95=${r(s.p95)}ms max=${r(s.max)}ms`;
}
