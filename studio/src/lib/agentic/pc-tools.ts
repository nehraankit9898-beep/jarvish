// pc-tools.ts — the everyday PC skills the audit found missing:
//
//   pc-diagnose    "PC slow kyun hai?" — real numbers + ranked findings
//   folder-create  create a folder inside the allowed roots (approval-gated)
//   music-control  play/pause/next/previous/stop/mute (media keys)
//   music-play     open a track/search on YouTube or Spotify
//   whatsapp-send  compose a WhatsApp message with the text pre-filled
//
// Permission model: the diagnosis is READ-ONLY ('safe'). Everything that
// changes the machine (a folder, an app, a message) becomes a host action, so
// it inherits the SAME approval queue, kill switch and audit trail as the rest
// of the laptop tools.

import type { ToolResult } from './tool-registry';
import { registerTool } from './tool-registry';
import { requestHostAction, type HostAction } from './host-control';
import { desktopCall, isValidEndpoint } from './desktop-bridge';
import { resolveInsideRoots } from './allowed-roots';
import { diagnosePc, summarizeDiagnosis } from './pc-health';
import { screenWatcher } from './screen-awareness';

let registered = false;

function now(): string {
  return new Date().toISOString();
}

function fromHost(out: Awaited<ReturnType<typeof requestHostAction>>, permission: ToolResult['permission']): ToolResult {
  if (out.status === 'done') {
    return { ok: out.result.ok, data: out.result.data, error: out.result.error, permission, at: now() };
  }
  if (out.status === 'approval_required') {
    return {
      ok: false,
      error: 'approval_required',
      reason: `Waiting for the user: ${out.summary}. Do not retry — continue only after the user approves.`,
      data: { approvalId: out.id, summary: out.summary, expiresAt: out.expiresAt },
      permission,
      at: now(),
    };
  }
  return { ok: false, error: 'refused', reason: out.reason, permission, at: now() };
}

// ---------------------------------------------------------------------------
// music
// ---------------------------------------------------------------------------

export type MediaCommand = 'playpause' | 'next' | 'previous' | 'stop' | 'mute';

const MEDIA_KEYS: Record<MediaCommand, string> = {
  playpause: 'playpause',
  next: 'nexttrack',
  previous: 'prevtrack',
  stop: 'stop',
  mute: 'volumemute',
};

export function isMediaCommand(value: string): value is MediaCommand {
  return Object.prototype.hasOwnProperty.call(MEDIA_KEYS, value);
}

/** The media key a command maps to (exported for the tests). */
export function mediaKeyFor(command: MediaCommand): string {
  return MEDIA_KEYS[command];
}

/**
 * Build the URL a `music-play` request should open.
 *  - an explicit https URL is opened as-is (after the usual checks),
 *  - `spotify` uses the app's own search URI (opens the desktop app),
 *  - anything else becomes a YouTube search (no key, no API quota).
 */
export function buildMusicTarget(opts: { query?: string; url?: string; service?: string }): {
  target: string;
  kind: 'url' | 'spotify' | 'youtube';
} {
  const service = (opts.service ?? 'youtube').toLowerCase();
  const query = String(opts.query ?? '').trim();
  const url = String(opts.url ?? '').trim();

  if (url) {
    if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
    return { target: url, kind: 'url' };
  }
  if (!query) throw new Error('query (song / artist / video name) is required');
  if (service === 'spotify') {
    return { target: `spotify:search:${encodeURIComponent(query)}`, kind: 'spotify' };
  }
  return { target: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, kind: 'youtube' };
}

// ---------------------------------------------------------------------------
// whatsapp
// ---------------------------------------------------------------------------

/** Normalise a phone number the way wa.me expects (digits only, 8-15 long). */
export function normalizeWhatsappNumber(raw: string): string {
  const digits = String(raw ?? '').replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('A phone number with country code is required (8-15 digits, e.g. 919876543210)');
  }
  return digits;
}

/**
 * Build the WhatsApp deep link. `whatsapp://` opens the DESKTOP app with the
 * message already typed; the user still presses Send — an agent must never be
 * able to send a message silently.
 */
