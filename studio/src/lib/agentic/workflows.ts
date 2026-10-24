// workflows.ts — GUIDED WORKFLOWS (Features 9 + 15).
//
// Some tasks deserve a DETERMINISTIC plan instead of a generated one: the
// steps, their order and their approval gates are the safety feature. A
// workflow template produces a fixed PlanStep[] that lands in the engine
// like any other plan — awaiting_approval, sandboxed, test-gated — but no
// LLM decided the structure.
//
// Templates:
//   negotiation        — "provider se bill kam karwao" (Feature 9)
//   purchase-protection — claim/refund/price-drop workflows (Feature 15)
//
// HARD RULES baked into every template (from the platform spec):
//   - CAPTCHA / OTP / login walls are NEVER bypassed — the workflow stops
//     and asks the user (the browser intel reports humanVerification);
//   - every external communication is DRAFTED FIRST and approved;
//   - any binding commitment (plan change, cancellation, claim submission)
//     needs the user's explicit approval.

import { db } from '@/lib/db';
import type { PlanStep } from './types';
import { recordAudit } from './audit';

export interface WorkflowTemplate {
  id: string;
  title: string;
  description: string;
  /** what the user should provide in the prompt */
  inputHint: string;
  buildPlan: (prompt: string) => { title: string; steps: PlanStep[] };
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'negotiation',
    title: 'Negotiation',
    description:
      'Research the options, draft the negotiation points, contact the provider through an approved channel, analyse the reply and prepare a counter-offer. Every external message is drafted for approval FIRST; account changes need your final confirmation.',
    inputHint:
      'e.g. "Internet bill kam karne ke liye provider se baat karo — current plan 999/month, account no. 12345"',
    buildPlan: (prompt) => ({
      title: 'Negotiation workflow',
      steps: [
        {
          index: 1,
          title: 'Research available plans and terms',
          description:
            `Research the provider's current plans, prices and cancellation/retention terms relevant to: ${prompt.slice(0, 300)}. Use read-only research (web search via browser tools is allowed, no login). Report facts with sources.`,
          kind: 'research',
          acceptance: 'A written summary of plans, prices and terms with sources exists in the workspace.',
        },
        {
          index: 2,
          title: 'Draft negotiation points and first message',
          description:
            'Based on the research, write the negotiation strategy (target price, leverage points, alternatives) and DRAFT the first message to customer support. Do NOT send anything — this step only writes the draft to the workspace.',
          kind: 'implement',
          acceptance: 'negotiation-plan.md and draft-message-1.md exist in the workspace.',
          dependencies: [{ stepIndex: 1, type: 'blocks' }],
        },
        {
          index: 3,
          title: 'Review the draft (user approval)',
          description:
            'The user reviews the draft message. Sending it happens ONLY after this review step passes with the user approval. If the provider channel requires login/OTP/CAPTCHA, STOP and hand the exact steps to the user instead of bypassing anything.',
          kind: 'review',
          acceptance: 'The user approved the draft (review verdict pass).',
          dependencies: [{ stepIndex: 2, type: 'blocks' }],
        },
        {
          index: 4,
          title: 'Send via approved channel and record the reply',
          description:
            'Send the APPROVED message through the channel the user authorised (e.g. the provider web chat or email form via browser tools). Never automate a channel that forbids automation. Record the provider reply verbatim in the workspace.',
          kind: 'implement',
          acceptance: 'reply-1.md contains the provider response (or a clear note that the user must act manually).',
          dependencies: [{ stepIndex: 3, type: 'blocks' }],
        },
        {
          index: 5,
          title: 'Analyse reply and draft the counter-offer',
          description:
            'Analyse the reply against the negotiation strategy. Draft the counter-offer (or acceptance). Again: DRAFT ONLY — no commitment, no plan change, nothing binding.',
          kind: 'implement',
          acceptance: 'counter-offer.md exists with the reasoning.',
          dependencies: [{ stepIndex: 4, type: 'blocks' }],
        },
        {
          index: 6,
          title: 'Final review before any commitment',
          description:
            'Final user approval gate: the plan change / cancellation / commitment only happens after this review passes. The task then either hands the user the exact steps or executes the approved action via browser tools (payment guard applies).',
          kind: 'review',
          acceptance: 'The user made the final decision (verdict recorded).',
          dependencies: [{ stepIndex: 5, type: 'blocks' }],
        },
      ],
    }),
  },
  {
    id: 'purchase-protection',
    title: 'Purchase protection claim',
    description:
      'Collect the claim information (invoice, tracking, damage photos references), check the eligibility and deadlines against the provider ACTUAL terms, draft the claim and track the submission. Protection is NEVER assumed to apply automatically — eligibility is verified per transaction.',
    inputHint:
      'e.g. "Last week ka order damaged pahuncha — Flipkart order OD123, invoice INV456, 2500 rupees"',
    buildPlan: (prompt) => ({
      title: 'Purchase protection claim',
      steps: [
        {
          index: 1,
          title: 'Collect the claim information',
          description:
            `Gather every fact needed for a claim: ${prompt.slice(0, 300)}. Organise order id, invoice, amount, delivery date, tracking, and what exactly is wrong. Write facts.md — no fabrication, missing facts are listed as MISSING.`,
          kind: 'research',
          acceptance: 'facts.md exists with the structured claim data (or listed gaps).',
        },
        {
          index: 2,
          title: 'Verify eligibility and deadlines',
          description:
            'Find the provider\'s ACTUAL return/refund/price-drop policy (official pages only) and check: return window deadline, damaged-item rules, price-drop eligibility, required documents. Do not assume protection applies — write the verdict with citations.',
          kind: 'analyze',
          acceptance: 'eligibility.md states eligible/not eligible per policy point with deadlines.',
          dependencies: [{ stepIndex: 1, type: 'blocks' }],
        },
        {
          index: 3,
          title: 'Draft the claim',
          description:
            'Draft the claim message with all evidence references, the policy clauses that apply and the exact ask (refund/replacement/price adjustment). DRAFT ONLY — no submission.',
          kind: 'implement',
          acceptance: 'claim-draft.md exists and quotes the policy clauses.',
          dependencies: [{ stepIndex: 2, type: 'blocks' }],
        },
        {
          index: 4,
          title: 'Review the claim (user approval)',
          description:
            'The user reviews the claim draft. Submission through the provider channel happens only after approval; login/OTP/CAPTCHA walls are handed to the user, never bypassed.',
          kind: 'review',
          acceptance: 'The user approved the claim draft (verdict pass).',
          dependencies: [{ stepIndex: 3, type: 'blocks' }],
        },
        {
          index: 5,
          title: 'Submit and track the claim',
          description:
            'Submit the APPROVED claim via the provider\'s official channel (browser tools; payment guard and human-verification rules apply). Record the claim/ticket id and the expected response time. Write submission.md with the status.',
          kind: 'implement',
          acceptance: 'submission.md contains the claim id and status (or manual steps for the user).',
          dependencies: [{ stepIndex: 4, type: 'blocks' }],
        },
      ],
    }),
  },
];

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((w) => w.id === id);
}

