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
//   - the tool code runs in a SHORT-LIVED CHILD PROCESS with a sanitized
//     environment, bounded heap and Node's permission model (no filesystem
//     write, child process, worker, addon or WASI permission). Its V8 context
//     disables string code generation. No host object or function crosses
//     into the Studio process, so a realm escape cannot reach Studio secrets;
//   - if that isolated runtime cannot start, execution FAILS CLOSED. There is
//     deliberately no in-process `node:vm` fallback;
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
import { spawn } from 'node:child_process';
import path from 'node:path';
import { db } from '@/lib/db';
import {
  registerTool,
  unregisterTool,
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
} from './tool-registry';
import { assertOutboundUrl } from './outbound';
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
  const controllers = new Set<AbortController>();

  const checkedTarget = async (raw: string): Promise<URL> => {
    let target = String(raw ?? '');
    if (base && !/^https?:\/\//i.test(target)) {
      target = `${base.replace(/\/$/, '')}/${target.replace(/^\//, '')}`;
    }
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new CustomToolError('fetch', `Invalid URL: ${target}`);
    }
    await assertOutboundUrl(parsed.toString(), {});
    if (base && parsed.origin !== base) {
      throw new CustomToolError('fetch', `Custom tool may only call its declared baseUrl (${base})`);
    }
    return parsed;
  };

  return {
    async fetch(url: string, init: RequestInit = {}): Promise<{ status: number; body: string; ok: boolean }> {
      let current = String(url ?? '');
      for (let hop = 0; hop < 6; hop++) {
        const parsed = await checkedTarget(current);
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), 30_000);
        try {
          let requestInit = init;
          const res = await fetch(parsed.toString(), {
            ...requestInit,
            // Every redirect is checked again. Automatic redirects would let a
            // public URL hop to loopback, metadata, or another origin.
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              'user-agent': 'AgentScope-Studio-CustomTool/1.0',
              ...(requestInit.headers ?? {}),
            },
          });
          const location = res.headers.get('location');
          if (res.status >= 300 && res.status < 400 && location) {
            void res.body?.cancel().catch(() => undefined);
            if (hop === 5) throw new CustomToolError('fetch', 'Too many redirects (maximum 5)');
            current = new URL(location, parsed).toString();
            if (res.status === 303 && !['GET', 'HEAD'].includes((requestInit.method ?? 'GET').toUpperCase())) {
              const headers = { ...(requestInit.headers ?? {}) } as Record<string, string>;
              delete headers['content-type'];
              delete headers['Content-Type'];
              requestInit = { ...requestInit, method: 'GET', body: undefined, headers };
              init = requestInit;
            }
            continue;
          }

          const reader = res.body?.getReader();
          if (!reader) return { status: res.status, body: '', ok: res.ok };
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (size + value.byteLength > 200_000) {
              chunks.push(value.slice(0, 200_000 - size));
              size = 200_000;
              await reader.cancel().catch(() => undefined);
              break;
            }
            chunks.push(value);
            size += value.byteLength;
          }
          const merged = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return { status: res.status, body: new TextDecoder().decode(merged), ok: res.ok };
        } finally {
          clearTimeout(timer);
          controllers.delete(controller);
        }
      }
      throw new CustomToolError('fetch', 'Too many redirects');
    },
    log: (line: string) => onLog(String(line).slice(0, 500)),
    now: () => Date.now(),
    cancel: () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}

/** Hard cap on a single tool invocation; the parent kills the whole child on expiry. */
export const TOOL_SANDBOX_TIMEOUT_MS = 30_000;

/**
 * Execute in the isolated runner. Exported for deterministic timeout and
 * boundary regression tests; production callers use the registry lifecycle.
 */
