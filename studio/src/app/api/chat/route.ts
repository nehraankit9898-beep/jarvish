import { NextRequest } from 'next/server';
import { encodeChatEvent } from '@/lib/chat-stream';
import { db } from '@/lib/db';
import { getProvider, resolveModelWithNotice, modelNote } from '@/lib/providers';
import {
  buildUpstreamStream,
  capHistoryContext,
  parseApiError,
  type CoreChatMessage,
} from '@/lib/llm-core';
import { buildProviderFailure, classifyHttpStatus, sanitizeProviderMessage } from '@/lib/provider-errors';
import { effectiveCredential } from '@/lib/agentic/provider-store';
import { recordLastError } from '@/lib/agentic/last-action-error';
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

    if (body.model?.trim() && !body.provider?.trim()) {
      return Response.json({ error: 'An explicit model requires an explicit provider.' }, { status: 400 });
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

    // ---- ONE source of truth for the credential -------------------------
    // The browser used to be the only place a key lived, so a key saved in
    // the Providers panel (server-side, encrypted) was invisible to chat and
    // the user was told "Gemini API key is required" while a valid key was
    // already stored on the very same server. The request-supplied credential
    // still wins (nothing that worked before changes), then the encrypted
    // server-side store, then the environment.
    let apiKey = body.apiKey?.trim() || '';
    let baseUrl = body.baseUrl?.trim() || '';
    if (!apiKey || !baseUrl) {
      try {
        const stored = await effectiveCredential(providerId, {
          apiKey: body.apiKey,
          baseUrl: body.baseUrl,
        });
        apiKey = apiKey || stored.apiKey;
        baseUrl = baseUrl || stored.baseUrl;
      } catch {
        // no database / no stored credential — the request value is all we have
      }
    }

    // A retired model id is replaced WITH a notice (never silently).
    const resolvedModel = resolveModelWithNotice(provider, body.model);
    const usedModel = resolvedModel.model;
    const modelNotice = resolvedModel.notice;

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
        apiKey: apiKey || undefined,
        model: usedModel,
        baseUrl: baseUrl || undefined,
        temperature,
        signal: req.signal,
      }, { getProvider });
    } catch (err) {
      // A provider 429 keeps its status + Retry-After so the UI can say
      // "rate limited, retry in Ns" instead of a generic 502.
      const parsed = parseApiError(err);
      if (parsed.status === 429) {
        const limited = buildProviderFailure({
          category: 'rate_limit',
          status: 429,
          detail: '',
          retryAfterSec: parsed.retryAfterSec,
          providerName: provider.name,
          model: usedModel,
        });
        return new Response(
          JSON.stringify({
            error: limited.message,
            errorCategory: limited.category,
            hint: limited.hint,
            provider: providerId,
            model: usedModel,
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

      // NAME THE ACTUAL FAILURE through ONE shared classifier.
      // (Previously: every non-429 failure collapsed into "network", so a 401
      // for a wrong key was reported as "no internet", and a 404 for a
      // retired model never suggested picking another model.)
      const raw = err instanceof Error ? err.message : String(err ?? 'unknown error');
      const keyless = protect(raw).masked;
      const category = parsed.status
        ? classifyHttpStatus(parsed.status)
        : /timeout|aborted|timed out/i.test(raw)
          ? 'timeout'
          : /fetch failed|enotfound|econnrefused|eai_again|network|socket/i.test(raw)
            ? 'network'
            : 'unknown';
      const built = buildProviderFailure({
        category,
        status: parsed.status,
        detail: keyless.replace(/^API error \d{3}(?: \[retry-after=[^\]]+\])?:\s*/i, ''),
        secrets: apiKey ? [apiKey] : [],
        retryAfterSec: parsed.retryAfterSec,
        providerName: provider.name,
        model: usedModel,
      });
      recordLastError({
        what: `${provider.name} chat (${usedModel})`,
        category: built.category,
        message: built.message,
        hint: built.hint,
        secrets: apiKey ? [apiKey] : [],
      });
      const httpStatus =
        category === 'auth'
          ? 401
          : category === 'model_unavailable'
            ? 404
            : category === 'config'
              ? 400
              : category === 'timeout'
                ? 504
                : category === 'server'
                  ? 502
                  : 502;
      return new Response(
        JSON.stringify({
          error: built.message,
          errorCategory: built.category,
          hint: built.hint,
          provider: providerId,
          providerName: provider.name,
          model: usedModel,
          retryAfterSec: built.retryAfterSec,
          checkedAt: built.at,
        }),
        {
          status: httpStatus,
          headers: {
            'Content-Type': 'application/json',
            ...(modelNotice ? { 'X-Model-Notice': encodeURIComponent(modelNotice.reason) } : {}),
          },
        }
      );
    }
    const upstreamMs = Date.now() - upstreamOpenedAt;

    // ---- Wrap: stream to client while persisting full text ----
    let full = '';
    let streamFailure: Error | undefined;
    let cancelled = false;
    const reader = upstream.getReader();
    const outStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            full += value ?? '';
            controller.enqueue(encodeChatEvent({ type: 'text', text: value ?? '' }));
          }
        } catch (e) {
          // A user abort is not an error worth showing — the client is gone.
          if (!req.signal.aborted) {
            const msg = e instanceof Error ? e.message : 'stream error';
            streamFailure = new Error(sanitizeProviderMessage(msg, apiKey ? [apiKey] : []));
          }
        }
        // Errors belong to the transport, NEVER the assistant text/TTS queue.
        if (!full.trim() && !streamFailure && !req.signal.aborted && !cancelled) {
          streamFailure = new Error(`${provider.name} returned an empty response.`);
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
        if (!cancelled) {
          if (streamFailure) {
            const built = buildProviderFailure({
              detail: streamFailure.message,
              secrets: apiKey ? [apiKey] : [],
              providerName: provider.name,
              model: usedModel,
            });
            controller.enqueue(encodeChatEvent({ type: 'error', error: built.message, errorCategory: built.category, hint: built.hint }));
          } else controller.enqueue(encodeChatEvent({ type: 'done' }));
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
        // Client disconnected mid-stream (Stop button / navigation): release
        // the upstream provider connection immediately. llm-core aborts the
        // fetch; the reader.cancel() below also unblocks a pending read().
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          /* already closed */
        }
      },
    });

    return new Response(outStream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'X-Chat-Stream': 'ndjson-v1',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Server-Timing': `setup;dur=${setupMs}, upstream;dur=${upstreamMs}`,
        ...(modelNotice ? { 'X-Model-Notice': encodeURIComponent(modelNotice.reason) } : {}),
        ...(modelNote(provider, usedModel)
          ? { 'X-Model-Note': encodeURIComponent(modelNote(provider, usedModel) as string) }
          : {}),
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
