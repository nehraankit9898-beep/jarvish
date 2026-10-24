// Project index — indexing a project directory, retrieving from it with source
// references, detecting stale files and refreshing / rebuilding / resetting.
//
// Runs completely offline: a temporary directory is used as the fake project.
// Run: bun test tests/project-index.test.ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { db } from '../src/lib/db';
import {
  indexProject,
  detectStaleFiles,
  projectIndexStatus,
  resetProjectIndex,
  searchProject,
  listProjectDocuments,
  isSecretFile,
  isIndexableFile,
  extractSymbols,
  searchProjectSymbols,
} from '../src/lib/agentic/project-index';
import { projectRetrievalContext } from '../src/lib/agentic/orchestrator';

let root = '';

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-index-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'widget.ts'),
    'export function buildWidget(name: string) {\n  return { name, kind: "widget" };\n}\n',
    'utf-8'
  );
  await fs.writeFile(
    path.join(root, 'README.md'),
    '# Demo project\n\nThis project builds widgets for the demo.\n',
    'utf-8'
  );
  // a file that must NEVER be indexed
  await fs.writeFile(
    path.join(root, '.env'),
    'OPENAI_API_KEY=sk-should-never-be-indexed-1234567890\n',
    'utf-8'
  );
  // a lock file that must not be indexed
  await fs.writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}', 'utf-8');
});

