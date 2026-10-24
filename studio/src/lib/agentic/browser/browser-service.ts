// browser-service.ts — the built-in agent browser (Features 11 + 12 + 13).
//
// One Playwright Chromium instance per server, one ISOLATED browser context
// per session (separate cookies/storage — sessions never share state).
// Every agent navigation passes the SAME SSRF guard the provider
// connections use, so the browser cannot reach private/metadata addresses.
//
// TAKEOVER (Feature 12): the user can grab the wheel at any moment. While a
// session is on user hold, EVERY agent action is refused at this layer (not
// just in the UI) — the agent can only re-inspect the page after the user
// releases control.
//
// PAYMENT GUARD (Features 14 + 15): clicking a submit on a page whose intel
// says "payment" requires `confirm: true`, and the confirm flag is ONLY
// accepted from the user-facing API — the agent tool layer never sets it.

import path from 'node:path';
import fs from 'node:fs/promises';
import { db } from '@/lib/db';
import { assertOutboundUrl, OutboundUrlError } from '../outbound';
import { recordAudit } from '../audit';
import { createNotification } from '../notifications';
import { downloadsDir, sanitizeFilename } from '../downloads';
import { PAGE_INTEL_SCRIPT, boundIntel, paymentGuardDecision, type PageIntel } from './page-intel';

export const BROWSER_ROOT = path.join(process.cwd(), '.agentic-workspace', 'browser');

/**
 * Loopback browsing (http://localhost:… / 127.0.0.1:…) is OFF by default —
 * the SSRF guard treats loopback like any other private address. A Studio
 * running on the user's own laptop often needs to open the user's LOCAL dev
 * servers, so this is an explicit opt-in via AGENTSCOPE_BROWSER_ALLOW_LOOPBACK=1.
 */
export function loopbackAllowed(): boolean {
  return process.env.AGENTSCOPE_BROWSER_ALLOW_LOOPBACK === '1';
}

export class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

interface LiveSession {
  /** the playwright BrowserContext (isolated: own cookies + storage) */
  context: {
    newPage: () => Promise<unknown>;
    close: () => Promise<void>;
  };
  /** true when this session rides the user's REAL Chrome over CDP */
  cdp?: boolean;
  page: Record<string, unknown> & {
    goto: (url: string, opts?: unknown) => Promise<unknown>;
    title: () => Promise<string>;
    screenshot: (opts: unknown) => Promise<Buffer>;
    evaluate: <T>(fn: unknown) => Promise<T>;
    click: (selector: string, opts?: unknown) => Promise<void>;
    fill: (selector: string, value: string, opts?: unknown) => Promise<void>;
    waitForTimeout: (ms: number) => Promise<void>;
    url: () => string;
    on?: (event: string, handler: (payload: unknown) => void) => void;
  };
}

/** playwright types are loaded lazily so the studio works without browsers installed */
type PlaywrightBrowser = {
  close: () => Promise<void>;
  newContext: (opts?: unknown) => Promise<LiveSession['context']>;
  contexts?: () => unknown[];
};
type PlaywrightChromium = PlaywrightModule['chromium'] & {
  connectOverCDP?: (endpoint: string, opts?: unknown) => Promise<PlaywrightBrowser>;
};
type PlaywrightModule = { chromium: { launch: (opts: unknown) => Promise<PlaywrightBrowser> } };

let browserInstance: PlaywrightBrowser | null = null;
let browserStarting: Promise<PlaywrightBrowser> | null = null;
const sessions = new Map<string, LiveSession>();

async function getBrowser(): Promise<PlaywrightBrowser> {
  if (browserInstance) return browserInstance;
  if (browserStarting) return browserStarting;
  browserStarting = (async () => {
    let pw: { chromium: { launch: (opts: unknown) => Promise<PlaywrightBrowser> } };
    try {
      pw = (await import('playwright')) as unknown as typeof pw;
    } catch {
      throw new BrowserError(
        'Playwright is not installed. Run: bun add playwright && bunx playwright install chromium'
      );
    }
    const browser = await pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    browserInstance = browser;
    return browser;
  })();
  try {
    return await browserStarting;
  } finally {
    browserStarting = null;
  }
}

