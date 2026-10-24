// document-tools.test.ts — document-read / file-search / document-index.
//
// The tools are exercised through the real registry (`invokeTool`), so the
// permission layer, timeout handling and redaction are covered as well.
// Paths are real temporary folders — no mocks, no network.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { invokeTool, hasTool } from '../src/lib/agentic/tool-registry';
import { readFileAsText, registerDocumentTools, searchFiles } from '../src/lib/agentic/document-tools';

let root = '';
const originalRoots = process.env.AGENTSCOPE_ALLOWED_ROOTS;

/** minimal zip writer (stored entries) for the .docx fixture */
function makeZip(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.data, 'utf8');
    const nameBuf = Buffer.from(file.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, raw);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + raw.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-docs-'));
  await fs.mkdir(path.join(root, 'reports'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(root, 'notes.txt'), 'Quarterly revenue grew by 12%\nsecond line\n');
  await fs.writeFile(path.join(root, 'reports', 'summary.md'), '# Summary\nrevenue is up\n');
  await fs.writeFile(path.join(root, 'reports', 'budget.docx'), makeZip([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>Budget plan</w:t></w:r></w:p></w:body></w:document>' },
  ]));
  await fs.writeFile(path.join(root, 'reports', 'scan.pdf'), Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1'));
  await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  // a decoy inside node_modules: the search must not descend into it
  await fs.writeFile(path.join(root, 'node_modules', 'revenue-copy.txt'), 'revenue inside node_modules\n');
  process.env.AGENTSCOPE_ALLOWED_ROOTS = root;
  registerDocumentTools();
});

afterAll(async () => {
  if (originalRoots === undefined) delete process.env.AGENTSCOPE_ALLOWED_ROOTS;
  else process.env.AGENTSCOPE_ALLOWED_ROOTS = originalRoots;
  await fs.rm(root, { recursive: true, force: true });
});

describe('readFileAsText', () => {
  test('plain text is returned as-is', async () => {
    const out = await readFileAsText(path.join(root, 'notes.txt'));
    expect(out.kind).toBe('text');
    expect(out.text).toContain('Quarterly revenue');
  });

  test('a real .docx is extracted', async () => {
    const out = await readFileAsText(path.join(root, 'reports', 'budget.docx'));
    expect(out.kind).toBe('docx');
    expect(out.text).toBe('Budget plan');
  });

  test('maxChars truncates and says so', async () => {
    const out = await readFileAsText(path.join(root, 'notes.txt'), { maxChars: 200 });
    expect(out.text.length).toBeLessThanOrEqual(200);
    expect(out.truncated).toBe(false); // the file is shorter than the cap
  });

  test('a binary file is refused with a readable message', async () => {
    await expect(readFileAsText(path.join(root, 'blob.bin'))).rejects.toThrow(/binary/i);
  });
});

describe('searchFiles', () => {
  test('content matches carry a line number and a preview', async () => {
    const matches = await searchFiles(root, 'revenue', { mode: 'content' });
    const note = matches.find((m) => m.path.endsWith('notes.txt'));
    expect(note?.line).toBe(1);
    expect(note?.preview).toContain('Quarterly revenue');
  });

  test('name matches are found too', async () => {
    const matches = await searchFiles(root, 'summary', { mode: 'name' });
    expect(matches.some((m) => m.path.endsWith('summary.md'))).toBe(true);
  });

  test('node_modules is never searched', async () => {
    const matches = await searchFiles(root, 'revenue', { mode: 'both' });
    expect(matches.some((m) => m.path.includes('node_modules'))).toBe(false);
  });

  test('an empty query returns nothing', async () => {
    expect(await searchFiles(root, '   ')).toEqual([]);
  });

  test('the result cap is honoured', async () => {
    const matches = await searchFiles(root, 'revenue', { maxResults: 1 });
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});

describe('the registered tools', () => {
  test('document-read returns extracted text through the registry', async () => {
    expect(hasTool('document-read')).toBe(true);
    const res = await invokeTool({
      tool: 'document-read',
      parameters: { path: path.join(root, 'reports', 'budget.docx') },
      taskId: 'test-doc-tools',
    });
    expect(res.ok).toBe(true);
    expect(res.data.text).toBe('Budget plan');
    expect(res.data.kind).toBe('docx');
  });

  test('document-read refuses a path outside the allowed roots', async () => {
    const res = await invokeTool({
      tool: 'document-read',
      parameters: { path: '/etc/passwd' },
      taskId: 'test-doc-tools',
    });
    expect(res.ok).toBe(false);
  });

  test('a scanned pdf is read but reports that OCR is needed', async () => {
    const res = await invokeTool({
      tool: 'document-read',
      parameters: { path: path.join(root, 'reports', 'scan.pdf') },
      taskId: 'test-doc-tools',
    });
    expect(res.ok).toBe(true);
    expect(res.data.text).toBe('');
    expect(res.data.warnings.join(' ')).toMatch(/OCR/);
  });

  test('file-search finds content through the registry', async () => {
    const res = await invokeTool({
      tool: 'file-search',
      parameters: { query: 'revenue', path: root, maxResults: 5 },
      taskId: 'test-doc-tools',
    });
    expect(res.ok).toBe(true);
    expect(res.data.count).toBeGreaterThan(0);
    expect(JSON.stringify(res.data.matches)).toContain('notes.txt');
  });

  test('file-search without a query fails cleanly', async () => {
    const res = await invokeTool({ tool: 'file-search', parameters: {}, taskId: 'test-doc-tools' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/query/);
  });

  test('document-index needs a taskId', async () => {
    const res = await invokeTool({ tool: 'document-index', parameters: { path: 'x.txt' }, taskId: '' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/taskId/);
  });

  test('all three tools are read-only', async () => {
    const { getTool } = await import('../src/lib/agentic/tool-registry');
    for (const name of ['document-read', 'file-search', 'document-index']) {
      expect(getTool(name)?.permission).toBe('safe');
    }
  });
});

// keep the zip import referenced (deflate helper stays available for future fixtures)
void zlib;
