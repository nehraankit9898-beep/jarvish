// tool-registry.ts — documented tool interface with discovery, registration,
// schema validation, permission enforcement, timeouts, cancellation, audit logs.

import { z } from 'zod';
import { protect, redactUnknown, type SecretScan } from './secrets';
import { type Permission } from './permissions';
import { executeCommand } from './terminal';
import {
  createWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
  listTree,
  deleteWorkspaceFile,
} from './workspace';
import { ensureRepo, snapshot, diffBetween, changedFiles, rollbackTo, baselineRef } from './git-tools';

// ---------- tool schema ----------

export const ToolParameterSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  description: z.string().optional(),
  required: z.boolean().default(false),
});

export const ToolDefinitionSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1),
  category: z.enum(['file', 'terminal', 'git', 'workspace', 'adapter', 'custom', 'host', 'desktop']),
  parameters: z.record(z.string(), ToolParameterSchema).default({}),
  required: z.array(z.string()).default([]),
  permission: z.enum(['safe', 'review', 'destructive', 'forbidden']).default('review'),
  timeoutMs: z.number().positive().default(120000),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export interface ToolInvocation {
  tool: string;
  parameters: Record<string, any>;
  taskId: string;
  approvedCommands?: string[];
}

export interface ToolResult {
  ok: boolean;
  data?: any;
  error?: string;
  permission?: Permission;
  reason?: string;
  exitCode?: number | null;
  durationMs?: number;
  redacted?: SecretScan;
  at: string;
}

export interface ToolCallRecord {
  tool: string;
  parameters: Record<string, any>;
  result: ToolResult;
  taskId: string;
  at: string;
}

// ---------- tool registry ----------

const TOOL_REGISTRY: Map<string, ToolDefinition> = new Map();
const TOOL_HANDLERS: Map<string, (invocation: ToolInvocation) => Promise<ToolResult>> = new Map();
const TOOL_AUDIT_LOG: ToolCallRecord[] = [];
const MAX_AUDIT_LOG = 1000;

/**
 * Register a tool definition and its handler.
 */
export function registerTool(def: ToolDefinition, handler: (invocation: ToolInvocation) => Promise<ToolResult>): void {
  TOOL_REGISTRY.set(def.name, def);
  TOOL_HANDLERS.set(def.name, handler);
}

/**
 * Remove a tool from the registry (used when a custom tool is disabled).
 * Built-in tools can be removed too — the engine calls them directly, so
 * removing a built-in only affects the /api/tools surface.
 */
export function unregisterTool(name: string): boolean {
  const had = TOOL_REGISTRY.delete(name);
  TOOL_HANDLERS.delete(name);
  return had;
}

/**
 * List all registered tool definitions.
 */
export function listTools(): ToolDefinition[] {
  return Array.from(TOOL_REGISTRY.values());
}

/**
 * Get a tool definition by name.
 */
export function getTool(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.get(name);
}

/**
 * Check if a tool exists.
 */
export function hasTool(name: string): boolean {
  return TOOL_REGISTRY.has(name);
}

/**
 * Get the audit log of tool calls.
 */
export function getAuditLog(limit = 100): ToolCallRecord[] {
  return TOOL_AUDIT_LOG.slice(-limit);
}

// ---------- audit logging ----------

function auditCall(record: ToolCallRecord): void {
  TOOL_AUDIT_LOG.push({
    ...record,
    parameters: redactUnknown(record.parameters) as Record<string, any>,
    result: redactUnknown(record.result) as ToolResult,
  });
  if (TOOL_AUDIT_LOG.length > MAX_AUDIT_LOG) {
    TOOL_AUDIT_LOG.splice(0, TOOL_AUDIT_LOG.length - MAX_AUDIT_LOG);
  }
}

// ---------- parameter validation ----------

const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
};

/**
 * Validate an invocation payload against the tool's DECLARED schema.
 *
 * H10: `invokeTool` used to hand `parameters` straight to the handler, so the
 * `required` list and the per-parameter types the tools advertise (and that the
 * LLM is billed to follow) were never enforced — a call with no arguments ran
 * with `path === undefined`, `content === undefined`, etc. and the failure
 * surfaced as an opaque ENOENT / "Empty path" instead of a schema error.
 * Unknown extra keys are tolerated (handlers ignore what they do not declare).
 * `taskId` is satisfied by the invocation itself, not by the payload.
 */
