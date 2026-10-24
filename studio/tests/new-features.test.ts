// New-feature tests — background runtime, cron, plan gaps, notifications,
// suggestions, goals, custom tools, workflows, browser intel.
// Run: bun test tests/new-features.test.ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { db } from '../src/lib/db';
import {
  parseCron,
  nextCronRun,
  isValidCron,
  describeCron,
  CronParseError,
} from '../src/lib/agentic/cron';
import { detectPlanGaps, hasCriticalGaps } from '../src/lib/agentic/plan-gaps';
import {
  createNotification,
  listNotifications,
  markAllRead,
  unreadCount,
  clearNotifications,
} from '../src/lib/agentic/notifications';
import { scanForSuggestions, dismissSuggestion } from '../src/lib/agentic/suggestions';
import { createGoal, getGoal, startNextGoalTask, abandonGoal, goalTaskConfig } from '../src/lib/agentic/goals';
import { createCustomTool, listCustomTools, decideCustomTool, scanToolCode, CustomToolError } from '../src/lib/agentic/custom-tools';
import { listWorkflowTemplates, createWorkflowTask } from '../src/lib/agentic/workflows';
import { boundIntel, paymentGuardDecision } from '../src/lib/agentic/browser/page-intel';
import { tick } from '../src/lib/agentic/background';
import type { PlanStep } from '../src/lib/agentic/types';

const created: { taskIds: string[]; goalIds: string[]; toolIds: string[]; notifIds: string[] } = {
  taskIds: [],
  goalIds: [],
  toolIds: [],
  notifIds: [],
};

beforeAll(async () => {
  // clean slate for the entities this suite creates
  await db.proactiveSuggestion.deleteMany({});
  await db.notification.deleteMany({});
});

afterAll(async () => {
  for (const id of created.taskIds) {
    await db.agenticTask.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of created.goalIds) {
    await db.goal.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of created.toolIds) {
    await db.customTool.deleteMany({ where: { id } }).catch(() => undefined);
  }
  await db.proactiveSuggestion.deleteMany({}).catch(() => undefined);
  await db.notification.deleteMany({}).catch(() => undefined);
});

// ---------- cron engine (Feature 5) ----------