// ---------- session lifecycle ----------

export async function createSession(
  taskId = ''
): Promise<{ id: string; status: string }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    // an isolated context per session — no shared cookies/storage
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  const page = (await context.newPage()) as LiveSession['page'];
  attachDownloadHandler(page, taskId);
  const row = await db.browserSession.create({
    data: { taskId, status: 'idle' },
  });
  sessions.set(row.id, { context, page } as LiveSession);
  await recordAudit({
    actor: 'user',
    action: 'browser.session_create',
    category: 'tool',
    approval: 'auto',
    details: { sessionId: row.id, taskId },
  });
  return { id: row.id, status: row.status };
}

export async function listSessions(): Promise<
  Array<{
    id: string;
    taskId: string;
    status: string;
    currentUrl: string;
    pageTitle: string;
    userHold: boolean;
    hasScreenshot: boolean;
    updatedAt: string;
  }>
> {
  const rows = await db.browserSession.findMany({
    where: { status: { not: 'closed' } },
    orderBy: { updatedAt: 'desc' },
    take: 30,
  });
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    status: r.status,
    currentUrl: r.currentUrl,
    pageTitle: r.pageTitle,
    userHold: r.userHold,
    hasScreenshot: Boolean(r.lastScreenshot),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

function requireSession(sessionId: string): LiveSession {
  const live = sessions.get(sessionId);
  if (!live) throw new BrowserError('Session not found (it may have been closed or the server restarted)');
  return live;
}

async function requireOpenSession(sessionId: string): Promise<LiveSession> {
  const row = await db.browserSession.findUnique({ where: { id: sessionId } });
  if (!row || row.status === 'closed') throw new BrowserError('Session is closed');
  return requireSession(sessionId);
}

async function persistIntel(sessionId: string, intel: PageIntel) {
  await db.browserSession
    .update({
      where: { id: sessionId },
      data: {
        currentUrl: intel.url,
        pageTitle: intel.title,
        pageIntel: JSON.stringify(intel),
      },
    })
    .catch(() => undefined);
}

async function extractIntel(sessionId: string): Promise<PageIntel> {
  const live = requireSession(sessionId);
  // NOTE: PAGE_INTEL_SCRIPT is a string of the form "() => { ... }".
  // Playwright does NOT call a string arrow function — it evaluates it as an
  // expression, which yields the function object (serialized as undefined).
  // Wrapping it as an IIFE expression "(() => { ... })()" makes evaluate run
  // it and return the actual intel object.
  const raw = await live.page.evaluate(`(${PAGE_INTEL_SCRIPT})()`);
  const intel = boundIntel(raw);
  await persistIntel(sessionId, intel);
  return intel;
}

// ---------- REAL Chrome over CDP (Roadmap #5) ----------

/**
 * Connect to the user's RUNNING Chrome that was started with
 *   chrome.exe --remote-debugging-port=9222
 * Tabs of that Chrome keep the user's real logins — that is the whole
 * point, and also why every action here stays behind the same takeover /
 * payment-guard rules as the isolated sessions. Loopback ONLY: the debug
 * endpoint must never be reached over the network.
 */
export const REAL_CHROME_CDP_PORT_DEFAULT = 9222;

export function realChromeHint(): { endpoint: string; commands: Record<string, string> } {
  const endpoint = `http://127.0.0.1:${REAL_CHROME_CDP_PORT_DEFAULT}`;
  return {
    endpoint,
    commands: {
      windows: 'chrome.exe --remote-debugging-port=9222',
      macOS: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222',
      linux: 'google-chrome --remote-debugging-port=9222',
    },
  };
}

export async function connectRealChrome(opts: {
  taskId?: string;
  endpoint?: string;
  actor?: string;
} = {}): Promise<{ id: string; status: string; endpoint: string }> {
  const endpoint = (opts.endpoint ?? `http://127.0.0.1:${REAL_CHROME_CDP_PORT_DEFAULT}`).trim();
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new BrowserError(`Invalid CDP endpoint: ${endpoint}`);
  }
  // the debug port is a FULL CONTROL channel — never allow a non-loopback host
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) {
    throw new BrowserError('CDP endpoint must be a loopback http:// address (127.0.0.1 / localhost)');
  }

  let pw: PlaywrightModule & { chromium: PlaywrightChromium };
  try {
    pw = (await import('playwright')) as unknown as typeof pw;
  } catch {
    throw new BrowserError('Playwright is not installed. Run: bun add playwright && bunx playwright install chromium');
  }
  if (typeof pw.chromium.connectOverCDP !== 'function') {
    throw new BrowserError('This Playwright build cannot connectOverCDP — update playwright');
  }

  let browser: PlaywrightBrowser;
  try {
    browser = await pw.chromium.connectOverCDP(parsed.toString(), { timeout: 8_000 });
  } catch {
    const hint = realChromeHint();
    throw new BrowserError(
      `Chrome is not reachable on ${parsed.toString()} — start it with the debug port first. ` +
        `Windows: ${hint.commands.windows}`
    );
  }

  // the default context of the real browser = the user's real profile
  const contexts = (browser.contexts?.() ?? []) as LiveSession['context'][];
  const context = contexts[0] ?? (await browser.newContext());
  const page = (await context.newPage()) as LiveSession['page'];
  attachDownloadHandler(page, opts.taskId ?? '');
  const row = await db.browserSession.create({
    data: { taskId: opts.taskId ?? '', status: 'idle' },
  });
  sessions.set(row.id, { context, page, cdp: true } as LiveSession);
  cdpBrowsers.set(row.id, browser);

  await recordAudit({
    actor: opts.actor ?? 'user',
    action: 'browser.cdp_connect',
    category: 'security',
    approval: 'auto',
    details: { sessionId: row.id, endpoint: parsed.toString() },
  });
  await createNotification({
    type: 'browser',
    title: 'Real Chrome connected',
    body: 'AgentScope ab aapke running Chrome ke tabs use kar sakta hai (session ' + row.id.slice(0, 8) + ').',
    taskId: opts.taskId ?? '',
    data: { sessionId: row.id, cdp: true },
  });
  return { id: row.id, status: row.status, endpoint: parsed.toString() };
}

