// message-bus.ts — typed agent-to-agent messaging.
//
// Every agent of a task talks to the other agents through this bus:
//   Planner → Coder   (type: 'task')
//   Coder   → Tester  (type: 'result')
//   Tester  → Coder   (type: 'error'  — a failing test)
//   Reviewer→ Coder   (type: 'review' — a failed verdict)
//   Reviewer→ Orchestrator (type: 'review' — the verdict)
//
// Rules enforced here:
//   - a message can NEVER be delivered outside its task
//   - only participants of the conversation may send/receive
//   - an agent sees another agent's conversation ONLY when the task policy
//     allows it (visibility: 'none' | 'participants')
//   - sender, receiver, task id and correlation id are persisted

import { db } from '@/lib/db';
import { protect } from './secrets';
import type {
  AgentMessage,
  AgentMessageType,
  AgentParticipant,
  AgenticEvent,
  MessageVisibility,
} from './types';

export interface PublishInput {
  fromAgent: AgentParticipant;
  toAgent: AgentParticipant;
  type: AgentMessageType;
  content: string;
  /** ties a reply back to the request that caused it */
  correlationId?: string;
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageBusOptions {
  taskId: string;
  conversationId: string;
  participants: AgentParticipant[];
  visibility?: MessageVisibility;
  /** receives an 'agent_message' event for every published message */
  onEvent?: (event: AgenticEvent) => void;
}

export interface DeliveryCheck {
  allowed: boolean;
  reason?: string;
}

const DEFAULT_PARTICIPANTS: AgentParticipant[] = [
  'planner',
  'coder',
  'tester',
  'reviewer',
  'orchestrator',
];

export class MessageBusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageBusError';
  }
}

/**
 * In-process + persisted message bus for ONE task.
 * A bus instance is bound to a single taskId — that is what makes
 * cross-task delivery impossible by construction.
 */
export class MessageBus {
  readonly taskId: string;
  readonly conversationId: string;
  readonly participants: AgentParticipant[];
  readonly visibility: MessageVisibility;

  private onEvent?: (event: AgenticEvent) => void;
  private listeners = new Map<string, Set<(m: AgentMessage) => void>>();
  /** in-memory mirror of the conversation (for fast UI updates) */
  private buffer: AgentMessage[] = [];

  constructor(opts: MessageBusOptions) {
    this.taskId = opts.taskId;
    this.conversationId = opts.conversationId;
    this.participants = opts.participants?.length
      ? opts.participants
      : DEFAULT_PARTICIPANTS;
    this.visibility = opts.visibility ?? 'none';
    this.onEvent = opts.onEvent;
  }

  /**
   * May `from` send a message to `to` inside this conversation?
   */
  checkDelivery(from: string, to: string): DeliveryCheck {
    if (!this.participants.includes(from as AgentParticipant)) {
      return { allowed: false, reason: `"${from}" is not a participant of this task` };
    }
    if (!this.participants.includes(to as AgentParticipant)) {
      return { allowed: false, reason: `"${to}" is not a participant of this task` };
    }
    if (from === to) {
      return { allowed: false, reason: 'An agent cannot send a message to itself' };
    }
    return { allowed: true };
  }

