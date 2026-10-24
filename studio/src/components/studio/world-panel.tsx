'use client';

// world-panel.tsx — the World Monitor: a live 3D-look globe with geocoded
// hotspots, their categories, and the live headlines next to it.
//
// The globe is drawn with the 2D canvas API (orthographic projection, rotation
// + drag, depth culling, pulsing markers). No three.js, no WebGL context to
// lose, ~1 ms per frame on an i3 — the same constraint the reactor follows.
//
// Honesty: when an upstream is down the panel shows a banner with the reason
// instead of an empty, peaceful-looking globe.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Globe2, TriangleAlert, ExternalLink } from 'lucide-react';

type Category = 'conflict' | 'protest' | 'disaster' | 'climate' | 'economy' | 'health' | 'cyber' | 'politics' | 'other';

interface Hotspot {
  id: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  mentions: number;
  category: Category;
  severity: 'high' | 'medium' | 'low';
  sampleHeadline: string;
}

interface Headline {
  title: string;
  link: string;
  source: string;
  publishedAt: string;
}

interface WorldData {
  hotspots: Hotspot[];
  headlines: Headline[];
  counts: Record<string, number>;
  degraded: boolean;
  errors: string[];
  generatedAt: string;
  cached: boolean;
}

const CATEGORY_COLOR: Record<Category, string> = {
  conflict: '#f87171',
  protest: '#fbbf24',
  disaster: '#fb923c',
  climate: '#34d399',
  economy: '#60a5fa',
  health: '#a78bfa',
  cyber: '#22d3ee',
  politics: '#e879f9',
  other: '#94a3b8',
};

const CATEGORY_LABEL: Record<Category, string> = {
  conflict: 'Conflict',
  protest: 'Protest',
  disaster: 'Disaster',
  climate: 'Climate',
  economy: 'Economy',
  health: 'Health',
  cyber: 'Cyber',
  politics: 'Politics',
  other: 'Other',
};

interface Projected {
  x: number;
  y: number;
  z: number;
}

/** Orthographic projection of lat/lon on a sphere rotated by (rotY, tilt). */
function project(lat: number, lon: number, rotY: number, tilt: number): Projected {
  const phi = (lat * Math.PI) / 180;
  const lambda = ((lon + rotY) * Math.PI) / 180;
  const x = Math.cos(phi) * Math.sin(lambda);
  const y = Math.sin(phi);
  const z = Math.cos(phi) * Math.cos(lambda);
  const y2 = y * Math.cos(tilt) - z * Math.sin(tilt);
  const z2 = y * Math.sin(tilt) + z * Math.cos(tilt);
  return { x, y: -y2, z: z2 };
}

