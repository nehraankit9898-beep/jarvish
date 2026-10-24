'use client';

import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'text-zinc-500 bg-zinc-900';
  }
  if (line.startsWith('diff ') || line.startsWith('index ')) {
    return 'text-emerald-300 font-semibold bg-emerald-500/5';
  }
  if (line.startsWith('@@')) return 'text-sky-300 bg-sky-500/10';
  if (line.startsWith('+')) return 'text-emerald-300 bg-emerald-500/10';
  if (line.startsWith('-')) return 'text-red-300 bg-red-500/10';
  return 'text-zinc-300';
}

export function DiffViewDialog({
  open,
  onOpenChange,
  diff,
  loading,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  diff: string;
  loading: boolean;
}) {
  const lines = useMemo(() => diff.split('\n'), [diff]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl bg-zinc-950 border-zinc-800">
        <DialogHeader>
          <DialogTitle className="text-emerald-300">
            📄 Git Diff (baseline → HEAD)
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-zinc-800 bg-black/60 p-3 font-mono text-[11px] leading-5">
          {loading && <p className="text-zinc-500">Diff load ho raha hai…</p>}
          {!loading && !diff && (
            <p className="text-zinc-500">Koi changes nahi mile.</p>
          )}
          {lines.map((line, i) => (
            <div key={i} className={`px-1 whitespace-pre-wrap ${diffLineClass(line)}`}>
              {line || ' '}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function FileViewDialog({
  open,
  onOpenChange,
  path,
  content,
  loading,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  path: string;
  content: string;
  loading: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl bg-zinc-950 border-zinc-800">
        <DialogHeader>
          <DialogTitle className="text-emerald-300 font-mono text-sm">
            📝 {path}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-zinc-800 bg-black/60 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-zinc-300">
          {loading && <p className="text-zinc-500">File load ho raha hai…</p>}
          {content || ' '}
        </div>
      </DialogContent>
    </Dialog>
  );
}
