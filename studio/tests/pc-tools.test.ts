// pc-tools.test.ts — PC diagnosis + the everyday PC skills
// (folder-create, music control, WhatsApp compose).
//
// The diagnosis is exercised with fixed snapshots (deterministic rules), the
// command parsers with real `ps`/`tasklist`/`df` output shapes, and the tools
// through the real registry.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  analyzePcHealth,
  collectPcSnapshot,
  parseDfOutput,
  parsePsOutput,
  parseTasklistOutput,
  summarizeDiagnosis,
  type PcSnapshot,
} from '../src/lib/agentic/pc-health';
import {
  buildMusicTarget,
  buildWhatsappTarget,
  mediaKeyFor,
  normalizeWhatsappNumber,
  registerPcTools,
} from '../src/lib/agentic/pc-tools';
import { classifyHostAction, summarizeHostAction } from '../src/lib/agentic/host-control';
import { getTool, invokeTool } from '../src/lib/agentic/tool-registry';

const HEALTHY: PcSnapshot = {
  platform: 'linux',
  arch: 'x64',
  uptimeHours: 3,
  cpu: { model: 'Intel i3', cores: 4, loadPct: 12 },
  memory: { totalMb: 8192, freeMb: 4096 },
  disks: [{ mount: '/', totalGb: 500, freeGb: 300 }],
  processes: [
    { name: 'chrome', cpuPct: 8, memMb: 900 },
    { name: 'node', cpuPct: 3, memMb: 300 },
  ],
  capturedAt: '2026-10-24T00:00:00.000Z',
};

describe('pc diagnosis rules', () => {
  test('a healthy machine scores high and has no findings', () => {
    const d = analyzePcHealth(HEALTHY);
    expect(d.score).toBe(100);
    expect(d.findings).toHaveLength(0);
    expect(d.verdict).toContain('Healthy');
  });

  test('full RAM is critical and explained with numbers', () => {
    const d = analyzePcHealth({ ...HEALTHY, memory: { totalMb: 8192, freeMb: 400 } });
    const f = d.findings.find((x) => x.title.includes('RAM'));
    expect(f?.severity).toBe('critical');
    expect(f?.detail).toContain('95');
    expect(d.score).toBeLessThan(80);
  });

  test('a full disk is critical', () => {
    const d = analyzePcHealth({ ...HEALTHY, disks: [{ mount: 'C:', totalGb: 100, freeGb: 1.5 }] });
    const f = d.findings.find((x) => x.title.includes('nearly full'));
    expect(f?.severity).toBe('critical');
    expect(f?.action.length).toBeGreaterThan(10);
  });

  test('an overloaded CPU and a single hog are reported together', () => {
    const d = analyzePcHealth({
      ...HEALTHY,
      cpu: { ...HEALTHY.cpu, loadPct: 210 },
      processes: [{ name: 'MsMpEng.exe', cpuPct: 92, memMb: 400 }],
    });
    expect(d.findings.some((f) => f.title.includes('overloaded'))).toBe(true);
    const hog = d.findings.find((f) => f.title.includes('MsMpEng.exe'));
    expect(hog?.severity).toBe('critical');
  });

  test('findings are sorted by severity and the score never goes below 0', () => {
    const d = analyzePcHealth({
      platform: 'win32',
      arch: 'x64',
      uptimeHours: 24 * 30,
      cpu: { model: 'old', cores: 2, loadPct: 400 },
      memory: { totalMb: 4096, freeMb: 20 },
      disks: [{ mount: 'C:', totalGb: 120, freeGb: 0.3 }],
      processes: [{ name: 'heavy.exe', cpuPct: 99, memMb: 3200 }],
      capturedAt: '2026-10-24T00:00:00.000Z',
    });
    expect(d.score).toBe(0);
    expect(d.findings[0].severity).toBe('critical');
    expect(d.findings.at(-1)?.severity).toBe('info');
    expect(summarizeDiagnosis(d)).toContain('critical');
  });

  test('long uptime is only an info item', () => {
    const d = analyzePcHealth({ ...HEALTHY, uptimeHours: 24 * 10 });
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].severity).toBe('info');
    expect(d.score).toBe(97);
  });
});

describe('command parsers', () => {
  test('ps output is sorted by CPU and trimmed', () => {
    const rows = parsePsOutput(' 12.5 204800 /usr/lib/firefox/firefox\n 45.0 102400 node\n  1.0 51200 bash\n');
    expect(rows[0]).toEqual({ name: 'node', cpuPct: 45, memMb: 100 });
    expect(rows[1].name).toBe('firefox');
  });

  test('tasklist CSV output is sorted by memory', () => {
    const out = '"chrome.exe","1234","Console","1","850,000 K"\n"Code.exe","4321","Console","1","1,200,000 K"\n';
    const rows = parseTasklistOutput(out);
    expect(rows[0].name).toBe('Code.exe');
    expect(rows[0].memMb).toBeCloseTo(1171.875, 1);
  });

  test('df output skips pseudo filesystems', () => {
    const out = [
      'Filesystem     1024-blocks    Used Available Capacity Mounted on',
      'tmpfs              1000000   10000    990000       1% /run',
      '/dev/sda1         104857600 5242880 99614720       5% /',
      'overlay            2097152 1000000   1097152      48% /var/lib/docker',
    ].join('\n');
    const disks = parseDfOutput(out);
    expect(disks).toHaveLength(1);
    expect(disks[0].mount).toBe('/');
    expect(disks[0].totalGb).toBe(100);
  });
});

