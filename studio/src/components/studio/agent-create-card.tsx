'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Sparkles, Wand2 } from 'lucide-react';

export interface AgentCreatePayload {
  name: string;
  emoji: string;
  systemPrompt: string;
  temperature?: number;
}

// Extracts the ```agentcreate {json}``` block from an assistant message.
// Returns { visibleContent, payload } — payload null when no complete block yet.
export function parseAgentCreateBlock(
  content: string
): { visibleContent: string; payload: AgentCreatePayload | null } {
  const match = content.match(/```agentcreate\s*\n?([\s\S]*?)```/);
  if (!match) return { visibleContent: content, payload: null };
  const visibleContent = content
    .replace(match[0], '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  try {
    const json = JSON.parse(match[1].trim());
    if (!json.name || !json.systemPrompt) {
      return { visibleContent, payload: null };
    }
    return {
      visibleContent,
      payload: {
        name: String(json.name),
        emoji: String(json.emoji || '🤖').slice(0, 4),
        systemPrompt: String(json.systemPrompt),
        temperature:
          typeof json.temperature === 'number' ? json.temperature : 0.7,
      },
    };
  } catch {
    // Incomplete/invalid JSON — treat as no block while streaming
    return { visibleContent, payload: null };
  }
}

type CardState = 'creating' | 'created' | 'failed';

export function AgentCreateCard({
  payload,
  onCreate,
}: {
  payload: AgentCreatePayload;
  onCreate: (agent: AgentCreatePayload) => Promise<boolean>;
}) {
  const [state, setState] = useState<CardState>('creating');
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    let cancelled = false;
    (async () => {
      try {
        const ok = await onCreate(payload);
        if (!cancelled) setState(ok ? 'created' : 'failed');
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
     
  }, []);

  return (
    <div
      className={`my-3 rounded-xl border p-4 ${
        state === 'created'
          ? 'border-emerald-500/40 bg-emerald-500/10'
          : state === 'failed'
            ? 'border-red-500/40 bg-red-500/10'
            : 'border-zinc-700 bg-zinc-800/60'
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
        {state === 'created' ? (
          <span className="flex items-center gap-1.5 text-emerald-400">
            <Sparkles className="h-3.5 w-3.5" /> AI ne agent bana diya
          </span>
        ) : state === 'failed' ? (
          <span className="text-red-400 flex items-center gap-1.5">
            <Wand2 className="h-3.5 w-3.5" /> Creation failed
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-zinc-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Agent ban raha hai…
          </span>
        )}
      </div>
      <div className="mt-2.5 flex items-start gap-3">
        <div className="h-11 w-11 shrink-0 rounded-xl bg-zinc-900 ring-1 ring-emerald-500/30 flex items-center justify-center text-2xl">
          {payload.emoji}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm text-zinc-100">{payload.name}</p>
          <p className="text-xs text-zinc-400 mt-0.5 line-clamp-3 leading-relaxed">
            {payload.systemPrompt}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-400">
              temp {payload.temperature?.toFixed(1) ?? '0.7'}
            </span>
            {state === 'created' && (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Sidebar me add ho gaya — chat se select
                karo
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
