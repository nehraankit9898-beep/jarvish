import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { completeText, type CoreChatMessage } from '@/lib/llm-core';
import { getProvider, resolveModel } from '@/lib/providers';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  authenticate,
  countMessage,
  setConversationId,
  touch,
  RemoteError,
  type RemoteSession,
} from '@/lib/agentic/remote-session';
import { runRemoteTurn, historyFor, type Responder } from '@/lib/agentic/remote-chat';
import { effectiveCredential, readStudioSettings } from '@/lib/agentic/provider-store';
import { relevantMemoryContext } from '@/lib/agentic/memory';
import {
  captureFromUserTurn,
  recallContext,
  recallIntent,
  timeContext,
} from '@/lib/agentic/recollect';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** Bearer token from the phone. */
function bearer(req: NextRequest): string {
  const auth = req.headers.get('authorization') ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers.get('x-remote-token')?.trim() ?? '';
}

/** The remote transcript is visible in the Studio, so a PC user sees it. */
async function persistTurn(session: RemoteSession, user: string, assistant: string): Promise<void> {
  try {
    let conversationId = session.conversationId;
    if (!conversationId) {
      const conversation = await db.conversation.create({
        data: { title: `Remote · ${session.device.label}`.slice(0, 80) },
      });
      conversationId = conversation.id;
      setConversationId(session, conversationId);
    }
    await db.message.create({ data: { conversationId, role: 'user', content: user } });
    await db.message.create({ data: { conversationId, role: 'assistant', content: assistant } });
  } catch {
    // persistence is a convenience — a database hiccup must not break the call
  }
}

/**
 * POST /api/remote/message — one turn from the phone.
 * Body: { text }   Header: Authorization: Bearer <session token>
 *
 * Returns { reply, spoken, session: { messageCount, persona } }.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  let session: RemoteSession;
  try {
    session = authenticate(bearer(req));
  } catch (err) {
    if (err instanceof RemoteError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const text = String(body?.text ?? '').trim();

    // the model call — studio default provider, server-side credential
    const settings = await readStudioSettings().catch(() => null);
    const providerId = settings?.defaultProvider || 'zai';
    const provider = getProvider(providerId);
    if (!provider) throw new Error(`Provider "${providerId}" is not configured in the Studio.`);

    const credential = await effectiveCredential(providerId);
    const model = resolveModel(provider, settings?.defaultModel || '');
    const signal = req.signal;

    const responder: Responder = async (messages: CoreChatMessage[]) =>
      completeText(
        messages,
        {
          provider: providerId,
          apiKey: credential.apiKey || undefined,
          baseUrl: credential.baseUrl || undefined,
          model,
          temperature: 0.6,
          timeoutMs: 90_000,
          signal,
        },
        { getProvider }
      );

    // The phone channel gets the same long-term memory as the desktop: what the
    // user said yesterday ("mera naam Ankit hai") plus the real clock.
    let memoryBlock = '';
    try {
      const parts = [timeContext(), await relevantMemoryContext(text, 6)];
      const intent = recallIntent(text);
      if (intent.wanted) parts.push(await recallContext(intent.query || text));
      memoryBlock = parts.filter(Boolean).join('\n\n');
    } catch {
      // memory must never break the phone call
    }

    const { reply, spoken } = await runRemoteTurn({
      sessionId: session.id,
      text,
      responder,
      memoryBlock,
      onUserTurn: () => {
        touch(session);
        countMessage(session);
      },
    });

    await persistTurn(session, text, reply);
    // facts stated over the phone are remembered too
    await captureFromUserTurn(text, { source: 'remote' }).catch(() => undefined);
    await recordAudit({
      actor: 'remote',
      action: 'remote.message',
      category: 'general',
      approval: 'auto',
      details: { sessionId: session.id, device: session.device.label, chars: text.length },
      ip,
    }).catch(() => undefined);

    return Response.json({
      reply,
      spoken,
      session: {
        id: session.id,
        device: session.device.label,
        messages: session.messages,
        history: historyFor(session.id).length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The remote turn failed';
    await recordAudit({
      actor: 'remote',
      action: 'remote.message',
      category: 'general',
      result: 'error',
      errorCategory: 'model',
      error: message,
      details: { sessionId: session.id },
      ip,
    }).catch(() => undefined);
    return Response.json({ error: message }, { status: 502 });
  }
}