describe('real snapshot', () => {
  test('a snapshot is collected on this machine', async () => {
    const snap = await collectPcSnapshot();
    expect(snap.memory.totalMb).toBeGreaterThan(0);
    expect(snap.cpu.cores).toBeGreaterThan(0);
    expect(snap.capturedAt).toMatch(/\d{4}-\d{2}-\d{2}/);
    const diagnosis = analyzePcHealth(snap);
    expect(diagnosis.score).toBeGreaterThanOrEqual(0);
    expect(diagnosis.score).toBeLessThanOrEqual(100);
  });

  test('a failing command degrades to "unknown" instead of throwing', async () => {
    const snap = await collectPcSnapshot({
      runner: async () => {
        throw new Error('no such command');
      },
    });
    expect(snap.processes).toEqual([]);
    expect(snap.disks).toEqual([]);
  });
});

describe('music helpers', () => {
  test('media commands map to real media keys', () => {
    expect(mediaKeyFor('playpause')).toBe('playpause');
    expect(mediaKeyFor('next')).toBe('nexttrack');
    expect(mediaKeyFor('previous')).toBe('prevtrack');
    expect(mediaKeyFor('mute')).toBe('volumemute');
  });

  test('a search becomes a YouTube search URL', () => {
    const built = buildMusicTarget({ query: 'arijit singh kesariya' });
    expect(built.kind).toBe('youtube');
    expect(built.target).toContain('youtube.com/results?search_query=arijit');
  });

  test('spotify uses the app search URI', () => {
    expect(buildMusicTarget({ query: 'lofi', service: 'spotify' }).target).toBe('spotify:search:lofi');
  });

  test('a direct URL is kept, a non-http URL is refused', () => {
    expect(buildMusicTarget({ url: 'https://example.com/a.mp3' }).target).toBe('https://example.com/a.mp3');
    expect(() => buildMusicTarget({ url: 'file:///etc/passwd' })).toThrow(/http/);
  });

  test('an empty request is rejected', () => {
    expect(() => buildMusicTarget({})).toThrow(/query/);
  });
});

describe('whatsapp helpers', () => {
  test('numbers are normalised to digits', () => {
    expect(normalizeWhatsappNumber('+91 98765-43210')).toBe('919876543210');
  });

  test('too short / too long numbers are refused', () => {
    expect(() => normalizeWhatsappNumber('123')).toThrow(/8-15/);
    expect(() => normalizeWhatsappNumber('1'.repeat(20))).toThrow(/8-15/);
  });

  test('the deep link carries the encoded text', () => {
    const link = buildWhatsappTarget('919876543210', 'Kal 5 baje milte hain');
    expect(link.startsWith('whatsapp://send?phone=919876543210&text=')).toBe(true);
    expect(decodeURIComponent(link.split('text=')[1])).toBe('Kal 5 baje milte hain');
  });

  test('an empty message is refused', () => {
    expect(() => buildWhatsappTarget('919876543210', '   ')).toThrow(/text is required/i);
  });
});

describe('the mkdir host action', () => {
  test('a new folder is review-class', () => {
    const cls = classifyHostAction({ kind: 'mkdir', path: path.join(os.tmpdir(), 'studio-new-folder-test') });
    expect(cls.permission).toBe('review');
  });

  test('system and credential locations are forbidden', () => {
    expect(classifyHostAction({ kind: 'mkdir', path: '/etc/evidence' }).permission).toBe('forbidden');
  });

  test('a FILE with the same name is destructive', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mkdir-cls-'));
    const file = path.join(dir, 'already-a-file');
    await fs.writeFile(file, 'x');
    try {
      const cls = classifyHostAction({ kind: 'mkdir', path: file });
      expect(cls.permission).toBe('destructive');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('the approval card text is human', () => {
    expect(summarizeHostAction({ kind: 'mkdir', path: '~/Documents/New' })).toContain('Create folder');
  });
});

describe('registered tools', () => {
  beforeAll(() => registerPcTools());

  test('all five tools exist with the right permission', () => {
    expect(getTool('pc-diagnose')?.permission).toBe('safe');
    for (const name of ['folder-create', 'music-control', 'music-play', 'whatsapp-send']) {
      expect(getTool(name)?.permission).toBe('review');
    }
  });

  test('pc-diagnose returns a real diagnosis through the registry', async () => {
    const res = await invokeTool({ tool: 'pc-diagnose', parameters: {}, taskId: 'test-pc-tools' });
    expect(res.ok).toBe(true);
    expect(typeof res.data.score).toBe('number');
    expect(Array.isArray(res.data.findings)).toBe(true);
    expect(res.data.snapshot.cpu.cores).toBeGreaterThan(0);
  });

  test('music-control rejects an unknown command', async () => {
    const res = await invokeTool({
      tool: 'music-control',
      parameters: { command: 'explode' },
      taskId: 'test-pc-tools',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/playpause/);
  });

  test('whatsapp-send rejects a bad number before touching the machine', async () => {
    const res = await invokeTool({
      tool: 'whatsapp-send',
      parameters: { to: '123', text: 'hi' },
      taskId: 'test-pc-tools',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/8-15/);
  });

  test('folder-create refuses a path outside the allowed roots', async () => {
    const previous = process.env.AGENTSCOPE_ALLOWED_ROOTS;
    process.env.AGENTSCOPE_ALLOWED_ROOTS = path.join(os.tmpdir(), 'allowed-root-x');
    try {
      const res = await invokeTool({
        tool: 'folder-create',
        parameters: { path: '/etc/should-not-exist' },
        taskId: 'test-pc-tools',
      });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toMatch(/allowed roots|not allowed/i);
    } finally {
      if (previous === undefined) delete process.env.AGENTSCOPE_ALLOWED_ROOTS;
      else process.env.AGENTSCOPE_ALLOWED_ROOTS = previous;
    }
  });
});

afterAll(async () => {
  await fs.rm(path.join(os.tmpdir(), 'studio-new-folder-test'), { recursive: true, force: true });
});
