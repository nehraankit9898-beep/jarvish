'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FileText, Plus, RefreshCw, Search, Trash2, CircleAlert, FolderTree, HardDriveDownload, Eraser, RotateCcw, Braces } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface KnowledgeDoc {
  id: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  status: 'pending' | 'indexed' | 'failed' | 'unsupported';
  error: string;
  chunkCount: number;
  taskId: string;
  createdAt: string;
}

interface ProjectStatus {
  root: string;
  documents: number;
  chunks: number;
  bytes: number;
  lastIndexedAt: string | null;
  stale: { path: string; name: string; reason: string }[];
  exists: boolean;
}

interface Hit {
  docId: string;
  docName: string;
  path: string;
  seq: number;
  score: number;
  snippet: string;
}

const statusBadge: Record<string, string> = {
  indexed: 'border-emerald-500/40 text-emerald-300',
  pending: 'border-zinc-600 text-zinc-400',
  failed: 'border-red-500/40 text-red-300',
  unsupported: 'border-amber-500/40 text-amber-300',
};

export function KnowledgePanel() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [projectRoot, setProjectRoot] = useState('');
  const [projectStatus, setProjectStatus] = useState<ProjectStatus | null>(null);
  const [projectBusy, setProjectBusy] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const [projectHits, setProjectHits] = useState<Hit[]>([]);
  const [projectSymbols, setProjectSymbols] = useState<
    { name: string; kind: string; line: number; path: string }[]
  >([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/knowledge');
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to load documents' }));
        throw new Error(err.error || 'Failed to load documents');
      }
      setDocs(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const importDoc = useCallback(async () => {
    if (!content.trim()) {
      setError('Paste the document content first');
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || undefined, content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      setName('');
      setContent('');
      toast({
        title: data.status === 'indexed' ? 'Document indexed' : 'Document stored',
        description:
          data.status === 'indexed'
            ? `${data.chunkCount} chunk(s) indexed`
            : data.error || `status: ${data.status}`,
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed';
      setError(msg);
      toast({ title: 'Import failed', description: msg, variant: 'destructive' });
    } finally {
      setImporting(false);
    }
  }, [name, content, load]);

  const remove = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/knowledge?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      await load();
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  }, [load]);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/knowledge/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      setHits(data.hits ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  }, [query]);

  /** Load the status (and the stale file list) of a project index. */
  const loadProjectStatus = useCallback(async (root: string) => {
    if (!root.trim()) {
      setProjectStatus(null);
      return;
    }
    try {
      const res = await fetch(
        `/api/knowledge/project?root=${encodeURIComponent(root.trim())}`
      );
      const data = await res.json();
      if (!res.ok) {
        setProjectStatus(null);
        setError(data.error || 'Failed to read the project index');
        return;
      }
      setProjectStatus(data as ProjectStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read the project index');
    }
  }, []);

  /** index | refresh | rebuild | reset */
  const projectAction = useCallback(
    async (action: 'index' | 'refresh' | 'rebuild' | 'reset') => {
      const root = projectRoot.trim();
      if (!root) {
        setError('Enter the absolute path of the project folder first.');
        return;
      }
      setProjectBusy(action);
      setError(null);
      try {
        const res = await fetch('/api/knowledge/project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root, action }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Project index failed');
        toast({
          title:
            action === 'reset'
              ? 'Index cleared'
              : action === 'refresh'
                ? 'Index refreshed'
                : action === 'rebuild'
                  ? 'Index rebuilt'
                  : 'Project indexed',
          description:
            action === 'reset'
              ? `${data.removed} document(s) removed`
              : `${data.files ?? 0} file(s), ${data.chunks ?? 0} chunk(s) in ${data.durationMs ?? 0} ms`,
        });
        await loadProjectStatus(root);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Project index failed';
        setError(msg);
        toast({ title: 'Project index failed', description: msg, variant: 'destructive' });
      } finally {
        setProjectBusy('');
      }
    },
    [projectRoot, loadProjectStatus]
  );

  /** Search inside the project index — every hit carries its source file. */
  const searchProject = useCallback(async () => {
    const root = projectRoot.trim();
    if (!root || !projectQuery.trim()) return;
    setProjectBusy('search');
    try {
      const res = await fetch(
        `/api/knowledge/project?root=${encodeURIComponent(root)}&search=${encodeURIComponent(projectQuery.trim())}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      setProjectHits(data.hits ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setProjectBusy('');
    }
  }, [projectRoot, projectQuery]);

  /** Search the SYMBOL index — "where is X defined?" */
  const searchSymbols = useCallback(async () => {
    const root = projectRoot.trim();
    if (!root || !projectQuery.trim()) return;
    setProjectBusy('symbols');
    try {
      const res = await fetch(
        `/api/knowledge/project?root=${encodeURIComponent(root)}&symbols=${encodeURIComponent(projectQuery.trim())}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Symbol search failed');
      setProjectSymbols(data.symbols ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Symbol search failed');
    } finally {
      setProjectBusy('');
    }
  }, [projectRoot, projectQuery]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <header className="h-14 shrink-0 border-b border-zinc-800 bg-zinc-900/30 backdrop-blur flex items-center gap-3 px-4">
        <FileText className="h-5 w-5 text-amber-400" />
        <h2 className="font-bold">Knowledge</h2>
        <Badge variant="outline" className="border-amber-500/30 text-amber-400 text-[10px]">
          {docs.length} document(s)
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">Import a document</h3>
            <div className="space-y-1.5 mb-3">
              <Label className="text-xs text-zinc-400">Name (optional)</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="architecture.md"
                className="bg-zinc-800/60 border-zinc-700 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-400">Content</Label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={8}
                placeholder="Paste a markdown/text document here…"
                className="w-full rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>
            <Button
              onClick={() => void importDoc()}
              disabled={importing}
              className="mt-3 bg-amber-600 hover:bg-amber-500 text-white"
            >
              <Plus className="h-4 w-4 mr-2" />
              Index document
            </Button>
            <p className="text-[11px] text-zinc-500 mt-2">
              Supported: text/source files and real documents (pdf, docx, xlsx, pptx,
              odt/ods, rtf, epub). Images, archives and scanned PDFs are reported as
              &ldquo;unsupported&rdquo; with the exact reason instead of pretending to be indexed.
            </p>
          </section>

          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">Search</h3>
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void search();
                }}
                placeholder="e.g. how does the auth flow work?"
                className="bg-zinc-800/60 border-zinc-700 text-sm"
              />
              <Button onClick={() => void search()} disabled={searching}>
                <Search className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-3 space-y-2 max-h-[320px] overflow-y-auto">
              {hits.length === 0 ? (
                <p className="text-xs text-zinc-500">
                  {searching ? 'Searching…' : 'No hits yet — enter a query and press Enter.'}
                </p>
              ) : (
                hits.map((h) => (
                  <div
                    key={`${h.docId}-${h.seq}`}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-amber-300">{h.docName}</span>
                      {h.path && (
                        <span className="text-[10px] text-zinc-500">{h.path}</span>
                      )}
                      <span className="text-[10px] text-zinc-600">chunk #{h.seq}</span>
                      <span className="text-[10px] text-zinc-500 ml-auto">
                        score {h.score}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words">
                      {h.snippet.slice(0, 400)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <section className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex items-center gap-2 mb-3">
            <FolderTree className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-zinc-200">Project index</h3>
            {projectStatus && (
              <Badge variant="outline" className="border-amber-500/30 text-amber-400 text-[10px]">
                {projectStatus.documents} file(s) · {projectStatus.chunks} chunk(s)
              </Badge>
            )}
          </div>

          <div className="space-y-1.5 mb-3">
            <Label className="text-xs text-zinc-400">Project folder (absolute path)</Label>
            <div className="flex gap-2">
              <Input
                value={projectRoot}
                onChange={(e) => setProjectRoot(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void loadProjectStatus(projectRoot);
                }}
                placeholder="C:\\Users\\you\\projects\\my-app"
                className="bg-zinc-800/60 border-zinc-700 text-sm"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadProjectStatus(projectRoot)}
                className="shrink-0"
              >
                Status
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-3">
            <Button
              size="sm"
              onClick={() => void projectAction('index')}
              disabled={Boolean(projectBusy)}
              className="bg-amber-600 hover:bg-amber-500 text-white"
            >
              <HardDriveDownload className="h-4 w-4 mr-2" />
              Index project
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void projectAction('refresh')}
              disabled={Boolean(projectBusy) || !projectStatus?.stale.length}
              title={
                projectStatus?.stale.length
                  ? 'Re-index the changed files'
                  : 'No stale files — nothing to refresh'
              }
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh ({projectStatus?.stale.length ?? 0} stale)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void projectAction('rebuild')}
              disabled={Boolean(projectBusy)}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Rebuild
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void projectAction('reset')}
              disabled={Boolean(projectBusy) || !projectStatus?.documents}
              className="text-red-400 hover:text-red-300"
            >
              <Eraser className="h-4 w-4 mr-2" />
              Reset
            </Button>
          </div>

          {projectStatus && projectStatus.stale.length > 0 && (
            <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-xs text-amber-300 mb-1">
                {projectStatus.stale.length} file(s) changed on disk — refresh to update the
                index.
              </p>
              <ul className="text-[10px] text-amber-200/80 space-y-0.5 max-h-24 overflow-y-auto">
                {projectStatus.stale.slice(0, 40).map((s) => (
                  <li key={s.path}>
                    {s.path} <span className="text-amber-300/60">({s.reason})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs text-zinc-400">Search inside the project</Label>
            <div className="flex gap-2">
              <Input
                value={projectQuery}
                onChange={(e) => setProjectQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void searchProject();
                }}
                placeholder="e.g. where is the retry logic?"
                className="bg-zinc-800/60 border-zinc-700 text-sm"
              />
              <Button
                onClick={() => void searchProject()}
                disabled={projectBusy === 'search' || !projectRoot.trim()}
              >
                <Search className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                onClick={() => void searchSymbols()}
                disabled={projectBusy === 'symbols' || !projectRoot.trim()}
                title="Find where a symbol is declared"
              >
                <Braces className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {projectSymbols.length > 0 && (
            <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <p className="text-[11px] text-zinc-500 mb-2">
                {projectSymbols.length} symbol(s) found
              </p>
              <ul className="space-y-1 max-h-[160px] overflow-y-auto">
                {projectSymbols.map((s) => (
                  <li key={`${s.path}-${s.name}-${s.line}`} className="text-[11px]">
                    <span className="text-amber-300 font-medium">{s.name}</span>{' '}
                    <span className="text-zinc-600">({s.kind})</span>{' '}
                    <span className="text-zinc-500 font-mono">
                      {s.path}:{s.line}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {projectHits.length > 0 && (
            <div className="mt-3 space-y-2 max-h-[260px] overflow-y-auto">
              {projectHits.map((h) => (
                <div
                  key={`${h.docId}-${h.seq}`}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-amber-300">{h.path}</span>
                    <span className="text-[10px] text-zinc-600">chunk #{h.seq}</span>
                    <span className="text-[10px] text-zinc-500 ml-auto">score {h.score}</span>
                  </div>
                  <p className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words">
                    {h.snippet.slice(0, 400)}
                  </p>
                </div>
              ))}
            </div>
          )}

          <p className="text-[11px] text-zinc-500 mt-3">
            Secret-looking files (.env, *.pem, credentials.json, …) are never indexed and
            credential-shaped content is redacted before it is stored.
          </p>
        </section>

        <section className="mt-5">
          <h3 className="text-sm font-semibold text-zinc-200 mb-2">Documents</h3>
          {loading ? (
            <div className="text-xs text-zinc-500">Loading…</div>
          ) : docs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
              No documents imported yet.
            </div>
          ) : (
            <div className="space-y-2">
              {docs.map((d) => (
                <div
                  key={d.id}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-sm font-medium text-zinc-100">{d.name}</span>
                      <Badge
                        variant="outline"
                        className={`text-[9px] ${statusBadge[d.status] ?? statusBadge.pending}`}
                      >
                        {d.status}
                      </Badge>
                      {d.chunkCount > 0 && (
                        <span className="text-[10px] text-zinc-500">
                          {d.chunkCount} chunk(s)
                        </span>
                      )}
                      <span className="text-[10px] text-zinc-600">{d.size} bytes</span>
                    </div>
                    {d.error && <p className="text-[11px] text-amber-400">{d.error}</p>}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(d.id)}
                    aria-label={`Delete ${d.name}`}
                    className="text-red-400 hover:text-red-300 shrink-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
