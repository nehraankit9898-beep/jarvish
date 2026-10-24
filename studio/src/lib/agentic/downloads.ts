// downloads.ts — download handling for the user's REAL Downloads folder
// (Roadmap #3).
//
// Two capabilities:
//   1. downloadToDownloads(url) — server-side HTTP download with the SAME
//      SSRF guard the provider connections use, a hard size cap, filename
//      sanitising and collision-safe naming. Files land in the user's
//      Downloads folder (AGENTSCOPE_DOWNLOADS_DIR overrides).
//   2. The Downloads WATCHER — a dependency-free polling watcher that
//      notices NEW files in Downloads and drops a notification, so the user
//      (and the agent) see what arrived. Chokidar was considered, but a
//      stat-based poll has zero new dependencies and works identically on
//      Windows.
//
// Killing/pausing: the watcher is part of the background runtime. Downloads
// themselves flow through host-control as the `download` action kind, so in
// 'ask' mode every download waits for approval like any other write.

import fs from 'node:fs';
import path from 'node:path';
import { assertOutboundUrl, OutboundUrlError } from './outbound';
import { recordAudit } from './audit';
import { createNotification } from './notifications';
import { downloadsDir } from './allowed-roots';

// single source of truth for the Downloads location lives in allowed-roots;
// re-exported here so browser-service and the API layer share one path
export { downloadsDir };

const MAX_DOWNLOAD_BYTES_DEFAULT = 200 * 1024 * 1024; // 200 MB
/** how long a download may go without a single new byte before it is aborted */
const DOWNLOAD_STALL_MS = 120_000;
const WATCH_INTERVAL_MS = 20_000;
const MAX_WATCH_FILES = 400;

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

function maxDownloadBytes(): number {
  const mb = Number(process.env.AGENTSCOPE_DOWNLOAD_MAX_MB ?? '');
  if (!Number.isFinite(mb) || mb <= 0) return MAX_DOWNLOAD_BYTES_DEFAULT;
  return Math.min(mb, 2048) * 1024 * 1024;
}

/** Windows reserved device names — creating these files fails or worse on win32. */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Strip path separators, control chars and Windows-reserved names. */
export function sanitizeFilename(name: string): string {
  let clean = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '');
  if (clean.length > 120) clean = clean.slice(0, 120);
  // "CON.pdf" / "nul.txt" cannot exist as normal files on Windows — prefix
  // them so a download named after a device never fails at rename time
  const base = clean.split('.')[0]?.toUpperCase();
  if (base && WINDOWS_RESERVED.has(base)) clean = `file-${clean}`;
  if (!clean) clean = 'download.bin';
  return clean;
}

/** `photo.jpg` exists -> `photo (2).jpg` — never overwrite user files. */
export function collisionSafePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
    if (i > 999) throw new DownloadError('Too many duplicate filenames');
  }
  return candidate;
}

