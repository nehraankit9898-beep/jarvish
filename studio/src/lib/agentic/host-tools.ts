// host-tools.ts — the agent-facing laptop tools (host-control.ts is the engine).
//
// They register into the normal tool registry, so schema validation, timeouts
// and the tool audit apply. They always act as `actor: 'agent'`.
//
// An action that needs the user's approval does NOT run: the tool returns
// `ok:false, error:'approval_required'` with the approval id. The agent has no
// tool that can approve — only the user-facing route /api/host can.

import type { ToolResult } from './tool-registry';
import { registerTool } from './tool-registry';
import { requestHostAction, type HostAction } from './host-control';

let registered = false;

function toResult(out: Awaited<ReturnType<typeof requestHostAction>>): ToolResult {
  const at = new Date().toISOString();
  if (out.status === 'done') {
    return { ok: out.result.ok, data: out.result.data, error: out.result.error, exitCode: out.result.exitCode, permission: out.permission, at };
  }
  if (out.status === 'approval_required') {
    return {
      ok: false,
      error: 'approval_required',
      reason: `Waiting for the user: ${out.summary}. Do not retry — continue only after the user approves.`,
      data: { approvalId: out.id, summary: out.summary, expiresAt: out.expiresAt },
      permission: out.permission,
      at,
    };
  }
  return { ok: false, error: 'refused', reason: out.reason, permission: out.permission, at };
}

function def(
  name: string,
  description: string,
  parameters: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }>,
  build: (p: Record<string, unknown>) => HostAction,
  timeoutMs = 30_000
): void {
  registerTool(
    {
      name,
      description,
      category: 'host',
      parameters: Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, { ...v, required: v.required ?? false }])),
      required: Object.entries(parameters).filter(([, v]) => v.required).map(([k]) => k),
      permission: 'review',
      timeoutMs,
    },
    async (inv): Promise<ToolResult> => toResult(await requestHostAction(build(inv.parameters), 'agent'))
  );
}

/** Register the laptop tools once (idempotent). */
export function registerHostTools(): void {
  if (registered) return;
  registered = true;

  def('host-info', "Read the user's machine info (OS, memory, CPU, home folder, control mode).", {}, () => ({ kind: 'info' }));
  def('host-list', 'List a folder on the real laptop.', { path: { type: 'string', description: 'Folder path (~ allowed)', required: true } },
    (p) => ({ kind: 'list', path: String(p.path ?? '') }));
  def('host-read', 'Read a text file on the real laptop (credential files are refused).',
    { path: { type: 'string', description: 'File path', required: true }, maxBytes: { type: 'number', description: 'Max bytes (default 200000)' } },
    (p) => ({ kind: 'read', path: String(p.path ?? ''), maxBytes: p.maxBytes === undefined ? undefined : Number(p.maxBytes) }));
  def('host-write', 'Create/append/overwrite a file on the real laptop. Needs the user approval unless inside a trusted folder.',
    { path: { type: 'string', description: 'File path', required: true }, content: { type: 'string', description: 'Text content', required: true }, append: { type: 'boolean', description: 'Append instead of overwrite' } },
    (p) => ({ kind: 'write', path: String(p.path ?? ''), content: String(p.content ?? ''), append: p.append === true }));
  def('host-delete', 'Delete a file or folder on the real laptop. ALWAYS needs the user approval.',
    { path: { type: 'string', description: 'Path to delete', required: true } },
    (p) => ({ kind: 'delete', path: String(p.path ?? '') }));
  def('host-open', 'Open a URL in the default browser or a document in its default app.',
    { target: { type: 'string', description: 'http(s) URL or file path', required: true } },
    (p) => ({ kind: 'open', target: String(p.target ?? '') }));
  registerTool(
    {
      name: 'host-email',
      description:
        "Send an e-mail (optionally with a calendar invite) in the user's name via their SMTP account. ALWAYS needs the user approval; success means the mail server accepted every recipient.",
      category: 'host',
      parameters: {
        to: { type: 'array', description: 'recipient addresses', required: true },
        subject: { type: 'string', description: 'single-line subject', required: true },
        body: { type: 'string', description: 'plain-text body', required: true },
        meeting: { type: 'object', description: '{title,start,end,location?,description?} — start/end ISO 8601', required: false },
      },
      required: ['to', 'subject', 'body'],
      permission: 'review',
      timeoutMs: 60_000,
    },
    async (inv): Promise<ToolResult> =>
      toResult(
        await requestHostAction(
          {
            kind: 'email',
            to: Array.isArray(inv.parameters.to) ? inv.parameters.to.map(String) : [],
            subject: String(inv.parameters.subject ?? ''),
            body: String(inv.parameters.body ?? ''),
            meeting: inv.parameters.meeting && typeof inv.parameters.meeting === 'object' ? (inv.parameters.meeting as never) : undefined,
          },
          'agent'
        )
      )
  );
  def('host-exec', 'Run a command on the real laptop (PowerShell on Windows, bash elsewhere). Needs the user approval.',
    { command: { type: 'string', description: 'The command line', required: true }, cwd: { type: 'string', description: 'Working folder (default: home)' }, timeoutMs: { type: 'number', description: 'Timeout, default 120000' } },
    (p) => ({ kind: 'exec', command: String(p.command ?? ''), cwd: p.cwd ? String(p.cwd) : undefined, timeoutMs: p.timeoutMs === undefined ? undefined : Number(p.timeoutMs) }),
    130_000);
}
