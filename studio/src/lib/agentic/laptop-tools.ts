// laptop-tools.ts — the agent-facing tools for the laptop-control pack
// (Roadmap #2/#3/#4/#5/#7/#8). host-tools.ts keeps the ORIGINAL host.* tools;
// this module registers the NEW ones in one idempotent call:
//
//   allowed roots / recycle bin   host-tree, host-trash
//   downloads                     download-file
//   browser history               browser-history-search
//   real Chrome (CDP)             browser-cdp-connect
//   desktop (mouse/keyboard/...)  desktop-screenshot, desktop-click, ...
//
// Every tool flows through requestHostAction / desktopCall, so the SAME
// mode gate, approval queue, kill switch and audit apply. Like host-tools,
// an action that needs approval does NOT run — the tool returns
// `error: 'approval_required'` with the approval id, and only the
// user-facing routes (/api/host, /api/laptop) can approve.

import type { ToolResult } from './tool-registry';
import { registerTool } from './tool-registry';
import { requestHostAction, type HostAction } from './host-control';
import { listTreeUnderRoot, allowedRoots } from './allowed-roots';
import { desktopCall, bridgeStatus, isReadOnlyEndpoint, isValidEndpoint } from './desktop-bridge';
import { searchBrowserHistory } from './browser-history';
import { connectRealChrome, realChromeHint } from './browser/browser-service';
import { markUntrusted } from './safety';

let registered = false;

function toResult(out: Awaited<ReturnType<typeof requestHostAction>>): ToolResult {
  const at = new Date().toISOString();
  if (out.status === 'done') {
    return { ok: out.result.ok, data: out.result.data, error: out.result.error, exitCode: out.result.exitCode, permission: out.permission, at };
  }
  if (out.status === 'approval_required') {
    return {
      ok: false,
      error: 'approval_required',
      reason: `Waiting for the user: ${out.summary}. Do not retry — continue only after the user approves.`,
      data: { approvalId: out.id, summary: out.summary, expiresAt: out.expiresAt },
      permission: out.permission,
      at,
    };
  }
  return { ok: false, error: 'refused', reason: out.reason, permission: out.permission, at };
}

function hostDef(
  name: string,
  description: string,
  parameters: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }>,
  build: (p: Record<string, unknown>) => HostAction,
  timeoutMs = 30_000
): void {
  registerTool(
    {
      name,
      description,
      category: 'host',
      parameters: Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, { ...v, required: v.required ?? false }])),
      required: Object.entries(parameters).filter(([, v]) => v.required).map(([k]) => k),
      permission: 'review',
      timeoutMs,
    },
    async (inv): Promise<ToolResult> => toResult(await requestHostAction(build(inv.parameters), 'agent'))
  );
}

