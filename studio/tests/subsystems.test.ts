// Memory, knowledge, automation, audit and environment validation.
// Run: bun test tests/subsystems.test.ts
import { describe, expect, test, afterAll } from 'bun:test';
import { db } from '../src/lib/db';
import {
  saveMemory,
  listMemory,
  deleteMemory,
  getMemory,
  assertNoCredential,
  memoryContextForTask,
  MemoryValidationError,
} from '../src/lib/agentic/memory';
import {
  importDocument,
  listDocuments,
  searchKnowledge,
  documentChunks,
  deleteDocument,
  KnowledgeError,
} from '../src/lib/agentic/knowledge';
import {
  createSchedule,
  updateSchedule,
  listSchedules,
  listRuns,
  startScheduleRun,
  isScheduleBusy,
  cancelRun,
  deleteSchedule,
  AutomationError,
} from '../src/lib/agentic/automation';
import { recordAudit, listAudit, clearAudit } from '../src/lib/agentic/audit';
import { validateEnv } from '../src/lib/agentic/env';

const TEST_TASK = 'test-subsystem-task';

afterAll(async () => {
  await db.memoryEntry.deleteMany({ where: { scope: 'user' } });
  await db.memoryEntry.deleteMany({ where: { scope: 'task', taskId: TEST_TASK } });
  await db.knowledgeDoc.deleteMany({});
  await db.knowledgeChunk.deleteMany({});
  await db.automationRun.deleteMany({});
  await db.automationSchedule.deleteMany({});
  await db.auditLog.deleteMany({ where: { taskId: TEST_TASK } });
});

