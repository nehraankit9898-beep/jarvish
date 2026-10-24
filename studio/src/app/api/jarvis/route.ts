import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { detectIntent, isApprovalAffirmative, wantsScreenTask, MIN_TASK_PROMPT } from '@/lib/agentic/jarvis';

export const runtime = 'nodejs';

/**
 * POST /api/jarvis
 *
 *   { op: 'intent', content }
 *       → { intent: 'chat' | 'action', reason, text }
 *       The Chat box calls this before every message: "action" messages are
 *       sent to the Agentic task engine, "chat" messages go to /api/chat.
 *
 *   { op: 'log', conversationId, userContent, assistantContent }
 *       → { ok: true }
 *       Saves the user message and the assistant's acknowledgement in the
 *       conversation, so a message that became a task still shows up in the
 *       chat history (the /api/chat route is not involved for those).
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  try {
    const body = (await req.json()) as {
      op?: string;
      content?: string;
      conversationId?: string;
      userContent?: string;
      assistantContent?: string;
    };

    if (body.op === 'intent') {
      const content = body.content ?? '';

      // Jarvis #5: a bare "haan kar do" approves the LATEST open suggestion —
      // the chat reply becomes the suggestion's actionPrompt so the normal
      // runAsTask flow (plan → approvals) takes over. Requires minimum-length
      // checks to be skipped, hence handled BEFORE detectIntent.
      if (isApprovalAffirmative(content)) {
        const open = await db.proactiveSuggestion.findFirst({
          where: { status: 'open' },
          orderBy: { createdAt: 'desc' },
          select: { id: true, actionPrompt: true, title: true },
        });
        if (open && open.actionPrompt.trim().length >= MIN_TASK_PROMPT) {
          return Response.json({
            intent: 'action',
            reason: `approval for suggestion "${open.title.slice(0, 60)}"`,
            text: open.actionPrompt,
            viaSuggestion: open.id,
          });
        }
      }

      const decision = detectIntent(content);
      // Jarvis #2: "screen dekh kar click karo" → the VISION loop instead of
      // the normal workspace engine
      const screenMode =
        decision.intent === 'action' && wantsScreenTask(content);
      // a job that is too short for the planner is treated as plain chat
      if (decision.intent === 'action' && decision.text.length < MIN_TASK_PROMPT) {
        return Response.json({ ...decision, intent: 'chat', reason: 'too short for a task' });
      }
      return Response.json({ ...decision, ...(screenMode ? { screenMode: true } : {}) });
    }

    if (body.op === 'log') {
      const { conversationId, userContent, assistantContent } = body;
      if (!conversationId || !userContent?.trim() || !assistantContent?.trim()) {
        return Response.json(
          { error: 'conversationId, userContent and assistantContent are required' },
          { status: 400 }
        );
      }
      const conv = await db.conversation.findUnique({ where: { id: conversationId } });
      if (!conv) {
        return Response.json({ error: 'Conversation not found' }, { status: 404 });
      }
      await db.message.create({
        data: { conversationId, role: 'user', content: userContent },
      });
      await db.message.create({
        data: { conversationId, role: 'assistant', content: assistantContent, provider: 'jarvis', model: 'task-router' },
      });
      if (conv.title === 'New Chat') {
        const title = userContent.length > 40 ? userContent.slice(0, 40) + '…' : userContent;
        await db.conversation.update({ where: { id: conversationId }, data: { title } });
      }
      return Response.json({ ok: true });
    }

    return Response.json({ error: "op must be 'intent' or 'log'" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return Response.json({ error: message }, { status: 500 });
  }
}
