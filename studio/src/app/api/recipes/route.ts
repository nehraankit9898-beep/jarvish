import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import { listRecipes, applyRecipe } from '@/lib/agentic/recipes';

export const runtime = 'nodejs';

/** GET /api/recipes — the automation recipe catalog (+ applied state). */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  const recipes = await listRecipes();
  return Response.json({ recipes });
}

/** POST /api/recipes — apply a recipe (creates a disabled-by-default schedule). */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as {
      recipeId?: string;
      enabled?: boolean;
      provider?: string;
      model?: string;
      timezone?: string;
    };
    if (!body.recipeId) {
      return Response.json({ error: 'recipeId is required' }, { status: 400 });
    }
    const schedule = await applyRecipe(body.recipeId, {
      enabled: body.enabled === true,
      provider: body.provider,
      model: body.model,
      timezone: body.timezone,
    });
    return Response.json({ ok: true, schedule });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'recipe apply failed' },
      { status: 400 }
    );
  }
}
