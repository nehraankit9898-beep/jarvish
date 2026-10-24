'use client';

// use-polling.ts — visibility-aware, non-overlapping polling.
//
// The dashboard used to run 4+ raw setIntervals that fired even with the tab
// hidden and piled up when a request was slower than the interval. On an i3
// laptop every one of those wakes the CPU, the radio and the DB for a screen
// nobody is looking at.
//
// Rules (all preserved call-site behavior, only the scheduling changes):
//   - a tick is skipped while the page is hidden (nothing to update),
//   - returning to the tab triggers ONE fresh refresh (no stale data),
//   - a tick is skipped while the previous run is still in flight (no
//     overlap pile-up when the server is slow),
//   - unmount aborts the in-flight run (all refreshers are idempotent reads).
//
// The Poller class is DOM-free (all platform bits injected) so the shipped
// scheduling logic is unit-tested; usePolling() is the thin React wrapper.

import { useEffect, useRef } from 'react';

export interface PollerOpts {
  intervalMs: number;
  run: (signal: AbortSignal) => Promise<void> | void;
  /** default: () => document.hidden (false outside a browser) */
  isHidden?: () => boolean;
  /** default true: one fresh run when the page becomes visible */
  refreshOnVisible?: boolean;
  /**
   * subscribe to visibility events; must return an unsubscribe function.
   * default: document visibilitychange listener (no-op outside a browser)
   */
  onVisible?: (cb: () => void) => () => void;
  /**
   * schedule a repeating callback; must return a cancel function.
   * default: setInterval/clearInterval
   */
  schedule?: (cb: () => void, ms: number) => () => void;
}

const defaultIsHidden = () =>
  typeof document !== 'undefined' ? document.hidden : false;

const defaultOnVisible = (cb: () => void) => {
  if (typeof document === 'undefined') return () => undefined;
  const listener = () => {
    if (!document.hidden) cb();
  };
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};

const defaultSchedule = (cb: () => void, ms: number) => {
  const t = setInterval(cb, ms);
  return () => clearInterval(t);
};

export class Poller {
  private readonly opts: PollerOpts;
  private cancelSchedule: (() => void) | null = null;
  private unsubscribeVisible: (() => void) | null = null;
  private inFlight: AbortController | null = null;
  private stopped = true;

  constructor(opts: PollerOpts) {
    this.opts = opts;
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** for tests: is a run currently in flight? */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  start(immediate = true): void {
    if (!this.stopped) return;
    this.stopped = false;
    const schedule = this.opts.schedule ?? defaultSchedule;
    if (this.opts.refreshOnVisible !== false) {
      const onVisible = this.opts.onVisible ?? defaultOnVisible;
      this.unsubscribeVisible = onVisible(() => {
        this.tick();
      });
    }
    this.cancelSchedule = schedule(() => {
      this.tick();
    }, Math.max(250, this.opts.intervalMs));
    if (immediate) this.tick();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.cancelSchedule?.();
    } catch {
      /* ignore */
    }
    try {
      this.unsubscribeVisible?.();
    } catch {
      /* ignore */
    }
    this.cancelSchedule = null;
    this.unsubscribeVisible = null;
    // unmount (or disable) ends the in-flight refresher — every call site
    // passes the signal to fetch(), and all refreshers are idempotent reads
    try {
      this.inFlight?.abort();
    } catch {
      /* ignore */
    }
    this.inFlight = null;
  }

  private tick(): void {
    if (this.stopped) return;
    const isHidden = this.opts.isHidden ?? defaultIsHidden;
    try {
      if (isHidden()) return; // hidden tab — skip, the visible event refreshes
    } catch {
      /* a throwing detector must not stop polling */
    }
    if (this.inFlight) return; // previous run still going — no pile-up
    const ctrl = new AbortController();
    this.inFlight = ctrl;
    void (async () => {
      try {
        await this.opts.run(ctrl.signal);
      } catch {
        // refreshers handle (or intentionally swallow) their own errors —
        // a failed tick must never break the schedule
      } finally {
        if (this.inFlight === ctrl) this.inFlight = null;
      }
    })();
  }
}

/**
 * Poll `run` every `intervalMs` with the Poller guarantees above.
 * `run` is read through a ref, so a changing callback never restarts the
 * schedule (passing an inline closure is safe).
 */
export function usePolling(
  run: (signal: AbortSignal) => Promise<void> | void,
  intervalMs: number,
  opts: { enabled?: boolean; immediate?: boolean } = {}
): void {
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  const enabled = opts.enabled ?? true;
  const immediate = opts.immediate ?? true;
  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    const poller = new Poller({
      intervalMs,
      run: (signal) => runRef.current(signal),
    });
    poller.start(immediate);
    return () => poller.stop();
  }, [enabled, intervalMs, immediate]);
}
