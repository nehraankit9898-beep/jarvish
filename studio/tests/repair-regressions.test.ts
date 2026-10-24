/**
 * Regression tests for defects independently reproduced during the 2026-10
 * repair pass. External/provider calls are deterministic test doubles; process,
 * filesystem and database assertions exercise the real local implementations.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import {
  createCustomTool,
  decideCustomTool,
  deleteCustomTool,
  runToolCode,
} from '@/lib/agentic/custom-tools';
import {
  executeCommand,
  CommandDeniedError,
} from '@/lib/agentic/terminal';
import {
  cancelTaskExecution,
  resetTaskExecution,
} from '@/lib/agentic/execution-cancellation';
import { createWorkspace, removeWorkspace, taskWorkspace } from '@/lib/agentic/workspace';
import { ModelRouter } from '@/lib/agentic/model-router';
import { runTask } from '@/lib/agentic/orchestrator';
import { saveMemory, MemoryValidationError } from '@/lib/agentic/memory';
import { recordAudit } from '@/lib/agentic/audit';
import { invokeTool, getAuditLog } from '@/lib/agentic/tool-registry';
import { saveProvider, removeProvider, loadRouterPolicy } from '@/lib/agentic/provider-store';
import { downloadToDownloads } from '@/lib/agentic/downloads';
import { GET as streamTask } from '@/app/api/agentic/tasks/[id]/stream/route';
import { GET as googleCallback } from '@/app/api/connectors/google/callback/route';

const id = (label: string) => `repair-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const restoreEnv = (key: string, old: string | undefined) => {
  if (old === undefined) delete process.env[key];
  else process.env[key] = old;
};

describe('repair regressions — custom tool process isolation', () => {
  test('a computed escape reaches only the child realm, not parent secrets or .env', async () => {
    const taskId = id('custom');
    const name = id('tool');
    const oldSecret = process.env.JARVISH_REGRESSION_PARENT_SECRET;
    let toolId = '';
    process.env.JARVISH_REGRESSION_PARENT_SECRET = 'parent-only-secret-value';
    try {
      const tool = await createCustomTool({
        name,
        description: 'security regression',
        params: [],
        code: `const k = 'constr' + 'uctor'; const F = params[k][k]; return F("const p=proc"+"ess; const out={pid:p.pid,secret:p.env.JARVISH_REGRESSION_PARENT_SECRET||null,file:'untested'}; try{p.getBuiltinModule('fs').readFileSync(p.cwd()+'/.env','utf8');out.file='read'}catch(e){out.file=e.code||'denied'} return out")();`,
      });
      toolId = tool.id;
      await decideCustomTool(tool.id, 'approve');
      const result = await invokeTool({ taskId, tool: name, parameters: {} });
      expect(result.ok).toBe(true);
      const data = JSON.parse(String(result.data)) as { pid: number; secret: string | null; file: string };
      expect(data.pid).not.toBe(process.pid);
      expect(data.secret).toBeNull();
      expect(data.file).not.toBe('read');
    } finally {
      restoreEnv('JARVISH_REGRESSION_PARENT_SECRET', oldSecret);
      if (toolId) await deleteCustomTool(toolId);
      else await db.customTool.deleteMany({ where: { name } });
      await db.auditLog.deleteMany({ where: { OR: [{ taskId }, { details: { contains: name } }] } });
    }
  }, 15000);

  test('an async tool that never settles is terminated instead of hanging forever', async () => {
    const started = Date.now();
    await expect(runToolCode(
      'await new Promise(() => {}); return 1;',
      {},
      { fetch: async () => { throw new Error('unused'); }, log: () => {}, now: () => Date.now(), cancel: () => {} },
      100
    )).rejects.toThrow('execution limit');
    expect(Date.now() - started).toBeLessThan(4000);
  }, 8000);
});

describe('repair regressions — terminal containment and cancellation', () => {
  test('parent traversal and an existing symlink are refused even with auto-approval', async () => {
    const taskId = id('paths');
    await createWorkspace(taskId);
    const outside = path.join(os.tmpdir(), `${id('marker')}.txt`);
    fs.writeFileSync(outside, 'outside workspace');
    const link = path.join(taskWorkspace(taskId), 'escape-link');
    try {
      fs.symlinkSync(outside, link);
      for (const command of [`cat ${JSON.stringify(outside)}`, 'cat escape-link', 'cat ../outside.txt']) {
        let denied: unknown;
        try {
          await executeCommand(taskId, command, { autoApproveDestructive: true });
        } catch (error) { denied = error; }
        expect(denied).toBeInstanceOf(CommandDeniedError);
        expect((denied as CommandDeniedError).permission).toBe('forbidden');
      }
    } finally {
      fs.rmSync(outside, { force: true });
      await removeWorkspace(taskId);
    }
  });

  test('timeout kills the whole spawned process group', async () => {
    const taskId = id('tree');
    await createWorkspace(taskId);
    resetTaskExecution(taskId);
    let childPid = 0;
    try {
      const result = await executeCommand(taskId, 'sleep 60 & echo $!; wait', {
        autoApproveDestructive: true,
        timeoutMs: 300,
      });
      childPid = Number(result.output.trim().split(/\r?\n/)[0]);
      expect(childPid).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive(childPid)).toBe(false);
    } finally {
      if (childPid && alive(childPid)) { try { process.kill(childPid, 'SIGKILL'); } catch { /* cleanup */ } }
      resetTaskExecution(taskId);
      await removeWorkspace(taskId);
    }
  });

  test('cancelling a running command kills its descendant and settles the result', async () => {
    const taskId = id('cancel-process');
    await createWorkspace(taskId);
    resetTaskExecution(taskId);
    let childPid = 0;
    try {
      const pending = executeCommand(taskId, 'sleep 60 & echo $! > child.pid; wait', {
        autoApproveDestructive: true,
        timeoutMs: 10000,
      });
      const pidFile = path.join(taskWorkspace(taskId), 'child.pid');
      for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(childPid).toBeGreaterThan(0);
      expect(cancelTaskExecution(taskId)).toBeGreaterThan(0);
      const result = await pending;
      expect(result.exitCode).not.toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive(childPid)).toBe(false);
    } finally {
      if (childPid && alive(childPid)) { try { process.kill(childPid, 'SIGKILL'); } catch { /* cleanup */ } }
      resetTaskExecution(taskId);
      await removeWorkspace(taskId);
    }
  });

  test('provider retry/call work observes task cancellation through its signal', async () => {
    const taskId = id('cancel-model');
    resetTaskExecution(taskId);
    let notifyStarted = () => {};
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const router = new ModelRouter({
      taskId,
      routing: { agents: { coder: { provider: 'openai', model: 'test-model' } } },
      complete: async (_params, config) => {
        notifyStarted();
        return new Promise((_resolve, reject) => {
          config.signal?.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
        });
      },
    });
    const pending = router.complete('coder', []);
    await started;
    expect(cancelTaskExecution(taskId)).toBe(1);
    await expect(pending).rejects.toThrow('Model call cancelled');
    resetTaskExecution(taskId);
  });
});

