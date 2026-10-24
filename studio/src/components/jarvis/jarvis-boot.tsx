'use client';

/**
 * JarvisBoot — full-screen initialization sequence (JARVIS-v3 style).
 *
 * The staged boot lines are REAL check results (health, system status,
 * provider uplink) fetched live — no fake progress. Shown once per browser
 * session (sessionStorage), skippable with Esc / Skip. Honors reduced motion.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { JarvisReactor } from './jarvis-reactor';

interface BootLine {
  text: string;
  tone: 'dim' | 'ok' | 'bad';
}

const CHECK_STAGES: Array<{ label: string; run: () => Promise<string> }> = [
  {
    label: 'Core systems',
    run: async () => {
      const r = await fetch('/api/health');
      if (!r.ok) throw new Error(`health HTTP ${r.status}`);
      const h = (await r.json()) as { status: string; checks?: { database?: { latencyMs?: number } } };
      return `core ${h.status} · db ${h.checks?.database?.latencyMs ?? '?'}ms`;
    },
  },
  {
    label: 'Engine runtime',
    run: async () => {
      const r = await fetch('/api/system/status');
      if (!r.ok) throw new Error(`system HTTP ${r.status}`);
      const s = (await r.json()) as {
        database?: { counts?: Record<string, number> };
        python?: { ok: boolean; agentscope?: string | null };
        tools?: { total: number; healthy: number };
      };
      const py = s.python?.ok ? `agentscope v${s.python.agentscope}` : 'node engine';
      return `${py} · ${s.database?.counts?.tasks ?? 0} tasks · ${s.tools?.healthy ?? 0}/${s.tools?.total ?? 0} tools`;
    },
  },
  {
    label: 'Provider uplink',
    run: async () => {
      const r = await fetch('/api/providers');
      if (!r.ok) throw new Error(`providers HTTP ${r.status}`);
      const p = (await r.json()) as { providers?: Array<{ enabled: boolean; name: string; lastTestOk: boolean | null; hasKey: boolean }> };
      const enabled = (p.providers ?? []).filter((x) => x.enabled);
      const ok = enabled.filter((x) => x.lastTestOk !== false).length;
      return `${ok}/${enabled.length} enabled providers ready`;
    },
  },
];

export function JarvisBoot({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<'ready' | 'booting' | 'done'>('ready');
  const [lines, setLines] = useState<BootLine[]>([]);
  const timerRefs = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const finish = useCallback(() => {
    timerRefs.current.forEach(clearTimeout);
    try {
      window.sessionStorage.setItem('jarvis-booted', '1');
    } catch {
      /* private mode */
    }
    onDone();
  }, [onDone]);

  const runBoot = useCallback(async () => {
    setPhase('booting');
    const push = (line: BootLine) => setLines((prev) => [...prev, line]);
    push({ text: 'JARVIS v3 core loading…', tone: 'dim' });
    for (const stage of CHECK_STAGES) {
      await new Promise((res) => {
        timerRefs.current.push(setTimeout(res, 420));
      });
      try {
        const detail = await stage.run();
        push({ text: `✓ ${stage.label}: ${detail}`, tone: 'ok' });
      } catch (e) {
        push({ text: `✗ ${stage.label}: ${e instanceof Error ? e.message : 'failed'}`, tone: 'bad' });
      }
    }
    await new Promise((res) => {
      timerRefs.current.push(setTimeout(res, 500));
    });
    setPhase('done');
    timerRefs.current.push(setTimeout(finish, 650));
  }, [finish]);

  // keeps the Esc handler valid without re-running its effect on every render
  // (the studio clock re-renders the parent every second)
  const finishRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  useEffect(() => {
    // ref-stabilized: this effect must be mount-only. Clearing the boot
    // timers on every re-run would deadlock the sequence.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finishRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center bg-[#020509]"
      role="dialog"
      aria-label="JARVIS initialization"
    >
      <div className="absolute inset-0 pointer-events-none">
        <JarvisReactor state={phase === 'booting' ? 'thinking' : 'idle'} className="absolute inset-0 opacity-70" />
        <div className="absolute inset-0 jv-scanlines" />
        <div className="absolute inset-0 jv-vignette" />
      </div>

      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        <h1 className="jv-brand text-2xl sm:text-4xl text-cyan-200 mb-1.5">J.A.R.V.I.S</h1>
        <p className="jv-hud-label mb-6">AGENTSCOPE STUDIO · COMMAND CORE v3</p>

        <div className="min-h-24 w-full max-w-md text-left font-mono text-[11px] space-y-1 mb-8" aria-live="polite">
          {lines.map((l, i) => (
            <p
              key={i}
              className={`jv-anim-fade-up ${
                l.tone === 'ok' ? 'text-emerald-300' : l.tone === 'bad' ? 'text-red-300' : 'text-zinc-500'
              }`}
            >
              {l.text}
            </p>
          ))}
        </div>

        {phase === 'ready' && (
          <button
            onClick={runBoot}
            className="rounded-full px-10 py-3 text-sm font-bold tracking-[0.35em] text-[#021018] bg-gradient-to-b from-[#6fe8ff] to-[#1fd4ff] shadow-[0_0_30px_rgba(31,212,255,0.45)] hover:shadow-[0_0_45px_rgba(31,212,255,0.65)] transition-shadow"
          >
            INITIALIZE
          </button>
        )}
        {phase === 'booting' && (
          <p className="text-xs font-mono text-cyan-300 jv-anim-blink">RUNNING SYSTEM CHECKS…</p>
        )}
        {phase === 'done' && <p className="text-xs font-mono text-emerald-300">ALL SYSTEMS NOMINAL</p>}

        <button
          onClick={finish}
          className="mt-6 text-[10px] font-mono uppercase tracking-[0.25em] text-zinc-600 hover:text-zinc-400"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