export function runToolCode(
  code: string,
  params: Record<string, unknown>,
  api: ReturnType<typeof makeToolApi>,
  timeoutMs = TOOL_SANDBOX_TIMEOUT_MS
): Promise<unknown> {
  const runner = path.join(process.cwd(), 'scripts', 'custom-tool-runner.cjs');
  const nodeBinary = (process.env.AGENTSCOPE_NODE_BINARY ?? 'node').trim() || 'node';
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    NODE_OPTIONS: '',
    NODE_ENV: process.env.NODE_ENV ?? 'production',
    ...(process.platform === 'win32'
      ? { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\Windows' }
      : {}),
  };

  // Never fall back to the parent's node:vm context. Node's permission model
  // denies filesystem writes, child processes, workers, addons and WASI in
  // this short-lived process; only the runner source itself is readable. If
  // the runtime cannot provide that isolation, execution fails closed.
  // The argv is assembled with push() ON PURPOSE. A literal array at this call
  // site makes the production bundler (Turbopack) treat `spawn(exe, [...])` as
  // a dynamic module import and fail the build with
  //   "Module not found: Can't resolve ('--experimental-permission' | <dynamic>)"
  // — `next build` could not complete at all, so no distributable bundle (and
  // no Windows installer) could be produced. Same argv, same isolation.
  const runnerArgs: string[] = [];
  runnerArgs.push('--experimental-permission');
  runnerArgs.push(`--allow-fs-read=${runner}`);
  runnerArgs.push('--max-old-space-size=64');
  runnerArgs.push('--max-semi-space-size=4');
  runnerArgs.push(runner);
  const child = spawn(nodeBinary, runnerArgs, {
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      api.cancel();
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } catch {
        // already exiting
      }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`Custom tool exceeded the ${timeoutMs}ms execution limit and was terminated`)),
      timeoutMs + 2_000
    );

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 2_000) stderr += String(chunk).slice(0, 2_000 - stderr.length);
    });
    child.on('error', (err) => finish(new Error(`Isolated custom-tool runtime failed to start: ${err.message}`)));
    child.on('exit', (code, signal) => {
      if (!settled) {
        const detail = stderr.trim().slice(-500);
        finish(new Error(
          `Isolated custom-tool runtime exited before returning a result (${signal ?? `code ${code ?? 'unknown'}`})` +
          (detail ? `: ${detail}` : '')
        ));
      }
    });
    child.on('message', (raw: unknown) => {
      if (settled || !raw || typeof raw !== 'object') return;
      const message = raw as {
        type?: string;
        id?: number;
        url?: string;
        init?: RequestInit;
        line?: string;
        ok?: boolean;
        result?: unknown;
        error?: string;
      };
      if (message.type === 'log') {
        api.log(String(message.line ?? ''));
        return;
      }
      if (message.type === 'fetch' && typeof message.id === 'number') {
        let size = 0;
        try {
          size = JSON.stringify(message.init ?? {}).length;
        } catch {
          size = Number.MAX_SAFE_INTEGER;
        }
        if (size > 64 * 1024 || typeof message.url !== 'string' || message.url.length > 8_192) {
          try {
            child.send({ type: 'fetch_result', id: message.id, ok: false, error: 'Fetch request is too large or malformed' });
          } catch {
            // child may have exited
          }
          return;
        }
        void api.fetch(message.url, message.init ?? {}).then(
          (result) => {
            if (!settled && child.connected) child.send({ type: 'fetch_result', id: message.id, ok: true, result });
          },
          (err) => {
            if (!settled && child.connected) {
              child.send({ type: 'fetch_result', id: message.id, ok: false, error: errorMessage(err).slice(0, 500) });
            }
          }
        );
        return;
      }
      if (message.type === 'result') {
        if (message.ok) finish(null, message.result);
        else finish(new Error(String(message.error ?? 'Tool execution failed').slice(0, 1_000)));
      }
    });

    try {
      child.send({ type: 'run', code, params, timeoutMs });
    } catch (err) {
      finish(new Error(`Could not start the isolated custom tool: ${errorMessage(err)}`));
    }
  });
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
