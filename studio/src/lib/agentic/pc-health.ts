// pc-health.ts — "PC slow kyun hai?" with an actual answer.
//
// The Studio could already read CPU/RAM/disk NUMBERS (desktop-system-info), but
// a number is not a diagnosis. This module turns a snapshot into ranked,
// actionable findings with a deterministic rule set — no LLM call, so the same
// input always produces the same verdict and it can be unit-tested.
//
// Everything here is READ-ONLY. The snapshot is collected from `node:os` plus
// a fixed, non-interpolated command (`ps` / `tasklist` / `wmic`); no user text
// ever reaches a shell, so there is nothing to inject.

import os from 'os';
import { execFile } from 'child_process';

export interface PcProcess {
  name: string;
  cpuPct: number | null;
  memMb: number | null;
}

export interface PcDisk {
  mount: string;
  totalGb: number;
  freeGb: number;
}

export interface PcSnapshot {
  platform: string;
  arch: string;
  uptimeHours: number;
  cpu: { model: string; cores: number; loadPct: number | null };
  memory: { totalMb: number; freeMb: number };
  disks: PcDisk[];
  processes: PcProcess[];
  capturedAt: string;
}

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  /** what is wrong, in one line */
  title: string;
  /** why it matters, with the numbers */
  detail: string;
  /** the concrete thing the user should do */
  action: string;
}

export interface PcDiagnosis {
  /** 0 (unusable) … 100 (healthy) */
  score: number;
  verdict: string;
  findings: Finding[];
  snapshot: PcSnapshot;
}