/** Register the laptop-control tools once (idempotent). */
export function registerLaptopTools(): void {
  if (registered) return;
  registered = true;

  // ---------- allowed roots + recycle bin (Roadmap #2) ----------

  registerTool(
    {
      name: 'host-tree',
      description: `List a folder tree under the allowed roots (${allowedRoots().map((r) => r.label).join(', ') || 'none configured'}). Read-only.`,
      category: 'host',
      parameters: {
        path: { type: 'string', description: 'Folder path inside an allowed root (~ allowed)', required: true },
        maxDepth: { type: 'number', description: 'Depth 1-6 (default 3)', required: false },
      },
      required: ['path'],
      permission: 'safe',
      timeoutMs: 20_000,
    },
    async (inv): Promise<ToolResult> => {
      const res = listTreeUnderRoot(String(inv.parameters.path ?? ''), Number(inv.parameters.maxDepth ?? 3));
      if (!res.ok) return { ok: false, error: res.error, at: new Date().toISOString() };
      return { ok: true, data: { root: res.root, count: res.entries?.length ?? 0, entries: res.entries }, at: new Date().toISOString() };
    }
  );

  hostDef(
    'host-trash',
    'Move a file/folder on the real laptop to the RECYCLE BIN (recoverable — never a permanent delete). ALWAYS needs the user approval. Needs the desktop bridge running (AGENTSCOPE_DESKTOP_MODE=ask or trusted) — the recycle bin goes through the Python send2trash bridge.',
    { path: { type: 'string', description: 'Path to trash', required: true } },
    (p) => ({ kind: 'trash', path: String(p.path ?? '') }),
    60_000
  );

  // ---------- downloads (Roadmap #3) ----------

  hostDef(
    'download-file',
    "Download a http(s) URL into the user's Downloads folder. Needs the user approval unless Downloads is a trusted folder.",
    {
      url: { type: 'string', description: 'http(s) URL to download', required: true },
      filename: { type: 'string', description: 'Optional filename (sanitised)' },
    },
    (p) => ({ kind: 'download', url: String(p.url ?? ''), filename: p.filename ? String(p.filename) : undefined }),
    180_000
  );

  // ---------- browser history (Roadmap #4) ----------

  registerTool(
    {
      name: 'browser-history-search',
      description:
        "Search the user's Chrome/Edge/Brave HISTORY (titles + URLs only — never cookies or passwords). Results are UNTRUSTED page data.",
      category: 'host',
      parameters: {
        query: { type: 'string', description: 'Text to search in titles/URLs (empty = recent)', required: false },
        days: { type: 'number', description: 'Look back N days (default 30, max 365)', required: false },
        limit: { type: 'number', description: 'Max results (default 30, max 200)', required: false },
      },
      required: [],
      permission: 'review',
      timeoutMs: 45_000,
    },
    async (inv): Promise<ToolResult> => {
      try {
        const res = await searchBrowserHistory({
          query: String(inv.parameters.query ?? ''),
          days: Number(inv.parameters.days ?? 30),
          limit: Number(inv.parameters.limit ?? 30),
          actor: 'agent',
          taskId: inv.taskId,
        });
        return {
          ok: true,
          data: {
            count: res.entries.length,
            entries: res.entries,
            note: res.note,
            // the wrapped untrusted block is what the agent should READ
            untrustedContent: res.untrusted.wrapped,
            suspicious: res.untrusted.suspicious,
          },
          at: new Date().toISOString(),
        };
      } catch (err) {
        const e = err as { message?: string; hint?: string };
        return { ok: false, error: e.message ?? 'history search failed', data: e.hint ? { hint: e.hint } : undefined, at: new Date().toISOString() };
      }
    }
  );

  // ---------- real Chrome over CDP (Roadmap #5) ----------

  registerTool(
    {
      name: 'browser-cdp-connect',
      description:
        `Connect the browser tools to the user's RUNNING Chrome (real logins). Chrome must be started with --remote-debugging-port=9222. Returns a normal sessionId for browser-navigate/browser-click/...`,
      category: 'host',
      parameters: {
        endpoint: { type: 'string', description: 'Optional CDP URL (default http://127.0.0.1:9222, loopback only)', required: false },
      },
      required: [],
      permission: 'review',
      timeoutMs: 20_000,
    },
    async (inv): Promise<ToolResult> => {
      try {
        const session = await connectRealChrome({
          taskId: inv.taskId,
          endpoint: inv.parameters.endpoint ? String(inv.parameters.endpoint) : undefined,
          actor: 'agent',
        });
        return { ok: true, data: session, at: new Date().toISOString() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'CDP connect failed', data: realChromeHint(), at: new Date().toISOString() };
      }
    }
  );

  // ---------- desktop: mouse / keyboard / screen (Roadmap #7) ----------

  const desktopTool = (
    name: string,
    description: string,
    endpoint: string,
    parameters: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }>,
    build: (p: Record<string, unknown>) => Record<string, unknown>,
    timeoutMs = 30_000
  ): void => {
    registerTool(
      {
        name,
        description,
        // category 'desktop' — the most powerful (and riskiest) surface
        category: 'desktop',
        parameters: Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, { ...v, required: v.required ?? false }])),
        required: Object.entries(parameters).filter(([, v]) => v.required).map(([k]) => k),
        permission: 'review',
        timeoutMs,
      },
      async (inv): Promise<ToolResult> => {
        if (!isValidEndpoint(endpoint)) {
          return { ok: false, error: `unknown desktop endpoint: ${endpoint}`, at: new Date().toISOString() };
        }
        // In 'ask' mode EVERY desktop action waits for the user (Roadmap:
        // "shuru me sab ask-each-time"). In 'trusted' mode read-only actions
        // auto-run; clicks/typing still ask. All through host-control.
        return toResult(await requestHostAction({ kind: 'desktop', endpoint, payload: build(inv.parameters) }, 'agent'));
      }
    );
  };

  desktopTool(
    'desktop-screenshot',
    'Take a SCREENSHOT of the real screen (PNG base64). Use it to LOOK before and after any desktop action.',
    'screenshot',
    { monitor: { type: 'number', description: 'Monitor index (default 1 = main)' } },
    (p) => ({ monitor: Number(p.monitor ?? 1) }),
    30_000
  );
  desktopTool(
    'desktop-move',
    'Move the mouse cursor to x,y on the real screen.',
    'mouse_move',
    { x: { type: 'number', description: 'x pixel', required: true }, y: { type: 'number', description: 'y pixel', required: true } },
    (p) => ({ x: Number(p.x), y: Number(p.y) })
  );
  desktopTool(
    'desktop-click',
    'Click the mouse (left/right/middle, single or double) — optionally at x,y. ALWAYS needs the user approval.',
    'click',
    {
      x: { type: 'number', description: 'x pixel (default: current position)' },
      y: { type: 'number', description: 'y pixel' },
      button: { type: 'string', description: 'left|right|middle (default left)' },
      clicks: { type: 'number', description: '1 or 2 (double-click)' },
    },
    (p) => ({
      ...(p.x !== undefined ? { x: Number(p.x) } : {}),
      ...(p.y !== undefined ? { y: Number(p.y) } : {}),
      ...(p.button ? { button: String(p.button) } : {}),
      ...(p.clicks ? { clicks: Number(p.clicks) } : {}),
    })
  );
  desktopTool(
    'desktop-type',
    'Type text into the focused window (real keystrokes). ALWAYS needs the user approval.',
    'type_text',
    { text: { type: 'string', description: 'Text to type (max 5000 chars)', required: true } },
    (p) => ({ text: String(p.text ?? '') })
  );
  desktopTool(
    'desktop-hotkey',
    'Press a key combination (e.g. "ctrl,shift,esc" or "enter"). ALWAYS needs the user approval.',
    'hotkey',
    { keys: { type: 'string', description: 'Comma-separated keys, 1-4', required: true } },
    (p) => ({ keys: String(p.keys ?? '') })
  );
  desktopTool(
    'desktop-scroll',
    'Scroll the window under the mouse. dx/dy in pixels (dy>0 = down). ALWAYS needs the user approval.',
    'scroll',
    { dx: { type: 'number', description: 'horizontal' }, dy: { type: 'number', description: 'vertical' } },
    (p) => ({ dx: Number(p.dx ?? 0), dy: Number(p.dy ?? 0) })
  );

  // ---------- desktop: app / window / system (Roadmap #8) ----------

  desktopTool(
    'desktop-windows',
    'List the open windows with titles and positions (read-only).',
    'list_windows',
    {},
    () => ({})
  );
  desktopTool(
    'desktop-focus-window',
    'Bring a window to the front by (partial) title. ALWAYS needs the user approval.',
    'focus_window',
    { title: { type: 'string', description: 'Window title (contains-match)', required: true } },
    (p) => ({ title: String(p.title ?? '') })
  );
  desktopTool(
    'desktop-clipboard-get',
    'Read the clipboard text. APPROVAL required — the clipboard may contain secrets.',
    'clipboard_get',
    {},
    () => ({})
  );
  desktopTool(
    'desktop-clipboard-set',
    'Put text on the clipboard. ALWAYS needs the user approval.',
    'clipboard_set',
    { text: { type: 'string', description: 'Text to place', required: true } },
    (p) => ({ text: String(p.text ?? '') })
  );
  desktopTool(
    'desktop-open-app',
    'Open an app/file/URL with the OS default handler (like double-clicking it). ALWAYS needs the user approval.',
    'open_app',
    { target: { type: 'string', description: 'Path, app name or URL', required: true } },
    (p) => ({ target: String(p.target ?? '') })
  );
  desktopTool(
    'desktop-volume',
    'Change system volume via media keys (up/down/mute). ALWAYS needs the user approval.',
    'volume',
    { direction: { type: 'string', description: 'up|down|mute', required: true }, steps: { type: 'number', description: '1-10 presses (default 3)' } },
    (p) => ({ direction: String(p.direction ?? ''), steps: Number(p.steps ?? 3) })
  );
  desktopTool(
    'desktop-lock-screen',
    'Lock the laptop screen (Windows Win+L equivalent). ALWAYS needs the user approval.',
    'lock_screen',
    {},
    () => ({})
  );

  // ---------- Jarvis extras: windows / power / display / network / camera ----------
  // All of these (except the two read-only ones) go through the approval queue.

  desktopTool(
    'desktop-close-window',
    'Close an app window by (partial) title. Refuses when several windows match unless all=true. ALWAYS needs the user approval — warn about unsaved work.',
    'close_window',
    {
      title: { type: 'string', description: 'Window title (contains-match, 2+ chars)', required: true },
      all: { type: 'boolean', description: 'Close every matching window (default false)' },
    },
    (p) => ({ title: String(p.title ?? ''), ...(p.all === true ? { all: true } : {}) })
  );
  desktopTool(
    'desktop-window-state',
    'Minimize, maximize or restore a window by (partial) title. ALWAYS needs the user approval.',
    'window_state',
    {
      title: { type: 'string', description: 'Window title (contains-match)', required: true },
      state: { type: 'string', description: 'minimize|maximize|restore', required: true },
    },
    (p) => ({ title: String(p.title ?? ''), state: String(p.state ?? '') })
  );
  desktopTool(
    'desktop-brightness',
    'Set the built-in screen brightness 5-100 (Windows laptop panel). ALWAYS needs the user approval.',
    'brightness',
    { level: { type: 'number', description: '5-100', required: true } },
    (p) => ({ level: Number(p.level) })
  );
  desktopTool(
    'desktop-wifi-status',
    'Show the current WiFi connection (SSID, signal) — read-only.',
    'wifi_status',
    {},
    () => ({})
  );
  desktopTool(
    'desktop-wifi-set',
    'Turn the WiFi adapter on or off. Needs Administrator rights on the bridge. ALWAYS needs the user approval — turning it off can cut this very session.',
    'wifi_set',
    {
      action: { type: 'string', description: 'on|off', required: true },
      interface: { type: 'string', description: 'Adapter name (default "Wi-Fi")' },
    },
    (p) => ({ action: String(p.action ?? ''), ...(p.interface ? { interface: String(p.interface) } : {}) })
  );
  desktopTool(
    'desktop-power',
    'Shutdown / restart (with a 15-300 s countdown, default 30), sleep, hibernate, or cancel a pending shutdown. ALWAYS needs the user approval — remind the user to save their work first.',
    'power',
    {
      action: { type: 'string', description: 'shutdown|restart|sleep|hibernate|cancel', required: true },
      delay: { type: 'number', description: 'Countdown seconds for shutdown/restart (15-300)' },
    },
    (p) => ({ action: String(p.action ?? ''), ...(p.delay !== undefined ? { delay: Number(p.delay) } : {}) })
  );
  desktopTool(
    'desktop-webcam-photo',
    'Take ONE photo with the laptop webcam; saved to Pictures/AgentScope. PRIVACY-SENSITIVE: ALWAYS needs the user approval.',
    'webcam_capture',
    { camera: { type: 'number', description: 'Camera index (default 0)' } },
    (p) => ({ camera: Number(p.camera ?? 0) }),
    30_000
  );
  desktopTool(
    'desktop-screen-record',
    'Record the screen to an MP4 in Pictures/AgentScope (max 60 s, max 15 fps). The kill switch stops it. ALWAYS needs the user approval.',
    'screen_record',
    {
      seconds: { type: 'number', description: '1-60 (default 10)' },
      fps: { type: 'number', description: '2-15 (default 8)' },
      monitor: { type: 'number', description: 'Monitor index (default 1)' },
    },
    (p) => ({ seconds: Number(p.seconds ?? 10), fps: Number(p.fps ?? 8), monitor: Number(p.monitor ?? 1) }),
    120_000
  );
  desktopTool(
    'desktop-system-info',
    'CPU / RAM / disk / battery / brightness snapshot — read-only.',
    'system_info',
    {},
    () => ({})
  );
}

/** Direct (non-agent) bridge status for the UI — no tool registry involved. */
export function laptopBridgeStatus(): ReturnType<typeof bridgeStatus> {
  return bridgeStatus();
}

export { isReadOnlyEndpoint, markUntrusted, desktopCall };