const cdpBrowsers = new Map<string, PlaywrightBrowser>();

/**
 * Playwright `download` event: save every browser download into the user's
 * Downloads folder (Roadmap #3) and notify. Never throws — a failed save
 * must not break the browsing session.
 */
function attachDownloadHandler(page: LiveSession['page'], taskId: string): void {
  if (typeof page.on !== 'function') return;
  try {
    page.on('download', (payload: unknown) => {
      const dl = payload as {
        suggestedFilename?: () => string;
        saveAs?: (p: string) => Promise<void>;
      };
      if (!dl || typeof dl.saveAs !== 'function') return;
      const name = sanitizeFilename(
        typeof dl.suggestedFilename === 'function' ? dl.suggestedFilename() : `download-${Date.now()}.bin`
      );
      const dir = downloadsDir();
      void (async () => {
        await fs.mkdir(dir, { recursive: true });
        let final = path.join(dir, name);
        const ext = path.extname(name);
        const base = path.basename(name, ext);
        let i = 2;
        while (await fs.access(final).then(() => true).catch(() => false)) {
          final = path.join(dir, `${base} (${i})${ext}`);
          i++;
        }
        await dl.saveAs!(final);
        await createNotification({
          type: 'download',
          title: `Browser download saved: ${path.basename(final)}`,
          body: final,
          taskId,
          data: { path: final, source: 'browser' },
        });
        await recordAudit({
          actor: 'browser',
          action: 'downloads.browser_saved',
          category: 'tool',
          taskId,
          approval: 'auto',
          details: { path: final },
        });
      })().catch(() => undefined);
    });
  } catch {
    /* older Playwright builds — downloads simply are not captured */
  }
}

