// notifications.ts — the user-facing notification service.
//
// Every background event the user should know about (task finished/failed,
// approval needed, automation results, proactive suggestions, browser
// takeovers) lands here. Notifications are PERSISTED so closing the app
// window never loses them — the banner/panel shows them when the user is
// back (Feature 3/5/8 of the platform spec).
//
// This module never throws: a notification failure must not break the run
// that produced it.

import { db } from '@/lib/db';

export type NotificationType =
  | 'task_done'
  | 'task_failed'
  | 'approval_required'
  | 'automation'
  | 'suggestion'
  | 'system'
  | 'browser'
  | 'goal'
  | 'download'
  | 'telegram';

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  taskId: string;
  scheduleId: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export async function createNotification(input: {
  type: NotificationType;
  title: string;
  body?: string;
  taskId?: string;
  scheduleId?: string;
  data?: Record<string, unknown>;
}): Promise<NotificationDto | null> {
  try {
    const row = await db.notification.create({
      data: {
        type: input.type,
        title: input.title.slice(0, 300),
        body: (input.body ?? '').slice(0, 4000),
        taskId: input.taskId ?? '',
        scheduleId: input.scheduleId ?? '',
        data: JSON.stringify(input.data ?? {}),
      },
    });
    return toDto(row);
  } catch {
    // never break a run because a notification could not be stored
    return null;
  }
}

function toDto(row: {
  id: string;
  type: string;
  title: string;
  body: string;
  taskId: string;
  scheduleId: string;
  data: string;
  read: boolean;
  createdAt: Date;
}): NotificationDto {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data || '{}');
  } catch {
    data = {};
  }
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    taskId: row.taskId,
    scheduleId: row.scheduleId,
    data,
    read: row.read,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listNotifications(opts: {
  unreadOnly?: boolean;
  limit?: number;
} = {}): Promise<NotificationDto[]> {
  const rows = await db.notification.findMany({
    where: opts.unreadOnly ? { read: false } : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.min(200, Math.max(1, opts.limit ?? 50)),
  });
  return rows.map(toDto);
}

export async function unreadCount(): Promise<number> {
  return db.notification.count({ where: { read: false } });
}

export async function markRead(id: string): Promise<boolean> {
  const res = await db.notification.updateMany({
    where: { id },
    data: { read: true },
  });
  return res.count > 0;
}

export async function markAllRead(): Promise<number> {
  const res = await db.notification.updateMany({
    where: { read: false },
    data: { read: true },
  });
  return res.count;
}

export async function clearNotifications(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const res = await db.notification.deleteMany({
    where: { read: true, createdAt: { lt: cutoff } },
  });
  return res.count;
}

/**
 * Convenience wrapper: notify about a task lifecycle change.
 * Kept small on purpose — the rich details live on the task itself.
 */
export async function notifyTaskEvent(
  taskId: string,
  status: 'done' | 'failed' | 'approval_required' | 'blocked' | 'retry_wait' | 'paused',
  detail?: string
): Promise<void> {
  const titles: Record<string, string> = {
    done: 'Task completed',
    failed: 'Task failed',
    approval_required: 'Approval needed',
    blocked: 'Task blocked',
    retry_wait: 'Task retrying',
    paused: 'Task paused',
  };
  await createNotification({
    type:
      status === 'done'
        ? 'task_done'
        : status === 'failed'
          ? 'task_failed'
          : status === 'approval_required'
            ? 'approval_required'
            : 'system',
    title: titles[status] ?? 'Task update',
    body: detail,
    taskId,
  });
}
