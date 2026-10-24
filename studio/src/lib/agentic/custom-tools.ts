// custom-tools.ts — SELF-BUILT tools (Feature 6).
//
// The agent (or the user) can propose NEW tools ("Jira connector banao").
// A custom tool is:
//   1. DRAFT — code + schema, not executable;
//   2. PENDING_APPROVAL — proposed, awaiting the user's review;
//   3. ACTIVE — the user approved it, it is loaded into the live tool
//      registry and invocable like any built-in tool (same permission
//      system, timeout, audit, secret redaction);
//   4. DISABLED / REJECTED — off.
//
// SECURITY MODEL (mirrors the platform spec):
//   - the tool code is a plain async function body executed in a DEDICATED
//     V8 context (node:vm) whose global object contains ONLY what is listed in
//     TOOL_SANDBOX_GLOBALS. `process`, `require`, `fs`, the host `fetch` and
//     the host intrinsics are structurally absent, and string code generation
//     (eval / new Function) is switched off for that context, so the classic
//     `Function("return this")()` / `""["constructor"]` escapes cannot reach
//     the host realm;
//   - a static scan (see FORBIDDEN_CODE_PATTERNS) runs BEFORE approval and
//     again at load time so obviously hostile code is rejected with a clear
//     reason instead of failing at runtime (defence in depth, not the
//     boundary itself);
//   - the ONLY way out is `api.fetch` — the SAME SSRF-guarded HTTP the
//     provider connections use, locked to the tool's declared baseUrl;
//   - a custom tool NEVER sees production credentials: no env access, no
//     provider store, credentials arrive only through its own parameters;
//   - every invocation is audited and counted.

import { z } from 'zod';
import vm from 'node:vm';
import { db } from '@/lib/db';
import {
  registerTool,
  unregisterTool,
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
} from './tool-registry';
import { assertOutboundUrl, OutboundUrlError } from './outbound';
import { recordAudit } from './audit';

// ---------- schema ----------

export const CustomToolParamSchema = z.object({
  name: z.string().min(1).max(60).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'parameter name must be a valid identifier'),
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  description: z.string().max(300).optional(),
  required: z.boolean().default(false),
});

export const CustomToolInputSchema = z.object({
  name: z
    .string()
    .min(3)
    .max(60)
    .regex(/^[a-z][a-z0-9-]*$/, 'tool name: lowercase letters, digits and dashes (e.g. "jira-search")'),
  description: z.string().min(8).max(500),
  category: z.enum(['adapter', 'custom']).default('custom'),
  params: z.array(CustomToolParamSchema).max(12).default([]),
  /** least permission the tool needs — review is the ceiling for customs */
  permission: z.enum(['safe', 'review']).default('review'),
  /** all api.fetch calls are locked to this base URL (SSRF-guarded) */
  baseUrl: z.string().url().optional().or(z.literal('')),
  code: z.string().min(20).max(20_000),
});

export type CustomToolInput = z.infer<typeof CustomToolInputSchema>;

export class CustomToolError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'CustomToolError';
    this.field = field;
  }
}

// ---------- static code safety ----------

