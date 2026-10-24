// agent-registry.ts — persistent registry of specialist agents
// Each agent has: unique ID, name, role, model/provider config, allowed tools,
// input/output schema, timeout/retry policy, task history, health status,
// versioned configuration. Validation + sandbox testing before registration.

import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { getProvider } from '@/lib/providers';

const REGISTRY_DIR = path.join(process.cwd(), '.agentic-workspace', 'registry');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'agents.json');

// ---------- schemas ----------

export const AgentToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  permission: z.enum(['safe', 'review', 'destructive', 'forbidden']),
});

export const AgentIOSchema = z.object({
  input: z.record(z.string(), z.any()),
  output: z.record(z.string(), z.any()),
});

export const AgentConfigSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(200),
  responsibilities: z.array(z.string()).min(1),
  provider: z.string(),
  model: z.string(),
  temperature: z.number().min(0).max(2).default(0.7),
  allowedTools: z.array(AgentToolSchema).default([]),
  inputSchema: AgentIOSchema.default({ input: {}, output: {} }),
  timeoutMs: z.number().positive().default(120000),
  retryBudget: z.number().positive().default(3),
  version: z.string().default('1.0.0'),
  isActive: z.boolean().default(true),
  healthStatus: z.enum(['healthy', 'unhealthy', 'unknown', 'testing']).default('unknown'),
  taskCount: z.number().nonnegative().default(0),
  successCount: z.number().nonnegative().default(0),
  failureCount: z.number().nonnegative().default(0),
  lastTaskAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentHealthStatus = 'healthy' | 'unhealthy' | 'unknown' | 'testing';

export interface AgentRegistryEntry extends AgentConfig {
  taskHistory: AgentTaskRecord[];
}

export interface AgentTaskRecord {
  taskId: string;
  prompt: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  result?: string;
  error?: string;
}

// ---------- registry storage ----------

async function ensureRegistryDir(): Promise<void> {
  await fs.mkdir(REGISTRY_DIR, { recursive: true });
}

async function readRegistry(): Promise<AgentConfig[]> {
  try {
    await ensureRegistryDir();
  } catch {
    // dir may already exist
  }
  try {
    const raw = await fs.readFile(REGISTRY_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    return [];
  } catch {
    return [];
  }
}

async function writeRegistry(agents: AgentConfig[]): Promise<void> {
  await ensureRegistryDir();
  // write to a temp file first and rename it into place — a crash midway
  // would otherwise leave a truncated/corrupt registry behind
  const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(agents, null, 2), 'utf-8');
  await fs.rename(tmp, REGISTRY_FILE);
}

/**
 * Serialize read-modify-write cycles on the registry file. Without this two
 * concurrent requests (e.g. two GETs triggering the seed) can both read the
 * old state and then overwrite each other's changes.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

// ---------- registry operations ----------

export async function listAgents(): Promise<AgentConfig[]> {
  return readRegistry();
}

export async function getAgent(id: string): Promise<AgentConfig | null> {
  const agents = await readRegistry();
  return agents.find((a) => a.id === id) ?? null;
}

export async function getAgentByName(name: string): Promise<AgentConfig | null> {
  const agents = await readRegistry();
  return agents.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * Validate an agent configuration before registration.
 * Checks: unique ID/name, valid provider, valid model, valid tools, no recursion.
 */
