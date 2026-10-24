// notifications-bell.tsx — the header notification bell (Features 3/5/8).
//
// Shows the unread count, the recent feed (task results, automation
// failures, suggestions, browser takeovers) and marks entries read. The
// runtime creates these while the user is away — this is how they find out.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/hooks/use-toast';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  taskId: string;
  read: boolean;
  createdAt: string;
}

const TYPE_META: Record<string, { emoji: string; tone: string }> = {
  task_done: { emoji: '✅', tone: 'text-emerald-400' },
  task_failed: { emoji: '❌', tone: 'text-red-400' },
  approval_required: { emoji: '⚠️', tone: 'text-amber-400' },
  automation: { emoji: '⏰', tone: 'text-violet-400' },
  suggestion: { emoji: '💡', tone: 'text-sky-400' },
  system: { emoji: '🔔', tone: 'text-zinc-400' },
  browser: { emoji: '🌐', tone: 'text-cyan-400' },
  goal: { emoji: '🎯', tone: 'text-emerald-400' },
  download: { emoji: '📥', tone: 'text-emerald-400' },
  telegram: { emoji: '✈️', tone: 'text-sky-400' },
};

export function NotificationsBell() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=30');
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.notifications ?? []);
      setUnread(data.unread ?? 0);
    } catch {
      // the bell must never break the header
    }
  }, []);

  useEffect(() => {
    // mount-time fetch is deferred one tick so the effect never sets state
    // synchronously (react-hooks/set-state-in-effect)
    const first = setTimeout(load, 0);
    const timer = setInterval(load, 30_000); // light polling
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  // refresh when the dropdown opens
  useEffect(() => {
    if (open) {
      const t = setTimeout(load, 0);
      return () => clearTimeout(t);
    }
  }, [open, load]);

  const markAll = async () => {
    const res = await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    if (res.ok) {
      setUnread(0);
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      toast({ title: 'Sab notifications mark ho gaye read' });
    }
  };

  const markOne = async (id: string) => {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => undefined);
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnread((u) => Math.max(0, u - 1));
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="relative border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <Badge
              variant="outline"
              className="absolute -top-2 -right-2 h-5 min-w-5 px-1 text-[10px] bg-emerald-600 border-emerald-400 text-white"
            >
              {unread > 99 ? '99+' : unread}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[340px] bg-zinc-900 border-zinc-700 p-0"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <button
              onClick={markAll}
              className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </button>
          )}
        </div>
        <ScrollArea className="max-h-96">
          <div className="p-1.5 space-y-1">
            {items.length === 0 && (
              <p className="text-xs text-zinc-500 text-center py-8">
                Koi notification nahi — background runtime yahan report karega.
              </p>
            )}
            {items.map((n) => {
              const meta = TYPE_META[n.type] ?? TYPE_META.system;
              return (
                <button
                  key={n.id}
                  onClick={() => markOne(n.id)}
                  className={`w-full text-left rounded-lg px-2.5 py-2 transition-colors ${
                    n.read ? 'opacity-60 hover:opacity-90' : 'bg-zinc-800/60 hover:bg-zinc-800'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className="text-sm leading-5">{meta.emoji}</span>
                    <div className="min-w-0 flex-1">
                      <p className={`text-xs font-medium ${meta.tone} truncate`}>{n.title}</p>
                      {n.body && (
                        <p className="text-[11px] text-zinc-500 line-clamp-2 mt-0.5">{n.body}</p>
                      )}
                      <p className="text-[10px] text-zinc-600 mt-1">
                        {new Date(n.createdAt).toLocaleString()}
                      </p>
                    </div>
                    {!n.read && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 mt-1.5" />}
                  </div>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