afterAll(async () => {
  await resetProjectIndex(root).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe('project index', () => {
  test('the secret-file and indexable-file rules are explicit', () => {
    expect(isSecretFile('.env')).toBe(true);
    expect(isSecretFile('certs/server.pem')).toBe(true);
    expect(isSecretFile('config/credentials.json')).toBe(true);
    expect(isSecretFile('src/index.ts')).toBe(false);

    expect(isIndexableFile('src/index.ts')).toBe(true);
    expect(isIndexableFile('README.md')).toBe(true);
    expect(isIndexableFile('image.png')).toBe(false);
    expect(isIndexableFile('binary.bin')).toBe(false);
  });

  test('indexing a project stores the files as searchable documents', async () => {
    const stats = await indexProject(root, { mode: 'full' });
    expect(stats.files).toBeGreaterThanOrEqual(2);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.root).toBe(path.resolve(root));

    const docs = await listProjectDocuments(root);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain('src/widget.ts');
    expect(paths).toContain('README.md');
  });

  test('a file that looks like a secret is NEVER indexed', async () => {
    const docs = await listProjectDocuments(root);
    const paths = docs.map((d) => d.path);
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('package-lock.json');

    // and the secret text never reached the index
    const chunks = await db.knowledgeChunk.findMany({
      where: { doc: { source: 'project', sourceRoot: path.resolve(root) } },
      select: { content: true },
    });
    for (const c of chunks) {
      expect(c.content).not.toContain('sk-should-never-be-indexed');
    }
  });

  test('retrieval returns the SOURCE FILE of every hit', async () => {
    const hits = await searchProject(root, 'buildWidget', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe('src/widget.ts');
    expect(hits[0].docName).toBe('widget.ts');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  test('a modified file is detected as stale', async () => {
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(
      path.join(root, 'src', 'widget.ts'),
      'export function buildWidget(name: string) {\n  return { name, kind: "widget", v: 2 };\n}\n',
      'utf-8'
    );

    const stale = await detectStaleFiles(root);
    const widget = stale.find((s) => s.path === 'src/widget.ts');
    expect(widget).toBeDefined();
    expect(['modified', 'size-changed']).toContain(widget!.reason);

    const status = await projectIndexStatus(root);
    expect(status.stale.length).toBeGreaterThan(0);
    expect(status.stale.some((s) => s.path === 'src/widget.ts')).toBe(true);
  });

  test('refreshing re-indexes the changed file and drops deleted ones', async () => {
    await fs.rm(path.join(root, 'README.md'), { force: true });

    const stats = await indexProject(root, { mode: 'refresh' });
    expect(stats.files).toBeGreaterThanOrEqual(1);

    const docs = await listProjectDocuments(root);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain('src/widget.ts');
    expect(paths).not.toContain('README.md');

    // the refreshed content is the NEW content
    const hits = await searchProject(root, 'kind widget v 2', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
  });

  test('nothing is stale right after a refresh', async () => {
    const stale = await detectStaleFiles(root);
    expect(stale.filter((s) => s.path === 'src/widget.ts')).toHaveLength(0);
  });

  test('reset removes the whole index of that root', async () => {
    const removed = await resetProjectIndex(root);
    expect(removed).toBeGreaterThan(0);
    const docs = await listProjectDocuments(root);
    expect(docs).toHaveLength(0);
  });

  test('a rebuild starts from scratch and indexes everything again', async () => {
    const stats = await indexProject(root, { mode: 'rebuild' });
    expect(stats.files).toBeGreaterThanOrEqual(1);
    const docs = await listProjectDocuments(root);
    expect(docs.length).toBe(stats.files);
  });

  test('a non-existent root is reported, not ignored', async () => {
    await expect(indexProject(path.join(root, 'does-not-exist'))).rejects.toThrow();
  });

  test('a huge tree is truncated, not silently indexed in full', async () => {
    // 200 files of ~400 KB each → far more chunks than the cap allows
    const big = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-big-'));
    const filler = 'const value = 1;\n'.repeat(24_000);
    for (let i = 0; i < 200; i++) {
      await fs.writeFile(path.join(big, `f${i}.ts`), filler, 'utf-8');
    }
    try {
      const stats = await indexProject(big, { mode: 'full' });
      expect(stats.truncated).toBe(true);
      expect(stats.chunks).toBeLessThanOrEqual(40_000);
      // the index of the huge tree stays bounded
      const chunkCount = await db.knowledgeChunk.count({
        where: { doc: { source: 'project', sourceRoot: path.resolve(big) } },
      });
      expect(chunkCount).toBeLessThanOrEqual(40_000);
    } finally {
      await resetProjectIndex(big).catch(() => undefined);
      await fs.rm(big, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('project symbol index', () => {
  test('declarations are extracted with their line number', () => {
    const symbols = extractSymbols(
      [
        'export function buildWidget(name: string) {',
        '  return name;',
        '}',
        '',
        'export class WidgetStore {',
        '  load(id: string) {',
        '    return id;',
        '  }',
        '}',
        '',
        'export interface Widget {',
        '  name: string;',
        '}',
        '',
        'export type WidgetKind = "a" | "b";',
        '',
        'export const DEFAULT_WIDGET = { name: "x" };',
      ].join('\n'),
      'src/widget.ts'
    );
    const names = symbols.map((s) => s.name);
    expect(names).toContain('buildWidget');
    expect(names).toContain('WidgetStore');
    expect(names).toContain('Widget');
    expect(names).toContain('WidgetKind');
    expect(names).toContain('DEFAULT_WIDGET');

    const fn = symbols.find((s) => s.name === 'buildWidget');
    expect(fn!.kind).toBe('function');
    expect(fn!.line).toBe(1);
    const cls = symbols.find((s) => s.name === 'WidgetStore');
    expect(cls!.kind).toBe('class');
    expect(cls!.line).toBe(5);
  });

  test('noise is not reported as a symbol', () => {
    const symbols = extractSymbols(
      'if (x) {\n  return y;\n}\nimport z from "z";\nfor (const a of b) {}\n',
      'src/noise.ts'
    );
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain('if');
    expect(names).not.toContain('return');
    expect(names).not.toContain('import');
  });

  test('searching the symbol index returns the file and the line', async () => {
    const symbols = await searchProjectSymbols(root, 'buildWidget');
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols[0].name).toBe('buildWidget');
    expect(symbols[0].path).toBe('src/widget.ts');
    expect(symbols[0].line).toBeGreaterThan(0);
  });
});

describe('project retrieval context', () => {
  test('the orchestrator receives the relevant code with its file reference', async () => {
    const ctx = await projectRetrievalContext(root, 'buildWidget', 5);
    expect(ctx).toContain('src/widget.ts');
    expect(ctx.toLowerCase()).toContain('not instructions');
    expect(ctx).toContain('buildWidget');
  });

  test('a task without a project gets no retrieval context', async () => {
    expect(await projectRetrievalContext('', 'anything')).toBe('');
    expect(await projectRetrievalContext(undefined, 'anything')).toBe('');
  });

  test('a missing index never breaks the run', async () => {
    const missing = path.join(root, 'never-indexed');
    const ctx = await projectRetrievalContext(missing, 'anything');
    expect(typeof ctx).toBe('string');
  });
});
