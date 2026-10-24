// Regression tests for the bug-hunt fixes (8 real bugs found by audit):
//   #1 cron schedule with nextRunAt = null fired a task on EVERY 30s tick
//   #2 a cancelled screen task's pending approval still executed + the
//      'blocked' verdict overwrote the terminal 'cancelled' status
//   #4 morning summary dedupe key used the UTC date (double fire UTC+9:30+)
//   #5 parseScreenAction accepted click/type/hotkey/open with missing/null
//      fields → click at cursor / (0,0)
//   #7 OAuth callback exchanged any code without checking the state
// Run: bun test tests/bugfix-regressions.test.ts
import { describe, expect, test, afterAll } from 'bun:test';
import { NextRequest } from 'next/server';
import { db } from '../src/lib/db';
import { nextCronRun } from '../src/lib/agentic/cron';
import {
  createSchedule,
  deleteSchedule,
  runDueSchedules,
  recoverMisfires,
  listSchedules,
} from '../src/lib/agentic/automation';
import {
  requestHostAction,
  waitForHostApproval,
  cancelHostApprovalsForTask,
  clearPendingHostActions,
  listPendingHostActions,
} from '../src/lib/agentic/host-control';
import { parseScreenAction } from '../src/lib/agentic/vision';
import { localDateKey } from '../src/lib/agentic/proactive';

afterAll(async () => {
  clearPendingHostActions();
});

// ---------------------------------------------------------------------------
// #1 — unsatisfiable cron must never create a null-and-due schedule
// ---------------------------------------------------------------------------
describe('bugfix #1 — cron null-nextRunAt runaway', () => {
  test('an unsatisfiable cron (Feb 30) is rejected at create time', async () => {
    expect(
      createSchedule({ name: 'regress-false-cron', prompt: 'kuch bhi kar do please', cronExpr: '0 5 30 2 *', enabled: true })
    ).rejects.toThrow(/no firing time/i);
  });

  test('a leap-day cron (Feb 29) still resolves within the 4-year window', () => {
    const next = nextCronRun('0 5 29 2 *', new Date('2026-10-23T00:00:00Z'));
    expect(next).not.toBeNull();
    // next Feb 29 is 2028
    expect(next!.getUTCFullYear()).toBe(2028);
    expect(next!.getUTCMonth()).toBe(1); // February
    expect(next!.getUTCDate()).toBe(29);
  });

  test('an enabled schedule with nextRunAt = null is NEVER due (legacy row healed by recovery)', async () => {
    // build a legacy-shaped row the same way an old DB would have one:
    // disabled at create (no nextRunAt), then force-enabled without re-arm
    const s = await createSchedule({ name: 'regress-null-row', prompt: 'kuch bhi kar do please', intervalMs: 3_600_000 });
    await db.automationSchedule.update({ where: { id: s.id }, data: { enabled: true, nextRunAt: null } });

    try {
      const before = await db.automationRun.count({ where: { scheduleId: s.id } });
      await runDueSchedules();
      const after = await db.automationRun.count({ where: { scheduleId: s.id } });
      expect(after).toBe(before); // no runaway run

      // recovery re-arms it (report says so) instead of running it
      const report = await recoverMisfires(new Date(), 365 * 24 * 60 * 60 * 1000);
      const mine = report.find((r) => r.scheduleId === s.id);
      expect(mine?.action).toBe('rearmed');
      const row = await db.automationSchedule.findUnique({ where: { id: s.id } });
      expect(row?.nextRunAt).not.toBeNull();
    } finally {
      await deleteSchedule(s.id);
    }
  });
});

