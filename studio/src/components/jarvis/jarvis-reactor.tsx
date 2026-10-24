'use client';

/**
 * JarvisReactor — the central holographic arc reactor.
 *
 * Faithful 2D-canvas port of the JARVIS-v3 WebGL scene (glow halo, fresnel
 * core, 4 gyro rings, 2 dashed tick rings, 3 HUD arcs, dust particles, floor
 * hologram) with the same state-color model:
 *   idle #1fd4ff · listening #38ffb0 · thinking #ffc247 · speaking #9fe8ff ·
 *   error #ff7b7b — all colors lerp toward their target each frame (0.06).
 *
 * Deliberately NO 3D library (task constraint: lightweight canvas). One RAF
 * loop, zero React re-renders per frame, DPR-capped, pauses when the tab is
 * hidden, honors prefers-reduced-motion (renders static color-correct frames).
 *
 * This visualizer never opens a microphone. An optional shared audioLevel
 * may be supplied by the audio owner; otherwise the pulse is decorative.
 */

import { useEffect, useRef } from 'react';

export type JarvisVisualState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

type RGB = [number, number, number];

const STATE_COLORS: Record<JarvisVisualState, RGB> = {
  idle: [0x1f, 0xd4, 0xff],
  listening: [0x38, 0xff, 0xb0],
  thinking: [0xff, 0xc2, 0x47],
  speaking: [0x9f, 0xe8, 0xff],
  error: [0xff, 0x7b, 0x7b],
};

const CORE_TINT: RGB = [0xdf, 0xfa, 0xff];

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function rgba(c: RGB, a: number) {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
}

interface Particle {
  r: number; // orbital radius (×R)
  a: number; // start angle
  speed: number;
  size: number;
  alpha: number;
  flat: number; // y-flatten for pseudo-3D shell
}

const PARTICLES: Particle[] = Array.from({ length: 60 }, (_, i) => ({
  r: 2.0 + ((i * 7919) % 1000) / 1000 * 4.2,
  a: ((i * 3571) % 628) / 100,
  speed: 0.02 + (((i * 104729) % 100) / 100) * 0.05,
  size: 0.6 + (((i * 7919) % 100) / 100) * 1.6,
  alpha: 0.15 + (((i * 1299709) % 100) / 100) * 0.5,
  flat: 0.62,
}));

