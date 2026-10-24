import { NextRequest } from 'next/server';
import { authenticate, revoke, RemoteError } from '@/lib/agentic/remote-session';
import { clearRemoteHistory } from '@/lib/agentic/remote-chat';

export const runtime = 'nodejs';

function bearer(req: NextRequest): string {
  const auth = req.headers.get('authorization') ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers.get('x-remote-token')?.trim() ?? '';
}

/** POST /api/remote/end — the phone hangs up. */
export async function POST(req: NextRequest) {
  const token = bearer(req);
  try {
    const session = authenticate(token);
    revoke(token);
    clearRemoteHistory(session.id);
    return Response.json({ ended: true });
  } catch (err) {
    if (err instanceof RemoteError) {
      return Response.json({ ended: true, reason: err.message });
    }
    return Response.json({ ended: false }, { status: 500 });
  }
}
