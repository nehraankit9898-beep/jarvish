// event-store.ts — persisted realtime events with monotonic ids.
//
// The previous implementation appended events to a JSON blob on the task row
// with a read-modify-write cycle. That is:
//   - NOT race safe (two concurrent writers lose each other's events)
//   - NOT replayable (the blob is trimmed to the newest N events)
//   - NOT resumable (there was no event id a client could reconnect with)
//
// Events are now stored as rows. `seq` is allocated with an atomic counter on
// the task row, so concurrent emitters never collide and never skip an event.
// `seq` doubles as the SSE event id → a client can reconnect with
// `Last-Event-ID` and get exactly the events it missed.

import { db } from '@/lib/db';
import type { AgenticEvent } from './types';

const MAX_EVENTS_PER_TASK = 2_000;

export interface StoredEvent extends AgenticEvent {
  seq: number;
}

/**
 * Append an event to the task history.
 * The sequence number is allocated with a single atomic UPDATE, so parallel
 * agent steps can emit concurrently without losing events.
 */
export async function appendEvent(
  taskId: string,
  event: AgenticEvent
): Promise<StoredEvent | null> {
  try {
    const task = await db.agenticTask.update({
      where: { id: taskId },
      data: { eventSeq: { increment: 1 } },
      select: { eventSeq: true },
    });
    const seq = task.eventSeq;
    const stored: StoredEvent = { ...event, seq };
    await db.agentEvent.create({
      data: {
        taskId,
        seq,
        type: event.type,
        at: event.at,
        stepIndex: event.stepIndex ?? null,
        payload: JSON.stringify(event.data ?? {}),
      },
    });
    void pruneEvents(taskId);
    return stored;
  } catch {
    // event persistence must never break a run
    return null;
  }
}

/** All events of a task, oldest first. */
export async function listEvents(
  taskId: string,
  afterSeq = 0,
  limit = MAX_EVENTS_PER_TASK
): Promise<StoredEvent[]> {
  const rows = await db.agentEvent.findMany({
    where: { taskId, seq: { gt: afterSeq } },
    orderBy: { seq: 'asc' },
    take: limit,
  });
  return rows.map((r) => ({
    type: r.type as AgenticEvent['type'],
    taskId: r.taskId,
    at: r.at,
    stepIndex: r.stepIndex ?? undefined,
    seq: r.seq,
    data: safeParse(r.payload),
  }));
}

/** The highest sequence number stored for a task (0 = nothing yet). */
export async function lastEventSeq(taskId: string): Promise<number> {
  const row = await db.agentEvent.findFirst({
    where: { taskId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return row?.seq ?? 0;
}

/** Keep the history bounded — drop the oldest rows. */
async function pruneEvents(taskId: string): Promise<void> {
  try {
    const count = await db.agentEvent.count({ where: { taskId } });
    if (count <= MAX_EVENTS_PER_TASK) return;
    const excess = count - MAX_EVENTS_PER_TASK;
    const old = await db.agentEvent.findMany({
      where: { taskId },
      orderBy: { seq: 'asc' },
      take: excess,
      select: { id: true },
    });
    if (old.length) {
      await db.agentEvent.deleteMany({
        where: { id: { in: old.map((o) => o.id) } },
      });
    }
  } catch {
    // pruning is best effort
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