export function JarvisReactor({
  state,
  className,
  audioLevel = 0,
}: {
  state: JarvisVisualState;
  className?: string;
  audioLevel?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<JarvisVisualState>(state);

  const redrawRef = useRef<(() => void) | null>(null);
  const micLevelRef = useRef(0);
  useEffect(() => {
    stateRef.current = state;
    micLevelRef.current = Number.isFinite(audioLevel) ? Math.max(0, Math.min(1, audioLevel)) : 0;
    redrawRef.current?.();
  }, [state, audioLevel]);

  // ---- the single render loop ---------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = motionQuery.matches;

    let raf = 0;
    let running = true;
    let width = 0;
    let height = 0;
    const dpr = Math.min(1.25, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

    // current interpolated color + energy (persist across frames)
    let cur: RGB = [...STATE_COLORS[stateRef.current]] as RGB;
    let energy = 0.16;
    const start = performance.now();

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      width = parent.clientWidth;
      height = parent.clientHeight;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      redrawRef.current?.();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement ?? canvas);

    const drawFrame = (tSec: number) => {
      const st = stateRef.current;
      const target = STATE_COLORS[st];

      // color lerp (reference: 0.06 per frame)
      cur = reducedMotion ? [...target] as RGB : [
        lerp(cur[0], target[0], 0.06),
        lerp(cur[1], target[1], 0.06),
        lerp(cur[2], target[2], 0.06),
      ] as RGB;

      const mic = micLevelRef.current;

      // speech throb (reference formula)
      const resp =
        st === 'speaking'
          ? Math.max(0, Math.min(1, 0.5 + 0.3 * Math.sin(tSec * 16.4) + 0.2 * Math.sin(tSec * 27.7 + 1.3)))
          : 0;

      let targetEnergy = 0.16;
      if (st === 'speaking') targetEnergy = 0.95;
      else if (st === 'listening') targetEnergy = Math.max(0.45, 0.35 + mic * 0.75);
      else if (st === 'thinking') targetEnergy = 0.48;
      else if (st === 'error') targetEnergy = 0.7;
      energy = lerp(energy, targetEnergy, 0.06);

      const W = width;
      const H = height;
      const cx = W / 2;
      const cy = H * 0.46;
      const R = Math.min(W, H) * 0.26;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';

      // ambient halo
      const haloR = R * 3.1;
      const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, haloR);
      halo.addColorStop(0, rgba(cur, 0.16 + energy * 0.12));
      halo.addColorStop(0.55, rgba(cur, 0.05 + energy * 0.04));
      halo.addColorStop(1, rgba(cur, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(cx - haloR, cy - haloR, haloR * 2, haloR * 2);

      // dust shell — static positions, whole group slowly rotates
      const dustRot = tSec * 0.02;
      for (const p of PARTICLES) {
        const a = p.a + dustRot * p.speed * 10;
        const x = cx + Math.cos(a) * p.r * R * 0.55;
        const y = cy + Math.sin(a) * p.r * R * 0.55 * p.flat;
        const tw = 0.6 + 0.4 * Math.sin(tSec * 2 + p.a * 7);
        ctx.fillStyle = rgba([0x63, 0xd9, 0xff], p.alpha * tw * 0.5);
        ctx.beginPath();
        ctx.arc(x, y, p.size * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.lineCap = 'round';

      // outer HUD arcs (3, different radii/speeds/directions)
      const arcs: Array<[number, number, number, number]> = [
        [1.98, 0.9, 0.2, 1], // [radius×R, sweep, speed, dir]
        [2.14, 0.55, 0.13, -1],
        [2.42, 1.25, 0.075, 1],
      ];
      for (const [rr, sweep, speed, dir] of arcs) {
        const a0 = tSec * speed * (1 + energy * 2.4) * dir;
        ctx.beginPath();
        ctx.arc(cx, cy, rr * R, a0, a0 + sweep);
        ctx.strokeStyle = rgba(cur, 0.5);
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      // dashed tick rings (2, counter-rotating) — reference: 72 + 44 ticks
      const tickRing = (
        radius: number,
        count: number,
        speed: number,
        len: number,
        alpha: number,
      ) => {
        const rot = tSec * speed * (1 + energy * 3);
        // constant per ring — hoisted (was: 116 style allocs per frame)
        ctx.strokeStyle = rgba(cur, alpha);
        ctx.lineWidth = 1.4;
        for (let i = 0; i < count; i++) {
          const a = rot + (i / count) * Math.PI * 2;
          const x1 = cx + Math.cos(a) * radius * R;
          const y1 = cy + Math.sin(a) * radius * R;
          const x2 = cx + Math.cos(a) * (radius + len) * R;
          const y2 = cy + Math.sin(a) * (radius + len) * R;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      };
      tickRing(1.72, 72, 0.14, 0.045, 0.4);
      tickRing(2.3, 44, -0.1, 0.06, 0.28);

      // 4 gyro rings — tumbling ellipses (pseudo-3D via animated radiusY + rotation)
      const gyros: Array<[number, number, number]> = [
        [1.32, 0.42, 1],
        [1.58, -0.3, 1.6],
        [1.86, 0.22, 2.3],
        [2.16, -0.16, 3.1],
      ]; // [radius×R, phase, speed]
      for (const [rr, phase, speed] of gyros) {
        const spin = tSec * 0.35 * speed * (1 + energy * 2.2) + phase * 4;
        const squash = 0.3 + 0.32 * Math.sin(tSec * 0.7 * speed + phase * 2.4);
        ctx.beginPath();
        ctx.ellipse(
          cx,
          cy,
          rr * R,
          rr * R * Math.abs(squash) + R * 0.06,
          spin * 0.35,
          0,
          Math.PI * 1.65,
        );
        ctx.strokeStyle = rgba(cur, 0.34);
        ctx.lineWidth = 1.3;
        ctx.stroke();
      }

      // fresnel ring (bright rim)
      ctx.beginPath();
      ctx.arc(cx, cy, 0.84 * R, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(cur, 0.55 + energy * 0.25);
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // waveform ring while listening — real mic amplitude bumps
      if (st === 'listening') {
        ctx.beginPath();
        const steps = 72;
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const amp =
            R * 0.06 * (0.4 + 0.6 * Math.sin(a * 5 + tSec * 6)) * (0.25 + mic * 1.4);
          const rr = 1.06 * R + amp;
          const x = cx + Math.cos(a) * rr;
          const y = cy + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = rgba(cur, 0.45);
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // core — layered radial gradients (fresnel sphere + bright nucleus)
      const pulse = 0.86 + 0.14 * Math.sin(tSec * 2.1);
      const coreR =
        R * (0.6 + 0.05 * pulse + resp * 0.14 + mic * 0.18 + (st === 'error' ? 0.05 : 0));
      const core = ctx.createRadialGradient(cx, cy, coreR * 0.1, cx, cy, coreR);
      core.addColorStop(0, rgba(CORE_TINT, 0.9));
      core.addColorStop(0.35, rgba(cur, 0.5 + energy * 0.2));
      core.addColorStop(0.8, rgba(cur, 0.14));
      core.addColorStop(1, rgba(cur, 0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      const nucleusR = R * (0.3 + resp * 0.1 + mic * 0.08);
      const nucleus = ctx.createRadialGradient(cx, cy, 1, cx, cy, nucleusR);
      nucleus.addColorStop(0, rgba(CORE_TINT, 0.98));
      nucleus.addColorStop(0.7, rgba(cur, 0.75));
      nucleus.addColorStop(1, rgba(cur, 0));
      ctx.fillStyle = nucleus;
      ctx.beginPath();
      ctx.arc(cx, cy, nucleusR, 0, Math.PI * 2);
      ctx.fill();

      // floor hologram — ellipse ring + ticks (the "grid floor")
      const fy = H * 0.9;
      const fRx = R * 2.6;
      const fRy = R * 0.5;
      ctx.strokeStyle = rgba(cur, 0.3);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(cx, fy, fRx, fRy, 0, 0, Math.PI * 2);
      ctx.stroke();
      const fRot = tSec * 0.1;
      ctx.strokeStyle = rgba(cur, 0.22);
      ctx.lineWidth = 1;
      for (let i = 0; i < 36; i++) {
        const a = fRot + (i / 36) * Math.PI * 2;
        const x = cx + Math.cos(a) * fRx * 1.06;
        const y = fy + Math.sin(a) * fRy * 1.06;
        const x2 = cx + Math.cos(a) * fRx * 1.14;
        const y2 = fy + Math.sin(a) * fRy * 1.14;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      ctx.globalCompositeOperation = 'source-over';
    };

    let lastFrame = -Infinity;
    const loop = (now: number) => {
      if (!running) return;
      if (now - lastFrame >= 1000 / 30) {
        drawFrame((now - start) / 1000);
        lastFrame = now;
      }
      raf = requestAnimationFrame(loop);
    };

    redrawRef.current = () => { if (reducedMotion) drawFrame(0); };
    if (reducedMotion) {
      drawFrame(0);
    } else {
      raf = requestAnimationFrame(loop);
    }

    const onVisibility = () => {
      if (reducedMotion) return;
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(loop);
      }
    };
    const onMotionChange = () => {
      reducedMotion = motionQuery.matches;
      cancelAnimationFrame(raf);
      running = !document.hidden;
      if (reducedMotion) drawFrame(0);
      else if (running) raf = requestAnimationFrame(loop);
    };
    motionQuery.addEventListener('change', onMotionChange);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      redrawRef.current = null;
      motionQuery.removeEventListener('change', onMotionChange);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      data-jarvis-reactor=""
    />
  );
}