export function WorldPanel() {
  const [data, setData] = useState<WorldData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Hotspot | null>(null);
  const [activeCategories, setActiveCategories] = useState<Set<Category>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rotation = useRef({ y: 20, tilt: -0.35, dragging: false, lastX: 0, lastY: 0, auto: true });
  const hotspotsRef = useRef<Hotspot[]>([]);
  const hoverRef = useRef<Hotspot | null>(null);
  const selectedRef = useRef<Hotspot | null>(null);

  const load = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/world${force ? '?refresh=1' : ''}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'World monitor unavailable');
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'World monitor unavailable');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const visibleHotspots = useMemo(() => {
    if (!data) return [];
    if (!activeCategories.size) return data.hotspots;
    return data.hotspots.filter((h) => activeCategories.has(h.category));
  }, [data, activeCategories]);

  useEffect(() => {
    hotspotsRef.current = visibleHotspots;
  }, [visibleHotspots]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // ---- canvas globe -----------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    let raf = 0;
    const reduceMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      frame++;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const cx = w / 2;
      const cy = h / 2;
      const r = Math.min(w, h) * 0.42;
      const rot = rotation.current;
      if (rot.auto && !rot.dragging && !reduceMotion) rot.y += 0.12;

      ctx.clearRect(0, 0, w, h);

      // background glow
      const glow = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.5);
      glow.addColorStop(0, 'rgba(34,211,238,0.16)');
      glow.addColorStop(0.6, 'rgba(14,116,144,0.05)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // sphere
      const sphere = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
      sphere.addColorStop(0, 'rgba(8,47,73,0.95)');
      sphere.addColorStop(1, 'rgba(2,12,20,0.98)');
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = sphere;
      ctx.fill();
      ctx.strokeStyle = 'rgba(34,211,238,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // graticule
      ctx.lineWidth = 0.7;
      const drawPolyline = (points: Projected[], alpha: number) => {
        ctx.strokeStyle = `rgba(34,211,238,${alpha})`;
        let started = false;
        ctx.beginPath();
        for (const p of points) {
          if (p.z < 0) {
            started = false;
            continue;
          }
          const px = cx + p.x * r;
          const py = cy + p.y * r;
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      };

      for (let lon = -180; lon < 180; lon += 30) {
        const points: Projected[] = [];
        for (let lat = -90; lat <= 90; lat += 4) points.push(project(lat, lon, rot.y, rot.tilt));
        drawPolyline(points, 0.12);
      }
      for (let lat = -60; lat <= 60; lat += 30) {
        const points: Projected[] = [];
        for (let lon = -180; lon <= 180; lon += 4) points.push(project(lat, lon, rot.y, rot.tilt));
        drawPolyline(points, lat === 0 ? 0.28 : 0.12);
      }

      // hotspots
      const pulse = (Math.sin(frame / 22) + 1) / 2;
      for (const hotspot of hotspotsRef.current) {
        const p = project(hotspot.lat, hotspot.lon, rot.y, rot.tilt);
        if (p.z <= 0) continue;
        const px = cx + p.x * r;
        const py = cy + p.y * r;
        const size = Math.min(7, 2.4 + Math.log10(hotspot.mentions + 1) * 2);
        const color = CATEGORY_COLOR[hotspot.category] ?? CATEGORY_COLOR.other;
        const isSelected = selectedRef.current?.id === hotspot.id;
        const isHovered = hoverRef.current?.id === hotspot.id;

        if (hotspot.severity === 'high' || isSelected) {
          ctx.beginPath();
          ctx.arc(px, py, size + 3 + pulse * 4, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.16 + pulse * 0.12;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        ctx.arc(px, py, isHovered || isSelected ? size + 1.5 : size, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.55 + p.z * 0.45;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (isSelected) {
          ctx.beginPath();
          ctx.arc(px, py, size + 5, 0, Math.PI * 2);
          ctx.strokeStyle = '#e2f7ff';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }

      // selected label
      const sel = selectedRef.current;
      if (sel) {
        const p = project(sel.lat, sel.lon, rot.y, rot.tilt);
        if (p.z > 0) {
          const px = cx + p.x * r;
          const py = cy + p.y * r;
          const label = `${sel.name}${sel.country ? ` · ${sel.country}` : ''}`;
          ctx.font = '11px ui-monospace, monospace';
          const width = ctx.measureText(label).width + 14;
          ctx.fillStyle = 'rgba(2,12,20,0.85)';
          ctx.strokeStyle = 'rgba(34,211,238,0.6)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(px - width / 2, py - 30, width, 18, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#cffafe';
          ctx.textAlign = 'center';
          ctx.fillText(label, px, py - 17);
          ctx.textAlign = 'left';
        }
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    // ---- interaction ----------------------------------------------------
    const toLocal = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top, w: rect.width, h: rect.height };
    };
    const hitTest = (x: number, y: number, w: number, h: number) => {
      const cx = w / 2;
      const cy = h / 2;
      const r = Math.min(w, h) * 0.42;
      const rot = rotation.current;
      let best: { hotspot: Hotspot; dist: number } | null = null;
      for (const hotspot of hotspotsRef.current) {
        const p = project(hotspot.lat, hotspot.lon, rot.y, rot.tilt);
        if (p.z <= 0) continue;
        const px = cx + p.x * r;
        const py = cy + p.y * r;
        const dist = Math.hypot(px - x, py - y);
        if (dist <= 12 && (!best || dist < best.dist)) best = { hotspot, dist };
      }
      return best?.hotspot ?? null;
    };

    const onPointerDown = (event: PointerEvent) => {
      rotation.current.dragging = true;
      rotation.current.lastX = event.clientX;
      rotation.current.lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const rot = rotation.current;
      if (rot.dragging) {
        rot.y += (event.clientX - rot.lastX) * 0.4;
        rot.tilt = Math.max(-1.2, Math.min(1.2, rot.tilt + (event.clientY - rot.lastY) * 0.005));
        rot.lastX = event.clientX;
        rot.lastY = event.clientY;
        return;
      }
      const { x, y, w, h } = toLocal(event);
      hoverRef.current = hitTest(x, y, w, h);
      canvas.style.cursor = hoverRef.current ? 'pointer' : 'grab';
    };
    const onPointerUp = (event: PointerEvent) => {
      rotation.current.dragging = false;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* pointer already released */
      }
      const { x, y, w, h } = toLocal(event);
      const hit = hitTest(x, y, w, h);
      setSelected(hit);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  const toggleCategory = (category: Category) => {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const categories = (data?.counts ? Object.keys(data.counts) : []) as Category[];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Globe2 className="h-5 w-5 text-cyan-400" /> World Monitor
            </h2>
            <p className="text-sm text-zinc-400 mt-1">
              Live geocoded events (GDELT, last 24 h) + headlines. Globe ko drag karke ghumao, dot par click
              karke detail dekho.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data ? (
              <Badge variant="outline" className="border-zinc-700 text-zinc-400 font-mono text-[10px]">
                {data.cached ? 'cached' : 'live'} · {new Date(data.generatedAt).toLocaleTimeString()}
              </Badge>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
        </header>

        {data?.degraded ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex gap-2">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            <span>
              Partial data — {data.errors.join(' · ')}. Jo dikh raha hai wahi real hai; baaki unavailable hai.
            </span>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        ) : null}

        <div className="grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-4">
          {/* globe */}
          <section className="rounded-xl border border-cyan-500/20 bg-[rgba(4,12,20,0.8)] overflow-hidden">
            <canvas
              ref={canvasRef}
              className="w-full block touch-none"
              style={{ height: 420, cursor: 'grab' }}
              aria-label="World globe with live event hotspots"
              role="img"
            />
            <div className="px-3 py-2 border-t border-cyan-500/15 flex flex-wrap gap-1.5">
              {categories.length === 0 ? (
                <span className="text-[11px] text-zinc-500">No hotspots in the last 24 hours.</span>
              ) : (
                categories.map((category) => {
                  const active = !activeCategories.size || activeCategories.has(category);
                  return (
                    <button
                      key={category}
                      onClick={() => toggleCategory(category)}
                      className={`text-[11px] rounded-full border px-2 py-0.5 transition-opacity ${
                        active ? 'opacity-100' : 'opacity-40'
                      }`}
                      style={{ borderColor: CATEGORY_COLOR[category], color: CATEGORY_COLOR[category] }}
                      aria-pressed={active}
                    >
                      {CATEGORY_LABEL[category]} · {data?.counts[category] ?? 0}
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {/* detail + headlines */}
          <div className="space-y-4 min-w-0">
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <h3 className="text-sm font-semibold text-zinc-200 mb-2">
                {selected ? selected.name : 'Selected hotspot'}
              </h3>
              {selected ? (
                <div className="space-y-1.5 text-xs text-zinc-400">
                  <p>
                    <span className="text-zinc-500">Country:</span> {selected.country || '—'}
                  </p>
                  <p>
                    <span className="text-zinc-500">Category:</span>{' '}
                    <span style={{ color: CATEGORY_COLOR[selected.category] }}>
                      {CATEGORY_LABEL[selected.category]}
                    </span>
                  </p>
                  <p>
                    <span className="text-zinc-500">Mentions (24 h):</span> {selected.mentions} ·{' '}
                    <span className="uppercase">{selected.severity}</span>
                  </p>
                  <p className="font-mono text-[11px] text-zinc-500">
                    {selected.lat.toFixed(2)}, {selected.lon.toFixed(2)}
                  </p>
                  {selected.sampleHeadline ? (
                    <a
                      href={selected.sampleHeadline}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-cyan-300 hover:underline break-all"
                    >
                      <ExternalLink className="h-3 w-3 shrink-0" /> source article
                    </a>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-zinc-500">Globe par kisi dot par click karo.</p>
              )}
            </section>

            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <h3 className="text-sm font-semibold text-zinc-200 mb-3">Live headlines</h3>
              {loading ? (
                <p className="text-xs text-zinc-500">Loading…</p>
              ) : (data?.headlines.length ?? 0) === 0 ? (
                <p className="text-xs text-zinc-500">No headlines available right now.</p>
              ) : (
                <ul className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
                  {data!.headlines.map((item) => (
                    <li key={item.link + item.title} className="text-xs leading-snug">
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noreferrer"
                        className="text-zinc-200 hover:text-cyan-300 hover:underline"
                      >
                        {item.title}
                      </a>
                      <span className="text-zinc-500 ml-1">
                        {item.source}
                        {item.publishedAt ? ` · ${new Date(item.publishedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