function filenameFromHeaders(headers: Headers, url: URL): string {
  const cd = headers.get('content-disposition') ?? '';
  const utf8 = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].replace(/["']/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (plain?.[1]) return plain[1];
  const fromPath = path.basename(decodeURIComponent(url.pathname));
  return fromPath || `download-${Date.now()}.bin`;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  filename: string;
  contentType: string;
  url: string;
  truncated: boolean;
}

/**
 * Stream a URL into the Downloads folder. Throws DownloadError (never leaks
 * partial files — the temp file is removed on failure).
 */
export async function downloadToDownloads(
  url: string,
  opts: { taskId?: string; actor?: string; filename?: string } = {}
): Promise<DownloadResult> {
  const target = String(url ?? '').trim();
  let parsed: URL;
  try {
    // the browser may fetch localhost dev servers; plain downloads use the
    // standard outbound policy (no loopback — matches provider connections)
    parsed = await assertOutboundUrl(target);
  } catch (err) {
    if (err instanceof OutboundUrlError) throw new DownloadError(`URL blocked: ${err.message}`);
    throw err;
  }

  const dir = downloadsDir();
  fs.mkdirSync(dir, { recursive: true });

  const controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
  let res: Response | null = null;
  try {
    // redirects are followed MANUALLY so every hop passes the same SSRF
    // guard — with redirect:'follow' a public URL could 302 into
    // 169.254.169.254 / localhost / RFC1918 and bypass the guard entirely
    let current = parsed.toString();
    for (let hop = 0; hop < 5 && !res; hop++) {
      const checked = await assertOutboundUrl(current);
      const step = await fetch(checked.toString(), {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'AgentScopeStudio/1.0 (+laptop-control)' },
      });
      const loc = step.headers.get('location');
      if (step.status >= 300 && step.status < 400 && loc) {
        try {
          step.body?.cancel();
        } catch {
          /* ignore */
        }
        current = new URL(loc, checked).toString();
        continue;
      }
      res = step;
    }
    if (!res) throw new DownloadError('too many redirects (5+) — download refused');
  } catch (err) {
    clearTimeout(timeout);
    throw new DownloadError(`Download failed: ${err instanceof Error ? err.message : 'network error'}`);
  }
  // H17: the timer used to be cancelled right here — as soon as the HEADERS
  // arrived. A server that answers instantly and then trickles the body one
  // byte a minute therefore kept the request (and the agent task waiting on
  // it) alive forever, past any size cap. From here the timer is a STALL
  // timeout that is re-armed on every chunk until the file is on disk.
  const armTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
  };

  // the `if (!res) throw` inside the try guarantees non-null here; the local
  // just gives TypeScript the same certainty
  const response = res as Response;
  if (!response.ok) {
    throw new DownloadError(`HTTP ${response.status} ${response.statusText} for ${parsed.hostname}`);
  }

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxDownloadBytes()) {
    throw new DownloadError(
      `File too large (${Math.round(declared / 1048576)} MB > limit ${Math.round(maxDownloadBytes() / 1048576)} MB)`
    );
  }

  const filename = sanitizeFilename(opts.filename || filenameFromHeaders(response.headers, parsed));
  const finalPath = collisionSafePath(dir, filename);
  const tmpPath = `${finalPath}.agentscope-part`;

  const cap = maxDownloadBytes();
  let written = 0;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new DownloadError('Empty response body');
    const fd = fs.openSync(tmpPath, 'w');
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armTimeout();
        written += value.byteLength;
        if (written > cap) throw new DownloadError(`Download exceeded the size limit mid-stream (${Math.round(cap / 1048576)} MB)`);
        fs.writeSync(fd, value);
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
    if (err instanceof DownloadError) throw err;
    const aborted = (err as Error)?.name === 'AbortError';
    throw new DownloadError(
      aborted
        ? `Download stalled — no data for ${DOWNLOAD_STALL_MS / 1000}s`
        : `Download failed: ${err instanceof Error ? err.message : 'unknown'}`
    );
  } finally {
    clearTimeout(timeout);
  }

  const result: DownloadResult = {
    path: finalPath,
    bytes: written,
    filename,
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    url: parsed.toString(),
    truncated: false,
  };

  await recordAudit({
    actor: opts.actor ?? 'agent',
    action: 'downloads.file_saved',
    category: 'tool',
    taskId: opts.taskId ?? '',
    approval: 'auto',
    details: { path: finalPath, bytes: written, url: parsed.toString() },
  });
  await createNotification({
    type: 'download',
    title: `Downloaded ${filename}`,
    body: `${Math.max(1, Math.round(written / 1024))} KB -> ${finalPath}`,
    taskId: opts.taskId,
    data: { path: finalPath, bytes: written, source: 'tool' },
  });

  return result;
}

// ---------- the Downloads watcher ----------

interface WatchState {
  timer: ReturnType<typeof setInterval> | null;
  known: Map<string, number>;
  lastTick: number;
  paused: boolean;
}

function watchStore(): WatchState {
  const g = globalThis as unknown as { __downloadsWatch?: WatchState };
  return (g.__downloadsWatch ??= { timer: null, known: new Map(), lastTick: 0, paused: false });
}

/**
 * Scan once: any file NEWER than the previous scan (and not seen before)
 * notifies. `silent` records what is there WITHOUT notifying — used for the
 * seeding pass at startup.
 */
