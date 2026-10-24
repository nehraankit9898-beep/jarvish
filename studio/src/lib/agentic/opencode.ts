import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { protect } from './secrets';
import type { AgenticEvent } from './types';

export interface OpenCodeConfig {
  executablePath?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
  timeoutMs?: number;
}

export interface OpenCodeStatus {
  installed: boolean;
  executablePath?: string;
  version?: string;
  error?: string;
  availableModels?: string[];
  configuredProviders?: string[];
}

export interface OpenCodeTaskResult {
  success: boolean;
  exitCode?: number;
  output: string;
  error: string;
  filesChanged: string[];
  durationMs: number;
}

let activeProcesses = new Map<string, ChildProcess>();

/**
 * The child environment for the OpenCode CLI.
 *
 * SECURITY: this used to be `{ ...process.env }`, which handed the Studio's own
 * secrets — AGENTSCOPE_SECRET_KEY (the AES key for every stored provider key),
 * AGENTSCOPE_API_TOKEN, DATABASE_URL and any key exported in the shell — to an
 * LLM-driven agent that runs commands inside the workspace. "Print your
 * environment" or a `env` call is enough to push them into a chat transcript
 * and out to a third-party model. Every other process spawner in this codebase
 * (terminal.ts `sanitizedEnv`, host-control `hostEnv`, desktop-bridge
 * `bridgeEnv`) already strips them; this one now does the same, and adds back
 * ONLY the provider key the caller explicitly passed for the run.
 */
function openCodeEnv(config: OpenCodeConfig): NodeJS.ProcessEnv {
  const allow = [
    'PATH',
    'HOME',
    'USER',
    'USERNAME',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
    'TEMP',
    'TMP',
    // where OpenCode keeps its own config/cache
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'SystemRoot',
    'SYSTEMROOT',
    'COMSPEC',
    'PATHEXT',
    // outbound proxies, if the operator needs one
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ];
  const env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The key the CALLER passed for this run (never the Studio's stored ones).
  if (config.apiKey) {
    env.OPENAI_API_KEY = config.apiKey;
    env.ANTHROPIC_API_KEY = config.apiKey;
    env.OPENROUTER_API_KEY = config.apiKey;
  }
  if (config.baseUrl) env.OPENAI_BASE_URL = config.baseUrl;
  return env;
}

export async function detectOpenCode(config?: OpenCodeConfig): Promise<OpenCodeStatus> {
  const candidates = [
    config?.executablePath,
    'opencode',
    'opencode.cmd',
    'opencode.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'opencode', 'opencode.exe'),
    join(process.env.APPDATA || '', 'npm', 'opencode.cmd'),
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const proc = spawn(candidate, ['--version'], {
        env: openCodeEnv(config ?? {}),
        shell: false,
      });
      let output = '';
      proc.stdout?.on('data', (data) => { output += data.toString(); });
      proc.stderr?.on('data', (data) => { output += data.toString(); });
      const exitCode = await Promise.race([
        new Promise<number>((resolve) => {
          // a missing executable emits an ASYNC 'error' event — without this
          // listener it becomes an uncaught exception and takes the server down
          proc.on('error', () => resolve(-1));
          proc.on('close', (code) => resolve(code ?? -1));
        }),
        new Promise<number>((resolve) => setTimeout(() => { try { proc.kill(); } catch {} resolve(-1); }, 5000))
      ]);
      if (exitCode === 0 && output.trim()) {
        return { installed: true, executablePath: candidate, version: output.trim().split('\n')[0] };
      }
    } catch {}
  }
  return { installed: false, error: 'OpenCode CLI not found. Install from https://opencode.ai' };
}

export async function executeOpenCodeTask(
  taskId: string,
  prompt: string,
  workspacePath: string,
  config: OpenCodeConfig = {},
  emit?: (event: AgenticEvent) => void
): Promise<OpenCodeTaskResult> {
  const status = await detectOpenCode(config);
  if (!status.installed || !status.executablePath) {
    throw new Error('OpenCode not installed');
  }
  const startTime = Date.now();
  const timeoutMs = config.timeoutMs || 600000;
  let output = '';
  let error = '';
  const args: string[] = [];
  if (config.provider) args.push('--provider', config.provider);
  if (config.model) args.push('--model', config.model);
  args.push(prompt);
  const env = openCodeEnv(config);
  const proc = spawn(status.executablePath, args, { cwd: workspacePath, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcesses.set(taskId, proc);
  proc.stdout?.on('data', (data) => {
    const chunk = data.toString();
    output += chunk;
    if (emit) emit({ type: 'log', taskId, at: new Date().toISOString(), data: { level: 'info', message: protect(chunk).masked.slice(0, 500) } });
  });
  proc.stderr?.on('data', (data) => {
    const chunk = data.toString();
    error += chunk;
    if (emit) emit({ type: 'log', taskId, at: new Date().toISOString(), data: { level: 'error', message: protect(chunk).masked.slice(0, 500) } });
  });
  const timeout = setTimeout(() => {
    try { proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
  }, timeoutMs);
  const exitCode = await new Promise<number>((resolve) => {
    proc.on('close', (code) => { clearTimeout(timeout); activeProcesses.delete(taskId); resolve(code ?? -1); });
    proc.on('error', (err) => { clearTimeout(timeout); activeProcesses.delete(taskId); error += '\nProcess error: ' + err.message; resolve(-1); });
  });
  return { success: exitCode === 0, exitCode, output: protect(output).masked, error: protect(error).masked, filesChanged: [], durationMs: Date.now() - startTime };
}

export function cancelOpenCodeTask(taskId: string): boolean {
  const proc = activeProcesses.get(taskId);
  if (proc) {
    try { proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000); activeProcesses.delete(taskId); return true; } catch { return false; }
  }
  return false;
}
