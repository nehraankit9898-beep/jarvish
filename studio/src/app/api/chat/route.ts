import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getProvider, resolveModel } from '@/lib/providers';
import {
  buildUpstreamStream,
  capHistoryContext,
  parseApiError,
  type CoreChatMessage,
} from '@/lib/llm-core';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { protect } from '@/lib/agentic/secrets';
import { isCapabilityQuestion, JARVIS_CAPABILITIES_PROMPT } from '@/lib/agentic/jarvis';
import {
  buildPersonaDirective,
  buildStyleOnlyDirective,
  getPersona,
  readPersonaSettings,
} from '@/lib/agentic/persona';
import { relevantMemoryContext } from '@/lib/agentic/memory';
import {
  captureFromUserTurn,
  recallContext,
  recallIntent,
  timeContext,
} from '@/lib/agentic/recollect';

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
  // Server-Timing diagnostics (Rule 8): setup = request parsing + DB reads,
  // upstream = time to open the provider stream. Cheap (two Date.now calls).
  const t0 = Date.now();
  let setupMs = 0;
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

    // The CHARACTER layer: the user picks who is talking (JARVIS, F.R.I.D.A.Y,
    // a friend, a mentor...). With a custom agent the agent keeps its identity
    // but the user's language / length / humour preferences still apply.
    try {
      const personaSettings = await readPersonaSettings();
      systemPrompt += agentId
        ? `\n\n${buildStyleOnlyDirective(personaSettings)}`
        : `\n\n${buildPersonaDirective(getPersona(personaSettings.personaId), personaSettings)}`;
    } catch {
      // the character layer must never break chat
    }

    // The clock: a small local model has no idea what day it is, so "aaj
    // kaunsa din hai" used to be a guess. The real date/time rides along.
    try {
      const clock = timeContext();
      if (clock) systemPrompt += `\n\n${clock}`;
    } catch {
      // the clock must never break chat
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

    // "Pichhli baar humne kya baat ki thi?" — only when the user asks for it,
    // pull the best matching excerpts out of the real transcripts.
    try {
      const intent = recallIntent(content);
      if (intent.wanted) {
        const recall = await recallContext(intent.query || content, {
          excludeConversationId: conversationId,
        });
        if (recall) systemPrompt += `\n\n${recall}`;
      }
    } catch {
      // recall must never break chat
    }

    // Persist user message
    await db.message.create({
      data: { conversationId, role: 'user', content },
    });

    // Long-term memory, written from what the user just SAID (no model call):
    // "mera naam Ankit hai" now survives the conversation instead of waiting
    // for an agent to decide to call memory-remember.
    try {
      await captureFromUserTurn(content, { source: 'chat' });
    } catch {
      // memory writes must never break chat
    }

    // Build message history (last 40 messages, newest-first fetch)
    // NOTE: fetch DESC and reverse — `orderBy asc + take 40` would return the
    // OLDEST 40 messages, so in a long conversation the model would never see
    // the current question.
    const recent = await db.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
    const history = recent.reverse();
    // ...then bound by characters too (long code dumps in old messages must
    // not balloon every prompt — the newest message always survives).
    const capped = capHistoryContext<CoreChatMessage>(
      history.map(
        (m): CoreChatMessage => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })
      ),
      { maxMessages: 40, maxChars: 24_000 }
    );
    const messages: CoreChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...capped,
    ];

    const temperature = body.temperature ?? 0.7;
    // Purane/retired model (e.g. gemini-2.0-flash) ko current model par map karo
    const usedModel = resolveModel(provider, body.model);

    // ---- Connect for real (via shared llm-core layer) ----
    // The request signal is forwarded: the user's Stop button aborts the
    // upstream provider call too (previously it kept running server-side).
    // Interactive chat stays single-target and fail-fast on purpose — an
    // automatic provider switch mid-conversation would change the voice of
    // the reply; bounded retries live in the agentic ModelRouter instead.
    setupMs = Date.now() - t0;
    const upstreamOpenedAt = Date.now();
    let upstream: ReadableStream<string>;
    try {
      upstream = await buildUpstreamStream(messages, {
        provider: providerId,
        apiKey: body.apiKey,
        model: usedModel,
        baseUrl: body.baseUrl,
        temperature,
        signal: req.signal,
      }, { getProvider });
    } catch (err) {
      // A provider 429 keeps its status + Retry-After so the UI can say
      // "rate limited, retry in Ns" instead of a generic 502.
      const parsed = parseApiError(err);
      if (parsed.status === 429) {
        return new Response(
          JSON.stringify({
            error: 'Provider rate limit reached.',
            retryAfterSec: parsed.retryAfterSec,
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              ...(parsed.retryAfterSec != null
                ? { 'Retry-After': String(Math.ceil(parsed.retryAfterSec)) }
                : {}),
            },
          }
        );
      }
      // The client went away before the upstream opened — nothing to report.
      if (req.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      console.error('[chat] upstream connection failed:', err);

      // NAME THE ACTUAL FAILURE. Everything used to collapse into
      // "Unable to reach the model provider" with a 502 — including a 401 for a
      // wrong API key, a 404 for a retired model and a provider 5xx. The user
      // was told the network was down while the provider was answering
      // perfectly well, and the fix (rotate the key / pick another model) was
      // never suggested. Provider status is mapped back to the caller; the
      // provider's own body is masked before it can reach the browser.
      const providerText = protect(
        err instanceof Error ? err.message : 'unknown error'
      ).masked.slice(0, 300);
      const failure = (status: number, error: string, errorCategory: string) =>
        new Response(
          JSON.stringify({ error, errorCategory, provider: providerId, model: usedModel }),
          {
            status,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      if (parsed.status === 401 || parsed.status === 403) {
        return failure(
          401,
          `The provider rejected the API key (${parsed.status}). Check the key for "${providerId}" in Settings → API.`,
          'auth'
        );
      }
      if (parsed.status === 404) {
        return failure(
          404,
          `The provider does not offer the model "${usedModel}". Pick another model in Settings → API.`,
          'config'
        );
      }
      if (parsed.status === 400 || parsed.status === 422) {
        return failure(400, `The provider rejected the request: ${providerText}`, 'config');
      }
      if (typeof parsed.status === 'number' && parsed.status >= 500) {
        return failure(502, `The provider is failing (HTTP ${parsed.status}). Try again shortly.`, 'server');
      }
      return failure(
        502,
        `Unable to reach the model provider (${providerText}).`,
        'network'
      );
    }
    const upstreamMs = Date.now() - upstreamOpenedAt;

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
          // A user abort is not an error worth showing — the client is gone.
          if (!req.signal.aborted) {
            const msg = e instanceof Error ? e.message : 'stream error';
            controller.enqueue(decoder.encode(`\n\n[Stream error: ${msg}]`));
          }
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
      cancel() {
        // Client disconnected mid-stream (Stop button / navigation): release
        // the upstream provider connection immediately. llm-core aborts the
        // fetch; the reader.cancel() below also unblocks a pending read().
        try {
          void upstream.cancel();
        } catch {
          /* already closed */
        }
      },
    });

    return new Response(outStream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Server-Timing': `setup;dur=${setupMs}, upstream;dur=${upstreamMs}`,
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
