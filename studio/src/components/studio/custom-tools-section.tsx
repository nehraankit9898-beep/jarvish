// custom-tools-section.tsx — the SELF-BUILT tools UI (Feature 6).
//
// Lists every proposed/approved custom tool with its CODE (review before
// approving!), the approval lifecycle buttons and a small proposer form.
// The sandbox rules are stated up-front so the user knows what is enforced.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Hammer, Check, X, Loader2, ShieldOff, Power, Trash2, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';

interface CustomTool {
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
  params: { name: string; type: string; required: boolean }[];
  baseUrl: string;
  updatedAt: string;
}

const STATUS_TONE: Record<string, string> = {
  active: 'border-emerald-500/40 text-emerald-400',
  pending_approval: 'border-amber-500/40 text-amber-400',
  rejected: 'border-red-500/40 text-red-400',
  disabled: 'border-zinc-600 text-zinc-400',
  draft: 'border-zinc-600 text-zinc-400',
};

const SAMPLE_CODE = `// params: the tool parameters
// api: { fetch(url, init), log(line), now() }  — fetch is SSRF-guarded and locked to baseUrl
const res = await api.fetch('/search?query=' + encodeURIComponent(params.query));
const data = JSON.parse(res.body);
api.log('found ' + (data.items?.length ?? 0) + ' items');
return { count: data.items?.length ?? 0, items: (data.items ?? []).slice(0, 10) };`;