/** Tokens a custom tool must NEVER contain (checked at save AND load time). */
const FORBIDDEN_CODE_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  // These patterns are CODE-shaped (a call, a member access), not word-shaped,
  // so ordinary prose in a string or comment ("this requires a key") does not
  // trip the scan. They exist to give a clear reason at save time — the real
  // boundary is the sandbox context itself (see runToolCode).
  { pattern: /\brequire\s*\(/, why: 'require() is not available in the tool sandbox' },
  { pattern: /\bimport\s*\(|\bimport\s+[\w{*]/, why: 'import statements are not available in the tool sandbox' },
  { pattern: /\bprocess\s*\./, why: 'process access is not available (no env credentials)' },
  { pattern: /\bglobalThis\b/, why: 'globalThis access is not allowed' },
  // H8: the old scan only rejected `eval(` and `new Function`, so
  // `Function("return process")()` and the `""["constructor"]["constructor"]`
  // chain walked straight out of the "sandbox". Any code generation and any
  // realm hop is refused now.
  { pattern: /\beval\s*\(/, why: 'eval() is not allowed' },
  { pattern: /\bFunction\s*\(|\bnew\s+Function\b/, why: 'the Function constructor is not allowed (no code generation)' },
  { pattern: /\.\s*constructor\b|\bconstructor\s*\[|\bprototype\b|__proto__/, why: 'prototype / constructor access is not allowed' },
  { pattern: /\bgetPrototypeOf\b|\bsetPrototypeOf\b|\bdefineProperty\b/, why: 'prototype manipulation is not allowed' },
  { pattern: /\bReflect\s*[.[]|\bWebAssembly\b/, why: 'Reflect/WebAssembly are not available in the tool sandbox' },
  { pattern: /\bBuffer\s*[.([]/, why: 'Buffer access is not allowed' },
  { pattern: /\b(?:document|window)\s*[.[]/, why: 'browser globals do not exist in the tool sandbox' },
  // `api.fetch` is the ONLY network path (SSRF-guarded + baseUrl-locked), so a
  // raw global fetch must not be reachable.
  { pattern: /(?<![.\w$])fetch\s*\(/, why: 'use api.fetch() — the raw global fetch is not available' },
];


export function scanToolCode(code: string): { ok: true } | { ok: false; reason: string } {
  for (const { pattern, why } of FORBIDDEN_CODE_PATTERNS) {
    if (pattern.test(code)) return { ok: false, reason: why };
  }
  // the code must be syntactically valid as an async function body — compiled
  // exactly the way the sandbox runs it, so a tool cannot save fine and then
  // fail at invocation time
  try {
    new vm.Script(wrapToolCode(code), { filename: 'custom-tool.js' });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Syntax error in tool code: ${errorMessage(err)}` };
  }
}

/** The tool body wrapped in a strict, awaitable async IIFE. */
function wrapToolCode(code: string): string {
  return `"use strict";\n(async () => {\n${code}\n})()`;
}

/** A sandboxed script throws its OWN Error class, so `instanceof` cannot be used. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const maybe = err as { message?: unknown } | null;
  if (maybe && typeof maybe.message === 'string') return maybe.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

// ---------- CRUD ----------

export async function createCustomTool(
  input: unknown,
  opts: { createdBy?: string } = {}
): Promise<{ id: string; status: string }> {
  const parsed = CustomToolInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CustomToolError(
      'input',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
  }
  const data = parsed.data;

  const scan = scanToolCode(data.code);
  if (!scan.ok) throw new CustomToolError('code', `Unsafe tool code — ${scan.reason}`);

  const existing = await db.customTool.findUnique({ where: { name: data.name } });
  if (existing) {
    throw new CustomToolError('name', `A tool named "${data.name}" already exists`);
  }

  const row = await db.customTool.create({
    data: {
      name: data.name,
      description: data.description,
      category: data.category,
      // the params array AND the (public, non-secret) baseUrl live in one
      // JSON envelope: { params: [...], baseUrl: "..." }
      paramsSchema: JSON.stringify({ params: data.params, baseUrl: data.baseUrl ?? '' }),
      permission: data.permission,
      code: data.code,
      status: 'pending_approval',
      createdBy: opts.createdBy ?? 'user',
    },
  });

  await recordAudit({
    actor: opts.createdBy === 'agent' ? 'agent:coder' : 'user',
    action: 'tool.propose',
    category: 'tool',
    details: { toolId: row.id, name: data.name, permission: data.permission, hasBaseUrl: Boolean(data.baseUrl) },
  });
  return { id: row.id, status: row.status };
}

export async function listCustomTools(): Promise<
  Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    permission: string;
    status: string;
    version: number;
    createdBy: string;
    invokeCount: number;
    lastError: string;
    params: Array<{ name: string; type: string; description?: string; required: boolean }>;
    baseUrl: string;
    updatedAt: string;
  }>
> {
  const rows = await db.customTool.findMany({ orderBy: { updatedAt: 'desc' } });
  return rows.map((r) => {
    let envelope: { params?: unknown[]; baseUrl?: string } = {};
    try {
      const raw = JSON.parse(r.paramsSchema || '[]');
      envelope = Array.isArray(raw) ? { params: raw } : raw;
    } catch {
      envelope = {};
    }
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      permission: r.permission,
      status: r.status,
      version: r.version,
      createdBy: r.createdBy,
      invokeCount: r.invokeCount,
      lastError: r.lastError,
      params: (envelope.params ?? []) as Array<{ name: string; type: string; description?: string; required: boolean }>,
      baseUrl: envelope.baseUrl ?? '',
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

export async function decideCustomTool(
  id: string,
  decision: 'approve' | 'reject' | 'disable' | 'enable',
  opts: { actor?: string } = {}
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const row = await db.customTool.findUnique({ where: { id } });
  if (!row) return { ok: false, error: 'Tool not found' };

  const scan = scanToolCode(row.code);
  if ((decision === 'approve' || decision === 'enable') && !scan.ok) {
    await db.customTool.update({ where: { id }, data: { lastError: scan.reason } });
    return { ok: false, error: `Cannot activate — ${scan.reason}` };
  }

  let status = row.status;
  if (decision === 'approve') {
    if (row.status !== 'pending_approval') {
      return { ok: false, error: `Tool is ${row.status}, not pending approval` };
    }
    status = 'active';
  } else if (decision === 'reject') {
    status = 'rejected';
  } else if (decision === 'disable') {
    status = 'disabled';
  } else if (decision === 'enable') {
    if (row.status !== 'disabled') return { ok: false, error: `Tool is ${row.status}` };
    status = 'active';
  }

  const updated = await db.customTool.update({
    where: { id },
    data: {
      status,
      approvedBy: decision === 'approve' ? (opts.actor ?? 'user') : row.approvedBy,
      version: { increment: 1 },
    },
  });

  if (status === 'active') {
    loadCustomToolIntoRegistry(updated);
  } else {
    unregisterTool(row.name);
    LIVE_CUSTOM_TOOLS.delete(row.name);
  }

  await recordAudit({
    actor: opts.actor ?? 'user',
    action: `tool.${decision}`,
    category: 'tool',
    // M3: the audit verdict must reflect the decision — a REJECTED tool was
    // labelled 'auto' (as if nobody had decided), which mislabelled the trail.
    approval:
      decision === 'approve'
        ? 'approved'
        : decision === 'reject'
          ? 'denied'
          : 'auto',
    details: { toolId: id, name: row.name, status },
  });
  return { ok: true, status };
}

export async function deleteCustomTool(id: string): Promise<boolean> {
  const row = await db.customTool.findUnique({ where: { id } });
  if (!row) return false;
  await db.customTool.delete({ where: { id } });
  // H9: a deleted tool used to stay REGISTERED (and callable) until the next
  // restart — the DB row was gone, so every later call ran orphaned code that
  // could no longer be audited, disabled or reviewed. Take it out of the live
  // registry now.
  unregisterTool(row.name);
  LIVE_CUSTOM_TOOLS.delete(row.name);
  await recordAudit({
    actor: 'user',
    action: 'tool.delete',
    category: 'tool',
    details: { toolId: id, name: row.name },
  });
  return true;
}

// ---------- runtime ----------

interface LoadedCustomTool {
  row: {
    id: string;
    name: string;
    description: string;
    category: string;
    permission: string;
    code: string;
  };
  baseUrl: string;
  paramDefs: Array<{ name: string; type: string; required: boolean }>;
}

/** Live custom tools: name → compiled executor. */
const LIVE_CUSTOM_TOOLS = new Map<string, LoadedCustomTool>();

function compileCustomTool(row: {
  id: string;
  name: string;
  description: string;
  category: string;
  permission: string;
  code: string;
  paramsSchema: string;
}): LoadedCustomTool {
  let envelope: { params?: unknown[]; baseUrl?: string } = {};
  try {
    const raw = JSON.parse(row.paramsSchema || '[]');
    envelope = Array.isArray(raw) ? { params: raw } : raw;
  } catch {
    envelope = {};
  }
  return {
    row,
    baseUrl: String(envelope.baseUrl ?? ''),
    paramDefs: (envelope.params ?? []) as Array<{ name: string; type: string; required: boolean }>,
  };
}

/**
 * The sandboxed `api` handed to a custom tool:
 * - api.fetch: SSRF-guarded, locked to the tool's baseUrl;
 * - api.log: audit-safe note taking (redacted upstream);
 * - api.now: monotonic clock.
 * NOTHING else — no process, no require, no env, no provider store.
 */
function makeToolApi(tool: LoadedCustomTool, onLog: (line: string) => void) {
  const base = tool.baseUrl ? new URL(tool.baseUrl).origin : '';
  return {
    async fetch(url: string, init: RequestInit = {}): Promise<{ status: number; body: string; ok: boolean }> {
      let target = String(url ?? '');
      if (base && !/^https?:\/\//i.test(target)) {
        target = `${base.replace(/\/$/, '')}/${target.replace(/^\//, '')}`;
      }
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        throw new CustomToolError('fetch', `Invalid URL: ${target}`);
      }
      // SSRF guard — same rules as the provider connections
      await assertOutboundUrl(parsed.toString(), {});
      // lock to the declared origin when one exists
      if (base && parsed.origin !== base) {
        throw new CustomToolError('fetch', `Custom tool may only call its declared baseUrl (${base})`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(parsed.toString(), {
          ...init,
          signal: controller.signal,
          headers: {
            'user-agent': 'AgentScope-Studio-CustomTool/1.0',
            ...(init.headers ?? {}),
          },
        });
        const body = (await res.text()).slice(0, 200_000);
        return { status: res.status, body, ok: res.ok };
      } finally {
        clearTimeout(timer);
      }
    },
    log: (line: string) => onLog(String(line).slice(0, 500)),
    now: () => Date.now(),
  };
}

/** Hard cap on a single tool invocation (the sync part is killed at this point). */
export const TOOL_SANDBOX_TIMEOUT_MS = 30_000;

/**
 * The globals a custom tool can see. Everything the host has and is NOT listed
 * here simply does not exist inside the sandbox — no `process`, no `require`,
 * no filesystem, no host `fetch`, no provider store, no env.
 */
const TOOL_SANDBOX_GLOBALS = [
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'AbortSignal',
] as const;

/**
 * H8: run the tool body in a DEDICATED V8 context instead of a host-realm
 * `new Function`. Inside that context `Function`, `eval` and
 * `""["constructor"]["constructor"]` resolve to the SANDBOX realm and string
 * code generation is disabled outright (`codeGeneration.strings: false`), so
 * compiled strings can no longer reach the host realm and read
 * `process.env`/the provider store. Timers are capped and always torn down
 * with the invocation, so a tool cannot outlive its own call.
 */
function runToolCode(
  code: string,
  params: Record<string, unknown>,
  api: unknown,
  timeoutMs = TOOL_SANDBOX_TIMEOUT_MS
): Promise<unknown> {
  const timers = new Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();
  const clearAll = () => {
    for (const t of timers) {
      clearTimeout(t as ReturnType<typeof setTimeout>);
      clearInterval(t as ReturnType<typeof setInterval>);
    }
    timers.clear();
  };
  const clamp = (ms: unknown, min: number, max: number) =>
    Math.min(Math.max(min, Number.isFinite(Number(ms)) ? Number(ms) : min), max);

  const sandbox: Record<string, unknown> = { params, api };
  for (const name of TOOL_SANDBOX_GLOBALS) sandbox[name] = globalThis[name as keyof typeof globalThis];
  sandbox.setTimeout = (fn: unknown, ms: unknown = 0, ...args: unknown[]) => {
    const delay = clamp(ms, 0, timeoutMs);
    const id = setTimeout(() => {
      timers.delete(id);
      if (typeof fn === 'function') (fn as (...a: unknown[]) => void)(...args);
    }, delay);
    timers.add(id);
    return id;
  };
  sandbox.clearTimeout = (id: unknown) => {
    if (id !== undefined && id !== null) clearTimeout(id as ReturnType<typeof setTimeout>);
    timers.delete(id as ReturnType<typeof setTimeout>);
  };
  sandbox.setInterval = (fn: unknown, ms: unknown = 1000, ...args: unknown[]) => {
    const every = clamp(ms, 1000, 60_000);
    const id = setInterval(() => {
      if (typeof fn === 'function') (fn as (...a: unknown[]) => void)(...args);
    }, every);
    timers.add(id);
    return id;
  };
  sandbox.clearInterval = (id: unknown) => {
    if (id !== undefined && id !== null) clearInterval(id as ReturnType<typeof setInterval>);
    timers.delete(id as ReturnType<typeof setInterval>);
  };

  let context: vm.Context;
  try {
    context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  } catch {
    context = vm.createContext(sandbox);
  }
  const script = new vm.Script(wrapToolCode(code), { filename: 'custom-tool.js' });
  let value: unknown;
  try {
    // `timeout` bounds the SYNCHRONOUS part — an infinite loop in a tool can
    // no longer wedge the whole Studio process
    value = script.runInContext(context, { timeout: timeoutMs, breakOnSigint: false });
  } catch (err) {
    clearAll();
    throw err;
  }
  return Promise.resolve(value).finally(clearAll);
}

function loadCustomToolIntoRegistry(row: {
  id: string;
  name: string;
  description: string;
  category: string;
  permission: string;
  code: string;
  paramsSchema: string;
}): void {
  const tool = compileCustomTool(row);
  const scan = scanToolCode(tool.row.code);
  if (!scan.ok) return; // never load unsafe code

  const def: ToolDefinition = {
    name: tool.row.name,
    description: `[custom] ${tool.row.description}`,
    category: tool.row.category === 'adapter' ? 'adapter' : 'custom',
    parameters: Object.fromEntries(
      tool.paramDefs.map((p) => [
        p.name,
        { type: p.type as 'string' | 'number' | 'boolean' | 'array' | 'object', required: p.required },
      ])
    ),
    required: tool.paramDefs.filter((p) => p.required).map((p) => p.name),
    permission: tool.row.permission === 'safe' ? 'safe' : 'review',
    timeoutMs: 60_000,
  };

  registerTool(def, async (invocation: ToolInvocation): Promise<ToolResult> => {
    const at = new Date().toISOString();
    const logs: string[] = [];
    // a FRESH sandbox per invocation — no state leaks between calls and no
    // shared global object to poison
    let result: unknown;
    try {
      result = await runToolCode(
        tool.row.code,
        invocation.parameters ?? {},
        makeToolApi(tool, (l) => logs.push(l))
      );
    } catch (err) {
      const message = errorMessage(err) || 'Tool execution failed';
      await db.customTool
        .update({
          where: { id: tool.row.id },
          data: { invokeCount: { increment: 1 }, lastInvokedAt: new Date(), lastError: message.slice(0, 500) },
        })
        .catch(() => undefined);
      return { ok: false, error: message, at };
    }

    await db.customTool
      .update({
        where: { id: tool.row.id },
        data: { invokeCount: { increment: 1 }, lastInvokedAt: new Date(), lastError: '' },
      })
      .catch(() => undefined);

    const data =
      typeof result === 'string' ? result : result === undefined ? null : JSON.stringify(result);
    return {
      ok: true,
      data,
      at,
      // logs are returned as part of a small envelope so the caller can see them
      error: undefined,
      ...(logs.length ? { reason: `logs: ${logs.join(' | ').slice(0, 400)}` } : {}),
    } as ToolResult;
  });

  LIVE_CUSTOM_TOOLS.set(tool.row.name, tool);
}

/** Load every ACTIVE custom tool into the registry (called at boot). */
export async function loadActiveCustomTools(): Promise<number> {
  const rows = await db.customTool.findMany({ where: { status: 'active' } });
  let loaded = 0;
  for (const row of rows) {
    const before = LIVE_CUSTOM_TOOLS.size;
    loadCustomToolIntoRegistry(row);
    if (LIVE_CUSTOM_TOOLS.size > before) loaded++;
  }
  if (loaded) {
    await recordAudit({
      actor: 'system',
      action: 'tool.load_custom',
      category: 'tool',
      approval: 'auto',
      details: { loaded },
    });
  }
  return loaded;
}

export function liveCustomToolNames(): string[] {
  return Array.from(LIVE_CUSTOM_TOOLS.keys());
}