export function listWorkflowTemplates() {
  return WORKFLOW_TEMPLATES.map(({ id, title, description, inputHint }) => ({
    id,
    title,
    description,
    inputHint,
  }));
}

/**
 * Create a task that uses the workflow's DETERMINISTIC plan (no planner LLM
 * call). The task lands in `awaiting_approval` exactly like a planned task —
 * the user reviews the steps and starts the run.
 */
export async function createWorkflowTask(
  workflowId: string,
  prompt: string
): Promise<{ taskId: string; title: string; steps: number }> {
  const template = getWorkflowTemplate(workflowId);
  if (!template) throw new Error(`Unknown workflow: ${workflowId}`);
  const cleanPrompt = String(prompt ?? '').trim();
  if (cleanPrompt.length < 8) {
    throw new Error('Prompt must be at least 8 characters (use the workflow input hint)');
  }

  const { title, steps } = template.buildPlan(cleanPrompt);
  const task = await db.agenticTask.create({
    data: {
      prompt: `[workflow:${workflowId}] ${cleanPrompt}`.slice(0, 4000),
      status: 'awaiting_approval',
      plan: JSON.stringify(steps),
      currentStep: 0,
      conversationId: `conv_wf_${workflowId}_${crypto.randomUUID()}`,
    },
  });
  for (const step of steps) {
    await db.agenticStep.create({
      data: {
        taskId: task.id,
        index: step.index,
        kind: step.kind,
        title: step.title,
        description: step.description,
        status: 'pending',
      },
    });
  }
  await recordAudit({
    actor: 'user',
    action: 'workflow.create_task',
    category: 'task',
    approval: 'auto',
    details: { workflowId, taskId: task.id, steps: steps.length },
  });
  return { taskId: task.id, title, steps: steps.length };
}
