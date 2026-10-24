// test-gate.ts — evidence based gate for the reviewer verdict.
//
// Requirement: "Reviewer ka PASS tabhi accept karo jab required tests sach mein
// execute hue hon."
//
// The reviewer LLM used to receive the diff plus a free-text list of commands
// and could answer "pass" even when NO test had ever run. This module derives
// hard evidence from the executed command records and decides whether a PASS
// verdict may be accepted.

export interface ExecutedCommand {
  command: string;
  exitCode: number | null;
}

export interface TestEvidence {
  /** number of commands that actually executed */
  executed: number;
  /** commands that exited 0 */
  passed: number;
  /** commands that failed */
  failed: number;
  /** every command that ran, with its real exit code */
  commands: ExecutedCommand[];
  /** the plan contained at least one 'test' step */
  testStepPlanned: boolean;
  /** a 'test' step actually executed at least one command */
  testStepExecuted: boolean;
  /** every command of every 'test' step exited 0 */
  allTestsPassed: boolean;
}

export interface StepEvidenceInput {
  kind: string;
  commands: ExecutedCommand[];
}

export function collectTestEvidence(steps: StepEvidenceInput[]): TestEvidence {
  const commands: ExecutedCommand[] = [];
  let testStepPlanned = false;
  let testStepExecuted = false;
  let allTestsPassed = true;

  for (const step of steps) {
    const isTestStep = step.kind === 'test';
    if (isTestStep) {
      testStepPlanned = true;
      if (step.commands.length) testStepExecuted = true;
    }
    for (const cmd of step.commands) {
      commands.push(cmd);
      if (isTestStep && cmd.exitCode !== 0) allTestsPassed = false;
    }
  }

  const passed = commands.filter((c) => c.exitCode === 0).length;
  return {
    executed: commands.length,
    passed,
    failed: commands.length - passed,
    commands,
    testStepPlanned,
    testStepExecuted,
    allTestsPassed,
  };
}

export interface TestGateResult {
  /** may a PASS verdict be accepted? */
  allowed: boolean;
  reason: string;
  /** the verdict that must be used instead of the LLM's PASS */
  forcedVerdict?: 'fail';
}

/**
 * Decide whether a reviewer PASS is acceptable.
 *
 * @param evidence  hard evidence collected from the executed commands
 * @param opts.requireExecutedTests  when true (default) a plan that contains
 *        a test step must have executed those tests successfully
 */
export function evaluateTestGate(
  evidence: TestEvidence,
  opts: { requireExecutedTests?: boolean } = {}
): TestGateResult {
  const requireExecuted = opts.requireExecutedTests ?? true;

  if (!requireExecuted) {
    return { allowed: true, reason: 'Test execution gate disabled' };
  }

  if (evidence.testStepPlanned && !evidence.testStepExecuted) {
    return {
      allowed: false,
      forcedVerdict: 'fail',
      reason:
        'Plan me ek test step tha lekin koi verification command actually execute nahi hui — PASS accept nahi kiya ja sakta.',
    };
  }

  if (evidence.executed === 0) {
    return {
      allowed: false,
      forcedVerdict: 'fail',
      reason:
        'Koi bhi verification command execute nahi hui — reviewer PASS ke liye real test evidence zaroori hai.',
    };
  }

  if (!evidence.allTestsPassed) {
    return {
      allowed: false,
      forcedVerdict: 'fail',
      reason: `${evidence.failed} test command(s) fail hue — reviewer PASS accept nahi kiya ja sakta.`,
    };
  }

  return {
    allowed: true,
    reason: `${evidence.passed} verification command(s) successfully executed.`,
  };
}