export async function validateAgentConfig(
  config: Partial<AgentConfig>
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  if (!config.id || typeof config.id !== 'string') {
    errors.push('Agent ID is required');
  }
  if (!config.name || config.name.trim().length === 0) {
    errors.push('Agent name is required');
  }
  if (config.name && config.name.length > 100) {
    errors.push('Agent name must be <= 100 characters');
  }
  if (!config.role || config.role.trim().length === 0) {
    errors.push('Agent role is required');
  }
  if (!config.responsibilities || config.responsibilities.length === 0) {
    errors.push('At least one responsibility is required');
  }
  if (!config.provider) {
    errors.push('Provider is required');
  } else {
    const provider = getProvider(config.provider);
    if (!provider) {
      errors.push(`Unknown provider: ${config.provider}`);
    }
  }
  if (!config.model) {
    errors.push('Model is required');
  }
  if (config.temperature !== undefined && (config.temperature < 0 || config.temperature > 2)) {
    errors.push('Temperature must be between 0 and 2');
  }
  if (config.timeoutMs !== undefined && config.timeoutMs <= 0) {
    errors.push('Timeout must be positive');
  }
  if (config.retryBudget !== undefined && config.retryBudget <= 0) {
    errors.push('Retry budget must be positive');
  }

  // check for duplicate name (case-insensitive)
  if (config.name) {
    const existing = await getAgentByName(config.name);
    if (existing && existing.id !== config.id) {
      errors.push(`Agent with name "${config.name}" already exists`);
    }
  }

  // check for duplicate ID
  if (config.id) {
    const existing = await getAgent(config.id);
    if (existing) {
      errors.push(`Agent with ID "${config.id}" already exists`);
    }
  }

  // validate allowed tools reference known tools
  if (config.allowedTools) {
    for (const tool of config.allowedTools) {
      if (!tool.name || tool.name.length === 0) {
        errors.push('Tool name is required');
      }
      if (!['safe', 'review', 'destructive', 'forbidden'].includes(tool.permission)) {
        errors.push(`Invalid permission for tool ${tool.name}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Register a new agent after validation. Returns the registered config or null.
 */
export async function registerAgent(
  config: Partial<AgentConfig>
): Promise<{ success: boolean; agent?: AgentConfig; errors?: string[] }> {
  const validation = await validateAgentConfig(config);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  return withRegistryLock(async () => {
    // re-validate inside the lock — a concurrent request may have registered
    // the same name/ID while we were waiting
    const recheck = await validateAgentConfig(config);
    if (!recheck.valid) {
      return { success: false, errors: recheck.errors };
    }

    const agents = await readRegistry();
    const now = new Date().toISOString();

    const agentConfig: AgentConfig = {
      id: config.id || crypto.randomUUID(),
      name: config.name!.trim(),
      role: config.role!.trim(),
      responsibilities: config.responsibilities ?? [],
      provider: config.provider || 'zai',
      model: config.model || '',
      temperature: config.temperature ?? 0.7,
      allowedTools: config.allowedTools ?? [],
      inputSchema: config.inputSchema ?? { input: {}, output: {} },
      timeoutMs: config.timeoutMs ?? 120000,
      retryBudget: config.retryBudget ?? 3,
      version: config.version ?? '1.0.0',
      isActive: config.isActive ?? true,
      healthStatus: 'unknown',
      taskCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    agents.push(agentConfig);
    await writeRegistry(agents);

    return { success: true, agent: agentConfig };
  });
}

/**
 * Update an existing agent's configuration (version bumped).
 */
export async function updateAgent(
  id: string,
  updates: Partial<AgentConfig>
): Promise<{ success: boolean; agent?: AgentConfig; errors?: string[] }> {
  return withRegistryLock(async () => {
    const agents = await readRegistry();
    const index = agents.findIndex((a) => a.id === id);
    if (index === -1) {
      return { success: false, errors: ['Agent not found'] };
    }

    const existing = agents[index];
    const merged: AgentConfig = {
      ...existing,
      ...updates,
      id,
      version: incrementVersion(existing.version),
      updatedAt: new Date().toISOString(),
    };

    const validation = await validateAgentConfig(merged);
    if (!validation.valid) {
      return { success: false, errors: validation.errors };
    }

    agents[index] = merged;
    await writeRegistry(agents);

    return { success: true, agent: merged };
  });
}

/**
 * Set agent health status.
 */
export async function setAgentHealth(
  id: string,
  healthStatus: AgentHealthStatus
): Promise<boolean> {
  return withRegistryLock(async () => {
    const agents = await readRegistry();
    const index = agents.findIndex((a) => a.id === id);
    if (index === -1) return false;
    agents[index].healthStatus = healthStatus;
    agents[index].updatedAt = new Date().toISOString();
    await writeRegistry(agents);
    return true;
  });
}

/**
 * Record a task execution for an agent.
 */
export async function recordAgentTask(
  agentId: string,
  taskRecord: Omit<AgentTaskRecord, 'taskId'> & { taskId: string }
): Promise<boolean> {
  return withRegistryLock(async () => {
    const agents = await readRegistry();
    const index = agents.findIndex((a) => a.id === agentId);
    if (index === -1) return false;

    const agent = agents[index];
    agent.taskCount += 1;
    agent.lastTaskAt = taskRecord.startedAt;
    agent.updatedAt = new Date().toISOString();

    if (taskRecord.status === 'done') {
      agent.successCount += 1;
    } else if (taskRecord.status === 'failed' || taskRecord.status === 'cancelled') {
      // a cancelled task is not a success either — counting it keeps
      // taskCount in sync with successCount + failureCount
      agent.failureCount += 1;
    }

    // Update health based on success rate
    const total = agent.successCount + agent.failureCount;
    if (total >= 5) {
      const successRate = agent.successCount / total;
      agent.healthStatus = successRate >= 0.8 ? 'healthy' : 'unhealthy';
    }

    agents[index] = agent;
    await writeRegistry(agents);
    return true;
  });
}

/**
 * Delete an agent from the registry. Prevents deletion if it has active tasks.
 */
export async function deleteAgent(id: string): Promise<{ success: boolean; errors?: string[] }> {
  return withRegistryLock(async () => {
    const agents = await readRegistry();
    const index = agents.findIndex((a) => a.id === id);
    if (index === -1) {
      return { success: false, errors: ['Agent not found'] };
    }

    const agent = agents[index];
    if (agent.isActive && agent.taskCount > agent.successCount + agent.failureCount) {
      return { success: false, errors: ['Agent has pending tasks — cannot delete'] };
    }

    agents.splice(index, 1);
    await writeRegistry(agents);
    return { success: true };
  });
}

/**
 * Find suitable agents for a task based on role keywords.
 * Returns agents sorted by health and success rate.
 */
export async function findSuitableAgents(
  roleKeywords: string[],
  limit: number = 5
): Promise<AgentConfig[]> {
  const agents = await readRegistry();
  const active = agents.filter((a) => a.isActive);

  const scored = active.map((a) => {
    let score = 0;
    const text = (a.role + ' ' + a.responsibilities.join(' ')).toLowerCase();
    for (const kw of roleKeywords) {
      if (text.includes(kw.toLowerCase())) score += 1;
    }
    // health bonus
    if (a.healthStatus === 'healthy') score += 10;
    if (a.healthStatus === 'unknown') score += 5;
    // success rate bonus
    const total = a.successCount + a.failureCount;
    if (total > 0) score += (a.successCount / total) * 5;
    return { agent: a, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.agent);
}

/**
 * Increment a semantic version string.
 */
function incrementVersion(version: string): string {
  const parts = version.split('.').map(Number);
  if (parts.length >= 3) {
    parts[2] = (parts[2] ?? 0) + 1;
  } else {
    parts.push(1);
  }
  return parts.join('.');
}

/**
 * Prevent recursive delegation: check if agent is already in the delegation chain.
 */
export async function checkDelegationCycle(
  agentId: string,
  delegationChain: string[]
): Promise<{ ok: boolean; cycle?: string[] }> {
  if (delegationChain.includes(agentId)) {
    return { ok: false, cycle: [...delegationChain, agentId] };
  }
  return { ok: true };
}

// ---------- default agents ----------

export const DEFAULT_AGENTS: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'Software Engineer',
    role: 'Full-stack software development and code modification',
    responsibilities: ['Write and modify code', 'Fix bugs', 'Run tests', 'Git operations'],
    provider: 'zai',
    model: 'glm-4.6',
    temperature: 0.3,
    allowedTools: [
      { name: 'file-read', description: 'Read files in workspace', permission: 'safe' },
      { name: 'file-write', description: 'Write files in workspace', permission: 'review' },
      { name: 'terminal', description: 'Run commands in workspace', permission: 'review' },
      { name: 'git', description: 'Git operations in workspace', permission: 'review' },
    ],
    inputSchema: { input: {}, output: {} },
    timeoutMs: 300000,
    retryBudget: 3,
    version: '1.0.0',
    isActive: true,
    healthStatus: 'unknown',
    taskCount: 0,
    successCount: 0,
    failureCount: 0,
  },
  {
    name: 'Test Engineer',
    role: 'Test creation, execution, and verification',
    responsibilities: ['Write unit tests', 'Run test suites', 'Verify test results', 'Regression testing'],
    provider: 'zai',
    model: 'glm-4.6',
    temperature: 0.2,
    allowedTools: [
      { name: 'file-read', description: 'Read files in workspace', permission: 'safe' },
      { name: 'file-write', description: 'Write test files', permission: 'review' },
      { name: 'terminal', description: 'Run test commands', permission: 'review' },
    ],
    inputSchema: { input: {}, output: {} },
    timeoutMs: 120000,
    retryBudget: 3,
    version: '1.0.0',
    isActive: true,
    healthStatus: 'unknown',
    taskCount: 0,
    successCount: 0,
    failureCount: 0,
  },
  {
    name: 'Security Reviewer',
    role: 'Security analysis and vulnerability assessment',
    responsibilities: ['Security code review', 'Dependency audit', 'Secret detection', 'Permission verification'],
    provider: 'zai',
    model: 'glm-4.6',
    temperature: 0.1,
    allowedTools: [
      { name: 'file-read', description: 'Read files for security review', permission: 'safe' },
      { name: 'terminal', description: 'Run security scanning tools', permission: 'safe' },
    ],
    inputSchema: { input: {}, output: {} },
    timeoutMs: 180000,
    retryBudget: 2,
    version: '1.0.0',
    isActive: true,
    healthStatus: 'unknown',
    taskCount: 0,
    successCount: 0,
    failureCount: 0,
  },
];

/**
 * Seed default agents if registry is empty.
 */
export async function seedDefaultAgents(): Promise<void> {
  await withRegistryLock(async () => {
    const agents = await readRegistry();
    if (agents.length > 0) return;

    const now = new Date().toISOString();
    const seeded: AgentConfig[] = DEFAULT_AGENTS.map((a) => ({
      ...a,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    }));
    await writeRegistry(seeded);
  });
}