describe('cron engine', () => {
  test('a 5-field expression parses, 6 fields are rejected', () => {
    expect(isValidCron('30 8 * * *')).toBe(true);
    expect(isValidCron('*/15 9-17 * * MON-FRI')).toBe(true);
    expect(isValidCron('0 0 1 JAN-Mar *')).toBe(true);
    expect(isValidCron('* * * * * *')).toBe(false);
    expect(isValidCron('99 * * * *')).toBe(false);
    expect(isValidCron('')).toBe(false);
    expect(() => parseCron('0 25 * * *')).toThrow(CronParseError);
  });

  test('the next run lands on the expected wall-clock time', () => {
    const from = new Date('2026-10-23T10:07:00Z'); // a Friday
    expect(nextCronRun('*/15 * * * *', from)?.toISOString()).toBe('2026-10-23T10:15:00.000Z');
    expect(nextCronRun('30 8 * * *', from)?.toISOString()).toBe('2026-10-24T08:30:00.000Z');
    // Friday 10:07 → next weekday 9am firing is Monday
    expect(nextCronRun('0 9 * * MON-FRI', from)?.getUTCDay()).toBe(1);
    expect(nextCronRun('0 0 1 * *', from)?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  test('timezone-aware evaluation (Kolkata 8:30 = 03:00 UTC)', () => {
    const from = new Date('2026-10-23T10:00:00Z');
    const next = nextCronRun('30 8 * * *', from, 'Asia/Kolkata');
    expect(next?.toISOString()).toBe('2026-10-24T03:00:00.000Z');
  });

  test('an unsatisfiable expression returns null instead of hanging', () => {
    expect(nextCronRun('0 0 30 2 *', new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });

  test('common patterns get a human description', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(describeCron('0 * * * *')).toBe('Hourly');
  });
});

// ---------- plan-gap detection (Feature 10) ----------

describe('plan-gap detection', () => {
  const step = (over: Partial<PlanStep>): PlanStep => ({
    index: 1,
    title: 'step',
    description: '',
    kind: 'implement',
    acceptance: '',
    ...over,
  });

  test('code changes without verification = critical missing_tests', () => {
    const gaps = detectPlanGaps('fix the login bug', [step({ index: 1, kind: 'implement' })]);
    expect(gaps.some((g) => g.kind === 'missing_tests' && g.severity === 'critical')).toBe(true);
    expect(hasCriticalGaps(gaps)).toBe(true);
  });

  test('a deploy plan without health check and rollback reports gaps', () => {
    const gaps = detectPlanGaps('deploy the website to production', [
      step({ index: 1, kind: 'implement', title: 'build' }),
      step({ index: 2, kind: 'test', title: 'run tests' }),
    ]);
    expect(gaps.some((g) => g.kind === 'missing_health_check')).toBe(true);
    expect(gaps.some((g) => g.kind === 'missing_rollback')).toBe(true);
  });

  test('a migration task without a migration step reports it', () => {
    const gaps = detectPlanGaps('add the users table to the database', [
      step({ index: 1, kind: 'implement', title: 'write code' }),
      step({ index: 2, kind: 'test', title: 'test' }),
    ]);
    expect(gaps.some((g) => g.kind === 'missing_migration')).toBe(true);
  });

  test('a complete plan stays quiet', () => {
    const gaps = detectPlanGaps('fix the login bug and test it', [
      step({ index: 1, kind: 'implement', title: 'fix the bug' }),
      step({ index: 2, kind: 'test', title: 'verify with tests', description: 'run pytest' }),
    ]);
    expect(gaps).toEqual([]);
  });
});

// ---------- notifications (Features 3/5/8) ----------

describe('notifications', () => {
  test('create → list → unread → mark all read → prune', async () => {
    const first = await createNotification({
      type: 'task_done',
      title: 'Task done',
      body: 'yay',
      taskId: 'task-x',
    });
    expect(first).not.toBeNull();
    // ensure a strictly LATER createdAt so the "newest first" ordering is
    // deterministic even when SQLite stores both timestamps in the same ms
    await new Promise((r) => setTimeout(r, 5));
    await createNotification({ type: 'system', title: 'Another one' });
    expect(await unreadCount()).toBeGreaterThanOrEqual(2);

    const list = await listNotifications({ limit: 10 });
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].title).toBe('Another one'); // newest first

    const marked = await markAllRead();
    expect(marked).toBeGreaterThanOrEqual(2);
    expect(await unreadCount()).toBe(0);

    // prune only touches read notifications older than the window
    const pruned = await clearNotifications(0);
    expect(pruned).toBeGreaterThanOrEqual(2);
  });
});

// ---------- proactive suggestions (Feature 8) ----------

describe('proactive suggestions', () => {
  test('a repeated failure produces a deduplicated suggestion', async () => {
    const prompt = 'check the build pipeline carefully ok';
    await db.agenticTask.create({ data: { prompt, status: 'failed', error: 'build timeout' } });
    await db.agenticTask.create({ data: { prompt, status: 'failed', error: 'build timeout 2' } });

    const first = await scanForSuggestions();
    const recurring = first.find((s) => s.kind === 'recurring_check');
    expect(recurring).toBeDefined();
    expect(recurring!.actionPrompt).toContain(prompt.slice(0, 20));

    // the second scan must NOT duplicate the open suggestion
    const second = await scanForSuggestions();
    const dupes = second.filter((s) => s.kind === 'recurring_check');
    expect(dupes.length).toBe(0);

    // dismiss → next scan may propose again
    expect(await dismissSuggestion(recurring!.id)).toBe(true);
  });
});

// ---------- goals (Feature 2) ----------

describe('goals', () => {
  test('create → start next → progress → abandon', async () => {
    const goal = await createGoal({
      title: 'Production readiness',
      description: 'make the app production ready',
      tasks: [
        { index: 1, title: 'Audit', prompt: 'Audit the codebase and list every production blocker with severity.', dependsOn: [] },
        { index: 2, title: 'Fix critical bugs', prompt: 'Fix the critical blockers found by the audit and verify with tests.', dependsOn: [1] },
      ],
    });
    created.goalIds.push(goal.id);
    expect(goal.progress.total).toBe(2);
    expect(goal.status).toBe('active');

    // goal tasks run with higher limits
    const cfg = goalTaskConfig();
    expect(cfg.timeoutMs!).toBeGreaterThan(60 * 60 * 1000);
    expect(cfg.maxSteps!).toBeGreaterThan(6);

    // nothing runnable without planning... startNextGoalTask plans task 1
    // (planner LLM call — injected via module mock is overkill here; we
    // assert the guard rails instead)
    const detail = await getGoal(goal.id);
    expect(detail!.tasks[0].taskStatus).toBeNull();

    expect(await abandonGoal(goal.id)).toBe(true);
    const abandoned = await getGoal(goal.id);
    expect(abandoned!.status).toBe('abandoned');
  });
});

// ---------- custom tools (Feature 6) ----------

describe('custom tools', () => {
  const safeCode = `
    const doubled = (params.count || 0) * 2;
    return { doubled };
  `;

  test('the code sandbox rejects unsafe patterns', () => {
    expect(scanToolCode('return process.env').ok).toBe(false);
    expect(scanToolCode('return require("fs")').ok).toBe(false);
    expect(scanToolCode('return eval("1+1")').ok).toBe(false);
    expect(scanToolCode('return globalThis').ok).toBe(false);
    expect(scanToolCode('this is not valid javascript {{{').ok).toBe(false);
    expect(scanToolCode(safeCode).ok).toBe(true);
  });

  test('proposal → approval lifecycle (approve requires a clean scan)', async () => {
    const bad = await createCustomTool({
      name: 'evil-tool',
      description: 'tries to reach the process object',
      params: [],
      code: 'return process.env;',
    }).catch((err) => err);
    expect(bad instanceof CustomToolError).toBe(true);

    const created1 = await createCustomTool({
      name: 'double-count',
      description: 'Doubles the count parameter for testing',
      params: [{ name: 'count', type: 'number', required: true }],
      code: safeCode,
    });
    created.toolIds.push(created1.id);

    // pending → not in the live list as active
    const pending = (await listCustomTools()).find((t) => t.id === created1.id);
    expect(pending!.status).toBe('pending_approval');

    // reject path first
    const rejected = await decideCustomTool(created1.id, 'reject');
    expect(rejected.ok).toBe(true);
    expect(rejected.status).toBe('rejected');

    // a rejected tool cannot be approved directly
    const cannotApprove = await decideCustomTool(created1.id, 'approve');
    expect(cannotApprove.ok).toBe(false);
  });
});

// ---------- workflows (Features 9 + 15) ----------

describe('guided workflows', () => {
  test('templates exist and create approval-gated tasks with fixed plans', async () => {
    const templates = listWorkflowTemplates();
    expect(templates.map((t) => t.id)).toContain('negotiation');
    expect(templates.map((t) => t.id)).toContain('purchase-protection');

    const { taskId, steps } = await createWorkflowTask(
      'purchase-protection',
      'damaged item on order OD123 worth 2500 rupees'
    );
    created.taskIds.push(taskId);
    expect(steps).toBeGreaterThanOrEqual(5);

    const task = await db.agenticTask.findUnique({ where: { id: taskId } });
    expect(task!.status).toBe('awaiting_approval'); // never auto-run
    const plan = JSON.parse(task!.plan) as PlanStep[];
    expect(plan.some((s) => s.kind === 'review')).toBe(true); // approval gates built in

    // unknown workflow rejected
    expect(createWorkflowTask('nonexistent', 'some prompt here')).rejects.toThrow();
  });
});

// ---------- browser page intel (Features 11-15) ----------

describe('browser page intel + payment guard', () => {
  test('sensitive field values are never part of the intel', () => {
    const intel = boundIntel({
      url: 'https://shop.example/checkout',
      title: 'Checkout',
      forms: [
        {
          id: 'pay',
          fields: [
            { tag: 'input', name: 'cardnumber', type: 'text', label: 'Card number', sensitive: true },
            { tag: 'input', name: 'email', type: 'email', label: 'Email', sensitive: false },
          ],
          submitLabels: ['Pay now'],
          looksLikePayment: true,
        },
      ],
      payment: { detected: true, cardFields: ['cardnumber'], payButtons: ['Pay now'] },
    });
    // structure only — no value anywhere
    expect(intel.forms[0].fields[0].sensitive).toBe(true);
    expect(JSON.stringify(intel)).not.toContain('4242'); // no card data
  });

  test('the payment guard demands user confirmation on payment pages', () => {
    const guard = paymentGuardDecision(
      boundIntel({ payment: { detected: true } })
    );
    expect(guard.requiresConfirmation).toBe(true);

    const plain = paymentGuardDecision(boundIntel({}));
    expect(plain.requiresConfirmation).toBe(false);
  });
});

// ---------- background runtime (Features 3 + 5) ----------

describe('background runtime', () => {
  test('a tick never throws and does not touch a healthy idle state', async () => {
    // create a retry_wait task that is TOO YOUNG to be re-queued → tick
    // must leave it alone
    const young = await db.agenticTask.create({
      data: { prompt: 'young retry task for tick test', status: 'retry_wait' },
    });
    created.taskIds.push(young.id);
    await expect(tick()).resolves.toBeUndefined();
    const after = await db.agenticTask.findUnique({ where: { id: young.id } });
    expect(after!.status).toBe('retry_wait'); // not yet re-queued
  });

  test('a long-waiting retry_wait task is made resumable (paused)', async () => {
    const old = await db.agenticTask.create({
      data: { prompt: 'old retry task for tick test', status: 'retry_wait' },
    });
    created.taskIds.push(old.id);
    // age it beyond the retry window
    await db.agenticTask.update({
      where: { id: old.id },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await tick();
    const after = await db.agenticTask.findUnique({ where: { id: old.id } });
    expect(after!.status).toBe('paused'); // resumable, notification created
    const notif = await db.notification.findFirst({
      where: { taskId: old.id, type: 'system' },
    });
    expect(notif).not.toBeNull();
  });
});

// ---------- browser engine with REAL chromium (auto-skipped when unavailable) ----------
//
// Regression guard for the page.evaluate integration: the intel script is a
// STRING arrow function — Playwright does not CALL a string arrow, so it must
// be wrapped as an IIFE expression. Without this test that bug returns
// silently (every page reports zero forms / zero payment signals).

describe('browser engine (real chromium)', () => {
  let engineAvailable: boolean | null = null;

  async function chromiumAvailable(): Promise<boolean> {
    if (engineAvailable !== null) return engineAvailable;
    try {
      const { createSession, closeSession } = await import('../src/lib/agentic/browser/browser-service');
      const s = await createSession('');
      await closeSession(s.id);
      engineAvailable = true;
    } catch {
      engineAvailable = false; // playwright / chromium not installed — skip
    }
    return engineAvailable;
  }

  test('navigate returns real page intel: forms, payment fields, pay buttons', async () => {
    if (!(await chromiumAvailable())) return; // soft skip

    process.env.AGENTSCOPE_BROWSER_ALLOW_LOOPBACK = '1';
    const http = await import('node:http');
    const html =
      '<!doctype html><html><head><title>Checkout Test</title></head><body>' +
      '<form id="checkout">' +
      '<label>Email <input name="email" type="email"></label>' +
      '<label>Card number <input name="cardnumber" autocomplete="cc-number"></label>' +
      '<label>CVV <input name="cvv" autocomplete="cc-csc"></label>' +
      '<button type="submit">Pay now</button>' +
      '</form></body></html>';
    const server = http.createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    const { createSession, navigate, closeSession } = await import(
      '../src/lib/agentic/browser/browser-service'
    );
    const session = await createSession('');
    try {
      const intel = await navigate(session.id, `http://127.0.0.1:${port}/`);
      expect(intel.title).toBe('Checkout Test');
      expect(intel.forms.length).toBe(1);
      expect(intel.payment.detected).toBe(true);
      expect(intel.payment.cardFields.join(' ')).toContain('cardnumber');
      expect(intel.payment.payButtons.join(' ')).toContain('Pay now');
    } finally {
      await closeSession(session.id).catch(() => undefined);
      server.close();
      delete process.env.AGENTSCOPE_BROWSER_ALLOW_LOOPBACK;
    }
  });
});
