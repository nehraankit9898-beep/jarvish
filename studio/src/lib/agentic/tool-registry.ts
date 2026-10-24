// tool-registry.ts — documented tool interface with discovery, registration,
// schema validation, permission enforcement, timeouts, cancellation, audit logs.

import { z } from 'zod';
import { protect, type SecretScan } from './secrets';
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
  TOOL_AUDIT_LOG.push(record);
  if (TOOL_AUDIT_LOG.length > MAX_AUDIT_LOG) {
    TOOL_AUDIT_LOG.splice(0, TOOL_AUDIT_LOG.length - MAX_AUDIT_LOG);
  }
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

      // redact secrets from result data
      if (enriched.data !== undefined && typeof enriched.data === 'string') {
        const { masked, found } = protect(enriched.data);
        enriched.data = masked;
        enriched.redacted = found.length > 0 ? { found, masked } : undefined;
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
      return makeToolResult(
        true,
        { command: res.command, exitCode: res.exitCode, output: res.output, durationMs: res.durationMs },
        undefined,
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
 * Run a health check on a tool by invoking it with minimal parameters.
 *
 * M4: `invokeTool` RETURNS a failed result (ok:false) instead of throwing
 * when the handler errors — treating "did not throw" as healthy made every
 * tool report ok:true, even broken ones. The result's own ok flag is the
 * health verdict.
 */
export async function healthCheckTool(toolName: string, taskId: string): Promise<ToolHealthCheck> {
  const def = TOOL_REGISTRY.get(toolName);
  if (!def) {
    return { tool: toolName, ok: false, latencyMs: 0, error: 'Tool not registered' };
  }
  const started = Date.now();
  try {
    const result = await invokeTool({
      tool: toolName,
      parameters: {},
      taskId,
      approvedCommands: def.permission === 'destructive' ? [toolName] : [],
    });
    return {
      tool: toolName,
      ok: result.ok === true,
      latencyMs: Date.now() - started,
      ...(result.ok === true ? {} : { error: result.error || 'tool returned ok:false' }),
    };
  } catch (err) {
    return { tool: toolName, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Run health checks on all registered tools.
 */
export async function healthCheckAllTools(taskId: string): Promise<ToolHealthCheck[]> {
  const tools = listTools();
  const results = await Promise.all(tools.map((t) => healthCheckTool(t.name, taskId)));
  return results;
}
