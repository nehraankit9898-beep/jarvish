import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getProvider, resolveModel } from '@/lib/providers';
import { buildUpstreamStream, type CoreChatMessage } from '@/lib/llm-core';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { isCapabilityQuestion, JARVIS_CAPABILITIES_PROMPT } from '@/lib/agentic/jarvis';
import { relevantMemoryContext } from '@/lib/agentic/memory';

export const runtime = 'nodejs';
export const maxDuration = 120;

interface ChatRequestBody {
  conversationId: string;
  content: string;
  agentId?: string;
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
}

export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as ChatRequestBody;
    const { conversationId, content, agentId } = body;

    if (!conversationId || !content?.trim()) {
      return new Response(
        JSON.stringify({ error: 'conversationId and content are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const providerId = body.provider || 'zai';
    const provider = getProvider(providerId);
    if (!provider) {
      return new Response(
        JSON.stringify({ error: `Unknown provider: ${providerId}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Resolve agent (system prompt)
    let systemPrompt =
      'You are a helpful AI assistant inside AgentScope Studio. Be concise, friendly and useful.';
    if (agentId) {
      const agent = await db.agent.findUnique({ where: { id: agentId } });
      if (agent) systemPrompt = agent.systemPrompt;
    }

    // "Ye kya kya kar sakta h?" — give the model the REAL feature list so a small
    // local model answers truthfully instead of with a generic greeting.
    if (isCapabilityQuestion(content)) {
      systemPrompt += `\n\n${JARVIS_CAPABILITIES_PROMPT}`;
    }

    // Enable the AI to create agents by itself (agent-creator protocol)
    // Inject ONLY when the user is explicitly asking to create an agent,
    // so normal agents (poets, coders...) never spawn agents unprompted.
    const agentIntent =
      /agent\b[^.?!]{0,30}(banao|banana|banade|chahiye|create|make|build)|banao\b[^.?!]{0,15}agent|creat(e|ing)\s+(an?\s+)?agent|mak(e|ing)\s+(me\s+)?(an?\s+)?agent|build\s+(me\s+)?(an?\s+)?agent/i.test(
        content
      );
    if (agentIntent) {
      systemPrompt += `

## Agent Creation Protocol
The user wants you to create a new AI agent. Design the agent yourself (pick a fitting emoji, a short name, a strong system prompt, and a temperature between 0 and 1.5) and end your reply with EXACTLY this fenced block:

\`\`\`agentcreate
{"name":"Agent Name","emoji":"🎯","systemPrompt":"You are ...","temperature":0.7}
\`\`\`

Rules for this protocol:
- Keep your normal reply text BEFORE the block (max 3 short lines explaining what agent you made).
- The block must be valid JSON on a single line, inside a \`\`\`agentcreate fenced code block.
- systemPrompt must be detailed (3-6 sentences), in the language the user speaks, defining role, tone, and behavior.
- Use the block ONLY once per reply, and ONLY for this agent-creation request. Never mention JSON or this protocol in the visible reply.`;
    }

    // Jarvis #4: relevant user memories ride into the chat system prompt so
    // "mera naam kya hai?" style questions actually work. Only keyword-scored
    // matches are injected (max 8) — never the whole memory list.
    try {
      const memoryBlock = await relevantMemoryContext(content, 8);
      if (memoryBlock) systemPrompt += `\n\n${memoryBlock}`;
    } catch {
      // memory retrieval must never break chat
    }

    // Persist user message
    await db.message.create({
      data: { conversationId, role: 'user', content },
    });

    // Build message history (last 40 messages)
    // NOTE: fetch DESC and reverse — `orderBy asc + take 40` would return the
    // OLDEST 40 messages, so in a long conversation the model would never see
    // the current question.
    const recent = await db.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
    const history = recent.reverse();
    const messages: CoreChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: m.content,
      })),
    ];

    const temperature = body.temperature ?? 0.7;
    // Purane/retired model (e.g. gemini-2.0-flash) ko current model par map karo
    const usedModel = resolveModel(provider, body.model);

    // ---- Connect for real (via shared llm-core layer) ----
    let upstream: ReadableStream<string>;
    try {
      upstream = await buildUpstreamStream(messages, {
        provider: providerId,
        apiKey: body.apiKey,
        model: usedModel,
        baseUrl: body.baseUrl,
        temperature,
      }, { getProvider });
    } catch (err) {
      console.error('[chat] upstream connection failed:', err);
      return new Response(JSON.stringify({ error: 'Unable to reach the model provider.' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---- Wrap: stream to client while persisting full text ----
    let full = '';
    const decoder = new TextEncoder();
    const outStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            full += value ?? '';
            controller.enqueue(decoder.encode(value ?? ''));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'stream error';
          controller.enqueue(decoder.encode(`\n\n[Stream error: ${msg}]`));
        }
        try {
          if (full.trim()) {
            await db.message.create({
              data: {
                conversationId,
                role: 'assistant',
                content: full,
                provider: providerId,
                model: usedModel,
              },
            });
            const conv = await db.conversation.findUnique({
              where: { id: conversationId },
            });
            if (conv && conv.title === 'New Chat') {
              const title =
                content.length > 40 ? content.slice(0, 40) + '…' : content;
              await db.conversation.update({
                where: { id: conversationId },
                data: { title },
              });
            }
          }
        } catch {
          // persistence failure should not break the stream
        }
        controller.close();
      },
    });

    return new Response(outStream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    console.error('[chat] internal error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