// ---------- navigation ----------

export async function navigate(
  sessionId: string,
  url: string,
  opts: { actor: 'agent' | 'user' } = { actor: 'user' }
): Promise<PageIntel> {
  const live = await requireOpenSession(sessionId);
  if (opts.actor === 'agent') await assertAgentMayAct(sessionId);
  const target = String(url ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new BrowserError(`Invalid URL: ${target}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new BrowserError('Only http(s) URLs are allowed');
  }
  // the browser obeys the SAME SSRF policy as the provider connections
  // (loopback only with the explicit opt-in — see loopbackAllowed()).
  // H16: `requireHttps` is dropped here on purpose. It exists so an LLM
  // provider base URL cannot be dialed over cleartext; a WEB BROWSER is
  // different — refusing http:// made the tool reject plain-http links it had
  // just advertised as allowed ("Only http(s) URLs are allowed"), including
  // local dev sites that are not on loopback. Every address rule still
  // applies: private, link-local and metadata targets stay blocked.
  await assertOutboundUrl(parsed.toString(), {
    allowLoopback: loopbackAllowed(),
    requireHttps: false,
  });
  await db.browserSession.update({ where: { id: sessionId }, data: { status: 'navigating' } });
  try {
    await live.page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Navigation failed';
    await db.browserSession.update({ where: { id: sessionId }, data: { status: 'idle' } });
    throw new BrowserError(`Navigation failed: ${message}`);
  }
  await db.browserSession.update({ where: { id: sessionId }, data: { status: 'idle' } });
  await recordAudit({
    actor: opts.actor === 'agent' ? 'agent:coder' : 'user',
    action: 'browser.navigate',
    category: 'tool',
    approval: 'auto',
    details: { sessionId, url: parsed.toString() },
  });
  return extractIntel(sessionId);
}

// ---------- screenshots ----------

export async function screenshot(sessionId: string): Promise<{ path: string; base64: string }> {
  const live = requireSession(sessionId);
  const buffer = await live.page.screenshot({ type: 'png', fullPage: false });
  const dir = path.join(BROWSER_ROOT, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'latest.png');
  await fs.writeFile(file, buffer);
  const rel = path.relative(process.cwd(), file);
  await db.browserSession
    .update({ where: { id: sessionId }, data: { lastScreenshot: rel } })
    .catch(() => undefined);
  return { path: rel, base64: buffer.toString('base64') };
}

export async function readScreenshot(sessionId: string): Promise<string | null> {
  const row = await db.browserSession.findUnique({ where: { id: sessionId } });
  if (!row?.lastScreenshot) return null;
  try {
    const abs = path.join(process.cwd(), row.lastScreenshot);
    const rel = path.relative(process.cwd(), abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // traversal guard
    return (await fs.readFile(abs)).toString('base64');
  } catch {
    return null;
  }
}

// ---------- interaction ----------

function selectorFor(target: string): string {
  // a "text=..." target clicks by visible text; anything else must be a
  // plain CSS selector (no JS evaluation surface)
  return target.trim();
}

export async function click(
  sessionId: string,
  target: string,
  opts: {
    actor: 'agent' | 'user';
    /** USER-ONLY: confirmation for a payment submit (the agent tool layer
     *  never passes this — see registerBrowserTools) */
    confirmPayment?: boolean;
  }
): Promise<{ clicked: boolean; intel: PageIntel; paymentBlocked?: boolean; reason?: string }> {
  const live = await requireOpenSession(sessionId);
  if (opts.actor === 'agent') await assertAgentMayAct(sessionId);

  // payment guard runs BEFORE the click for agent AND user without confirm
  const intel = await extractIntel(sessionId);
  const guard = paymentGuardDecision(intel);
  const targetLooksLikePay = /pay|purchase|buy|place.?order|subscribe|checkout/i.test(target);
  // C4: the commit button on a payment page is usually clicked through a
  // STRUCTURALLY neutral selector ("button[type=submit]", "form button",
  // "input[type=submit]", "[role=button]") — the guard must not depend on the
  // word "pay" appearing in the selector text. When the page intel says this
  // is a payment surface, ANY submit-like click is treated as a payment commit
  // and requires the user's explicit confirm flag (the agent tool layer can
  // never set it).
  const SUBMIT_TARGET_RE =
    /button|\[\s*type\s*=\s*["']?submit|input\s*\[\s*type\s*=\s*["']?submit|\[\s*role\s*=\s*["']?button/i;
  const commitLike = targetLooksLikePay || SUBMIT_TARGET_RE.test(target);
  if (guard.requiresConfirmation && commitLike && !opts.confirmPayment) {
    await recordAudit({
      actor: opts.actor === 'agent' ? 'agent:coder' : 'user',
      action: 'browser.payment_blocked',
      category: 'security',
      approval: 'auto',
      details: { sessionId, target: target.slice(0, 200), reason: guard.reason },
    });
    return { clicked: false, intel, paymentBlocked: true, reason: guard.reason };
  }

  try {
    await live.page.click(selectorFor(target), { timeout: 15_000 });
  } catch (err) {
    throw new BrowserError(`Click failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  await live.page.waitForTimeout(600); // let the page settle
  const after = await extractIntel(sessionId);
  await recordAudit({
    actor: opts.actor === 'agent' ? 'agent:coder' : 'user',
    action: 'browser.click',
    category: 'tool',
    approval: opts.confirmPayment ? 'approved' : 'auto',
    details: { sessionId, target: target.slice(0, 200) },
  });
  return { clicked: true, intel: after };
}

export async function fillForm(
  sessionId: string,
  fields: Array<{ selector: string; value: string }>,
  opts: { actor: 'agent' | 'user' } = { actor: 'user' }
): Promise<{ filled: string[]; refused: string[]; intel: PageIntel }> {
  const live = await requireOpenSession(sessionId);
  if (opts.actor === 'agent') await assertAgentMayAct(sessionId);

  const intel = await extractIntel(sessionId);
  // Sensitive fields are matched PER FIELD (selector ↔ intel field tokens):
  // the previous check tested the selector against the joined list of ALL
  // sensitive fields, which (a) refused every fill on any page that contained
  // a password field somewhere and (b) let a card field whose name did not hit
  // the keyword regex (e.g. autocomplete="cc-number") slip through.
  const SENSITIVE_KIND_RE =
    /card|cc-?num|cvc|cvv|csc|cid|\bpan\b|expir|exp[-_ ]?(date|month|year)|password|passphrase|\bpin\b|\botp\b|secret|ssn|security.?code/i;
  const sensitiveTokens = intel.forms
    .flatMap((f) => f.fields.filter((fl) => fl.sensitive))
    .flatMap((fl) => [fl.name, fl.autocomplete ?? '', ...fl.label.split(/\s+/)])
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3);
  const selectorHitsSensitive = (sel: string): boolean => {
    if (SENSITIVE_KIND_RE.test(sel)) return true;
    const selTokens = sel
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((t) => t.length >= 3);
    return selTokens.some((st) =>
      sensitiveTokens.some((t) => t.includes(st) || st.includes(t))
    );
  };

  const filled: string[] = [];
  const refused: string[] = [];
  for (const field of fields.slice(0, 30)) {
    const sel = String(field.selector ?? '').slice(0, 300);
    const value = String(field.value ?? '').slice(0, 5000);
    if (opts.actor === 'agent' && selectorHitsSensitive(sel)) {
      refused.push(sel);
      continue;
    }
    try {
      await live.page.fill(selectorFor(sel), value, { timeout: 10_000 });
      filled.push(sel);
    } catch {
      refused.push(sel);
    }
  }
  const after = await extractIntel(sessionId);
  await recordAudit({
    actor: opts.actor === 'agent' ? 'agent:coder' : 'user',
    action: 'browser.fill',
    category: 'tool',
    approval: 'auto',
    details: {
      sessionId,
      filled: filled.length,
      refused: refused.length,
      // never log values
    },
  });
  return { filled, refused, intel: after };
}

// ---------- takeover (Feature 12) ----------

async function assertAgentMayAct(sessionId: string): Promise<void> {
  const row = await db.browserSession.findUnique({ where: { id: sessionId } });
  if (row?.userHold) {
    throw new BrowserError(
      'User has taken over this browser session — agent actions are paused. ' +
        'The agent may act again after the user releases control (Resume Agent).'
    );
  }
}

/**
 * User takes control: the agent is locked out at THIS layer (not just in the
 * UI) until `releaseControl` is called.
 */
export async function takeControl(sessionId: string): Promise<{ ok: boolean }> {
  const row = await db.browserSession.findUnique({ where: { id: sessionId } });
  if (!row || row.status === 'closed') throw new BrowserError('Session not found or closed');
  await db.browserSession.update({
    where: { id: sessionId },
    data: { userHold: true, status: 'paused' },
  });
  await recordAudit({
    actor: 'user',
    action: 'browser.takeover',
    category: 'security',
    approval: 'auto',
    details: { sessionId, url: row.currentUrl },
  });
  await createNotification({
    type: 'browser',
    title: 'Browser takeover active',
    body: 'Agent actions are paused for this session. Resume Agent control when you are done.',
    taskId: row.taskId,
    data: { sessionId },
  });
  return { ok: true };
}

/**
 * User releases control (Resume Agent): the hold clears and the CURRENT page
 * is re-inspected so the agent can continue from the new state — exactly the
 * resume flow of Feature 12.
 */
export async function releaseControl(sessionId: string): Promise<{ ok: boolean; intel: PageIntel | null }> {
  const row = await db.browserSession.findUnique({ where: { id: sessionId } });
  if (!row) throw new BrowserError('Session not found');
  await db.browserSession.update({
    where: { id: sessionId },
    data: { userHold: false, status: 'idle' },
  });
  await recordAudit({
    actor: 'user',
    action: 'browser.release',
    category: 'security',
    approval: 'auto',
    details: { sessionId },
  });
  let intel: PageIntel | null = null;
  if (sessions.has(sessionId)) {
    try {
      intel = await extractIntel(sessionId);
    } catch {
      intel = null;
    }
  }
  return { ok: true, intel };
}

// ---------- close ----------

export async function closeSession(sessionId: string): Promise<{ ok: boolean }> {
  const live = sessions.get(sessionId);
  if (live) {
    await live.context.close().catch(() => undefined);
    sessions.delete(sessionId);
  }
  // a CDP session only DETACHES from the real Chrome — the user's browser
  // must never be killed by the Studio
  const cdp = cdpBrowsers.get(sessionId);
  if (cdp) {
    await cdp.close().catch(() => undefined);
    cdpBrowsers.delete(sessionId);
  }
  await db.browserSession
    .update({ where: { id: sessionId }, data: { status: 'closed', userHold: false } })
    .catch(() => undefined);
  await recordAudit({
    actor: 'user',
    action: 'browser.close',
    category: 'tool',
    approval: 'auto',
    details: { sessionId },
  });
  return { ok: true };
}

/** Close every live session (graceful shutdown / tests). */
export async function closeAllSessions(): Promise<void> {
  for (const id of Array.from(sessions.keys())) {
    await closeSession(id).catch(() => undefined);
  }
  if (browserInstance) {
    await browserInstance.close().catch(() => undefined);
    browserInstance = null;
  }
}

export async function getSessionIntel(sessionId: string): Promise<PageIntel | null> {
  const row = await db.browserSession.findUnique({ where: { id: sessionId } });
  if (!row) return null;
  try {
    return boundIntel(JSON.parse(row.pageIntel || '{}'));
  } catch {
    return null;
  }
}

/** Re-analyse the CURRENT page without navigating (agent tool entry point). */
export async function readPage(sessionId: string): Promise<PageIntel> {
  await requireOpenSession(sessionId);
  return extractIntel(sessionId);
}

export { OutboundUrlError };