export function validateToolParameters(
  def: ToolDefinition,
  parameters: Record<string, any> | undefined,
  invocationTaskId?: string
): { ok: true } | { ok: false; error: string } {
  const payload = parameters ?? {};
  const problems: string[] = [];
  for (const name of def.required ?? []) {
    const value = payload[name];
    const missing =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '');
    if (!missing) continue;
    // `taskId` is supplied by the engine on the invocation, not by the caller
    if (name === 'taskId' && invocationTaskId) continue;
    // the declared description is the hint the model needs to fix the call
    const hint = def.parameters?.[name]?.description;
    problems.push(
      `missing required parameter "${name}"${hint ? ` (${hint})` : ''}`
    );
  }
  for (const [name, spec] of Object.entries(def.parameters ?? {})) {
    const value = payload[name];
    if (value === undefined || value === null) continue;
    if (name === 'taskId' && !('taskId' in payload)) continue;
    const check = TYPE_CHECKS[spec.type];
    if (check && !check(value)) {
      problems.push(`parameter "${name}" must be ${spec.type === 'object' || spec.type === 'array' ? 'an' : 'a'} ${spec.type}`);
    }
  }
  if (problems.length) return { ok: false, error: `Invalid parameters: ${problems.join('; ')}` };
  return { ok: true };
}

/**
 * Invoke a registered tool with permission enforcement, timeout, and redaction.
 *
 * H4: tool payloads are deliberately NOT run through the shell-command
 * classifier (`checkCommand`). The old code classified
 * `${tool} ${JSON.stringify(parameters)}`, so ANY invocation whose JSON
 * happened to be longer than 500 chars was rejected as "forbidden" — and a
 * parameter that merely MENTIONED a word like "shutdown" was too. Tool
 * permission is a declared property (`def.permission`), reviewed at
 * registration time; destructive tools still require explicit approval below.
 */