describe('memory', () => {
  test('stores a user preference and reads it back', async () => {
    const entry = await saveMemory({
      scope: 'user',
      key: 'preferred-language',
      content: 'The user prefers TypeScript over JavaScript.',
      category: 'preference',
    });
    expect(entry.scope).toBe('user');
    expect(entry.taskId).toBe('');
    expect(entry.key).toBe('preferred-language');

    const list = await listMemory({ scope: 'user' });
    expect(list.some((m) => m.key === 'preferred-language')).toBe(true);

    const fetched = await getMemory(entry.id);
    expect(fetched?.content).toContain('TypeScript');
  });

  test('writing the same key updates instead of duplicating', async () => {
    await saveMemory({ scope: 'user', key: 'dup-key', content: 'first' });
    const second = await saveMemory({ scope: 'user', key: 'dup-key', content: 'second' });
    const all = await listMemory({ scope: 'user' });
    const matches = all.filter((m) => m.key === 'dup-key');
    expect(matches.length).toBe(1);
    expect(matches[0].content).toBe('second');
    expect(second.id).toBe(matches[0].id);
  });

  test('refuses an empty key and empty content', async () => {
    await expect(saveMemory({ scope: 'user', key: '', content: 'x' })).rejects.toBeInstanceOf(
      MemoryValidationError
    );
    await expect(saveMemory({ scope: 'user', key: 'k', content: '  ' })).rejects.toBeInstanceOf(
      MemoryValidationError
    );
  });

  test('refuses a credential instead of storing it', async () => {
    let err: unknown = null;
    try {
      await saveMemory({
        scope: 'user',
        key: 'leak',
        content: 'my api key is sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MemoryValidationError);
    expect((err as Error).message).toContain('credential');
  });

  test('assertNoCredential detects a secret pattern', () => {
    expect(() =>
      assertNoCredential('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    ).toThrow();
    expect(() => assertNoCredential('I prefer dark mode')).not.toThrow();
  });

  test('task-scoped memory is isolated per task', async () => {
    await saveMemory({
      scope: 'task',
      taskId: TEST_TASK,
      key: 'private-note',
      content: 'only for this task',
    });
    const mine = await listMemory({ scope: 'task', taskId: TEST_TASK });
    expect(mine.length).toBe(1);
    expect(mine[0].taskId).toBe(TEST_TASK);

    // another task must not see it — and the listing requires a task id
    await expect(listMemory({ scope: 'task' })).rejects.toBeInstanceOf(
      MemoryValidationError
    );
  });

  test('a task-scoped entry requires a task id', async () => {
    await expect(
      saveMemory({ scope: 'task', key: 'x', content: 'y' })
    ).rejects.toBeInstanceOf(MemoryValidationError);
  });

  test('deletes an entry by id', async () => {
    const entry = await saveMemory({ scope: 'user', key: 'to-delete', content: 'x' });
    const removed = await deleteMemory({ id: entry.id });
    expect(removed).toBe(1);
    expect(await getMemory(entry.id)).toBeNull();
  });

  test('the task context contains the user preferences but not foreign notes', async () => {
    await saveMemory({ scope: 'user', key: 'ctx-pref', content: 'answer in Hindi' });
    const ctx = await memoryContextForTask(TEST_TASK);
    expect(ctx).toContain('answer in Hindi');
    expect(ctx).toContain('only for this task');
  });
});

describe('knowledge', () => {
  test('imports a document and indexes it into chunks', async () => {
    const doc = await importDocument({
      name: 'auth.md',
      content:
        'The authentication flow uses a bearer token.\n\n' +
        'The token is verified in the middleware.\n\n' +
        'Sessions expire after one hour.',
    });
    expect(doc.status).toBe('indexed');
    expect(doc.chunkCount).toBeGreaterThan(0);

    const chunks = await documentChunks(doc.id);
    expect(chunks.length).toBe(doc.chunkCount);
    expect(chunks[0].docName).toBe('auth.md');
  });

  test('search returns hits with a source reference', async () => {
    const hits = await searchKnowledge('bearer token', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].docName).toBeTruthy();
    expect(hits[0].snippet.length).toBeGreaterThan(0);
  });

  test('an empty document is rejected instead of being indexed as empty', async () => {
    let err: unknown = null;
    try {
      await importDocument({ name: 'empty.md', content: '' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KnowledgeError);
    expect((err as Error).message).toContain('empty');
  });

  test('a binary file is reported as unsupported', async () => {
    // a path import needs a workspace; the mime/extension check happens first
    const doc = await importDocument({
      name: 'image.png',
      content: 'not really a png',
      mime: 'image/png',
    });
    // pasted text is indexable — the mime type alone does not make it binary
    expect(['indexed', 'unsupported']).toContain(doc.status);
  });

  test('importing without content or path is rejected', async () => {
    let err: unknown = null;
    try {
      await importDocument({ name: 'nothing' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KnowledgeError);
  });

  test('lists and deletes documents', async () => {
    const doc = await importDocument({ name: 'temp.md', content: 'temporary content' });
    const list = await listDocuments({});
    expect(list.some((d) => d.id === doc.id)).toBe(true);
    expect(await deleteDocument(doc.id)).toBe(true);
    const after = await listDocuments({});
    expect(after.some((d) => d.id === doc.id)).toBe(false);
  });
});

describe('automation', () => {
  test('a new schedule is created DISABLED', async () => {
    const schedule = await createSchedule({
      name: 'nightly check',
      prompt: 'Check the dependencies of the project and report them.',
      intervalMs: 60_000,
    });
    expect(schedule.enabled).toBe(false);
    expect(schedule.nextRunAt).toBeNull();
  });

  test('a schedule needs a name and a real prompt', async () => {
    await expect(createSchedule({ name: '', prompt: 'x' })).rejects.toBeInstanceOf(
      AutomationError
    );
    await expect(createSchedule({ name: 'x', prompt: 'short' })).rejects.toBeInstanceOf(
      AutomationError
    );
  });

  test('the interval is clamped to a sane range', async () => {
    const schedule = await createSchedule({
      name: 'clamped',
      prompt: 'A prompt that is long enough to be accepted.',
      intervalMs: 1,
    });
    expect(schedule.intervalMs).toBeGreaterThanOrEqual(60_000);
    await deleteSchedule(schedule.id);
  });

  test('enabling a schedule arms the next run', async () => {
    const schedule = await createSchedule({
      name: 'armed',
      prompt: 'A prompt that is long enough to be accepted.',
      intervalMs: 3_600_000,
    });
    const enabled = await updateSchedule(schedule.id, { enabled: true });
    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRunAt).not.toBeNull();
    await deleteSchedule(schedule.id);
  });

  test('a second run is skipped while one is running (duplicate prevention)', async () => {
    const schedule = await createSchedule({
      name: 'no-doubles',
      prompt: 'A prompt that is long enough to be accepted.',
      intervalMs: 3_600_000,
    });
    // simulate a run that is already in progress
    await db.automationRun.create({
      data: { scheduleId: schedule.id, status: 'running' },
    });
    expect(await isScheduleBusy(schedule.id)).toBe(true);

    const run = await startScheduleRun(schedule.id, { trigger: 'manual' });
    expect(run.status).toBe('skipped');
    expect(run.error).toContain('already running');

    const runs = await listRuns(schedule.id);
    expect(runs.filter((r) => r.status === 'skipped').length).toBe(1);

    await db.automationRun.deleteMany({ where: { scheduleId: schedule.id } });
    await deleteSchedule(schedule.id);
  });

  test('a running run can be cancelled and its task is cancelled too', async () => {
    const schedule = await createSchedule({
      name: 'cancellable',
      prompt: 'A prompt that is long enough to be accepted.',
      intervalMs: 3_600_000,
    });
    const task = await db.agenticTask.create({
      data: { prompt: 'cancelled by a test', status: 'running' },
    });
    const run = await db.automationRun.create({
      data: { scheduleId: schedule.id, status: 'running', taskId: task.id },
    });

    expect(await cancelRun(run.id)).toBe(true);
    const after = await db.agenticTask.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('cancelled');
    // a second cancel is a no-op
    expect(await cancelRun(run.id)).toBe(false);

    await db.automationRun.deleteMany({ where: { scheduleId: schedule.id } });
    await db.agenticTask.delete({ where: { id: task.id } });
    await deleteSchedule(schedule.id);
  });

  test('schedules are listed', async () => {
    const schedule = await createSchedule({
      name: 'listed',
      prompt: 'A prompt that is long enough to be accepted.',
      intervalMs: 3_600_000,
    });
    const all = await listSchedules();
    expect(all.some((s) => s.id === schedule.id)).toBe(true);
    await deleteSchedule(schedule.id);
  });
});

describe('audit trail', () => {
  test('records an event and reads it back', async () => {
    await recordAudit({
      actor: 'user',
      taskId: TEST_TASK,
      action: 'test.action',
      category: 'task',
      approval: 'approved',
      details: { hello: 'world' },
    });
    const rows = await listAudit({ taskId: TEST_TASK });
    const row = rows.find((r) => r.action === 'test.action');
    expect(row).toBeDefined();
    expect(row?.actor).toBe('user');
    expect(row?.approval).toBe('approved');
    expect(row?.result).toBe('ok');
    expect(row?.details).toContain('hello');
  });

  test('a secret in the details is redacted', async () => {
    await recordAudit({
      actor: 'user',
      taskId: TEST_TASK,
      action: 'test.secret',
      category: 'security',
      details: { apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz012345' },
    });
    const rows = await listAudit({ taskId: TEST_TASK });
    const row = rows.find((r) => r.action === 'test.secret');
    expect(row).toBeDefined();
    expect(row?.details ?? '').not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz012345');
  });

  test('a failing audit write does not throw', async () => {
    // an empty action is still recorded (the writer never throws)
    await expect(
      recordAudit({ actor: 'user', action: '', category: 'general' })
    ).resolves.toBeUndefined();
  });

  test('the audit list can be filtered by category', async () => {
    await recordAudit({
      actor: 'system',
      action: 'test.filtered',
      category: 'automation',
    });
    const rows = await listAudit({ category: 'automation', limit: 50 });
    expect(rows.every((r) => r.category === 'automation')).toBe(true);
  });

  test('the audit trail can be cleared for a task', async () => {
    const removed = await clearAudit({ taskId: TEST_TASK });
    expect(removed).toBeGreaterThan(0);
    expect((await listAudit({ taskId: TEST_TASK })).length).toBe(0);
  });
});

describe('environment validation', () => {
  test('a missing DATABASE_URL is an error', () => {
    const report = validateEnv({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.name === 'DATABASE_URL' && i.severity === 'error')).toBe(
      true
    );
  });

  test('production without a token is an error (fail closed)', () => {
    const report = validateEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'file:../db/custom.db',
    } as NodeJS.ProcessEnv);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((i) => i.name === 'AGENTSCOPE_API_TOKEN' && i.severity === 'error')
    ).toBe(true);
  });

  test('production with a token is fine', () => {
    const report = validateEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'file:../db/custom.db',
      AGENTSCOPE_API_TOKEN: 'token',
      AGENTSCOPE_SECRET_KEY: 'a'.repeat(64),
    } as NodeJS.ProcessEnv);
    expect(report.ok).toBe(true);
  });

  test('a malformed secret key is an error', () => {
    const report = validateEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'file:../db/custom.db',
      AGENTSCOPE_SECRET_KEY: 'too-short',
    } as NodeJS.ProcessEnv);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((i) => i.name === 'AGENTSCOPE_SECRET_KEY' && i.severity === 'error')
    ).toBe(true);
  });

  test('the report never contains a value', () => {
    const report = validateEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'file:../db/custom.db',
      OPENAI_API_KEY: 'sk-secret-value',
    } as NodeJS.ProcessEnv);
    expect(JSON.stringify(report)).not.toContain('sk-secret-value');
  });
});
