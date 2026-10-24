// Regression tests for the second bug-hunt round (2026-10, agent audit loop).
// Each test pins the BROKEN behaviour that was reported, then the fixed one:
//
//   H5  plan steps that depend on a dropped step were silently never run
//   H6  a skipped duplicate run released ANOTHER starter's in-process claim
//   H7  executeCommand classified the whitespace-folded command (multi-line
//       payloads lost their line structure before the classifier saw them)
//   H8  the custom-tool sandbox was escapable (Function / .constructor / raw fetch)
//   H9  a deleted custom tool stayed live in the registry
//   H10 invokeTool ignored the declared parameter schema
//   H11 "health checks" executed tools — with side effects, auto-approving the
//       destructive ones, and reporting healthy tools as broken
//   H12 a corrupt worker-lock heartbeat counted as "fresh"
//   H13 the SSRF guard called any IP literal a loopback host and missed the
//       IPv6 loopback/mapped forms
// Run: bun test tests/bug-hunt.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../src/lib/db';
import {
  checkDependencies,
  readySteps,
  sanitizeStepDependencies,
  planIndexes,
} from '../src/lib/agentic/scheduler';
import type { PlanStep } from '../src/lib/agentic/types';
import {
  createSchedule,
  deleteSchedule,
  startScheduleRun,
} from '../src/lib/agentic/automation';
import { CommandDeniedError, executeCommand } from '../src/lib/agentic/terminal';
import { checkCommand } from '../src/lib/agentic/permissions';
import { classifyHostAction } from '../src/lib/agentic/host-control';
import { scanToolCode } from '../src/lib/agentic/custom-tools';
import { hasTool, healthCheckAllTools, invokeTool } from '../src/lib/agentic/tool-registry';
import { isWorkerAlive } from '../src/lib/agentic/worker-lock';
import { addressBlocked, assertOutboundUrl } from '../src/lib/agentic/outbound';

const step = (over: Partial<PlanStep> & { index: number }): PlanStep => ({
  title: `step ${over.index}`,
  description: '',
  kind: 'implement',
  acceptance: '',
  ...over,
});

