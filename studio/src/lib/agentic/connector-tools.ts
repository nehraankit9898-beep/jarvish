// connector-tools.ts — agent-facing tools for the external connectors.
//
// Jarvis #7 rules applied here:
//   - READ tools are 'safe' (calendar-list-events, gmail-list-messages)
//   - WRITE tools are 'destructive' → the tool layer's approval gate asks
//     the user first (calendar-create-event NEVER silently writes)
//
// Registered lazily via /api/tools (ensureFullCatalog), same as the laptop
// tools.

import { registerTool, type ToolResult } from './tool-registry';
import {
  listCalendarEvents,
  createCalendarEvent,
  listGmailMessages,
} from './connectors/google';

let registered = false;

const at = () => new Date().toISOString();

/** Register the connector tools once (idempotent). */
export function registerConnectorTools(): void {
  if (registered) return;
  registered = true;

  registerTool(
    {
      name: 'calendar-list-events',
      description:
        'List upcoming Google Calendar events (READ-ONLY). Needs the Google connector to be connected (System panel → Connectors).',
      category: 'adapter',
      parameters: {
        days: { type: 'number', description: 'How many days ahead (1-30, default 7)', required: false },
        max: { type: 'number', description: 'Max events 1-25 (default 10)', required: false },
        query: { type: 'string', description: 'Optional text filter', required: false },
      },
      required: [],
      permission: 'safe',
      timeoutMs: 30_000,
    },
    async (inv): Promise<ToolResult> => {
      try {
        const events = await listCalendarEvents({
          days: Number(inv.parameters.days ?? 7),
          max: Number(inv.parameters.max ?? 10),
          query: inv.parameters.query ? String(inv.parameters.query) : undefined,
        });
        return { ok: true, data: { count: events.length, events }, at: at() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'calendar read failed', at: at() };
      }
    }
  );

  registerTool(
    {
      name: 'calendar-create-event',
      description:
        'CREATE a Google Calendar event/reminder (WRITE — always asks the user for approval first). ISO timestamps: 2026-10-24T09:00:00+05:30.',
      category: 'adapter',
      parameters: {
        title: { type: 'string', description: 'Event title', required: true },
        startIso: { type: 'string', description: 'Start time (ISO 8601 with timezone)', required: true },
        endIso: { type: 'string', description: 'End time (default: start + 30 min)', required: false },
        description: { type: 'string', description: 'Optional description', required: false },
        location: { type: 'string', description: 'Optional location', required: false },
      },
      required: ['title', 'startIso'],
      permission: 'destructive',
      timeoutMs: 30_000,
    },
    async (inv): Promise<ToolResult> => {
      try {
        const ev = await createCalendarEvent({
          title: String(inv.parameters.title ?? ''),
          startIso: String(inv.parameters.startIso ?? ''),
          endIso: inv.parameters.endIso ? String(inv.parameters.endIso) : undefined,
          description: inv.parameters.description ? String(inv.parameters.description) : undefined,
          location: inv.parameters.location ? String(inv.parameters.location) : undefined,
        });
        return { ok: true, data: ev, at: at() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'calendar write failed', at: at() };
      }
    }
  );

  registerTool(
    {
      name: 'gmail-list-messages',
      description:
        'List recent Gmail messages (READ-ONLY — never sends, never marks as read). Default: inbox, last 3 days.',
      category: 'adapter',
      parameters: {
        query: { type: 'string', description: 'Gmail search query (default "is:inbox newer_than:3d")', required: false },
        max: { type: 'number', description: 'Max messages 1-20 (default 10)', required: false },
      },
      required: [],
      permission: 'safe',
      timeoutMs: 45_000,
    },
    async (inv): Promise<ToolResult> => {
      try {
        const messages = await listGmailMessages({
          query: inv.parameters.query ? String(inv.parameters.query) : undefined,
          max: Number(inv.parameters.max ?? 10),
        });
        return { ok: true, data: { count: messages.length, messages }, at: at() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'gmail read failed', at: at() };
      }
    }
  );
}