export async function invokeTool(invocation: ToolInvocation): Promise<ToolResult> {
  const def = TOOL_REGISTRY.get(invocation.tool);
  const handler = TOOL_HANDLERS.get(invocation.tool);
  const started = Date.now();

  if (!def || !handler) {
    const result: ToolResult = {
      ok: false,
      error: `Unknown tool: ${invocation.tool}`,
      at: new Date().toISOString(),
    };
    auditCall({ tool: invocation.tool, parameters: invocation.parameters, result, taskId: invocation.taskId, at: result.at });
    return result;
  }

  // permission enforcement — based on the tool's DECLARED permission only
  if (def.permission === 'forbidden') {
    const result: ToolResult = {
      ok: false,
      error: `Tool ${invocation.tool} is forbidden`,
      permission: 'forbidden',
      reason: 'Tool declared forbidden',
      at: new Date().toISOString(),
    };
    auditCall({ tool: invocation.tool, parameters: invocation.parameters, result, taskId: invocation.taskId, at: result.at });
    return result;
  }

  if (def.permission === 'destructive' && !invocation.approvedCommands?.includes(invocation.tool)) {
    const result: ToolResult = {
      ok: false,
      error: `Tool ${invocation.tool} requires explicit approval`,
      permission: 'destructive',
      reason: 'User approval required for destructive tool',
      at: new Date().toISOString(),
    };
    auditCall({ tool: invocation.tool, parameters: invocation.parameters, result, taskId: invocation.taskId, at: result.at });
    return result;
  }

  // declared-schema validation (H10) — before the handler sees anything
  const validation = validateToolParameters(def, invocation.parameters, invocation.taskId);
  if (!validation.ok) {
    const result: ToolResult = {
      ok: false,
      error: validation.error,
      permission: def.permission,
      reason: 'Parameter validation failed',
      at: new Date().toISOString(),
    };
    auditCall({ tool: invocation.tool, parameters: invocation.parameters, result, taskId: invocation.taskId, at: result.at });
    return result;
  }

  try {
    // run handler with timeout
    // L: the losing setTimeout used to stay armed for the full timeout — one
    // leaked timer per invocation kept the event loop busy for nothing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        handler(invocation),
        new Promise<ToolResult>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Tool timeout after ${def.timeoutMs}ms`)), def.timeoutMs);
        }),
      ]);

      const durationMs = Date.now() - started;
      const enriched: ToolResult = {
        ...result,
        durationMs,
        at: new Date().toISOString(),
      };

      // Redact every result shape, not only top-level strings (file reads and
      // connector responses commonly nest credentials in objects/arrays).
      if (enriched.data !== undefined) {
        if (typeof enriched.data === 'string') {
          const { masked, found } = protect(enriched.data);
          enriched.data = masked;
          enriched.redacted = found.length > 0 ? { found, masked } : undefined;
        } else {
          enriched.data = redactUnknown(enriched.data);
        }
      }
      if (enriched.error && typeof enriched.error === 'string') {
        const { masked } = protect(enriched.error);
        enriched.error = masked;
      }

      auditCall({ tool: invocation.tool, parameters: invocation.parameters, result: enriched, taskId: invocation.taskId, at: enriched.at });
      return enriched;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    const durationMs = Date.now() - started;
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    const result: ToolResult = {
      ok: false,
      error: errorMsg,
      durationMs,
      at: new Date().toISOString(),
    };
    auditCall({ tool: invocation.tool, parameters: invocation.parameters, result, taskId: invocation.taskId, at: result.at });
    return result;
  }
}

// ---------- built-in tools ----------

function makeToolResult(ok: boolean, data?: any, error?: string, opts?: { permission?: Permission; exitCode?: number | null }): ToolResult {
  return {
    ok,
    data,
    error,
    permission: opts?.permission,
    exitCode: opts?.exitCode,
    at: new Date().toISOString(),
  };
}

/** FILE: read a file from the workspace */
registerTool(
  {
    name: 'file-read',
    description: 'Read a file from the isolated workspace',
    category: 'file',
    parameters: {
      path: { type: 'string', description: 'Relative path within workspace', required: true },
    },
    required: ['path'],
    permission: 'safe',
    timeoutMs: 10000,
  },
  async ({ taskId, parameters }) => {
    const path = parameters.path as string;
    try {
      const content = await readWorkspaceFile(taskId, path);
      return makeToolResult(true, { path, content }, undefined, { permission: 'safe' });
    } catch (err) {
      return makeToolResult(false, undefined, err instanceof Error ? err.message : 'Read failed');
    }
  }
);

/** FILE: write a file to the workspace */
registerTool(
  {
    name: 'file-write',
    description: 'Write or overwrite a file in the isolated workspace',
    category: 'file',
    parameters: {
      path: { type: 'string', description: 'Relative path within workspace', required: true },
      content: { type: 'string', description: 'File content', required: true },
    },
    required: ['path', 'content'],
    permission: 'review',
    timeoutMs: 10000,
  },
  async ({ taskId, parameters }) => {
    const path = parameters.path as string;
    const content = parameters.content as string;
    try {
      const result = await writeWorkspaceFile(taskId, path, content);
      return makeToolResult(true, { path, bytes: result.bytes }, undefined, { permission: 'review' });
    } catch (err) {
      return makeToolResult(false, undefined, err instanceof Error ? err.message : 'Write failed');
    }
  }
);

/** FILE: delete a file from the workspace */
registerTool(
  {
    name: 'file-delete',
    description: 'Delete a file from the isolated workspace',
    category: 'file',
    parameters: {
      path: { type: 'string', description: 'Relative path within workspace', required: true },
    },
    required: ['path'],
    permission: 'destructive',
    timeoutMs: 10000,
  },
  async ({ taskId, parameters, approvedCommands }) => {
    const path = parameters.path as string;
    try {
      await deleteWorkspaceFile(taskId, path);
      return makeToolResult(true, { path }, undefined, { permission: 'destructive' });
    } catch (err) {
      return makeToolResult(false, undefined, err instanceof Error ? err.message : 'Delete failed');
    }
  }
);

/** FILE: list workspace tree */
registerTool(
  {
    name: 'file-list',
    description: 'List files in the isolated workspace',
    category: 'workspace',
    parameters: {
      taskId: { type: 'string', description: 'Task ID', required: true },
      maxDepth: { type: 'number', description: 'Max directory depth', required: false },
    },
    required: ['taskId'],
    permission: 'safe',
    timeoutMs: 10000,
  },
  async ({ taskId, parameters }) => {
    const maxDepth = typeof parameters.maxDepth === 'number' ? parameters.maxDepth : 6;
    try {
      const tree = await listTree(taskId, maxDepth);
      return makeToolResult(true, { tree }, undefined, { permission: 'safe' });
    } catch (err) {
      return makeToolResult(false, undefined, err instanceof Error ? err.message : 'List failed');
    }
  }
);

/** TERMINAL: execute a command in the workspace */
registerTool(
  {
    name: 'terminal',
    description: 'Execute a command in the isolated workspace',
    category: 'terminal',
    parameters: {
      command: { type: 'string', description: 'Shell command to execute', required: true },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds', required: false },
    },
    required: ['command'],
    permission: 'review',
    timeoutMs: 120000,
  },
  async ({ taskId, parameters, approvedCommands }) => {
    const command = parameters.command as string;
    const timeoutMs = typeof parameters.timeoutMs === 'number' ? parameters.timeoutMs : 120000;
    try {
      const res = await executeCommand(taskId, command, {
        approvedCommands,
        timeoutMs,
      });
      const succeeded = res.exitCode === 0;
      return makeToolResult(
        succeeded,
        { command: res.command, exitCode: res.exitCode, output: res.output, durationMs: res.durationMs },
        succeeded ? undefined : `Command exited with code ${res.exitCode ?? 'unknown'}`,
        { permission: res.permission, exitCode: res.exitCode }
      );
    } catch (err) {
      return makeToolResult(false, undefined, err instanceof Error ? err.message : 'Command failed');
    }
  }
);

/** GIT: initialize repo and create baseline */
registerTool(
  {
    name: 'git-init',
    description: 'Initialize git repository and create baseline commit',
    category: 'git',
    parameters: {
      taskId: { type: 'string', description: 'Task ID', required: true },
      label: { type: 'string', description: 'Baseline label', required: false },
    },
    required: ['taskId'],
    permission: 'review',
    timeoutMs: 30000,
  },
  async ({ taskId, parameters }) => {
    try {
      await ensureRepo(taskId, parameters.label || 'baseline');
      return makeToolResult(true, { initialized: true }, undefined, { permission: 'review' });
    } catch (err) {
      return makeToolResult(false, undefined, err instanceof Error ? err.message : 'Git init failed');
    }
  }
);

/** GIT: snapshot current state */
registerTool(
  {
    name: 'git-snapshot',
    description: 'Create a git snapshot of the current workspace state',
    category: 'git',
    parameters: {
      taskId: { type: 'string', description: 'Task ID', required: true },
      label: { type: 'string', description: 'Snapshot label', required: true },
    },
    required: ['taskId', 'label'],
    permission: 'review',
    timeoutMs: 30000,
  },
  async ({ taskId, parameters }) => {
    try {
      const snap = await snapshot(taskId, parameters.label);
      return makeToolResult(true, snap, undefined, { permission: 'review' });
    } catch (err) {
      return makeToolResult(false, undefined, err instanceof Error ? err.message : 'Snapshot failed');
    }
  }
);

/** GIT: diff between refs */
registerTool(
  {
    name: 'git-diff',
    description: 'Get git diff between two references',
    category: 'git',
    parameters: {
      taskId: { type: 'string', description: 'Task ID', required: true },
      from: { type: 'string', description: 'From ref', required: false },
      to: { type: 'string', description: 'To ref (default HEAD)', required: false },
    },
    required: ['taskId'],
    permission: 'safe',
    timeoutMs: 30000,
  },
  async ({ taskId, parameters }) => {
    try {
      const from = parameters.from || (await baselineRef(taskId));
      const to = parameters.to || 'HEAD';
      const diff = await diffBetween(taskId, from, to);
      const files = await changedFiles(taskId, from, to);
      return makeToolResult(true, { from, to, diff, files }, undefined, { permission: 'safe' });
    } catch (err) {
      return makeToolResult(false, undefined, err instanceof Error ? err.message : 'Diff failed');
    }
  }
);

/** GIT: rollback to a reference */
registerTool(
  {
    name: 'git-rollback',
    description: 'Rollback workspace to a git reference',
    category: 'git',
    parameters: {
      taskId: { type: 'string', description: 'Task ID', required: true },
      ref: { type: 'string', description: 'Git reference to rollback to', required: true },
    },
    required: ['taskId', 'ref'],
    permission: 'destructive',
    timeoutMs: 30000,
  },
  async ({ taskId, parameters, approvedCommands }) => {
    try {
      await rollbackTo(taskId, parameters.ref);
      const snap = await snapshot(taskId, `rollback-to-${parameters.ref}`);
      return makeToolResult(true, { ref: parameters.ref, snapshot: snap }, undefined, { permission: 'destructive' });
    } catch (err) {
      return makeToolResult(false, undefined, err instanceof Error ? err.message : 'Rollback failed');
    }
  }
);

/** WORKSPACE: create workspace for a task */
registerTool(
  {
    name: 'workspace-create',
    description: 'Create an isolated workspace for a task',
    category: 'workspace',
    parameters: {
      taskId: { type: 'string', description: 'Task ID', required: true },
    },
    required: ['taskId'],
    permission: 'safe',
    timeoutMs: 10000,
  },
  async ({ taskId }) => {
    try {
      // actually create the directory — returning a path that does not exist
      // made every follow-up file tool fail
      const ws = await createWorkspace(taskId);
      return makeToolResult(true, { taskId, workspacePath: ws }, undefined, { permission: 'safe' });
    } catch (err) {
      return makeToolResult(false, undefined, err instanceof Error ? err.message : 'Workspace creation failed');
    }
  }
);

// ---------- health checks ----------

export interface ToolHealthCheck {
  tool: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Check that a tool is wired up correctly.
 *
 * M4 kept the point: "the handler did not throw" is NOT a health signal,
 * because `invokeTool` RETURNS `ok:false` results instead of throwing.
 *
 * H11 fixes what the M4 fix left behind: probing a tool means EXECUTING it, so
 * the old "minimal parameters" call
 *   • created a git repo and committed in the workspace (`git-init`,
 *     `git-snapshot` are `review` tools that were run anyway),
 *   • auto-approved every `destructive` tool (`approvedCommands: [toolName]`),
 *     i.e. a status endpoint was allowed to delete files and roll the
 *     workspace back, and
 *   • reported every tool with a required parameter as BROKEN, because the
 *     empty probe payload was rejected — a false alarm on a perfectly healthy
 *     toolset, in the UI and on /api/system/status.
 *
 * A registry health check can honestly answer one question: is the tool
 * registered, bound to a handler and does its own definition satisfy the
 * schema? That is what it checks now. Pass `{ probe: true }` (only for tools
 * that declare `permission: 'safe'` and need no payload) to additionally run
 * the handler — the deep probe is opt-in precisely because it has effects.
 */
export interface ToolHealthOptions {
  /** actually invoke the handler (only for side-effect-free, safe tools) */
  probe?: boolean;
}

const PROBE_EXCLUDED_TOOLS = new Set(['workspace-create', 'browser-session']);

export async function healthCheckTool(
  toolName: string,
  taskId: string,
  options: ToolHealthOptions = {}
): Promise<ToolHealthCheck> {
  const started = Date.now();
  const def = TOOL_REGISTRY.get(toolName);
  if (!def) {
    return { tool: toolName, ok: false, latencyMs: 0, error: 'Tool not registered' };
  }
  if (!TOOL_HANDLERS.get(toolName)) {
    return { tool: toolName, ok: false, latencyMs: 0, error: 'Tool has no handler' };
  }
  const parsed = ToolDefinitionSchema.safeParse(def);
  if (!parsed.success) {
    return {
      tool: toolName,
      ok: false,
      latencyMs: Date.now() - started,
      error: `Tool definition invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  if (!options.probe) {
    return { tool: toolName, ok: true, latencyMs: Date.now() - started };
  }
  // H37: a few tools are labelled 'safe' (nobody has to approve them) yet are
  // NOT harmless to call casually — they allocate a live resource or create
  // directories on disk. A health probe must never leave an orphaned browser
  // session (with a DB row, an audit entry and an open Playwright context) or
  // a stray workspace behind, so these stay structural-only even in probe mode.
  if (PROBE_EXCLUDED_TOOLS.has(toolName)) {
    return {
      tool: toolName,
      ok: true,
      latencyMs: Date.now() - started,
      error: 'not probed: tool allocates a live resource',
    };
  }
  // a probe is only allowed for read-only tools with no required input
  const needsPayload = (def.required ?? []).filter((name) => name !== 'taskId');
  if (def.permission !== 'safe' || needsPayload.length) {
    return {
      tool: toolName,
      ok: true,
      latencyMs: Date.now() - started,
      error:
        def.permission !== 'safe'
          ? 'not probed: tool can mutate state'
          : 'not probed: tool needs parameters',
    };
  }
  try {
    const result = await invokeTool({ tool: toolName, parameters: {}, taskId });
    return {
      tool: toolName,
      ok: result.ok === true,
      latencyMs: Date.now() - started,
      ...(result.ok === true ? {} : { error: result.error || 'tool returned ok:false' }),
    };
  } catch (err) {
    return {
      tool: toolName,
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Run health checks on all registered tools.
 */
export async function healthCheckAllTools(
  taskId: string,
  options: ToolHealthOptions = {}
): Promise<ToolHealthCheck[]> {
  const tools = listTools();
  const results = await Promise.all(tools.map((t) => healthCheckTool(t.name, taskId, options)));
  return results;
}