export function buildWhatsappTarget(rawNumber: string, text: string): string {
  const phone = normalizeWhatsappNumber(rawNumber);
  const message = String(text ?? '').trim();
  if (!message) throw new Error('Message text is required');
  if (message.length > 2000) throw new Error('Message is too long (max 2000 characters)');
  return `whatsapp://send?phone=${phone}&text=${encodeURIComponent(message)}`;
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

function hostToolDef(
  name: string,
  description: string,
  parameters: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }>,
  timeoutMs = 30_000
) {
  return {
    name,
    description,
    category: 'host' as const,
    parameters: Object.fromEntries(
      Object.entries(parameters).map(([k, v]) => [k, { ...v, required: v.required ?? false }])
    ),
    required: Object.entries(parameters)
      .filter(([, v]) => v.required)
      .map(([k]) => k),
    permission: 'review' as const,
    timeoutMs,
  };
}

/** Register the PC-skill tools once (idempotent). */
export function registerPcTools(): void {
  if (registered) return;
  registered = true;

  // ---- diagnosis (read-only) -------------------------------------------
  registerTool(
    {
      name: 'pc-diagnose',
      description:
        'Diagnose why the computer feels slow: real CPU / RAM / disk numbers plus ranked, actionable findings ' +
        '("PC slow kyun hai?"). Read-only — changes nothing.',
      category: 'host',
      parameters: {},
      required: [],
      permission: 'safe',
      timeoutMs: 30_000,
    },
    async (): Promise<ToolResult> => {
      try {
        const diagnosis = await diagnosePc();
        return {
          ok: true,
          data: {
            score: diagnosis.score,
            verdict: diagnosis.verdict,
            summary: summarizeDiagnosis(diagnosis),
            findings: diagnosis.findings,
            snapshot: {
              platform: diagnosis.snapshot.platform,
              cpu: diagnosis.snapshot.cpu,
              memory: diagnosis.snapshot.memory,
              disks: diagnosis.snapshot.disks,
              processes: diagnosis.snapshot.processes.slice(0, 5),
              uptimeHours: Math.round(diagnosis.snapshot.uptimeHours),
            },
          },
          permission: 'safe',
          at: now(),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Diagnosis failed', permission: 'safe', at: now() };
      }
    }
  );

  // ---- folder-create ---------------------------------------------------
  registerTool(
    hostToolDef(
      'folder-create',
      'Create a folder (inside an allowed root such as Desktop/Documents/Downloads). Needs your approval.',
      { path: { type: 'string', description: 'Folder path, ~ allowed (e.g. "~/Documents/Invoices/2026")', required: true } }
    ),
    async ({ parameters }) => {
      const raw = String(parameters.path ?? '').trim();
      if (!raw) return { ok: false, error: 'path is required', permission: 'review', at: now() };
      const resolved = resolveInsideRoots(raw);
      if (!resolved.ok) return { ok: false, error: resolved.error ?? 'Path is not allowed', permission: 'review', at: now() };
      return fromHost(await requestHostAction({ kind: 'mkdir', path: resolved.path }, 'agent'), 'review');
    }
  );

  // ---- media keys ------------------------------------------------------
  registerTool(
    hostToolDef(
      'music-control',
      'Control the currently playing music/video with the system media keys: playpause, next, previous, stop, mute. ' +
      'Needs your approval while the desktop bridge is in ask mode.',
      {
        command: {
          type: 'string',
          description: 'playpause | next | previous | stop | mute',
          required: true,
        },
      }
    ),
    async ({ parameters }) => {
      const command = String(parameters.command ?? '').trim().toLowerCase();
      if (!isMediaCommand(command)) {
        return {
          ok: false,
          error: 'command must be one of: playpause, next, previous, stop, mute',
          permission: 'review',
          at: now(),
        };
      }
      if (!isValidEndpoint('hotkey')) {
        return { ok: false, error: 'The desktop bridge does not expose hotkeys', permission: 'review', at: now() };
      }
      const out = await requestHostAction(
        { kind: 'desktop', endpoint: 'hotkey', payload: { keys: mediaKeyFor(command) } },
        'agent'
      );
      return fromHost(out, 'review');
    }
  );

  // ---- music-play ------------------------------------------------------
  registerTool(
    hostToolDef(
      'music-play',
      'Open a song / video: searches YouTube, or opens Spotify, or opens a direct URL. Playback starts in the ' +
      'opened app — then use music-control to pause/skip. Needs approval.',
      {
        query: { type: 'string', description: 'Song, artist or video name' },
        service: { type: 'string', description: 'youtube (default) | spotify' },
        url: { type: 'string', description: 'A direct https URL instead of a search' },
      }
    ),
    async ({ parameters }) => {
      let built;
      try {
        built = buildMusicTarget({
          query: String(parameters.query ?? ''),
          url: String(parameters.url ?? ''),
          service: String(parameters.service ?? 'youtube'),
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Invalid request', permission: 'review', at: now() };
      }
      const out = await requestHostAction({ kind: 'open', target: built.target }, 'agent');
      const result = fromHost(out, 'review');
      if (result.ok) {
        result.data = {
          ...(result.data as object),
          target: built.target,
          kind: built.kind,
          note:
            built.kind === 'youtube'
              ? 'Search results opened in the browser — the first result must be clicked (JARVIS can do it with browser tools).'
              : built.kind === 'spotify'
                ? 'Spotify search opened in the desktop app — pick the track and it plays.'
                : 'Opened the URL — the player starts automatically.',
        };
      }
      return result;
    }
  );

  // ---- whatsapp --------------------------------------------------------
  registerTool(
    hostToolDef(
      'whatsapp-send',
      'Compose a WhatsApp message (text pre-filled) to a number via the WhatsApp DESKTOP app. ' +
        'The user still presses Send — the agent cannot deliver it silently. Needs approval.',
      {
        to: { type: 'string', description: 'Phone with country code, e.g. 919876543210', required: true },
        text: { type: 'string', description: 'Message text', required: true },
      },
      30_000
    ),
    async ({ parameters }) => {
      let target: string;
      try {
        target = buildWhatsappTarget(String(parameters.to ?? ''), String(parameters.text ?? ''));
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Invalid message', permission: 'review', at: now() };
      }
      const out = await requestHostAction({ kind: 'open', target }, 'agent');
      const result = fromHost(out, 'review');
      if (result.ok) {
        result.data = {
          ...(result.data as object),
          note: 'WhatsApp opened with the message filled in. Press Send in the app — nothing was sent automatically.',
        };
      } else if (!result.ok && result.error && /open|no such|not found/i.test(result.error)) {
        result.error =
          'WhatsApp Desktop does not look installed. Install WhatsApp Desktop (or use https://web.whatsapp.com) and try again.';
      }
      return result;
    }
  );

  // ---- screen awareness (continuous, opt-in) ---------------------------
  registerTool(
    hostToolDef(
      'screen-watch',
      'Continuously watch the screen and report when it CHANGES (start/stop/status). ' +
        'Read-only: it never clicks or types, it never stores screenshots, and it pauses on ' +
        'bank/password windows. Use it when the user asks "screen par kya ho raha hai".',
      {
        action: { type: 'string', description: 'start | stop | status', required: true },
      },
      20_000
    ),
    async ({ parameters }) => {
      const action = String(parameters.action ?? '').trim().toLowerCase();
      const watcher = screenWatcher();
      if (action === 'start') {
        return { ok: true, data: watcher.start(), permission: 'review', at: now() };
      }
      if (action === 'stop') {
        return { ok: true, data: watcher.stop(), permission: 'review', at: now() };
      }
      if (action === 'status') {
        return { ok: true, data: watcher.status(), permission: 'review', at: now() };
      }
      return { ok: false, error: "action must be 'start', 'stop' or 'status'", permission: 'review', at: now() };
    }
  );

  // keep the import used even when the bridge is unavailable
  void desktopCall;
}

/** Exported for tests: the host action a folder creation produces. */
export function folderCreateAction(path: string): HostAction {
  return { kind: 'mkdir', path };
}