const round = (n: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

function usedMemoryPct(snapshot: PcSnapshot): number {
  const { totalMb, freeMb } = snapshot.memory;
  if (!totalMb || totalMb <= 0) return 0;
  return ((totalMb - Math.max(0, freeMb)) / totalMb) * 100;
}

/**
 * Turn a snapshot into findings. Ordered by severity, then by impact.
 * Pure — this is the part the tests pin down.
 */
export function analyzePcHealth(snapshot: PcSnapshot): PcDiagnosis {
  const findings: Finding[] = [];
  const memUsed = usedMemoryPct(snapshot);

  // ---- memory -----------------------------------------------------------
  if (memUsed >= 90) {
    findings.push({
      severity: 'critical',
      title: 'RAM almost full',
      detail: `${round(memUsed)}% of ${round(snapshot.memory.totalMb / 1024)} GB is in use — Windows starts paging to disk, which is the classic "sab kuch atak raha hai" feeling.`,
      action: 'Close the biggest browser tabs / apps, or add RAM. Check the list below for the top memory hog.',
    });
  } else if (memUsed >= 80) {
    findings.push({
      severity: 'warning',
      title: 'RAM is under pressure',
      detail: `${round(memUsed)}% of ${round(snapshot.memory.totalMb / 1024)} GB is in use.`,
      action: 'Close what you are not using before opening another heavy app (IDE, browser, VM).',
    });
  }

  // ---- CPU load ---------------------------------------------------------
  if (snapshot.cpu.loadPct !== null) {
    if (snapshot.cpu.loadPct >= 150) {
      findings.push({
        severity: 'critical',
        title: 'CPU is overloaded',
        detail: `Load is ${round(snapshot.cpu.loadPct)}% of ${snapshot.cpu.cores} cores — the machine is queuing work, not doing it.`,
        action: 'Find the top CPU process below and close it; a build/indexing job left running is the usual cause.',
      });
    } else if (snapshot.cpu.loadPct >= 90) {
      findings.push({
        severity: 'warning',
        title: 'CPU is busy',
        detail: `Load is ${round(snapshot.cpu.loadPct)}% of ${snapshot.cpu.cores} cores.`,
        action: 'If the machine feels slow right now, wait for the current job to finish or pause it.',
      });
    }
  }

  // ---- disk -------------------------------------------------------------
  for (const disk of snapshot.disks) {
    if (!disk.totalGb) continue;
    const freePct = (disk.freeGb / disk.totalGb) * 100;
    if (freePct < 5 || disk.freeGb < 2) {
      findings.push({
        severity: 'critical',
        title: `Disk ${disk.mount} is nearly full`,
        detail: `Only ${round(disk.freeGb)} GB free of ${round(disk.totalGb)} GB (${round(freePct)}%). Windows slows down badly and updates fail below a few GB.`,
        action: 'Empty Downloads / Recycle Bin, or run Disk Cleanup. The Studio can list the Downloads folder for you.',
      });
    } else if (freePct < 12) {
      findings.push({
        severity: 'warning',
        title: `Disk ${disk.mount} is filling up`,
        detail: `${round(disk.freeGb)} GB free of ${round(disk.totalGb)} GB (${round(freePct)}%).`,
        action: 'Clear old downloads and caches before it becomes a problem.',
      });
    }
  }

  // ---- individual processes --------------------------------------------
  const cpuHogs = snapshot.processes
    .filter((p) => (p.cpuPct ?? 0) >= 40)
    .sort((a, b) => (b.cpuPct ?? 0) - (a.cpuPct ?? 0));
  if (cpuHogs.length) {
    const top = cpuHogs[0];
    findings.push({
      severity: (top.cpuPct ?? 0) >= 80 ? 'critical' : 'warning',
      title: `"${top.name}" is using ${round(top.cpuPct ?? 0)}% CPU`,
      detail:
        cpuHogs.length > 1
          ? `Other heavy processes: ${cpuHogs.slice(1, 4).map((p) => `${p.name} (${round(p.cpuPct ?? 0)}%)`).join(', ')}.`
          : 'A single process is responsible for most of the load.',
      action: 'Close or restart that app. If it is a background updater, let it finish once.',
    });
  }

  const memHogs = snapshot.processes
    .filter((p) => (p.memMb ?? 0) >= 1500)
    .sort((a, b) => (b.memMb ?? 0) - (a.memMb ?? 0));
  if (memHogs.length && memUsed >= 75) {
    const top = memHogs[0];
    findings.push({
      severity: 'warning',
      title: `"${top.name}" holds ${round((top.memMb ?? 0) / 1024)} GB of RAM`,
      detail: `Largest memory consumer while RAM is ${round(memUsed)}% full.`,
      action: 'Restart that app — browsers and Electron apps leak memory over long sessions.',
    });
  }

  // ---- uptime -----------------------------------------------------------
  if (snapshot.uptimeHours >= 24 * 7) {
    findings.push({
      severity: 'info',
      title: 'Long uptime',
      detail: `This machine has been running for ${round(snapshot.uptimeHours / 24)} days.`,
      action: 'A restart clears leaked memory and pending updates — worth doing once a week.',
    });
  }

  // ---- score ------------------------------------------------------------
  let score = 100;
  for (const f of findings) {
    score -= f.severity === 'critical' ? 30 : f.severity === 'warning' ? 12 : 3;
  }
  score = Math.max(0, Math.min(100, score));

  const verdict =
    score >= 85
      ? 'Healthy — nothing is holding the machine back right now.'
      : score >= 60
        ? 'Okay, but there are a few things worth cleaning up.'
        : score >= 35
          ? 'Sluggish — the items below explain most of the slowdown.'
          : 'Struggling — fix the critical items first.';

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return { score, verdict, findings, snapshot };
}

// ---------------------------------------------------------------------------
// collection
// ---------------------------------------------------------------------------

type Runner = (file: string, args: string[]) => Promise<string>;

const defaultRunner: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout ?? ''));
    });
  });

function cpuLoadPct(cores: number): number | null {
  try {
    const [one, five, fifteen] = os.loadavg();
    if (!Number.isFinite(one)) return null;
    // Windows reports 0,0,0 from os.loadavg(); treat that as "unknown" rather
    // than claiming a perfectly idle machine
    if (one === 0 && five === 0 && fifteen === 0) return null;
    return (one / Math.max(1, cores)) * 100;
  } catch {
    return null;
  }
}

/** Parse `ps -A -o %cpu=,rss=,comm=` into the top processes. */
export function parsePsOutput(output: string, limit = 8): PcProcess[] {
  const rows: PcProcess[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    rows.push({
      name: (m[3].split('/').pop() ?? m[3]).slice(0, 60),
      cpuPct: Number(m[1]),
      memMb: Number(m[2]) / 1024,
    });
  }
  rows.sort((a, b) => (b.cpuPct ?? 0) - (a.cpuPct ?? 0));
  return rows.slice(0, limit);
}