// ---------------------------------------------------------------------------
// #2 — cancelling a task must drop its pending approvals and wake the waiter
// ---------------------------------------------------------------------------
describe('bugfix #2 — task cancel vs pending host approval', () => {
  test('cancelHostApprovalsForTask drops the pending action and resolves the waiter as denied', async () => {
    process.env.AGENTSCOPE_HOST_MODE = 'ask';
    clearPendingHostActions();

    // trash is destructive → always queues for approval, in every mode
    const queued = await requestHostAction(
      { kind: 'trash', path: '/tmp/never-created-by-a-test.txt' },
      'screen-agent',
      'task-regress-1'
    );
    expect(queued.status).toBe('approval_required');
    const id = (queued as { id: string }).id;

    // the screen loop is blocked here — cancel must wake it
    const waiting = waitForHostApproval(id, 60_000);
    const dropped = await cancelHostApprovalsForTask('task-regress-1');
    expect(dropped).toBe(1);
    expect(await waiting).toBe('denied');

    // and the action is gone from the queue: a late approve click finds nothing
    expect(listPendingHostActions().find((p) => p.id === id)).toBeUndefined();
    clearPendingHostActions();
  });

  test('approvals of OTHER tasks survive the cancel', async () => {
    process.env.AGENTSCOPE_HOST_MODE = 'ask';
    clearPendingHostActions();
    const a = await requestHostAction({ kind: 'trash', path: '/tmp/regress-a.txt' }, 'agent', 'task-keep');
    const b = await requestHostAction({ kind: 'trash', path: '/tmp/regress-b.txt' }, 'agent', 'task-kill');
    expect(a.status).toBe('approval_required');
    expect(b.status).toBe('approval_required');

    await cancelHostApprovalsForTask('task-kill');
    const pending = listPendingHostActions();
    expect(pending.find((p) => p.id === (a as { id: string }).id)).toBeDefined();
    expect(pending.find((p) => p.id === (b as { id: string }).id)).toBeUndefined();
    clearPendingHostActions();
  });
});

// ---------------------------------------------------------------------------
// #5 — malformed coordinate actions must be rejected, not mis-executed
// ---------------------------------------------------------------------------
describe('bugfix #5 — parseScreenAction plausibility', () => {
  test('click without coordinates is rejected (bridge would click at the cursor)', () => {
    expect(parseScreenAction('{"action":"click"}')).toBeNull();
    expect(parseScreenAction('{"action":"click","x":null,"y":456}')).toBeNull();
    expect(parseScreenAction('{"action":"double_click","x":10}')).toBeNull();
  });

  test('a click with real coordinates still parses', () => {
    const a = parseScreenAction('{"action":"click","x":123,"y":456,"note":"open button"}');
    expect(a?.action).toBe('click');
    expect(a?.x).toBe(123);
    expect(a?.y).toBe(456);
  });

  test('type / hotkey / open without their payload are rejected', () => {
    expect(parseScreenAction('{"action":"type"}')).toBeNull();
    expect(parseScreenAction('{"action":"type","text":null}')).toBeNull();
    expect(parseScreenAction('{"action":"hotkey"}')).toBeNull();
    expect(parseScreenAction('{"action":"open"}')).toBeNull();
    expect(parseScreenAction('{"action":"hotkey","keys":"ctrl,s"}')?.keys).toBe('ctrl,s');
    expect(parseScreenAction('{"action":"open","target":"notepad"}')?.target).toBe('notepad');
  });

  test('wait / done / cannot still need nothing', () => {
    expect(parseScreenAction('{"action":"wait","ms":500}')?.action).toBe('wait');
    expect(parseScreenAction('{"action":"done","summary":"ho gaya"}')?.action).toBe('done');
    expect(parseScreenAction('{"action":"cannot","reason":"sensitive"}')?.action).toBe('cannot');
  });
});

// ---------------------------------------------------------------------------
// #4 — once-a-day keys must use the LOCAL date, not UTC
// ---------------------------------------------------------------------------
describe('bugfix #4 — localDateKey vs UTC date', () => {
  test('the key follows the LOCAL clock components in any timezone', () => {
    // construct from LOCAL components so the invariant holds on a UTC CI box
    // and on a real +05:30/+10:00 laptop alike
    const evening = new Date(2026, 2, 9, 23, 30); // local Mar 09, 23:30
    expect(localDateKey(evening)).toBe('2026-03-09');
    const later = new Date(evening.getTime() + 90 * 60_000); // local Mar 10, 01:00
    expect(localDateKey(later)).toBe('2026-03-10');
  });
});

// ---------------------------------------------------------------------------
// #7 — the OAuth callback must verify state before exchanging a code
// ---------------------------------------------------------------------------
describe('bugfix #7 — google oauth state enforcement', () => {
  test('a callback with no state cookie is refused before any token exchange', async () => {
    const req = new NextRequest('http://localhost:3000/api/connectors/google/callback?code=attacker-code&state=attacker-state');
    const { GET } = await import('../src/app/api/connectors/google/callback/route');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('state mismatch');
    // cookie consumed (single use)
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('agentscope_oauth_state=;');
    expect(setCookie).toContain('Max-Age=0');
  });
});