  /**
   * Publish a message: validate → persist → notify listeners → emit event.
   */
  async publish(input: PublishInput): Promise<AgentMessage> {
    const check = this.checkDelivery(input.fromAgent, input.toAgent);
    if (!check.allowed) {
      throw new MessageBusError(
        `Message delivery rejected: ${check.reason}`
      );
    }

    const correlationId =
      input.correlationId?.trim() || `${this.taskId}:${input.fromAgent}->${input.toAgent}`;

    // secrets must never be persisted inside a message
    const guarded = protect(String(input.content ?? ''));

    const task = await db.agenticTask.update({
      where: { id: this.taskId },
      data: { messageSeq: { increment: 1 } },
      select: { messageSeq: true },
    });
    const seq = task.messageSeq;

    const message: AgentMessage = {
      id: `msg_${this.taskId}_${seq}`,
      taskId: this.taskId,
      conversationId: this.conversationId,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      type: input.type,
      correlationId,
      content: guarded.masked,
      createdAt: new Date().toISOString(),
      seq,
      role: input.fromAgent,
      provider: input.provider ?? '',
      model: input.model ?? '',
      metadata: input.metadata ?? {},
    };

    await db.agentMessage.create({
      data: {
        id: message.id,
        taskId: this.taskId,
        conversationId: this.conversationId,
        seq: message.seq!,
        fromAgent: message.fromAgent,
        toAgent: message.toAgent,
        type: message.type,
        correlationId: message.correlationId,
        content: message.content,
        provider: message.provider ?? '',
        model: message.model ?? '',
        metadata: JSON.stringify(message.metadata ?? {}),
      },
    });

    this.buffer.push(message);
    this.emit(message);
    return message;
  }

  private emit(message: AgentMessage) {
    this.onEvent?.({
      type: 'agent_message',
      taskId: this.taskId,
      at: message.createdAt,
      data: message,
    });
    const handlers = this.listeners.get(message.toAgent);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message);
        } catch {
          // a broken subscriber must not break the bus
        }
      }
    }
  }

  /** Subscribe an agent to the messages addressed to it. Returns an unsubscribe fn. */
  subscribe(agent: string, handler: (m: AgentMessage) => void): () => void {
    const set = this.listeners.get(agent) ?? new Set();
    set.add(handler);
    this.listeners.set(agent, set);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * The conversation history an agent is allowed to see.
   * - visibility 'none'        → only messages addressed to (or sent by) it
   * - visibility 'participants' → the full conversation of the participants
   */
  historyFor(agent?: string, limit = 200): AgentMessage[] {
    let list = this.buffer;
    if (agent && this.visibility === 'none') {
      list = list.filter((m) => m.toAgent === agent || m.fromAgent === agent);
    } else if (agent) {
      list = list.filter((m) => this.participants.includes(m.fromAgent as AgentParticipant));
    }
    return list.slice(-limit);
  }

  /** Persisted history, filtered by the same visibility rules. */
  async persistedHistory(
    agent?: string,
    limit = 200
  ): Promise<AgentMessage[]> {
    // M1: fetch the NEWEST rows first (descending). The previous
    // `orderBy asc + take` returned the OLDEST window of the conversation, so
    // a long-running task never saw its recent messages again.
    const rows = await db.agentMessage.findMany({
      where: { taskId: this.taskId, conversationId: this.conversationId },
      orderBy: { seq: 'desc' },
      take: limit * 2,
    });
    let list: AgentMessage[] = rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      conversationId: r.conversationId,
      fromAgent: r.fromAgent,
      toAgent: r.toAgent,
      type: r.type as AgentMessageType,
      correlationId: r.correlationId,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
      seq: r.seq,
      role: r.fromAgent,
      provider: r.provider,
      model: r.model,
      metadata: safeParse(r.metadata),
    }));
    if (agent && this.visibility === 'none') {
      list = list.filter((m) => m.toAgent === agent || m.fromAgent === agent);
    }
    // rows are newest-first → restore chronological order and keep the tail
    return list.reverse().slice(-limit);
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Load a bus for a task using the routing/policy stored on the task row.
 */
export async function createMessageBusForTask(
  taskId: string,
  opts: {
    conversationId?: string;
    visibility?: MessageVisibility;
    onEvent?: (event: AgenticEvent) => void;
  } = {}
): Promise<MessageBus> {
  const task = await db.agenticTask.findUnique({
    where: { id: taskId },
    select: { conversationId: true },
  });
  return new MessageBus({
    taskId,
    conversationId: opts.conversationId || task?.conversationId || `conv_${taskId}`,
    participants: DEFAULT_PARTICIPANTS,
    visibility: opts.visibility ?? 'none',
    onEvent: opts.onEvent,
  });
}
