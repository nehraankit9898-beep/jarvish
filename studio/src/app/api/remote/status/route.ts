import { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';
import {
  listSessions,
  pairingView,
  recentEvents,
  REMOTE_LIMITS,
  RemoteError,
  type PairingView,
} from '@/lib/agentic/remote-session';

export const runtime = 'nodejs';

/**
 * GET /api/remote/status — what the Remote panel shows on the PC:
 * the live pairing code (or null), the connected devices and the last events.
 */
export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  let pairing: PairingView | null = null;
  try {
    pairing = pairingView();
  } catch (err) {
    if (!(err instanceof RemoteError)) throw err;
  }
  return Response.json({
    pairing,
    sessions: listSessions(),
    events: recentEvents(20),
    limits: REMOTE_LIMITS,
  });
}
