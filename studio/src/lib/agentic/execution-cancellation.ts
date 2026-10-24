// execution-cancellation.ts — cancellation of REAL in-flight work.
// Database status checkpoints alone cannot stop a spawned process or an HTTP
// request. Task-scoped callbacks bridge the cancel route / kill switch to
// those resources; every registration is removed when the operation ends.

interface CancellationEntry {
  callbacks: Set<() => void>;
  cancelled: boolean;
}

const MAX_CANCELLED_MARKERS = 1_000;

function store(): Map<string, CancellationEntry> {
  const g = globalThis as unknown as {
    __agentscopeExecutionCancellation?: Map<string, CancellationEntry>;
  };
  return (g.__agentscopeExecutionCancellation ??= new Map());
}

/** A fresh run clears the marker left by an earlier cancelled attempt. */
export function resetTaskExecution(taskId: string): void {
  store().delete(taskId);
}

export function isTaskExecutionCancelled(taskId: string): boolean {
  return store().get(taskId)?.cancelled ?? false;
}

/** Register an idempotent cleanup callback. Returns its unregister function. */
export function onTaskExecutionCancelled(taskId: string, callback: () => void): () => void {
  const entries = store();
  let entry = entries.get(taskId);
  if (entry?.cancelled) {
    callback();
    return () => undefined;
  }
  if (!entry) {
    entry = { callbacks: new Set(), cancelled: false };
    entries.set(taskId, entry);
  }
  entry.callbacks.add(callback);
  return () => {
    const current = entries.get(taskId);
    current?.callbacks.delete(callback);
    if (current && !current.cancelled && current.callbacks.size === 0) entries.delete(taskId);
  };
}

/** Cancel all work currently associated with one task. */
export function cancelTaskExecution(taskId: string): number {
  const entries = store();
  const entry = entries.get(taskId) ?? { callbacks: new Set(), cancelled: false };
  entry.cancelled = true;
  entries.set(taskId, entry);
  const callbacks = Array.from(entry.callbacks);
  entry.callbacks.clear();
  for (const callback of callbacks) {
    try {
      callback();
    } catch {
      // One failing cleanup must not leave the remaining processes running.
    }
  }
  // Keep a bounded marker so a late registration cannot start after cancel.
  if (entries.size > MAX_CANCELLED_MARKERS) {
    const excess = entries.size - MAX_CANCELLED_MARKERS;
    let removed = 0;
    for (const [id, value] of entries) {
      if (value.cancelled && value.callbacks.size === 0 && id !== taskId) {
        entries.delete(id);
        if (++removed >= excess) break;
      }
    }
  }
  return callbacks.length;
}

/** Cancel every active task in this process (global kill switch). */
export function cancelAllTaskExecutions(): number {
  let count = 0;
  for (const id of Array.from(store().keys())) count += cancelTaskExecution(id);
  return count;
}