describe('repair regressions — orchestrator terminal truth', () => {
  const makeTask = async (label: string) => {
    const taskId = id(label);
    const plan = [{ index: 1, title: 'Analyze once', description: 'read only', kind: 'analyze', acceptance: 'notes', dependencies: [] }];
    await db.agenticTask.create({ data: {
      id: taskId,
      prompt: 'Independent read-only analysis regression',
      provider: 'zai', model: 'glm-4.6', status: 'awaiting_approval',
      plan: JSON.stringify(plan),
    } });
    await db.agenticStep.create({ data: {
      taskId, index: 1, kind: 'analyze', title: 'Analyze once', description: 'read only', status: 'pending',
    } });
    await createWorkspace(taskId);
    return taskId;
  };

  test('a failed parallel read-only step can never finish as done', async () => {
    const taskId = await makeTask('parallel-failure');
    try {
      await runTask(taskId, { complete: async () => { throw new Error('provider returned malformed response'); } });
      const task = await db.agenticTask.findUnique({ where: { id: taskId } });
      const step = await db.agenticStep.findFirst({ where: { taskId, index: 1 } });
      expect(task?.status).not.toBe('done');
      expect(['failed', 'paused']).toContain(task?.status ?? 'missing');
      expect(step?.status).toBe('failed');
    } finally {
      await db.agenticTask.deleteMany({ where: { id: taskId } });
      await removeWorkspace(taskId);
    }
  });

  test('cancellation during the last model call is not overwritten by the finisher', async () => {
    const taskId = await makeTask('finish-race');
    const events: Array<{ type: string }> = [];
    try {
      await runTask(taskId, {
        sse: (event) => events.push(event),
        complete: async () => {
          await db.agenticTask.update({ where: { id: taskId }, data: { status: 'cancelled' } });
          return 'Analysis complete\n### END';
        },
      });
      const task = await db.agenticTask.findUnique({ where: { id: taskId } });
      expect(task?.status).toBe('cancelled');
      expect(events.some((event) => event.type === 'done')).toBe(false);
    } finally {
      await db.agenticTask.deleteMany({ where: { id: taskId } });
      await removeWorkspace(taskId);
    }
  });
});

