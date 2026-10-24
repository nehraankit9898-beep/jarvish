// plan-gaps.ts — deterministic plan-gap detection (Feature 10).
//
// The planner's output is accepted far too easily: a "deploy the website"
// plan without a test step, a rollback step or a health check is NOT
// complete. This module checks a plan against the task's intent with
// deterministic rules (no LLM call, no flakiness, fully testable) and
// returns the gaps. The orchestrator feeds them back to the planner for ONE
// bounded revision pass and persists whatever remains on the task row so
// the UI can show exactly what the plan does NOT cover.

import type { PlanStep, PlanGap } from './types';

interface Intent {
  deploy: boolean;
  migration: boolean;
  env: boolean;
  credentials: boolean;
  install: boolean;
  changesCode: boolean;
}

const DEPLOY_WORDS =
  /\b(deploy|deployment|production|prod|release|publish|ship|launch|live)\b/i;
const MIGRATION_WORDS = /\b(migrat|schema|database|db|sql|prisma)\b/i;
const ENV_WORDS = /\b(env|environment variable|config|configuration|\.env)\b/i;
/** explicit credential ACQUISITION words — a bare "login/auth/password" in a
 *  code-fix task is the FEATURE, not a missing credential */
const CREDENTIAL_WORDS = /\b(api key|api token|access token|credentials?|secret key|api secret)\b/i;
const INSTALL_WORDS = /\b(install|dependency|npm|pip|package|requirements)\b/i;

function detectIntent(prompt: string): Intent {
  return {
    deploy: DEPLOY_WORDS.test(prompt),
    migration: MIGRATION_WORDS.test(prompt),
    env: ENV_WORDS.test(prompt),
    credentials: CREDENTIAL_WORDS.test(prompt),
    install: INSTALL_WORDS.test(prompt),
    changesCode: /\b(fix|add|create|write|implement|update|refactor|change|build)\b/i.test(prompt),
  };
}

function mentions(steps: PlanStep[], pattern: RegExp): boolean {
  return steps.some((s) => pattern.test(`${s.title} ${s.description} ${s.acceptance}`));
}

/** Step kinds that write code (vs analyze/review/docs). */
const WRITER_KINDS = new Set(['implement', 'debug', 'fix']);

/**
 * Check a plan for gaps against the task prompt.
 * Returns [] for a complete plan — the common case must stay quiet.
 */
export function detectPlanGaps(prompt: string, steps: PlanStep[]): PlanGap[] {
  const gaps: PlanGap[] = [];
  if (!steps.length) {
    return [
      {
        kind: 'coverage',
        description: 'The plan is empty.',
        suggestion: 'Re-plan the task — at least one implement and one verification step are required.',
        severity: 'critical',
      },
    ];
  }

  const intent = detectIntent(prompt);
  const hasTest = steps.some((s) => s.kind === 'test');
  const hasReview = steps.some((s) => s.kind === 'review');
  const hasImplement = steps.some((s) => WRITER_KINDS.has(s.kind));
  const testishMention = mentions(steps, /\b(test|verify|verification|check|smoke)\b/i);

  // 1) code changes without any verification
  if (hasImplement && !hasTest && !hasReview && !testishMention) {
    gaps.push({
      kind: 'missing_tests',
      description: 'The plan changes code but has no test or verification step.',
      suggestion:
        'Add a "test" step that runs real commands proving the change works (exit 0 = pass).',
      severity: 'critical',
    });
  }

  // 2) deploy intent without a POST-DEPLOY check (running tests before the
  //    deploy is NOT a health check — the site must be verified LIVE)
  if (
    intent.deploy &&
    !mentions(steps, /\b(health|smoke|post-?deploy|deploy.*verify|verify.*deploy|uptime)\b/i)
  ) {
    gaps.push({
      kind: 'missing_health_check',
      description: 'A deploy plan without a post-deploy health check is not complete.',
      suggestion: 'Add a verification step that checks the deployment is actually live and healthy.',
      severity: 'critical',
    });
  }

  // 3) deploy intent without a rollback path
  if (intent.deploy && !mentions(steps, /\b(rollback|revert|backup|restore)\b/i)) {
    gaps.push({
      kind: 'missing_rollback',
      description: 'No rollback plan for the deployment.',
      suggestion: 'Document (or implement) how to roll back if the deployment breaks.',
      severity: 'warning',
    });
  }

  // 4) migration intent without a migration step
  if (intent.migration && !mentions(steps, /\b(migrat|schema|prisma migrate|sql)\b/i)) {
    gaps.push({
      kind: 'missing_migration',
      description: 'The task involves a database/schema change but no step handles the migration.',
      suggestion: 'Add a step that creates/applies the migration and verifies the schema.',
      severity: 'critical',
    });
  }

  // 5) env/config intent without an env step
  if (intent.env && !mentions(steps, /\b(env|environment|config|\.env)\b/i)) {
    gaps.push({
      kind: 'missing_env',
      description: 'The task needs environment variables/config but no step sets or documents them.',
      suggestion: 'Add a step that sets the required environment (document every variable needed).',
      severity: 'warning',
    });
  }

  // 6) credential dependency not addressed
  if (intent.credentials && !mentions(steps, /\b(credential|api key|token|auth|secret)\b/i)) {
    gaps.push({
      kind: 'missing_credentials',
      description: 'The task depends on credentials that no step acquires or documents.',
      suggestion:
        'Add a step that documents which credentials are needed and where they come from (never hardcode secrets).',
      severity: 'warning',
    });
  }

  // 7) dependencies to install but no step installs them
  if (intent.install && !mentions(steps, /\b(install|npm|pip|requirements|package)\b/i)) {
    gaps.push({
      kind: 'missing_env',
      description: 'Dependencies must be installed but no step installs them.',
      suggestion: 'Add an install step (e.g. requirements.txt + pip install) before the implement step.',
      severity: 'warning',
    });
  }

  return gaps;
}

/** True when at least one gap is critical → the planner gets one revision pass. */
export function hasCriticalGaps(gaps: PlanGap[]): boolean {
  return gaps.some((g) => g.severity === 'critical');
}

/** Render the gaps as planner feedback (used for the revision pass). */
export function gapsForPlanner(gaps: PlanGap[]): string {
  return gaps
    .map((g, i) => `${i + 1}. [${g.severity}] ${g.kind}: ${g.description} → ${g.suggestion}`)
    .join('\n');
}
