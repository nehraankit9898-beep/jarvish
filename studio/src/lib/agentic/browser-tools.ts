// browser-tools.ts — the agent-facing browser TOOLS (Features 11 + 13).
//
// These register into the normal tool registry, so the SAME permission
// system, timeouts and audit apply as for every other tool. The agent
// versions always act as `actor: 'agent'`, which means:
//   - a user takeover refuses the action (browser-service enforces it);
//   - sensitive fields (card/CVV/password/OTP) are never filled;
//   - `confirmPayment` is structurally impossible — the payment guard can
//     only be satisfied through the user-facing API route.

import type { ToolResult } from './tool-registry';
import { registerTool } from './tool-registry';

let registered = false;

/** Register the browser tools once (idempotent). */
export function registerBrowserTools(): void {
  if (registered) return;
  registered = true;

  registerTool(
    {
      name: 'browser-session',
      description:
        'Open a fresh ISOLATED browser session (own cookies/storage). Returns the session id used by the other browser tools.',
      category: 'custom',
      parameters: {
        taskId: { type: 'string', description: 'optional task id to link the session to', required: false },
      },
      required: [],
      permission: 'safe',
      timeoutMs: 30_000,
    },
    async (invocation): Promise<ToolResult> => {
      const { createSession } = await import('./browser/browser-service');
      const session = await createSession(String(invocation.parameters.taskId ?? ''));
      return { ok: true, data: session, at: new Date().toISOString() };
    }
  );

  registerTool(
    {
      name: 'browser-navigate',
      description:
        'Navigate the session to an http(s) URL and return the page intel (forms, checkout/payment signals, headings).',
      category: 'custom',
      parameters: {
        sessionId: { type: 'string', description: 'session id from browser-session', required: true },
        url: { type: 'string', description: 'the http(s) URL to open', required: true },
      },
      required: ['sessionId', 'url'],
      permission: 'review',
      timeoutMs: 60_000,
    },
    async (invocation): Promise<ToolResult> => {
      const { navigate } = await import('./browser/browser-service');
      const intel = await navigate(
        String(invocation.parameters.sessionId ?? ''),
        String(invocation.parameters.url ?? ''),
        { actor: 'agent' }
      );
      return { ok: true, data: JSON.stringify(intel), at: new Date().toISOString() };
    }
  );

  registerTool(
    {
      name: 'browser-read-page',
      description:
        'Re-analyse the CURRENT page (no navigation): forms with their fields, checkout totals/items, payment signals, human-verification notices.',
      category: 'custom',
      parameters: {
        sessionId: { type: 'string', description: 'session id', required: true },
      },
      required: ['sessionId'],
      permission: 'safe',
      timeoutMs: 30_000,
    },
    async (invocation): Promise<ToolResult> => {
      const { readPage } = await import('./browser/browser-service');
      const intel = await readPage(String(invocation.parameters.sessionId ?? ''));
      return { ok: true, data: JSON.stringify(intel), at: new Date().toISOString() };
    }
  );

  registerTool(
    {
      name: 'browser-screenshot',
      description: 'Take a screenshot of the current page. Returns the file path (the UI shows it live).',
      category: 'custom',
      parameters: {
        sessionId: { type: 'string', description: 'session id', required: true },
      },
      required: ['sessionId'],
      permission: 'safe',
      timeoutMs: 30_000,
    },
    async (invocation): Promise<ToolResult> => {
      const { screenshot } = await import('./browser/browser-service');
      const shot = await screenshot(String(invocation.parameters.sessionId ?? ''));
      return { ok: true, data: shot.path, at: new Date().toISOString() };
    }
  );

  registerTool(
    {
      name: 'browser-click',
      description:
        'Click an element (CSS selector or text=...). PAY/ORDER/SUBSCRIBE buttons are BLOCKED for the agent — the user must confirm them in the UI (payment guard).',
      category: 'custom',
      parameters: {
        sessionId: { type: 'string', description: 'session id', required: true },
        target: { type: 'string', description: 'CSS selector (e.g. button.checkout) or text=Sign in', required: true },
      },
      required: ['sessionId', 'target'],
      permission: 'review',
      timeoutMs: 45_000,
    },
    async (invocation): Promise<ToolResult> => {
      const { click } = await import('./browser/browser-service');
      const result = await click(
        String(invocation.parameters.sessionId ?? ''),
        String(invocation.parameters.target ?? ''),
        { actor: 'agent' } // confirmPayment is NEVER set here
      );
      return {
        ok: result.clicked,
        data: JSON.stringify(result.intel),
        error: result.paymentBlocked ? result.reason : undefined,
        at: new Date().toISOString(),
      };
    }
  );

  registerTool(
    {
      name: 'browser-fill',
      description:
        'Fill form fields (selector+value pairs). SENSITIVE fields (card/CVV/password/OTP) are refused — the agent never types credentials.',
      category: 'custom',
      parameters: {
        sessionId: { type: 'string', description: 'session id', required: true },
        fields: { type: 'array', description: '[{selector, value}] pairs to fill', required: true },
      },
      required: ['sessionId', 'fields'],
      permission: 'review',
      timeoutMs: 60_000,
    },
    async (invocation): Promise<ToolResult> => {
      const { fillForm } = await import('./browser/browser-service');
      const fields = Array.isArray(invocation.parameters.fields)
        ? (invocation.parameters.fields as Array<{ selector?: string; value?: string }>)
        : [];
      const result = await fillForm(
        String(invocation.parameters.sessionId ?? ''),
        fields.map((f) => ({ selector: String(f.selector ?? ''), value: String(f.value ?? '') })),
        { actor: 'agent' }
      );
      return {
        ok: result.filled.length > 0,
        data: JSON.stringify({ filled: result.filled, refused: result.refused }),
        at: new Date().toISOString(),
      };
    }
  );
}
