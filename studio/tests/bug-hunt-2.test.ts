// Regression tests — bug-hunt round 3 (H18 … H34).
// See BUGFIXES.md / the audit report for the reasoning; each test pins the
// behaviour that was broken.
// Run: bun test tests/bug-hunt-2.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { db } from '../src/lib/db';
import { recordAudit } from '../src/lib/agentic/audit';
import { deleteDocument, searchKnowledge } from '../src/lib/agentic/knowledge';
import { resetProjectIndex } from '../src/lib/agentic/project-index';
import {
  decodeXmlEntities,
  parseSheetXml,
  pdfContentToText,
  readZipDirectory,
  readZipEntry,
} from '../src/lib/agentic/documents';
import { loadRouterPolicy, saveProvider } from '../src/lib/agentic/provider-store';
import { providerLoopbackAllowed, testProviderConnection } from '../src/lib/agentic/provider-connection';
import { downloadsDir, scanDownloadsOnce, stopDownloadsWatcher } from '../src/lib/agentic/downloads';
import { listTools } from '../src/lib/agentic/tool-registry';

// ---------------------------------------------------------------------------
// H18 — the Downloads watcher must not greet a restart with phantom files
// ---------------------------------------------------------------------------
describe('H18 — the download watcher seeds quietly', () => {
  const dir = path.join(os.tmpdir(), `jarvish-dl-${process.pid}-${Date.now()}`);
  const marker = `h18-${process.pid}`;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.AGENTSCOPE_DOWNLOADS_DIR;
    process.env.AGENTSCOPE_DOWNLOADS_DIR = dir;
    // a running watcher would scan the same folder on its next tick and race
    // with these assertions
    stopDownloadsWatcher();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.AGENTSCOPE_DOWNLOADS_DIR;
    else process.env.AGENTSCOPE_DOWNLOADS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** only the notifications about THIS test's files (the table is shared) */
  const myNotifications = () =>
    db.notification.count({ where: { title: { contains: marker } } });

  test('downloadsDir() honours the override', () => {
    expect(downloadsDir()).toBe(path.resolve(dir));
  });

  test('a seeding scan reports the file but stays silent', async () => {
    // a file the user downloaded two minutes ago: on the OLD code the startup
    // "seed without notifying" pass still notified, once per server restart
    fs.writeFileSync(path.join(dir, `${marker}-report.pdf`), 'data');
    const fresh = scanDownloadsOnce(Date.now(), { silent: true });
    expect(fresh.map((f) => f.name)).toEqual([`${marker}-report.pdf`]);
    await new Promise((r) => setTimeout(r, 20));
    expect(await myNotifications()).toBe(0);

    // and the next real scan knows it already, so it stays quiet as well
    expect(scanDownloadsOnce(Date.now() + 60_000)).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(await myNotifications()).toBe(0);
  });

  test('a genuinely new file still notifies', async () => {
    scanDownloadsOnce(Date.now(), { silent: true });
    fs.writeFileSync(path.join(dir, `${marker}-invoice.pdf`), 'data');
    const fresh = scanDownloadsOnce(Date.now() + 5_000);
    expect(fresh.map((f) => f.name)).toEqual([`${marker}-invoice.pdf`]);
    await new Promise((r) => setTimeout(r, 30));
    expect(await myNotifications()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H19 — "Test connection" must not contradict the runtime
// ---------------------------------------------------------------------------
describe('H19 — a local provider endpoint is testable, not reported broken', () => {
  const savedEnv = process.env.AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK;
    else process.env.AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK = savedEnv;
  });

  test('loopback is allowed by default and can be closed by the operator', () => {
    delete process.env.AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK;
    expect(providerLoopbackAllowed()).toBe(true);
    process.env.AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK = '0';
    expect(providerLoopbackAllowed()).toBe(false);
  });

  test('LM Studio on localhost gets past the guard (the failure is the missing server)', async () => {
    delete process.env.AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK;
    const res = await testProviderConnection({
      provider: 'custom',
      baseUrl: 'http://localhost:45321/v1',
      apiKey: 'test-key',
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(false);
    // 'config' + "loopback address" was the old answer: the URL was rejected
    // before it was ever tried, even though chat with the same URL works
    expect(res.errorCategory).not.toBe('config');
    expect(res.error ?? '').not.toMatch(/loopback/);
  });

  test('with the opt-out the guard speaks up again', async () => {
    process.env.AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK = '0';
    const res = await testProviderConnection({
      provider: 'custom',
      baseUrl: 'http://localhost:45321/v1',
      apiKey: 'test-key',
      timeoutMs: 5_000,
    });
    expect(res.errorCategory).toBe('config');
    // with the opt-out a cleartext endpoint is refused outright
    expect(res.error).toMatch(/https|loopback/);
  });

  test('the private network is still off limits', async () => {
    delete process.env.AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK;
    const res = await testProviderConnection({
      provider: 'custom',
      baseUrl: 'https://10.1.2.3:1234/v1',
      apiKey: 'k',
      timeoutMs: 5_000,
    });
    expect(res.errorCategory).toBe('config');
    expect(res.error).toMatch(/private network/);
  });
});

// ---------------------------------------------------------------------------
// H20 — audit artifacts are secret material too
// ---------------------------------------------------------------------------
describe('H20 — audit entries are masked, including the artifact', () => {
  const key = `sk-${'A'.repeat(24)}`;

  test('a key inside `artifact` never reaches the audit row', async () => {
    await db.auditLog.deleteMany();
    await recordAudit({
      actor: 'test',
      action: 'unit.h20',
      category: 'general',
      details: { note: `details already masked: ${key}` },
      artifact: { request: { headers: { authorization: key } } },
    });
    const [row] = await db.auditLog.findMany({ where: { action: 'unit.h20' } });
    expect(row.details).not.toContain(key);
    expect(row.artifact).not.toContain(key);
    expect(row.artifact).toContain('[REDACTED');
  });
});

// ---------------------------------------------------------------------------
// H21 / H26 — deleting a document deletes its CHUNKS
// ---------------------------------------------------------------------------
describe('H21/H26 — an index delete removes the stored text', () => {
  test('deleteDocument removes the chunks of a workspace document', async () => {
    const doc = await db.knowledgeDoc.create({
      data: { name: 'private.txt', path: 'private.txt', status: 'indexed', chunkCount: 2, taskId: 'h21' },
    });
    await db.knowledgeChunk.createMany({
      data: [
        { docId: doc.id, seq: 0, content: 'the passport number is 1234' },
        { docId: doc.id, seq: 1, content: 'more private text' },
      ],
    });
    expect(await deleteDocument(doc.id)).toBe(true);
    expect(await db.knowledgeChunk.count({ where: { docId: doc.id } })).toBe(0);
    expect(await searchKnowledge('passport', { taskId: 'h21' })).toEqual([]);
  });

  test('resetProjectIndex removes every chunk of the root', async () => {
    const root = '/tmp/h26-project';
    await db.knowledgeDoc.deleteMany();
    await db.knowledgeChunk.deleteMany();
    const a = await db.knowledgeDoc.create({
      data: { name: 'a.ts', path: 'src/a.ts', status: 'indexed', chunkCount: 1, source: 'project', sourceRoot: root },
    });
    const b = await db.knowledgeDoc.create({
      data: { name: 'b.ts', path: 'src/b.ts', status: 'indexed', chunkCount: 1, source: 'project', sourceRoot: root },
    });
    await db.knowledgeChunk.createMany({
      data: [
        { docId: a.id, seq: 0, content: 'alpha source' },
        { docId: b.id, seq: 0, content: 'beta source' },
      ],
    });

    expect(await resetProjectIndex(root)).toBe(2);
    expect(await db.knowledgeChunk.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// H22 — H25 — the document readers survive hostile input
// ---------------------------------------------------------------------------
describe('H22 — a zip entry that lies about its offsets is refused', () => {
  // a minimal one-entry zip: 30-byte local header, the deflated payload, then
  // a 46-byte central-directory record and the EOCD
  const build = (lyingLocalNameLen: number) => {
    const payload = zlib.deflateRawSync(Buffer.from('{"ok":true}'));
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8); // method: deflate
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(payload.length, 20);
    lh.writeUInt16LE(lyingLocalNameLen, 26); // name length (the lie)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10); // method
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(payload.length, 24);
    cd.writeUInt16LE(0, 28); // central name length: 0
    cd.writeUInt32LE(0, 42); // the local header sits at offset 0
    const body = Buffer.concat([lh, payload, cd]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8); // entries on this disk
    eocd.writeUInt16LE(1, 10); // total entries
    eocd.writeUInt32LE(30 + payload.length, 16); // central directory offset
    return Buffer.concat([body, eocd]);
  };

  test('a well-formed archive inflates', () => {
    const buf = build(0);
    const [entry] = readZipDirectory(buf);
    expect(entry).toBeDefined();
    expect(readZipEntry(buf, entry).toString()).toBe('{"ok":true}');
  });

  test('a truncated or lying local header throws instead of returning garbage', () => {
    const buf = build(60_000);
    const [entry] = readZipDirectory(buf);
    expect(() => readZipEntry(buf, entry)).toThrow(/Corrupt zip entry/);
  });
});

describe('H24/H25/H23 — bounded, non-crashing parsing', () => {
  test('a bogus column reference cannot blow up the row padding', () => {
    // before the fix this padded ~8 billion cells (process death)
    const rows = parseSheetXml(
      '<row><c r="AAAAAAAA1" t="s"><v>0</v></c><c r="A1"><v>7</v></c></row>',
      ['x']
    );
    expect(rows).toEqual([['7']]);
    expect(parseSheetXml('<row><c r="ZZZZ9"><v>1</v></c></row>', [])).toEqual([]);
    // a real (in-grid) column still pads
    expect(parseSheetXml('<row><c r="C1"><v>3</v></c></row>', [])).toEqual([['', '', '3']]);
  });

  test('a backslash flood in a PDF content stream does not hang the regex', () => {
    const started = Date.now();
    // `(?:[^\[\]]|\\.)*` — both branches match a backslash → exponential
    expect(pdfContentToText(`[${'\\\\'.repeat(26)}x`)).toBe('');
    expect(Date.now() - started).toBeLessThan(500);
    expect(pdfContentToText('[(Hi) -200 (there)] TJ')).toBe('Hi there');
  });

  test('an out-of-range character reference is left alone instead of throwing', () => {
    expect(decodeXmlEntities('&#99999999;')).toBe('&#99999999;');
    expect(decodeXmlEntities('&#x110000;')).toBe('&#x110000;');
    expect(decodeXmlEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeXmlEntities('&#65;&#x42;&amp;')).toBe('AB&');
  });
});

// ---------------------------------------------------------------------------
// H28 / H29 — provider cost policy
// ---------------------------------------------------------------------------
describe('H28/H29 — cost class is preserved and free models are seen as free', () => {
  // the tables are shared with the other test files — touch ONLY the rows this
  // test owns (openrouter + the freeOnly flag), never everything
  beforeEach(async () => {
    await db.providerConfig.deleteMany({ where: { provider: 'openrouter' } });
    await db.studioSetting.deleteMany({ where: { key: 'freeOnly' } });
  });

  afterEach(async () => {
    await db.providerConfig.deleteMany({ where: { provider: 'openrouter' } });
    await db.studioSetting.deleteMany({ where: { key: 'freeOnly' } });
  });

  test('a partial save keeps the stored cost class', async () => {
    await saveProvider({ provider: 'openrouter', costClass: 'free', model: 'x' });
    // an unrelated change (no costClass in the request) must not re-infer it
    await saveProvider({ provider: 'openrouter', label: 'Router' });
    const row = await db.providerConfig.findUnique({ where: { provider: 'openrouter' } });
    expect(row?.costClass).toBe('free');
  });

  test('free-only mode uses an OpenRouter `:free` model on a paid provider', async () => {
    await saveProvider({ provider: 'openrouter', costClass: 'paid', model: 'llama-3.3:free' });
    await db.studioSetting.create({ data: { key: 'freeOnly', value: 'true' } });
    const policy = await loadRouterPolicy();
    expect(policy.costClassOf?.('openrouter', 'deepseek/deepseek-chat-v3-1:free')).toBe('free');
    expect(policy.costClassOf?.('openrouter', 'deepseek/deepseek-chat-v3-1')).toBe('paid');
  });
});

// ---------------------------------------------------------------------------
// H35 / H36 / H37 — the tool catalog and its health check
// ---------------------------------------------------------------------------
describe('H35/H36/H37 — one catalog, honestly checked', () => {
  test('the shared catalog contains EVERY family (list == invoke == health)', async () => {
    const { ensureFullToolCatalog } = await import('../src/lib/agentic/tool-catalog');
    await ensureFullToolCatalog();
    const names = listTools().map((t) => t.name);
    // these three families were missing from /api/tools/invoke (H36) and the
    // whole catalog was missing from /api/tools/health and /api/system/status
    // (H35) — the UI could list a tool it could not run, and the health panel
    // reported an empty toolset on a fresh server.
    for (const name of ['memory-remember', 'conversation-recall', 'gmail-list-messages', 'file-read', 'time-now']) {
      expect(names).toContain(name);
    }
  });

  test('a probe never allocates a live resource (H37)', async () => {
    const { ensureFullToolCatalog } = await import('../src/lib/agentic/tool-catalog');
    const { healthCheckTool } = await import('../src/lib/agentic/tool-registry');
    await ensureFullToolCatalog();
    const taskId = `zz-h37-${process.pid}`;
    const ws = path.join(process.cwd(), '.agentic-workspace', taskId);
    fs.rmSync(ws, { recursive: true, force: true });
    try {
      const created = await healthCheckTool('workspace-create', taskId, { probe: true });
      expect(created.ok).toBe(true);
      expect(created.error).toMatch(/not probed/);
      expect(fs.existsSync(ws)).toBe(false);

      const session = await healthCheckTool('browser-session', taskId, { probe: true });
      expect(session.error).toMatch(/not probed/);

      // and the ordinary check stays side-effect free too
      const read = await healthCheckTool('file-read', taskId);
      expect(read.ok).toBe(true);
      expect(fs.existsSync(ws)).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
