'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Brain, Plus, RefreshCw, Trash2, CircleAlert, Pencil, X, Check, Bot, User } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface MemoryEntry {
  id: string;
  scope: 'user' | 'task';
  taskId: string;
  category: 'preference' | 'fact' | 'note';
  key: string;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES = ['preference', 'fact', 'note'] as const;

export function MemoryPanel() {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<'preference' | 'fact' | 'note'>('preference');
  const [saving, setSaving] = useState(false);
  // Jarvis #4: inline edit — koi bhi yaad ko edit ya delete ("Forget") kar sako
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingOriginalKey, setEditingOriginalKey] = useState('');
  const [editKey, setEditKey] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState<'preference' | 'fact' | 'note'>('note');
  const [savingEdit, setSavingEdit] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // only the USER scope is listed here — task-scoped notes belong to
      // their task and are shown in the task timeline
      const res = await fetch('/api/memory?scope=user');
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to load memory' }));
        throw new Error(err.error || 'Failed to load memory');
      }
      setEntries(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load memory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!key.trim() || !content.trim()) {
      setError('A key and a content are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'user', key, content, category }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setKey('');
      setContent('');
      toast({ title: 'Memory saved', description: 'It will be available in every task.' });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setError(msg);
      toast({ title: 'Save failed', description: msg, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }, [key, content, category, load]);

  const remove = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/memory?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      toast({ title: 'Bhool gaya', description: 'Memory delete ho gayi.' });
      await load();
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  }, [load]);

  const startEdit = useCallback((m: MemoryEntry) => {
    setEditingId(m.id);
    setEditingOriginalKey(m.key);
    setEditKey(m.key);
    setEditContent(m.content);
    setEditCategory(m.category);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingOriginalKey('');
    setEditKey('');
    setEditContent('');
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editKey.trim() || !editContent.trim()) {
      toast({ title: 'Key aur content zaroori hain', variant: 'destructive' });
      return;
    }
    setSavingEdit(true);
    try {
      // POST is an UPSERT on (scope, key) — renaming the key creates a new
      // entry, so delete the old one only when the key actually changed
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'user', key: editKey, content: editContent, category: editCategory }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');
      // key badla hai toh purani entry hatani padegi warna duplicate yaad
      if (editingOriginalKey && editingOriginalKey !== editKey.trim() && editingId) {
        await fetch(`/api/memory?id=${encodeURIComponent(editingId)}`, {
          method: 'DELETE',
        }).catch(() => undefined);
      }
      await load();
      toast({ title: 'Memory updated' });
      cancelEdit();
    } catch (err) {
      toast({
        title: 'Update failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSavingEdit(false);
    }
  }, [editKey, editContent, editCategory, editingOriginalKey, load, cancelEdit]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <header className="h-14 shrink-0 border-b border-zinc-800 bg-zinc-900/30 backdrop-blur flex items-center gap-3 px-4">
        <Brain className="h-5 w-5 text-sky-400" />
        <h2 className="font-bold">Memory</h2>
        <Badge variant="outline" className="border-sky-500/30 text-sky-400 text-[10px]">
          {entries.length} user entries
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

        <section className="mb-5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="text-sm font-semibold text-zinc-200 mb-3">Add a memory</h3>
          <div className="grid sm:grid-cols-[1fr_160px] gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-400">Key</Label>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="e.g. preferred-language"
                className="bg-zinc-800/60 border-zinc-700 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-400">Category</Label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as 'preference' | 'fact' | 'note')}
              >
                <SelectTrigger className="bg-zinc-800/60 border-zinc-700 text-sm">
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
          </div>
          <div className="space-y-1.5 mt-3">
            <Label className="text-xs text-zinc-400">Content</Label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={3}
              placeholder="What should the agent remember?"
              className="w-full rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
          <div className="flex items-center gap-3 mt-3">
            <Button
              onClick={() => void save()}
              disabled={saving}
              className="bg-sky-600 hover:bg-sky-500 text-white"
            >
              <Plus className="h-4 w-4 mr-2" />
              Save memory
            </Button>
            <p className="text-[11px] text-zinc-500">
              API keys are refused — store them in the Providers panel.
            </p>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-zinc-200 mb-2">Stored memories</h3>
          {loading ? (
            <div className="text-xs text-zinc-500">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
              Nothing stored yet.
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((m) => (
                <div
                  key={m.id}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    {editingId === m.id ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Input
                            value={editKey}
                            onChange={(e) => setEditKey(e.target.value)}
                            className="h-8 bg-zinc-800/60 border-zinc-700 text-sm"
                            aria-label="Memory key"
                          />
                          <Select
                            value={editCategory}
                            onValueChange={(v) => setEditCategory(v as 'preference' | 'fact' | 'note')}
                          >
                            <SelectTrigger className="h-8 w-[130px] bg-zinc-800/60 border-zinc-700 text-xs">
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
                        <textarea
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          rows={3}
                          className="w-full rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                          aria-label="Memory content"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => void saveEdit()}
                            disabled={savingEdit}
                            className="h-8 bg-emerald-600 hover:bg-emerald-500 text-white"
                          >
                            <Check className="h-3.5 w-3.5 mr-1" /> Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={cancelEdit} className="h-8 text-zinc-400">
                            <X className="h-3.5 w-3.5 mr-1" /> Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-sm font-medium text-zinc-100">{m.key}</span>
                          <Badge variant="outline" className="text-[9px] border-zinc-700 text-zinc-400">
                            {m.category}
                          </Badge>
                          {m.source === 'agent' ? (
                            <Badge variant="outline" className="text-[9px] border-violet-500/40 text-violet-300 gap-1">
                              <Bot className="h-3 w-3" /> agent
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[9px] border-zinc-700 text-zinc-500 gap-1">
                              <User className="h-3 w-3" /> you
                            </Badge>
                          )}
                          <span className="text-[10px] text-zinc-600">
                            {new Date(m.updatedAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-400 whitespace-pre-wrap break-words">
                          {m.content}
                        </p>
                      </>
                    )}
                  </div>
                  {editingId !== m.id && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(m)}
                        aria-label={`Edit ${m.key}`}
                        className="text-zinc-400 hover:text-zinc-200"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void remove(m.id)}
                        aria-label={`Forget ${m.key}`}
                        title="Forget this — memory delete ho jayegi"
                        className="text-red-400 hover:text-red-300"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
