// recollect-tools.ts — agent-facing versions of the recollection helpers.
//
// Chat gets time + recall injected automatically (see api/chat/route.ts), but
// the agentic orchestrator runs on tools, so the same ability has to exist
// there too:
//
//   time-now            what day/date/time is it (a model has no clock)
//   conversation-recall search the user's past transcripts
//
// Both are read-only ('safe'), so they never need approval.

import { registerTool, type ToolResult } from './tool-registry';
import { clockSnapshot, searchPastConversations } from './recollect';

let registered = false;

const at = () => new Date().toISOString();

/** Register the recollection tools once (idempotent). */
export function registerRecollectTools(): void {
  if (registered) return;
  registered = true;

  registerTool(
    {
      name: 'time-now',
      description:
        'The real current date, day and time on this PC (with timezone). Use it for "aaj kaunsa din hai", scheduling, and any date arithmetic. Read-only.',
      category: 'adapter',
      parameters: {},
      required: [],
      permission: 'safe',
      timeoutMs: 5_000,
    },
    async (): Promise<ToolResult> => {
      try {
        const clock = clockSnapshot();
        return {
          ok: true,
          data: {
            weekday: clock.weekday,
            date: clock.date,
            time: clock.time,
            timeZone: clock.timeZone,
            iso: clock.iso,
          },
          at: at(),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'clock read failed', at: at() };
      }
    }
  );

  registerTool(
    {
      name: 'conversation-recall',
      description:
        'Search the user\'s past chat transcripts for what was said before ("pichhli baar humne kya baat ki thi"). Returns the best matching excerpts — never the whole history. Read-only.',
      category: 'adapter',
      parameters: {
        query: { type: 'string', description: 'What to look for, e.g. "laptop purchase"', required: true },
        limit: { type: 'number', description: 'Max excerpts 1-5 (default 3)', required: false },
      },
      required: ['query'],
      permission: 'safe',
      timeoutMs: 10_000,
    },
    async (inv): Promise<ToolResult> => {
      try {
        const hits = await searchPastConversations(String(inv.parameters.query ?? ''), {
          limit: Number(inv.parameters.limit ?? 3),
        });
        return { ok: true, data: { count: hits.length, conversations: hits }, at: at() };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'conversation recall failed',
          at: at(),
        };
      }
    }
  );
}