export function CustomToolsSection() {
  const [tools, setTools] = useState<CustomTool[]>([]);
  const [busy, setBusy] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  // proposer form
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [code, setCode] = useState(SAMPLE_CODE);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tools/custom');
      if (res.ok) {
        const data = await res.json();
        setTools(data.tools ?? []);
      }
    } catch {
      // section stays usable
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (id: string, action: 'approve' | 'reject' | 'disable' | 'enable') => {
    setBusy(`${action}:${id}`);
    try {
      const res = await fetch(`/api/tools/custom/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Action failed');
      toast({ title: `Tool ${action}d`, description: `Status: ${data.status}` });
      await load();
    } catch (err) {
      toast({
        title: 'Action failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this custom tool?')) return;
    setBusy(`remove:${id}`);
    try {
      const res = await fetch(`/api/tools/custom/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      await load();
    } finally {
      setBusy('');
    }
  };

  const propose = async () => {
    setBusy('propose');
    try {
      const res = await fetch('/api/tools/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          baseUrl,
          code,
          category: baseUrl ? 'adapter' : 'custom',
          params: [{ name: 'query', type: 'string', required: true }],
          permission: 'review',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Proposal failed');
      toast({
        title: 'Tool proposed',
        description: 'Code review karke Approve dabana — approve hone tak executable nahi hai.',
      });
      setName('');
      setDescription('');
      setShowForm(false);
      await load();
    } catch (err) {
      toast({
        title: 'Proposal failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mt-6 pt-4 border-t border-zinc-800">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Hammer className="h-4 w-4 text-purple-400" />
          <p className="text-xs font-semibold text-zinc-400 uppercase">Self-built tools</p>
          {tools.length > 0 && (
            <Badge variant="outline" className="text-[10px] border-purple-500/30 text-purple-300">
              {tools.filter((t) => t.status === 'active').length} active / {tools.length}
            </Badge>
          )}
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="text-xs text-purple-400 hover:text-purple-300"
        >
          {showForm ? 'Cancel' : '+ Propose a tool'}
        </button>
      </div>
      <p className="text-[11px] text-zinc-600 mb-3">
        Sandbox: async function body with (params, api) — no require/process/eval, api.fetch is
        SSRF-guarded and locked to the declared baseUrl, card/CVV values are never captured.
        Approval ke bina koi tool executable nahi hota.
      </p>

      {showForm && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 mb-3 space-y-2">
          <div className="grid sm:grid-cols-[180px_1fr_220px] gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="tool-name (e.g. jira-search)" className="bg-zinc-800/60 border-zinc-700 text-xs font-mono h-8" />
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does it do? (min 8 chars)" className="bg-zinc-800/60 border-zinc-700 text-xs h-8" />
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="baseUrl (optional, e.g. https://api.example.com)" className="bg-zinc-800/60 border-zinc-700 text-xs h-8" />
          </div>
          <Textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={8}
            className="bg-zinc-800/60 border-zinc-700 text-[11px] font-mono"
            placeholder={SAMPLE_CODE}
          />
          <Button size="sm" className="bg-purple-600 hover:bg-purple-500" disabled={busy === 'propose' || !name.trim() || description.trim().length < 8} onClick={propose}>
            {busy === 'propose' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Propose (pending approval)
          </Button>
        </div>
      )}

      {tools.length === 0 ? (
        <p className="text-xs text-zinc-600 py-3">
          Koi custom tool nahi. Agent ya tum khud propose kar sakte ho — approve hone ke baad ye
          built-in tools ki tarah invoke hote hain.
        </p>
      ) : (
        <div className="space-y-1.5">
          {tools.map((t) => (
            <div key={t.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60">
              <div className="flex items-center gap-2 px-2.5 py-2">
                <button
                  className="flex-1 min-w-0 text-left flex items-center gap-2"
                  onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                >
                  <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${expanded === t.id ? 'rotate-0' : '-rotate-90'}`} />
                  <span className="text-xs font-mono text-zinc-200 truncate">{t.name}</span>
                  <Badge variant="outline" className={`text-[9px] ${STATUS_TONE[t.status] ?? STATUS_TONE.draft}`}>
                    {t.status}
                  </Badge>
                  <span className="text-[10px] text-zinc-600 hidden sm:inline">v{t.version} · {t.invokeCount} calls · by {t.createdBy}</span>
                  {t.lastError && <span className="text-[10px] text-red-400 truncate hidden md:inline">⚠ {t.lastError}</span>}
                </button>
                {t.status === 'pending_approval' && (
                  <>
                    <Button size="sm" className="h-7 text-[11px] bg-emerald-600 hover:bg-emerald-500" disabled={busy === `approve:${t.id}`} onClick={() => decide(t.id, 'approve')}>
                      <Check className="h-3 w-3 mr-1" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-[11px] border-red-900/50 text-red-400" disabled={busy === `reject:${t.id}`} onClick={() => decide(t.id, 'reject')}>
                      <X className="h-3 w-3" />
                    </Button>
                  </>
                )}
                {t.status === 'active' && (
                  <Button size="sm" variant="outline" className="h-7 text-[11px] border-zinc-700 text-zinc-400" disabled={busy === `disable:${t.id}`} onClick={() => decide(t.id, 'disable')} title="Take out of the registry">
                    <Power className="h-3 w-3" />
                  </Button>
                )}
                {t.status === 'disabled' && (
                  <Button size="sm" variant="outline" className="h-7 text-[11px] border-emerald-700/50 text-emerald-400" disabled={busy === `enable:${t.id}`} onClick={() => decide(t.id, 'enable')}>
                    <Power className="h-3 w-3 mr-1" /> Enable
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-7 text-red-400" disabled={busy === `remove:${t.id}`} onClick={() => remove(t.id)} aria-label="Delete tool">
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
              {expanded === t.id && (
                <div className="px-3 pb-3 space-y-2">
                  <p className="text-[11px] text-zinc-400">{t.description}</p>
                  <p className="text-[10px] text-zinc-600">
                    permission: {t.permission} · params: {t.params.map((p) => p.name).join(', ') || 'none'}
                    {t.baseUrl ? ` · baseUrl: ${t.baseUrl}` : ''}
                  </p>
                  <pre className="text-[10px] font-mono text-zinc-400 bg-zinc-950 rounded-lg p-2.5 overflow-x-auto max-h-64 overflow-y-auto border border-zinc-800">
                    {t.id === expanded ? <CodePreview id={t.id} /> : null}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Lazy code preview (fetched on expand — keeps the list light). */
function CodePreview({ id }: { id: string }) {
  const [code, setCode] = useState('// loading…');

  useEffect(() => {
    let alive = true;
    fetch(`/api/tools/custom/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (alive) setCode(d.code ?? '// no code');
      })
      .catch(() => {
        if (alive) setCode('// could not load the code');
      });
    return () => {
      alive = false;
    };
  }, [id]);

  return <>{code}</>;
}
