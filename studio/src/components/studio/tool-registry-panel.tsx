'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Database, Play, RefreshCw, Terminal, File, GitBranch, ShieldCheck } from 'lucide-react';
import { CustomToolsSection } from './custom-tools-section';

interface ToolDef {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, any>;
  required: string[];
  permission: string;
  timeoutMs: number;
}

interface HealthResult {
  tool: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export function ToolRegistryPanel() {
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [health, setHealth] = useState<HealthResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTools = useCallback(async () => {
    try {
      const res = await fetch('/api/tools');
      if (res.ok) setTools(await res.json());
    } catch {
      setError('Failed to load tools');
    }
  }, []);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/tools/health?taskId=health-check');
      if (res.ok) setHealth(await res.json());
    } catch {
      setError('Health check failed');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    loadTools();
  }, [loadTools]);

  const permMeta: Record<string, { label: string; className: string }> = {
    safe: { label: 'Safe', className: 'text-emerald-300 border-emerald-500/40' },
    review: { label: 'Review', className: 'text-sky-300 border-sky-500/40' },
    destructive: { label: 'Destructive', className: 'text-amber-300 border-amber-500/40' },
    forbidden: { label: 'Forbidden', className: 'text-red-300 border-red-500/40' },
  };

  const catIcon: Record<string, any> = {
    file: File,
    terminal: Terminal,
    git: GitBranch,
    workspace: Database,
    adapter: ShieldCheck,
    custom: Play,
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <header className="h-14 shrink-0 border-b border-zinc-800 bg-zinc-900/30 backdrop-blur flex items-center gap-3 px-4">
        <Database className="h-5 w-5 text-purple-400" />
        <h2 className="font-bold">Tool Registry</h2>
        <div className="flex-1" />
        <Badge variant="outline" className="border-purple-500/30 text-purple-400 text-[10px]">
          {tools.length} registered
        </Badge>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="mb-4 flex items-end gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-zinc-400 uppercase mb-1">Real tool interface with discovery, validation, and health checks</p>
          </div>
          <Button
            onClick={checkHealth}
            disabled={checking}
            className="bg-purple-600 hover:bg-purple-500 text-white h-9"
          >
            {checking ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Play className="h-4 w-4 mr-2" />}
            Health Check
          </Button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm p-3">
            {error}
          </div>
        )}

        <div className="mb-6">
          <p className="text-xs font-semibold text-zinc-400 uppercase mb-1">Integration health</p>
          <div className="flex gap-4 text-xs">
            {health.map((h) => (
              <div key={h.tool} className="flex items-center gap-1.5">
                <span className={h.ok ? 'text-emerald-300' : 'text-red-300'}>
                  {h.ok ? '✓' : '✗'}
                </span>
                <span className="text-zinc-400">{h.tool}</span>
                {h.ok && <span className="text-zinc-600 ml-1">({h.latencyMs}ms)</span>}
                {!h.ok && <span className="text-red-400 ml-1">{h.error}</span>}
              </div>
            ))}
            {health.length === 0 && <span className="text-zinc-500">Run health check to see status</span>}
          </div>
        </div>

        <div className="space-y-2">
          {tools.length === 0 ? (
            <div className="text-center py-8 text-zinc-500 text-sm">
              No tools registered.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {tools.map((t) => {
                const Icon = catIcon[t.category] || Play;
                const h = health.find((x) => x.tool === t.name);
                return (
                  <div key={t.name} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-zinc-400" />
                        <span className="font-semibold text-zinc-200 text-sm">{t.name}</span>
                      </div>
                      <Badge variant="outline" className={permMeta[t.permission]?.className ?? permMeta.safe.className}>
                        {permMeta[t.permission]?.label ?? permMeta.safe.label}
                      </Badge>
                    </div>
                    <p className="text-xs text-zinc-500 mb-2">{t.description}</p>
                    <div className="space-y-1 text-[10px]">
                      <div className="flex items-center gap-1">
                        <span className="text-zinc-600">Category:</span>
                        <span className="text-zinc-400 capitalize">{t.category}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-zinc-600">Timeout:</span>
                        <span className="text-zinc-400">{t.timeoutMs}ms</span>
                      </div>
                      {t.required.length > 0 && (
                        <div className="flex items-center gap-1">
                          <span className="text-zinc-600">Required:</span>
                          <span className="text-zinc-400">{t.required.join(', ')}</span>
                        </div>
                      )}
                    </div>
                    <div className="mt-3 pt-2 border-t border-zinc-800/50">
                      <p className="text-[10px] font-semibold text-zinc-400 uppercase mb-1">Parameters</p>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(t.parameters).map(([key, val]) => (
                          <span key={key} className="text-[10px] bg-zinc-800/50 px-1.5 py-0.5 rounded text-zinc-400">
                            {key}{val.required ? ' *' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <CustomToolsSection />

        <div className="mt-6 pt-4 border-t border-zinc-800">
          <p className="text-xs font-semibold text-zinc-400 uppercase mb-2">Built-in tools</p>
          <ul className="space-y-1 text-xs text-zinc-500">
            <li>• <span className="text-zinc-300">file-read</span> — Read files from workspace (safe)</li>
            <li>• <span className="text-zinc-300">file-write</span> — Write files to workspace (review)</li>
            <li>• <span className="text-zinc-300">file-delete</span> — Delete files (destructive, needs approval)</li>
            <li>• <span className="text-zinc-300">file-list</span> — List workspace files (safe)</li>
            <li>• <span className="text-zinc-300">terminal</span> — Execute commands (review)</li>
            <li>• <span className="text-zinc-300">git-init</span> — Initialize git repo (review)</li>
            <li>• <span className="text-zinc-300">git-snapshot</span> — Create git snapshot (review)</li>
            <li>• <span className="text-zinc-300">git-diff</span> — Git diff between refs (safe)</li>
            <li>• <span className="text-zinc-300">git-rollback</span> — Rollback to reference (destructive)</li>
            <li>• <span className="text-zinc-300">workspace-create</span> — Create isolated workspace (safe)</li>
          </ul>
        </div>
      </main>
    </div>
  );
}
