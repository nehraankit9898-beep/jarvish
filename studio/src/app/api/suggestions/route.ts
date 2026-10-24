import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { recordAudit, clientIp } from '@/lib/agentic/audit';
import {
  listSuggestions,
  acceptSuggestion,
  dismissSuggestion,
  muteSuggestionKind,
} from '@/lib/agentic/suggestions';
import { createNotification } from '@/lib/agentic/notifications';
import { planTask } from '@/lib/agentic/orchestrator';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/suggestions — the proactive suggestions feed.
 *   ?status=open (default) | accepted | dismissed | (empty = all)
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') ?? undefined;
    const suggestions = await listSuggestions({ status: status || undefined });
    return Response.json({ suggestions });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load suggestions';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/suggestions — act on a suggestion.
 *
 *   { id, action: 'accept' } — the suggestion's actionPrompt becomes a NEW
 *     agentic task (planned like any other: workspace, approvals, test gate);
 *     the run is NOT started automatically — the user starts it from the
 *     Agentic panel after reviewing the plan.
 *   { id, action: 'dismiss' } — mark it dismissed.
 *   { id, action: 'mute' }    — Jarvis #5 "aage se mat batao": dismiss + the
 *     suggestion's KIND never notifies again (ProactiveState muted:<kind>).
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      action?: 'accept' | 'dismiss' | 'mute';
    };
    if (!body.id || !body.action) {
      return Response.json({ error: 'id and action are required' }, { status: 400 });
    }

    if (body.action === 'mute') {
      const res = await muteSuggestionKind(body.id);
      if (!res.ok) return Response.json({ error: 'Suggestion not found' }, { status: 404 });
      await recordAudit({
        actor: 'user',
        action: 'suggestion.mute_kind',
        category: 'task',
        details: { suggestionId: body.id, kind: res.kind },
        ip: clientIp(req.headers),
      });
      return Response.json({ ok: true, mutedKind: res.kind });
    }

    if (body.action === 'dismiss') {
      const ok = await dismissSuggestion(body.id);
      if (!ok) return Response.json({ error: 'Suggestion not found or not open' }, { status: 404 });
      await recordAudit({
        actor: 'user',
        action: 'suggestion.dismiss',
        category: 'task',
        details: { suggestionId: body.id },
        ip: clientIp(req.headers),
      });
      return Response.json({ ok: true });
    }

    const accepted = await acceptSuggestion(body.id);
    if (!accepted.ok || !accepted.suggestion) {
      return Response.json({ error: accepted.error ?? 'Accept failed' }, { status: 400 });
    }

    const prompt = accepted.suggestion.actionPrompt;
    if (!prompt || prompt.length < 8) {
      return Response.json(
        { error: 'The suggestion has no actionable prompt' },
        { status: 400 }
      );
    }

    // create + plan a normal task from the suggestion — every engine
    // guarantee (sandbox, approval gate, test gate, audit) applies to it
    const task = await db.agenticTask.create({
      data: {
        prompt: prompt.slice(0, 4000),
        status: 'queued',
        conversationId: `conv_sugg_${crypto.randomUUID()}`,
      },
    });
    await db.proactiveSuggestion.update({
      where: { id: body.id },
      data: { taskId: task.id },
    });
    try {
      await planTask(task.id, undefined, undefined, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Planning failed';
      await db.agenticTask
        .update({ where: { id: task.id }, data: { status: 'failed', error: message } })
        .catch(() => undefined);
      return Response.json({ error: message }, { status: 500 });
    }

    await createNotification({
      type: 'suggestion',
      title: 'Suggestion accepted — task planned',
      body: 'Review the plan in the Agentic panel and start the run when ready.',
      taskId: task.id,
      data: { suggestionId: body.id },
    });
    await recordAudit({
      actor: 'user',
      action: 'suggestion.accept',
      category: 'task',
      details: { suggestionId: body.id, taskId: task.id },
      ip: clientIp(req.headers),
    });

    return Response.json({ ok: true, taskId: task.id }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