describe('repair regressions — persistence and redaction', () => {
  test('concurrent memory writes upsert one row and unquoted passwords are refused', async () => {
    const key = id('memory');
    try {
      await Promise.all(Array.from({ length: 8 }, (_, i) => saveMemory({
        key, category: 'fact', content: `concurrent-value-${i}`, source: 'repair-test',
      })));
      expect(await db.memoryEntry.count({ where: { scope: 'user', taskId: '', key } })).toBe(1);
      await expect(saveMemory({ key, content: 'password = supersecret123' })).rejects.toBeInstanceOf(MemoryValidationError);
    } finally {
      await db.memoryEntry.deleteMany({ where: { scope: 'user', taskId: '', key } });
    }
  });

  test('nested audit details and artifacts cannot retain credentials', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const action = id('audit');
    try {
      await recordAudit({
        actor: 'repair-test', action, ip,
        details: { nested: { apiKey: 'nested-secret-key-123' }, text: 'password = anothersecret123' },
        artifact: { deep: [{ accessToken: 'nested-access-token-123' }] },
      });
      const row = await db.auditLog.findFirst({ where: { action, ip } });
      expect(row).not.toBeNull();
      const stored = `${row?.details}\n${row?.artifact}`;
      expect(stored).not.toContain('nested-secret-key-123');
      expect(stored).not.toContain('anothersecret123');
      expect(stored).not.toContain('nested-access-token-123');
      expect(stored).toContain('[REDACTED]');
    } finally {
      await db.auditLog.deleteMany({ where: { action, ip } });
    }
  });

  test('tool audit redacts nested inputs/results and nonzero terminal exits are failures', async () => {
    const taskId = id('tool-audit');
    await createWorkspace(taskId);
    try {
      const secret = 'password = supersecret123';
      const write = await invokeTool({ taskId, tool: 'file-write', parameters: { path: 'secret-check.txt', content: secret } });
      expect(write.ok).toBe(true);
      const read = await invokeTool({ taskId, tool: 'file-read', parameters: { path: 'secret-check.txt' } });
      expect(read.ok).toBe(true);
      expect(JSON.stringify(read.data)).not.toContain('supersecret123');
      const audited = getAuditLog(500).filter((entry) => entry.taskId === taskId);
      expect(JSON.stringify(audited)).not.toContain('supersecret123');

      const command = 'node -e "process.exit(7)"';
      const failed = await invokeTool({ taskId, tool: 'terminal', parameters: { command }, approvedCommands: [command] });
      expect(failed.ok).toBe(false);
      expect((failed.data as { exitCode: number }).exitCode).toBe(7);
    } finally {
      await db.auditLog.deleteMany({ where: { taskId } });
      await removeWorkspace(taskId);
    }
  });
});

describe('repair regressions — provider policy', () => {
  test('model changes and explicit model eligibility control free-only routing', async () => {
    const previous = await db.providerConfig.findUnique({ where: { provider: 'openrouter' } });
    await removeProvider('openrouter');
    try {
      const free = await saveProvider({
        provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1',
        model: 'meta-llama/test:free', enabled: true, costClass: 'free',
      });
      expect(free.costClass).toBe('free');
      const paid = await saveProvider({
        provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1',
        model: 'vendor/paid-model', enabled: true,
      });
      expect(paid.costClass).toBe('paid');
      expect((await loadRouterPolicy()).costClassOf?.('openrouter', paid.model)).toBe('paid');

      await saveProvider({
        provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1',
        model: 'catalog/free-default', enabled: true, costClass: 'free',
      });
      await removeProvider('openrouter');
      await saveProvider({
        provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1',
        model: 'vendor/paid-model', enabled: true,
      });
      const fallback = await loadRouterPolicy();
      expect(fallback.costClassOf?.('openrouter', 'vendor/paid-model')).toBe('paid');
    } finally {
      await removeProvider('openrouter');
      if (previous) await db.providerConfig.create({ data: previous });
    }
  });
});

