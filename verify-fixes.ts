/**
 * Functional verification of the AgentScope Jarvis bug fixes.
 * Run: bun /home/z/my-project/scripts/verify-fixes.ts
 */
import { checkCommand } from '../jarvis-src/agentscope-suite/studio/src/lib/agentic/permissions';
import { nextCronRun, parseCron } from '../jarvis-src/agentscope-suite/studio/src/lib/agentic/cron';
import { parseGoalDecomposition, nextRunnableSpec } from '../jarvis-src/agentscope-suite/studio/src/lib/agentic/goals';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''}`);
  }
}

console.log('\n== C1 / H1 / H2: permissions classifier ==');
{
  const multi = checkCommand('echo hi\nrm -rf /tmp/x');
  check('C1 multi-line echo+rm is NOT safe', multi.permission !== 'safe', multi);

  const pureEcho = checkCommand('echo hi\necho there');
  check('C1 benign multi-line echo stays safe', pureEcho.permission === 'safe', pureEcho);

  const findDel = checkCommand("find . -name '*.log' -delete");
  check('H1 find -delete is destructive', findDel.permission === 'destructive', findDel);

  const findPlain = checkCommand('find . -name "*.ts" -type f');
  check('H1 plain find stays safe', findPlain.permission === 'safe', findPlain);

  const mvEtc = checkCommand('mv a.txt /etc/passwd');
  check('H2 mv into /etc is escalated', mvEtc.permission === 'destructive' || mvEtc.permission === 'forbidden', mvEtc);

  const cpHome = checkCommand('cp secret.txt ~/.ssh/authorized_keys2');
  check('H2 cp into ~ escalated', cpHome.permission !== 'safe' && cpHome.permission !== 'review', cpHome);

  const mvLocal = checkCommand('mv a.txt build/a.txt');
  check('H2 relative mv stays review', mvLocal.permission === 'review', mvLocal);

  const regression = checkCommand('ls -la && echo done');
  check('regression: ls && echo still safe', regression.permission === 'safe', regression);

  const pipe = checkCommand('cat /etc/passwd | grep root');
  check('regression: pipe still safe-classified', pipe.permission === 'safe', pipe);
}

console.log('\n== C2: cron DST spring-forward (America/New_York, 2:30 does not exist 2025-03-09) ==');
{
  // 2025-03-09 02:30 EST does not exist (clocks jump 02:00 -> 03:00 EDT).
  const from = new Date('2025-03-09T06:59:30.000Z'); // 01:59:30 EST, just before the gap
  const t0 = Date.now();
  const next = nextCronRun('30 2 * * *', from, 'America/New_York');
  const dt = Date.now() - t0;
  check('C2 nextCronRun returns (does not hang)', next !== null, 'returned null');
  check('C2 resolves well under 2s', dt < 2000, `${dt}ms`);
  if (next) {
    // next valid 02:30 wall time is the NEXT day (2025-03-10 02:30 EDT = 06:30 UTC)
    check('C2 skips to next day 02:30 EDT (06:30Z)', next.toISOString().startsWith('2025-03-10T06:30'), next.toISOString());
  }

  // sanity: normal firing still correct (Mar 10 is after spring-forward → EDT,
  // so 02:30 EDT = 06:30 UTC)
  const n2 = nextCronRun('30 2 * * *', new Date('2025-03-10T00:00:00.000Z'), 'America/New_York');
  check('C2 regression: normal day fires 06:30Z (02:30 EDT)', n2?.toISOString().startsWith('2025-03-10T06:30') === true, n2?.toISOString());
  // winter date → EST (UTC-5): 02:30 EST = 07:30 UTC
  const n5 = nextCronRun('30 2 * * *', new Date('2025-01-10T00:00:00.000Z'), 'America/New_York');
  check('C2 regression: winter day fires 07:30Z (02:30 EST)', n5?.toISOString().startsWith('2025-01-10T07:30') === true, n5?.toISOString());

  // sanity: fall-back day (2025-11-02, 01:30 occurs twice) still terminates
  const n3 = nextCronRun('30 1 * * *', new Date('2025-11-02T05:00:00.000Z'), 'America/New_York');
  check('C2 regression: fall-back day terminates', n3 !== null, n3?.toISOString());

  // sanity: unsatisfiable expression still bounded
  const n4 = nextCronRun('0 5 30 2 *', new Date('2025-01-01T00:00:00.000Z'));
  check('C2 regression: Feb-30 returns null (bounded scan)', n4 === null, n4?.toISOString());

  // sanity: parse still fine
  check('C2 regression: parseCron ok', parseCron('*/5 9-17 * * MON-FRI').minutes.size === 12);
}

console.log('\n== H3: goal decomposition dangling dependsOn ==');
{
  // task #2 will be dropped (prompt too short) leaving a dangling dep on #2
  const dec = parseGoalDecomposition(
    JSON.stringify({
      title: 'G',
      tasks: [
        { index: 1, title: 'A', prompt: 'build the thing properly please', dependsOn: [] },
        { index: 2, title: 'B', prompt: 'short', dependsOn: [] },
        { index: 3, title: 'C', prompt: 'test everything end to end now', dependsOn: [2] },
      ],
    })
  );
  check('H3 dropped task removed from list', dec.tasks.length === 2, dec.tasks.map((t) => t.title));
  check('H3 indexes renumbered 1..N', dec.tasks.map((t) => t.index).join(',') === '1,2');
  const specC = dec.tasks.find((t) => t.title === 'C')!;
  check('H3 dangling dependsOn dropped', specC.dependsOn.length === 0, specC.dependsOn);

  // duplicate prompts are deduped
  const dup = parseGoalDecomposition(
    JSON.stringify({
      title: 'G',
      tasks: [
        { index: 1, title: 'A', prompt: 'exactly the same prompt text', dependsOn: [] },
        { index: 2, title: 'B', prompt: 'exactly the same prompt text', dependsOn: [] },
      ],
    })
  );
  check('H3 duplicate prompts deduped', dup.tasks.length === 1, dup.tasks.length);

  // cycle is broken
  const cyc = parseGoalDecomposition(
    JSON.stringify({
      title: 'G',
      tasks: [
        { index: 1, title: 'A', prompt: 'first task does stuff aa', dependsOn: [2] },
        { index: 2, title: 'B', prompt: 'second task does stuff bb', dependsOn: [1] },
      ],
    })
  );
  check('H3 cycle edges dropped', cyc.tasks.every((t) => t.dependsOn.length === 0), cyc.tasks.map((t) => t.dependsOn));

  // runtime guard: unknown dep index ignored
  const runnable = nextRunnableSpec(
    [
      { index: 1, title: 'A', prompt: 'p1', dependsOn: [9] },
      { index: 2, title: 'B', prompt: 'p2', dependsOn: [1] },
    ],
    []
  );
  check('H3 nextRunnableSpec ignores unknown dep', runnable?.index === 1, runnable?.index);

  // normal dependency flow still respected
  const r2 = nextRunnableSpec(
    [
      { index: 1, title: 'A', prompt: 'p1', dependsOn: [] },
      { index: 2, title: 'B', prompt: 'p2', dependsOn: [1] },
    ],
    [{ index: 1, taskStatus: 'done', taskId: 't1' }]
  );
  check('H3 regression: dep done -> next spec runnable', r2?.index === 2, r2?.index);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