/** Parse `tasklist /fo csv /nh` into the top processes (no CPU column there). */
export function parseTasklistOutput(output: string, limit = 8): PcProcess[] {
  const rows: PcProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1));
    if (!parts || parts.length < 5) continue;
    const memText = parts[4].replace(/[^\d]/g, '');
    const memKb = Number(memText);
    if (!Number.isFinite(memKb)) continue;
    rows.push({ name: parts[0].slice(0, 60), cpuPct: null, memMb: memKb / 1024 });
  }
  rows.sort((a, b) => (b.memMb ?? 0) - (a.memMb ?? 0));
  return rows.slice(0, limit);
}

/** Parse `df -kP` into disks (skipping pseudo filesystems). */
export function parseDfOutput(output: string): PcDisk[] {
  const disks: PcDisk[] = [];
  for (const line of output.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const totalKb = Number(cols[1]);
    const freeKb = Number(cols[3]);
    const mount = cols[5];
    if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb) || !totalKb) continue;
    if (/^(tmpfs|devtmpfs|overlay|shm|udev)$/.test(cols[0])) continue;
    if (mount.startsWith('/sys') || mount.startsWith('/proc') || mount.startsWith('/dev')) continue;
    disks.push({ mount, totalGb: totalKb / 1024 / 1024, freeGb: freeKb / 1024 / 1024 });
  }
  // the root filesystem first, then the biggest ones
  disks.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : b.totalGb - a.totalGb));
  return disks.slice(0, 4);
}

/**
 * Collect a real snapshot. Every command is a fixed constant and any failure
 * degrades to "unknown" instead of throwing — a diagnosis must still work on a
 * locked-down machine.
 */
export async function collectPcSnapshot(opts: { runner?: Runner } = {}): Promise<PcSnapshot> {
  const runner = opts.runner ?? defaultRunner;
  const cpus = os.cpus();
  const cores = Math.max(1, cpus.length);
  const totalMb = os.totalmem() / 1024 / 1024;
  const freeMb = os.freemem() / 1024 / 1024;

  let processes: PcProcess[] = [];
  try {
    if (process.platform === 'win32') {
      processes = parseTasklistOutput(await runner('tasklist', ['/fo', 'csv', '/nh']));
    } else {
      processes = parsePsOutput(await runner('ps', ['-A', '-o', '%cpu=,rss=,comm=']));
    }
  } catch {
    processes = [];
  }

  let disks: PcDisk[] = [];
  try {
    if (process.platform === 'win32') {
      const out = await runner('wmic', ['logicaldisk', 'get', 'DeviceID,Size,FreeSpace', '/format:csv']);
      for (const line of out.split(/\r?\n/)) {
        const cols = line.split(',');
        if (cols.length < 4) continue;
        const size = Number(cols[1]);
        const free = Number(cols[2]);
        const mount = cols[3]?.trim();
        if (!mount || !Number.isFinite(size) || !size) continue;
        disks.push({ mount, totalGb: size / 1e9, freeGb: (Number.isFinite(free) ? free : 0) / 1e9 });
      }
    } else {
      disks = parseDfOutput(await runner('df', ['-kP']));
    }
  } catch {
    disks = [];
  }

  return {
    platform: process.platform,
    arch: process.arch,
    uptimeHours: os.uptime() / 3600,
    cpu: { model: cpus[0]?.model?.trim() ?? 'unknown', cores, loadPct: cpuLoadPct(cores) },
    memory: { totalMb, freeMb },
    disks,
    processes,
    capturedAt: new Date().toISOString(),
  };
}

/** Snapshot + analysis in one call (what the tool and the API route use). */
export async function diagnosePc(opts: { runner?: Runner } = {}): Promise<PcDiagnosis> {
  return analyzePcHealth(await collectPcSnapshot(opts));
}

/** A short, human summary (used in notifications and the tool result). */
export function summarizeDiagnosis(diagnosis: PcDiagnosis): string {
  const counts = diagnosis.findings.reduce(
    (acc, f) => ({ ...acc, [f.severity]: acc[f.severity] + 1 }),
    { critical: 0, warning: 0, info: 0 } as Record<Severity, number>
  );
  const head = `PC health ${diagnosis.score}/100 — ${diagnosis.verdict}`;
  if (!diagnosis.findings.length) return head;
  return `${head} (${counts.critical} critical, ${counts.warning} warning, ${counts.info} info)`;
}