describe('repair regressions — download atomicity', () => {
  test('concurrent same-name downloads retain distinct, uncorrupted bytes', async () => {
    const taskId = id('downloads');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvish-downloads-'));
    const oldDir = process.env.AGENTSCOPE_DOWNLOADS_DIR;
    const oldFetch = globalThis.fetch;
    process.env.AGENTSCOPE_DOWNLOADS_DIR = dir;
    let calls = 0;
    globalThis.fetch = (async () => {
      const text = calls++ === 0 ? 'AAAAaaaa' : 'BBBBbbbb';
      let sent = 0;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (sent >= 2) { controller.close(); return; }
          const chunk = text.slice(sent * 4, sent * 4 + 4);
          sent++;
          controller.enqueue(new TextEncoder().encode(chunk));
        },
      }), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }) as unknown as typeof fetch;
    try {
      const url = 'https://203.0.113.10/shared.bin';
      const options = { filename: 'same.txt', taskId };
      const [a, b] = await Promise.all([downloadToDownloads(url, options), downloadToDownloads(url, options)]);
      expect(a.path).not.toBe(b.path);
      expect(a.filename).toBe(path.basename(a.path));
      expect(b.filename).toBe(path.basename(b.path));
      const contents = [fs.readFileSync(a.path, 'utf8'), fs.readFileSync(b.path, 'utf8')].sort();
      expect(contents).toEqual(['AAAAaaaa', 'BBBBbbbb']);
      expect(fs.readdirSync(dir).filter((name) => name.includes('agentscope-part'))).toEqual([]);
    } finally {
      globalThis.fetch = oldFetch;
      restoreEnv('AGENTSCOPE_DOWNLOADS_DIR', oldDir);
      fs.rmSync(dir, { recursive: true, force: true });
      await db.auditLog.deleteMany({ where: { taskId } });
      await db.notification.deleteMany({ where: { taskId } });
    }
  }, 15000);
});

describe('repair regressions — HTTP stream and OAuth boundaries', () => {
  test('task SSE accepts the header token and rejects missing/query-string credentials', async () => {
    const taskId = id('sse');
    const oldToken = process.env.AGENTSCOPE_API_TOKEN;
    const oldEnv = process.env.NODE_ENV;
    process.env.AGENTSCOPE_API_TOKEN = 'repair-sse-test-token';
    Object.assign(process.env, { NODE_ENV: 'test' });
    await db.agenticTask.create({ data: { id: taskId, prompt: 'stream test', status: 'done' } });
    try {
      const url = `http://localhost/api/agentic/tasks/${taskId}/stream`;
      const missing = await streamTask(new NextRequest(url), { params: Promise.resolve({ id: taskId }) });
      expect(missing.status).toBe(401);
      const query = await streamTask(new NextRequest(`${url}?token=repair-sse-test-token`), { params: Promise.resolve({ id: taskId }) });
      expect(query.status).toBe(401);
      const authorized = await streamTask(new NextRequest(url, {
        headers: { authorization: 'Bearer repair-sse-test-token' },
      }), { params: Promise.resolve({ id: taskId }) });
      expect(authorized.status).toBe(200);
      await authorized.body?.cancel();
    } finally {
      await db.agenticTask.deleteMany({ where: { id: taskId } });
      restoreEnv('AGENTSCOPE_API_TOKEN', oldToken);
      restoreEnv('NODE_ENV', oldEnv);
    }
  });

  test('OAuth errors are escaped HTML with restrictive browser headers', async () => {
    const ip = '192.0.2.231';
    try {
      const response = await googleCallback(new NextRequest(
        'http://localhost/api/connectors/google/callback?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
        { headers: { 'x-real-ip': ip } }
      ));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img src=x');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      await db.auditLog.deleteMany({ where: { ip } });
    }
  });
});
