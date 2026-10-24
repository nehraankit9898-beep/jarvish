import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { listEvents } from '@/lib/agentic/event-store';
import { isTerminalStatus, normalizeTaskStatus } from '@/lib/agentic/types';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/agentic/tasks/[id]/stream — the realtime event stream (SSE).
 *
 * Protocol:
 *   - every frame carries `id: <seq>` so a client can reconnect with
 *     `?after=<lastSeq>` (or Last-Event-ID) and replay exactly what it missed;
 *   - events are the PERSISTED rows (never in-memory only), so the replay
 *     survives a server restart;
 *   - a terminal task gets a final `stream_status` frame with
 *     `terminal: true` so the client knows the run is over (vs. a dropped
 *     connection);
 *   - a live task is polled for new events until it reaches a terminal
 *     status or the client disconnects.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = rejectIfUnauthorized(req);
  if (unauthorized) return unauthorized;

  const { id } = await params;

  const task = await db.agenticTask.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!task) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  // resume from the client's last seen seq — Last-Event-ID wins when present
  const lastEventId = req.headers.get('last-event-id');
  const afterParam = searchParams.get('after');
  let after = 0;
  if (lastEventId && Number.isFinite(Number(lastEventId))) {
    after = Number(lastEventId);
  } else if (afterParam && Number.isFinite(Number(afterParam))) {
    after = Number(afterParam);
  }

  const encoder = new TextEncoder();
  const POLL_MS = 1000;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };

      const frame = (event: {
        type: string;
        seq?: number;
        at?: string;
        stepIndex?: number;
        data?: unknown;
      }) => {
        const body = JSON.stringify({
          type: event.type,
          taskId: id,
          at: event.at ?? new Date().toISOString(),
          stepIndex: event.stepIndex,
          seq: event.seq,
          data: event.data,
        });
        if (typeof event.seq === 'number') {
          send(`id: ${event.seq}\ndata: ${body}\n\n`);
        } else {
          send(`data: ${body}\n\n`);
        }
      };

      const terminalFrame = (status: string) => {
        frame({
          type: 'stream_status',
          at: new Date().toISOString(),
          data: { status, terminal: true },
        });
        send('event: end\ndata: {"terminal":true}\n\n');
      };

      req.signal.addEventListener('abort', () => {
        closed = true;
      });

      let currentStatus = normalizeTaskStatus(task.status);

      // Flush the response IMMEDIATELY with an SSE comment.
      //
      // Without this the handler enqueued nothing until an event existed, so
      // the HTTP response headers were never sent: `fetch()` (and EventSource)
      // stayed unresolved, the dashboard's status pill sat on "connecting"
      // for the whole quiet period between two steps, and a proxy in between
      // saw a request that produced no bytes at all. A comment line is ignored
      // by the SSE parser and only exists to open the channel.
      send(': connected\n\n');

      let quietPolls = 0;
      try {
        while (!closed) {
          // replay/poll everything newer than `after`
          const events = await listEvents(id, after);
          for (const e of events) {
            after = Math.max(after, e.seq);
            frame({
              type: e.type,
              seq: e.seq,
              at: e.at,
              stepIndex: e.stepIndex ?? undefined,
              data: e.data,
            });
          }

          // re-read the status — the last batch of events may have finished it
          const row = await db.agenticTask.findUnique({
            where: { id },
            select: { status: true },
          });
          if (row) currentStatus = normalizeTaskStatus(row.status);

          if (isTerminalStatus(currentStatus)) {
            terminalFrame(currentStatus);
            break;
          }

          // keep-alive: a task can legitimately emit nothing for minutes
          // (waiting for an approval, a long test run). One comment per ~15 s
          // keeps the connection observably alive without waking the client's
          // event handlers.
          quietPolls += 1;
          if (quietPolls >= 15) {
            quietPolls = 0;
            send(': ping\n\n');
          }

          // wait for more events (the abort listener flips `closed` on
          // client disconnect, which also breaks this sleep loop)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, POLL_MS);
            req.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
        }
      } catch {
        // an unexpected error must still close the stream cleanly
        try {
          terminalFrame(currentStatus);
        } catch {
          // controller already closed — nothing to do
        }
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
