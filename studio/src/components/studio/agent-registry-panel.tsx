'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Trash2, RefreshCw, ShieldAlert, Play, Bot, Pencil } from 'lucide-react';
import type { AgentConfig } from '@/lib/agentic/agent-registry';
import { PromptVersionsSection } from './prompt-versions-section';
import { PROVIDERS } from '@/lib/providers';

interface ProviderOption {
  id: string;
  label: string;
  defaultModel: string;
  free: boolean;
  /** the provider exists in the server-side configuration */
  configured: boolean;
}

interface AgentCardProps {
  agent: AgentConfig;
  onUpdate: (id: string, updates: Partial<AgentConfig>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSetHealth: (id: string, health: string) => Promise<void>;
}

export function AgentCard({ agent, onUpdate, onDelete, onSetHealth }: AgentCardProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [provider, setProvider] = useState(agent.provider);
  const [model, setModel] = useState(agent.model);

  const healthMeta: Record<string, { label: string; className: string }> = {
    healthy: { label: '✅ Healthy', className: 'text-emerald-300 border-emerald-500/40' },
    unhealthy: { label: '⚠️ Unhealthy', className: 'text-red-300 border-red-500/40' },
    unknown: { label: '❓ Unknown', className: 'text-zinc-400 border-zinc-700' },
    testing: { label: '🧪 Testing', className: 'text-amber-300 border-amber-500/40' },
  };

  const save = async () => {
    await onUpdate(agent.id, { name, role, provider, model });
    setEditing(false);
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm">{(agent as any).emoji || '🤖'}</span>
            {editing ? (
              <Input value={name} onChange={(e) => setName(e.target.value)} className="text-sm flex-1 bg-transparent border-0 focus:ring-0" />
            ) : (
              <span className="font-semibold text-zinc-200 truncate">{agent.name}</span>
            )}
            <Badge variant="outline" className={healthMeta[agent.healthStatus]?.className ?? healthMeta.unknown.className}>
              {healthMeta[agent.healthStatus]?.label ?? healthMeta.unknown.label}
            </Badge>
          </div>
          <p className="text-xs text-zinc-500 truncate">{agent.role}</p>
          <div className="flex items-center gap-1 text-[10px] text-zinc-500 mt-1">
            <span>{provider}</span>
            <span className="text-zinc-600">/</span>
            <span>{model}</span>
          </div>
        </div>
        <div className="flex gap-1">
          {!editing && (
            <Button size="icon" onClick={() => setEditing(true)} variant="outline" className="h-8 w-8 border-zinc-700 hover:bg-zinc-800">
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {editing && (
            <Button size="icon" onClick={save} className="h-8 w-8 bg-emerald-600 hover:bg-emerald-500 text-white">
              <Play className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            onClick={() => onDelete(agent.id)}
            variant="outline"
            className="h-8 w-8 border-zinc-700 text-red-400 hover:bg-red-500/20"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-2 space-y-1">
        <p className="text-[10px] font-semibold text-zinc-400 uppercase">Responsibilities</p>
        <div className="flex flex-wrap gap-1">
          {agent.responsibilities.map((r, i) => (
            <span key={i} className="text-[10px] bg-zinc-800/50 px-1.5 py-0.5 rounded text-zinc-400">{r}</span>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px]">
        <span className="text-zinc-500">Tasks: {agent.taskCount}</span>
        <span className="text-zinc-500">Success: {agent.successCount}</span>
        <span className="text-zinc-500">Failures: {agent.failureCount}</span>
        <span className="ml-auto text-zinc-500">v{agent.version}</span>
      </div>
    </div>
  );
}

export function AgentRegistryPanel() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newProvider, setNewProvider] = useState('zai');
  const [newModel, setNewModel] = useState('');
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * The provider list comes from the SERVER configuration (/api/providers);
   * the static catalog only supplies the default model of a known provider.
   * A provider that is configured on the server but not in the catalog (a
   * custom OpenAI-compatible endpoint) is shown as well.
   */
  const loadProviders = useCallback(async () => {
    const catalog: ProviderOption[] = PROVIDERS.map((p) => ({
      id: p.id,
      label: p.name,
      defaultModel: p.defaultModel,
      free: Boolean(p.free),
      configured: false,
    }));
    try {
      const res = await fetch('/api/providers');
      if (!res.ok) {
        setProviderOptions(catalog);
        return;
      }
      const data = (await res.json()) as {
        providers?: {
          provider: string;
          label?: string;
          name?: string;
          model?: string;
          costClass?: string;
        }[];
      };
      const server = data.providers ?? [];
      const configuredIds = new Set(server.map((p) => p.provider));
      const merged = catalog.map((c) => ({
        ...c,
        configured: configuredIds.has(c.id),
      }));
      for (const p of server) {
        if (merged.some((m) => m.id === p.provider)) continue;
        merged.push({
          id: p.provider,
          label: p.label || p.name || p.provider,
          defaultModel: p.model || '',
          free: p.costClass === 'free',
          configured: true,
        });
      }
      setProviderOptions(merged);
    } catch {
      setProviderOptions(catalog);
    }
  }, []);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/agent-registry/agents');
      if (res.ok) setAgents(await res.json());
    } catch {
      setError('Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
    loadProviders();
  }, [loadAgents, loadProviders]);

  const defaultModelFor = useCallback(
    (providerId: string) =>
      providerOptions.find((p) => p.id === providerId)?.defaultModel ?? '',
    [providerOptions]
  );

  const createAgent = async () => {
    if (!newName.trim() || !newRole.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const model = newModel.trim() || defaultModelFor(newProvider);
      if (!model) {
        throw new Error(
          'Model is required — pick a provider with a known default model or type one explicitly.'
        );
      }
      const res = await fetch('/api/agent-registry/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          role: newRole.trim(),
          provider: newProvider,
          model,
          responsibilities: [newRole.trim()],
          allowedTools: [
            { name: 'file-read', description: 'Read files', permission: 'safe' },
            { name: 'terminal', description: 'Run commands', permission: 'review' },
          ],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Create failed' }));
        throw new Error(err.error || 'Create failed');
      }
      setNewName('');
      setNewRole('');
      setNewModel('');
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setCreating(false);
    }
  };

  const updateAgent = async (id: string, updates: Partial<AgentConfig>) => {
    try {
      const res = await fetch(`/api/agent-registry/agents/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error('Update failed');
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  };

  const deleteAgent = async (id: string) => {
    if (!confirm('Delete this agent?')) return;
    try {
      const res = await fetch(`/api/agent-registry/agents/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const setHealth = async (id: string, health: string) => {
    try {
      const res = await fetch(`/api/agent-registry/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ healthStatus: health }),
      });
      if (!res.ok) throw new Error('Health update failed');
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Health update failed');
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="h-6 w-6 animate-spin rounded-full border-4 border-zinc-700 border-t-emerald-500" />
        <p className="mt-2 text-zinc-500 text-sm">Loading agents…</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <header className="h-14 shrink-0 border-b border-zinc-800 bg-zinc-900/30 backdrop-blur flex items-center gap-3 px-4">
        <Bot className="h-5 w-5 text-sky-400" />
        <h2 className="font-bold">Agent Registry</h2>
        <div className="flex-1" />
        <Badge variant="outline" className="border-sky-500/30 text-sky-400 text-[10px]">
          {agents.length} registered
        </Badge>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="mb-4 flex items-end gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-zinc-400 uppercase mb-1">Register new specialist agent</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Agent name"
                className="h-9 text-xs"
              />
              <Input
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                placeholder="Role (e.g. Code Reviewer)"
                className="h-9 text-xs"
              />
              <select
                value={newProvider}
                onChange={(e) => {
                  const id = e.target.value;
                  setNewProvider(id);
                  // the model must belong to the selected provider — reset it
                  // to that provider's default instead of keeping a stale one
                  setNewModel(defaultModelFor(id));
                }}
                className="h-9 text-xs bg-zinc-900 border-zinc-700 text-zinc-300 rounded px-2"
              >
                {providerOptions.length === 0 ? (
                  <option value="zai">Z.ai</option>
                ) : (
                  providerOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                      {p.free ? ' (free)' : ''}
                      {p.configured ? '' : ' — not configured'}
                    </option>
                  ))
                )}
              </select>
              <Input
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                placeholder="Model"
                className="h-9 text-xs"
              />
            </div>
          </div>
          <Button
            onClick={createAgent}
            disabled={creating || !newName.trim() || !newRole.trim()}
            className="bg-sky-600 hover:bg-sky-500 text-white h-9"
          >
            {creating ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
            Register
          </Button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm p-3">
            {error}
          </div>
        )}

        <div className="space-y-2">
          {agents.length === 0 ? (
            <div className="text-center py-8 text-zinc-500 text-sm">
              No agents registered. Create your first specialist agent above.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {agents.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  onUpdate={updateAgent}
                  onDelete={deleteAgent}
                  onSetHealth={setHealth}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 pt-4 border-t border-zinc-800">
          <p className="text-xs font-semibold text-zinc-400 uppercase mb-2">How it works</p>
          <ul className="space-y-1 text-xs text-zinc-500">
            <li>• Agents are registered with role, provider, model, and allowed tools</li>
            <li>• Configuration is validated before registration (unique name, valid provider)</li>
            <li>• Health status is tracked based on task success rate</li>
            <li>• Orchestrator reuses suitable agents before creating new ones</li>
          </ul>
        </div>

        <PromptVersionsSection />
      </main>
    </div>
  );
}