export function scanDownloadsOnce(
  now = Date.now(),
  opts: { silent?: boolean } = {}
): Array<{ name: string; path: string; size: number }> {
  const state = watchStore();
  if (state.paused) return [];
  const dir = downloadsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_WATCH_FILES);
  } catch {
    return []; // Downloads folder may not exist yet — not an error
  }

  const fresh: Array<{ name: string; path: string; size: number }> = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name;
    // partial files must never notify: Chrome's .crdownload/.part AND the
    // agent's own .agentscope-part temp file — otherwise every agent download
    // produced TWO watcher notifications (the temp file + the final name)
    // on top of the "Downloaded ..." notification the downloader already sent
    if (
      name.endsWith('.crdownload') ||
      name.endsWith('.part') ||
      name.endsWith('.tmp') ||
      name.endsWith('.agentscope-part')
    ) continue;
    const full = path.join(dir, name);
    seen.add(full);
    let mtime = 0;
    let size = 0;
    try {
      const st = fs.statSync(full);
      mtime = st.mtimeMs;
      size = st.size;
    } catch {
      continue;
    }
    const prev = state.known.get(full);
    if (prev === undefined) {
      // first sight after boot: only files from the last 10 minutes count as
      // "new" so a restart does not spam 400 notifications about old files
      if (now - mtime < 10 * 60_000) fresh.push({ name, path: full, size });
      state.known.set(full, mtime);
    } else if (mtime > prev + 1500) {
      fresh.push({ name, path: full, size });
      state.known.set(full, mtime);
    }
  }
  // forget entries that vanished (deleted/moved)
  for (const key of Array.from(state.known.keys())) {
    if (!seen.has(key)) state.known.delete(key);
  }
  state.lastTick = now;

  // H18: the "seed without notifying" pass used to notify anyway — any file
  // the user had touched in the last ten minutes produced a phantom
  // "New file in Downloads" on EVERY server restart, because the freshness
  // window inside the scan is what decides. Under `silent` the scan still
  // records the known-set (so the next real tick sees nothing new) but stays
  // quiet.
  if (fresh.length && !opts.silent) {
    void createNotification({
      type: 'download',
      title: fresh.length === 1 ? `New file in Downloads: ${fresh[0].name}` : `${fresh.length} new files in Downloads`,
      body: fresh.map((f) => f.name).join(', ').slice(0, 500),
      data: { files: fresh.slice(0, 10), source: 'watcher' },
    }).catch(() => undefined);
  }
  return fresh;
}

/** Start the poll watcher (idempotent — the background runtime calls this). */
export function startDownloadsWatcher(): boolean {
  if (process.env.AGENTSCOPE_DOWNLOADS_WATCH === '0') return false;
  const state = watchStore();
  if (state.timer) return false;
  state.timer = setInterval(() => {
    try {
      scanDownloadsOnce();
    } catch {
      /* never crash the runtime on a scan */
    }
  }, WATCH_INTERVAL_MS);
  // seed the known-set without notifying about the existing content
  scanDownloadsOnce(Date.now(), { silent: true });
  return true;
}

export function stopDownloadsWatcher(): void {
  const state = watchStore();
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** Recent files in Downloads (newest first) for the UI. */
export function recentDownloads(limit = 20): Array<{ name: string; path: string; size: number; modifiedAt: string }> {
  const dir = downloadsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  } catch {
    return [];
  }
  const rows: Array<{ name: string; path: string; size: number; modifiedAt: string; m: number }> = [];
  for (const e of entries.slice(0, 500)) {
    try {
      const st = fs.statSync(path.join(dir, e.name));
      rows.push({
        name: e.name,
        path: path.join(dir, e.name),
        size: st.size,
        modifiedAt: new Date(st.mtimeMs).toISOString(),
        m: st.mtimeMs,
      });
    } catch {
      continue;
    }
  }
  return rows
    .sort((a, b) => b.m - a.m)
    .slice(0, Math.min(Math.max(1, limit), 100))
    .map(({ m, ...rest }) => rest);
}
