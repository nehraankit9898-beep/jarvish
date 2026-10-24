'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollText, RefreshCw, CircleAlert, ShieldCheck, ShieldAlert } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  agentId: string;
  taskId: string;
  action: string;
  category: string;
  approval: string;
  result: string;
  errorCategory: string;
  artifact: string;
  details: string;
  ip: string;
}

const CATEGORIES = [
  'all',
  'security',
  'provider',
  'task',
  'tool',
  'automation',
  'memory',
  'knowledge',
  'general',
];

const categoryBadge: Record<string, string> = {
  security: 'border-red-500/40 text-red-300',
  provider: 'border-sky-500/40 text-sky-300',
  task: 'border-emerald-500/40 text-emerald-300',
  tool: 'border-violet-500/40 text-violet-300',
  automation: 'border-amber-500/40 text-amber-300',
  memory: 'border-teal-500/40 text-teal-300',
  knowledge: 'border-cyan-500/40 text-cyan-300',
  general: 'border-zinc-600 text-zinc-400',
};

export function AuditPanel() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('all');
  const [action, setAction] = useState('');
  const [taskId, setTaskId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (category !== 'all') params.set('category', category);
      if (action.trim()) params.set('action', action.trim());
      if (taskId.trim()) params.set('taskId', taskId.trim());
      params.set('limit', '200');
      const res = await fetch(`/api/audit?${params.toString()}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to load audit log' }));
        throw new Error(err.error || 'Failed to load audit log');
      }
      setRecords(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [category, action, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <header className="h-14 shrink-0 border-b border-zinc-800 bg-zinc-900/30 backdrop-blur flex items-center gap-3 px-4">
        <ScrollText className="h-5 w-5 text-zinc-400" />
        <h2 className="font-bold">Audit trail</h2>
        <Badge variant="outline" className="border-zinc-600 text-zinc-400 text-[10px]">
          {records.length} event(s)
        </Badge>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => void load()} className="h-9">
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm p-3 flex items-start gap-2">
            <CircleAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <section className="mb-4 grid sm:grid-cols-3 gap-3">
          <div>
            <span className="text-[11px] text-zinc-500">Category</span>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="bg-zinc-800/60 border-zinc-700 text-sm mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-zinc-900 border-zinc-700">
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <span className="text-[11px] text-zinc-500">Action contains</span>
            <Input
              value={action}
              onChange={(e) => setAction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load();
              }}
              placeholder="task.create"
              className="bg-zinc-800/60 border-zinc-700 text-sm mt-1"
            />
          </div>
          <div>
            <span className="text-[11px] text-zinc-500">Task id</span>
            <Input
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load();
              }}
              placeholder="(any)"
              className="bg-zinc-800/60 border-zinc-700 text-sm mt-1"
            />
          </div>
        </section>

        {loading ? (
          <div className="text-xs text-zinc-500">Loading…</div>
        ) : records.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
            No audit event matches this filter.
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-800 overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-900/80 text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Actor</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Approval</th>
                  <th className="px-3 py-2 font-medium">Result</th>
                  <th className="px-3 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-800/70 align-top">
                    <td className="px-3 py-2 text-zinc-500 whitespace-nowrap">
                      {new Date(r.at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">
                      {r.actor || '—'}
                    </td>
                    <td className="px-3 py-2 text-zinc-200 font-mono">{r.action}</td>
                    <td className="px-3 py-2">
                      <Badge
                        variant="outline"
                        className={`text-[9px] ${categoryBadge[r.category] ?? categoryBadge.general}`}
                      >
                        {r.category}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-zinc-400">
                      {r.approval ? (
                        <span className="inline-flex items-center gap-1">
                          {r.approval === 'approved' ? (
                            <ShieldCheck className="h-3 w-3 text-emerald-400" />
                          ) : r.approval === 'denied' ? (
                            <ShieldAlert className="h-3 w-3 text-red-400" />
                          ) : null}
                          {r.approval}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          r.result === 'error' ? 'text-red-400' : 'text-emerald-400'
                        }
                      >
                        {r.result}
                      </span>
                      {r.errorCategory && (
                        <span className="text-zinc-500 ml-1">({r.errorCategory})</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-500 max-w-[320px] break-all">
                      {r.details || r.artifact || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