// ---------------------------------------------------------------------------
// H5 — dangling dependency from the maxSteps truncation
// ---------------------------------------------------------------------------
describe('H5 — plan dependencies must reference steps that exist', () => {
  test('a dependency on a step the plan does not contain is ignored, not waited for', () => {
    const steps = [
      step({ index: 1 }),
      step({ index: 2, dependencies: [{ stepIndex: 5, type: 'blocks' }] }),
    ];
    const statuses = new Map(steps.map((s) => [s.index, 'pending' as const]));
    // before the fix: satisfied === false forever → step 2 never ran
    expect(checkDependencies(steps[1], statuses).satisfied).toBe(false);
    expect(checkDependencies(steps[1], statuses, planIndexes(steps)).satisfied).toBe(true);
  });

  test('readySteps never parks a step behind a phantom index', () => {
    const steps = [step({ index: 1 }), step({ index: 2, dependencies: [{ stepIndex: 9, type: 'blocks' }] })];
    const statuses = new Map<number, 'pending'>([
      [1, 'pending'],
      [2, 'pending'],
    ]);
    expect(readySteps(steps, statuses).map((s) => s.index)).toEqual([1, 2]);
  });

  test('sanitizeStepDependencies drops edges to missing steps and self edges', () => {
    const steps = [
      step({ index: 1, dependencies: [{ stepIndex: 4, type: 'blocks' }] }),
      step({ index: 2, dependencies: [{ stepIndex: 2, type: 'blocks' }, { stepIndex: 1, type: 'blocks' }] }),
    ];
    sanitizeStepDependencies(steps);
    expect(steps[0].dependencies ?? []).toEqual([]);
    expect(steps[1].dependencies).toEqual([{ stepIndex: 1, type: 'blocks' }]);
  });

  test('a real (kept) dependency is still respected', () => {
    const steps = [step({ index: 1 }), step({ index: 2, dependencies: [{ stepIndex: 1, type: 'blocks' }] })];
    const statuses = new Map<number, 'pending'>([[1, 'pending'], [2, 'pending']]);
    expect(readySteps(steps, statuses).map((s) => s.index)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// H6 — the schedule claim must belong to the call that took it
// ---------------------------------------------------------------------------
describe('H6 — duplicate-run guard keeps its claim while a run is starting', () => {
  let scheduleId = '';

  beforeEach(async () => {
    await db.automationSchedule.deleteMany();
    await db.automationRun.deleteMany();
    const s = await createSchedule({
      name: 'nightly',
      prompt: 'run the nightly build check',
      intervalMs: 60_000,
    });
    scheduleId = s.id;
  });

  afterEach(() => {
    delete (db.automationRun as unknown as { create?: unknown }).create;
  });

  test('a second starter cannot release the first one claim', async () => {
    const runTable = db.automationRun as unknown as {
      create: (args: any) => Promise<any>;
    };
    const realCreate = runTable.create.bind(runTable);
    let gate = Promise.resolve();
    let release = () => {};
    gate = new Promise((r) => (release = r));
    let blocked = false;
    runTable.create = async (args: any) => {
      // the FIRST run row creation blocks, so the schedule is "in flight" with
      // no DB evidence yet — exactly the window the in-process claim guards
      if (!blocked && args?.data?.status === 'running') {
        blocked = true;
        await gate;
      }
      return realCreate(args);
    };

    const first = startScheduleRun(scheduleId);
    await new Promise((r) => setTimeout(r, 0));
    // a duplicate attempt while the first one is still starting → skipped
    const second = await startScheduleRun(scheduleId);
    expect(second.status).toBe('skipped');

    // a THIRD attempt now: with the bug the second call had already dropped the
    // first call's claim, so this starts a concurrent run
    const third = await startScheduleRun(scheduleId);
    expect(third.status).toBe('skipped');

    release();
    await first;
    const runs = await db.automationRun.findMany();
    // exactly ONE real run for the schedule (the first call) — the duplicate
    // attempts recorded skips instead of starting work twice
    const real = runs.filter((r) => r.status !== 'skipped');
    expect(real.length).toBe(1);
    expect(runs.filter((r) => r.status === 'skipped').length).toBe(2);

    // and the claim is gone once the starter finished
    const fourth = await startScheduleRun(scheduleId);
    expect(fourth.status).not.toBe('skipped');
    await deleteSchedule(scheduleId);
  });
});

// ---------------------------------------------------------------------------
// H7 / H15 — classification must see the raw payload
// ---------------------------------------------------------------------------
describe('H7 — shell payloads are classified before any whitespace folding', () => {
  test('the classifier itself still escalates a multi-line payload', () => {
    expect(checkCommand('echo hi\nrm -rf ./build').permission).toBe('destructive');
    expect(checkCommand('echo hi\necho there').permission).toBe('safe');
  });

  test('executeCommand refuses the multi-line payload instead of auto-running it', async () => {
    // 'echo hi\nrm -rf ./build' normalized to ONE line reads as a plain echo —
    // the old code classified that folded form and reported permission 'safe'
    const p = await executeCommand('task-h7', 'echo hi\nrm -rf ./build').catch((e) => e);
    expect(p).toBeInstanceOf(CommandDeniedError);
    expect((p as CommandDeniedError).permission).toBe('destructive');
  });

  test('host exec classification escalates a multi-line payload too', () => {
    const cls = classifyHostAction({ kind: 'exec', command: 'echo hi\nrm -rf ./build' });
    expect(cls.permission).toBe('destructive');
    const benign = classifyHostAction({ kind: 'exec', command: 'ls -la' });
    expect(benign.permission).toBe('review');
  });
});

// ---------------------------------------------------------------------------
// H8 / H9 — the custom-tool sandbox
// ---------------------------------------------------------------------------
describe('H8 — the custom tool sandbox cannot be escaped by code generation', () => {
  const rejects = (code: string) => scanToolCode(code).ok === false;

  test('the classic realm hops are refused', () => {
    expect(rejects('return Function("return process")()')).toBe(true);
    expect(rejects('return new Function("return 1")()')).toBe(true);
    expect(rejects('return "".constructor.constructor("return process")()')).toBe(true);
    expect(rejects('return Object.getPrototypeOf({})')).toBe(true);
    expect(rejects('return globalThis.process.env')).toBe(true);
    expect(rejects('return fetch("http://169.254.169.254/")')).toBe(true);
    expect(rejects('return eval("1+1")')).toBe(true);
  });

  test('ordinary tool code still passes the scan', () => {
    expect(
      scanToolCode('const r = await api.fetch("/search?q=" + params.q); return JSON.parse(r.body);').ok
    ).toBe(true);
    // prose that merely MENTIONS these words must not be rejected
    expect(scanToolCode('return { note: "this requires a key and imports nothing" }').ok).toBe(true);
  });

  test('a running tool cannot see the host realm', async () => {
    const { createCustomTool, decideCustomTool } = await import('../src/lib/agentic/custom-tools');
    await db.customTool.deleteMany();
    const { id } = await createCustomTool({
      name: 'realm-probe',
      description: 'probes what the sandbox can reach',
      params: [{ name: 'q', type: 'string', required: true }],
      code: 'return { q: params.q, proc: typeof process, fetch: typeof fetch, xhr: typeof XMLHttpRequest, sum: 1 + 1 }',
    });
    const decided = await decideCustomTool(id, 'approve');
    expect(decided.ok).toBe(true);

    const res = await invokeTool({ tool: 'realm-probe', parameters: { q: 'hi' }, taskId: 't-h8' });
    expect(res.ok).toBe(true);
    const data = JSON.parse(res.data as string);
    expect(data.q).toBe('hi');
    expect(data.sum).toBe(2);
    expect(data.proc).toBe('undefined');
    expect(data.fetch).toBe('undefined');
    expect(data.xhr).toBe('undefined');
    // the sandbox's own global object exists, but it is not the host's
    expect(typeof globalThis.__h8_leaked).toBe('undefined');
  });

  test('a tool that tries to compile code at runtime is stopped by the context', async () => {
    const { createCustomTool, decideCustomTool } = await import('../src/lib/agentic/custom-tools');
    await db.customTool.deleteMany();
    const { id } = await createCustomTool({
      name: 'sneaky-tool',
      description: 'builds the forbidden token at runtime',
      params: [],
      // 'constructor' never appears literally — it is assembled from parts, so
      // a pure source scan cannot see it. The context must.
      code: 'const key = ["con", "structor"].join(""); const f = ""[key][key]; return f("return 42")()',
    });
    expect((await decideCustomTool(id, 'approve')).ok).toBe(true);
    const res = await invokeTool({ tool: 'sneaky-tool', parameters: {}, taskId: 't-h8' });
    expect(res.ok).toBe(false);
  });
});

describe('H9 — deleting a custom tool takes it out of the live registry', () => {
  test('a deleted tool is no longer invocable', async () => {
    const { createCustomTool, decideCustomTool, deleteCustomTool } = await import(
      '../src/lib/agentic/custom-tools'
    );
    await db.customTool.deleteMany();
    const { id } = await createCustomTool({
      name: 'doomed-tool',
      description: 'a tool that is about to be deleted',
      params: [],
      code: 'return { hello: "world" }',
    });
    expect((await decideCustomTool(id, 'approve')).ok).toBe(true);
    expect(hasTool('doomed-tool')).toBe(true);

    expect(await deleteCustomTool(id)).toBe(true);
    expect(hasTool('doomed-tool')).toBe(false);
    const res = await invokeTool({ tool: 'doomed-tool', parameters: {}, taskId: 't-h9' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown tool/);
  });
});

// ---------------------------------------------------------------------------
// H10 — declared parameter schema is enforced
// ---------------------------------------------------------------------------
describe('H10 — tool payloads are validated against the declared schema', () => {
  test('a missing required parameter is reported as such', async () => {
    const res = await invokeTool({ tool: 'file-read', parameters: {}, taskId: 't-h10' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing required parameter "path"/);
  });

  test('a parameter of the wrong declared type is refused', async () => {
    const res = await invokeTool({
      tool: 'file-write',
      parameters: { path: 'a.txt', content: 1234 },
      taskId: 't-h10',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/parameter "content" must be a string/);
  });

  test('a long payload is no longer rejected as "forbidden" (H4 stays fixed)', async () => {
    const res = await invokeTool({
      tool: 'file-write',
      parameters: { path: 'long.txt', content: 'x'.repeat(4000) },
      taskId: 't-h10',
    });
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H11 — health checks must not touch anything
// ---------------------------------------------------------------------------
describe('H11 — a health check is a read-only check', () => {
  const taskId = 'zz-h11-health';
  const ws = path.join(process.cwd(), '.agentic-workspace', taskId);

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  test('probing the catalog creates no workspace, no git repo and no commit', async () => {
    const results = await healthCheckAllTools(taskId);
    expect(results.length).toBeGreaterThan(0);
    expect(fs.existsSync(ws)).toBe(false);
    expect(fs.existsSync(path.join(ws, '.git'))).toBe(false);
  });

  test('tools that need parameters are not reported as broken', async () => {
    const results = await healthCheckAllTools(taskId);
    const broken = results.filter((r) => !r.ok).map((r) => `${r.tool}: ${r.error}`);
    expect(broken).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// H12 — a corrupt heartbeat is stale, not fresh
// ---------------------------------------------------------------------------
describe('H12 — worker lock heartbeat parsing', () => {
  test('an unparseable heartbeat never counts as alive', () => {
    const file = path.join(os.tmpdir(), `jarvish-lock-${process.pid}-h12.json`);
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({ pid: process.pid, startedAt: 'x', heartbeatAt: 'not-a-date' })
      );
      expect(isWorkerAlive(Date.now(), file)).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// H13 — SSRF guard
// ---------------------------------------------------------------------------
describe('H13 — the SSRF guard understands IPv6 and does not trust IP literals', () => {
  test('every spelling of the loopback address is blocked', () => {
    expect(addressBlocked('::1')).toBe('loopback address');
    expect(addressBlocked('0:0:0:0:0:0:0:1')).toBe('loopback address');
    expect(addressBlocked('::ffff:127.0.0.1')).toBe('loopback address');
    expect(addressBlocked('::127.0.0.1')).toBe('loopback address');
    expect(addressBlocked('2002:7f00:1::')).toBe('loopback address (via 6to4)');
    expect(addressBlocked('fe80::2')).toBe('link-local address');
    expect(addressBlocked('fd12:3456::1')).toBe('unique local address');
    expect(addressBlocked('2606:4700:4700::1111')).toBe(null);
  });

  test('a public IP literal is not a "loopback host" (https stays required)', async () => {
    // allowLoopback exists for Ollama on 127.0.0.1 — it must not silently
    // downgrade https for an arbitrary public address
    await expect(assertOutboundUrl('http://203.0.113.9/v1', { allowLoopback: true })).rejects.toThrow(
      /Only https/
    );
    await expect(assertOutboundUrl('http://127.0.0.1:11434/v1', { allowLoopback: true })).resolves.toBeDefined();
  });

  test('bracketed v6 literals are checked as addresses, not looked up as hosts', async () => {
    await expect(assertOutboundUrl('http://[::1]:11434/v1', { requireHttps: false })).rejects.toThrow(
      /loopback/
    );
    await expect(
      assertOutboundUrl('http://[::ffff:169.254.169.254]/x', { requireHttps: false })
    ).rejects.toThrow(/link-local/);
  });
});
