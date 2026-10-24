// prompt-versions-section.tsx — SAFE self-editing UI (Feature 7).
//
// Shows the version history of every role prompt: pending proposals (with
// the rationale of WHY the agent wants the change), the active version and
// the rollback to the built-in prompt. Approving is always the USER's
// decision — the agent can only propose.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Sparkles, Check, X, History, Loader2, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';

interface PromptVersion {
  id: string;
  role: string;
  content: string;
  version: number;
  status: string;
  rationale: string;
  createdBy: string;
  approvedBy: string;
  createdAt: string;
}

const STATUS_TONE: Record<string, string> = {
  active: 'border-emerald-500/40 text-emerald-400',
  pending: 'border-amber-500/40 text-amber-400',
  rejected: 'border-red-500/40 text-red-400',
  rolled_back: 'border-zinc-600 text-zinc-400',
};

export function PromptVersionsSection() {
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [busy, setBusy] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/prompt-versions');
      if (res.ok) {
        const data = await res.json();
        setVersions(data.versions ?? []);
      }
    } catch {
      // section stays usable
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: string, action: 'approve' | 'reject' | 'rollback') => {
    setBusy(`${action}:${id}`);
    try {
      const res = await fetch(`/api/prompt-versions/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Action failed');
      toast({
        title:
          action === 'approve'
            ? 'Prompt version active'
            : action === 'reject'
              ? 'Proposal rejected'
              : 'Rolled back to built-in',
      });
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

  const pending = versions.filter((v) => v.status === 'pending');
  const others = versions.filter((v) => v.status !== 'pending');

  return (
    <div className="mt-6 pt-4 border-t border-zinc-800">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="h-4 w-4 text-sky-400" />
        <p className="text-xs font-semibold text-zinc-400 uppercase">Prompt versions (self-editing)</p>
        {pending.length > 0 && (
          <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">
            {pending.length} pending
          </Badge>
        )}
      </div>
      <p className="text-[11px] text-zinc-600 mb-3">
        Agent apne prompts ka improvement PROPOSE kar sakta hai — activate karne ke liye
        tumhari approval chahiye. Safety policy (permissions/workspace/terminal) kabhi editable
        nahi hai. Rollback har waqt ek click door hai.
      </p>

      {versions.length === 0 ? (
        <p className="text-xs text-zinc-600 py-2">
          Abhi koi prompt change proposed nahi. Agent repeated failures dekh kar suggestion de
          sakta hai, ya tum khud propose kar sakte ho (POST /api/prompt-versions).
        </p>
      ) : (
        <div className="space-y-1.5">
          {[...pending, ...others].slice(0, 12).map((v) => (
            <div key={v.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60">
              <div className="flex items-center gap-2 px-2.5 py-2">
                <button
                  className="flex-1 min-w-0 text-left flex items-center gap-2"
                  onClick={() => setExpanded(expanded === v.id ? null : v.id)}
                >
                  <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${expanded === v.id ? 'rotate-0' : '-rotate-90'}`} />
                  <span className="text-xs text-zinc-200 font-mono">{v.role}</span>
                  <Badge variant="outline" className={`text-[9px] ${STATUS_TONE[v.status] ?? STATUS_TONE.rolled_back}`}>
                    {v.status} v{v.version}
                  </Badge>
                  <span className="text-[10px] text-zinc-600 hidden sm:inline truncate">
                    by {v.createdBy} · {new Date(v.createdAt).toLocaleDateString()}
                  </span>
                </button>
                {v.status === 'pending' && (
                  <>
                    <Button size="sm" className="h-7 text-[11px] bg-emerald-600 hover:bg-emerald-500" disabled={busy === `approve:${v.id}`} onClick={() => act(v.id, 'approve')}>
                      <Check className="h-3 w-3 mr-1" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-[11px] border-red-900/50 text-red-400" disabled={busy === `reject:${v.id}`} onClick={() => act(v.id, 'reject')}>
                      <X className="h-3 w-3" />
                    </Button>
                  </>
                )}
                {v.status === 'active' && (
                  <Button size="sm" variant="outline" className="h-7 text-[11px] border-zinc-700 text-zinc-400" disabled={busy === `rollback:${v.id}`} onClick={() => act(v.id, 'rollback')} title="Back to the built-in prompt">
                    <History className="h-3 w-3 mr-1" /> Rollback
                  </Button>
                )}
              </div>
              {expanded === v.id && (
                <div className="px-3 pb-3 space-y-1.5">
                  {v.rationale && (
                    <p className="text-[11px] text-amber-300/80">Why: {v.rationale}</p>
                  )}
                  <pre className="text-[10px] font-mono text-zinc-400 bg-zinc-950 rounded-lg p-2.5 max-h-56 overflow-y-auto border border-zinc-800 whitespace-pre-wrap">
                    {v.content}
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
