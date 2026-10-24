// connectors/google.ts — Google Calendar + Gmail (READ-FIRST) connector.
//
// Jarvis #7: "Har connector ke liye niyam: pehle sirf read access, write
// baad mein; token AGENTSCOPE_SECRET_KEY se encrypt ho kar rakhein; email
// bhejna ya meeting banana hamesha approval ke saath."
//
// What this module does:
//   - OAuth 2.0 (web redirect flow):
//       AGENTSCOPE_GOOGLE_CLIENT_ID / AGENTSCOPE_GOOGLE_CLIENT_SECRET + the
//       redirect URI <studio>/api/connectors/google/callback
//   - token storage in Prisma ConnectorToken (encrypted via crypto.ts)
//   - silent refresh when expired
//   - Calendar: list upcoming events (read) + create event (WRITE → the
//     tool is registered as destructive, so it always asks approval)
//   - Gmail: list recent messages (read-only; never sends, never marks read)
//
// Setup guide: docs/GOOGLE_CONNECTOR_SETUP.md

import { db } from '@/lib/db';
import { encryptSecret, decryptSecret, packSecret, unpackSecret } from '../crypto';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'userinfo.email',
].join(' ');

// The WRITE scope is separate so the UI can show "write access connected".
export const GOOGLE_CALENDAR_WRITE_SCOPE =
  'https://www.googleapis.com/auth/calendar.events';

export function googleOAuthConfigured(): boolean {
  return Boolean(
    (process.env.AGENTSCOPE_GOOGLE_CLIENT_ID ?? '').trim() &&
      (process.env.AGENTSCOPE_GOOGLE_CLIENT_SECRET ?? '').trim()
  );
}

export function googleRedirectUri(origin: string): string {
  const base = (process.env.AGENTSCOPE_PUBLIC_URL ?? origin).replace(/\/+$/, '');
  return `${base}/api/connectors/google/callback`;
}

/** The consent screen URL the user must open once. */
export function buildGoogleAuthUrl(origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: (process.env.AGENTSCOPE_GOOGLE_CLIENT_ID ?? '').trim(),
    redirect_uri: googleRedirectUri(origin),
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline', // we need the refresh token
    prompt: 'consent', // …and Google only re-issues it with consent
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTH}?${params.toString()}`;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiryAt: Date | null;
  scope: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Google token exchange failed: ${json.error ?? res.status} ${json.error_description ?? ''}`.slice(0, 300)
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? '',
    expiryAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scope: json.scope ?? '',
  };
}

/** Swap the OAuth code for tokens and store them encrypted. */
export async function exchangeGoogleCode(code: string, origin: string): Promise<{ email: string; scope: string }> {
  const tokens = await tokenRequest({
    code,
    client_id: (process.env.AGENTSCOPE_GOOGLE_CLIENT_ID ?? '').trim(),
    client_secret: (process.env.AGENTSCOPE_GOOGLE_CLIENT_SECRET ?? '').trim(),
    redirect_uri: googleRedirectUri(origin),
    grant_type: 'authorization_code',
  });

  // who consented?
  let email = '';
  try {
    const info = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await info.json()) as { email?: string };
    email = j.email ?? '';
  } catch {
    /* email is cosmetic */
  }

  await db.connectorToken.upsert({
    where: { connector: 'google' },
    create: {
      connector: 'google',
      accountEmail: email,
      scopes: tokens.scope,
      accessTokenEnc: packSecret(encryptSecret(tokens.accessToken)),
      refreshTokenEnc: tokens.refreshToken
        ? packSecret(encryptSecret(tokens.refreshToken))
        : '',
      expiryAt: tokens.expiryAt,
    },
    update: {
      accountEmail: email || undefined,
      scopes: tokens.scope,
      accessTokenEnc: packSecret(encryptSecret(tokens.accessToken)),
      refreshTokenEnc: tokens.refreshToken
        ? packSecret(encryptSecret(tokens.refreshToken))
        : undefined,
      expiryAt: tokens.expiryAt,
    },
  });
  return { email, scope: tokens.scope };
}

async function loadTokenRow() {
  return db.connectorToken.findUnique({ where: { connector: 'google' } });
}

/**
 * A valid access token — refreshing silently when needed. Throws with a
 * human hint when the connector is not connected.
 */
export async function getGoogleAccessToken(): Promise<string> {
  const row = await loadTokenRow();
  if (!row || !row.accessTokenEnc) {
    throw new Error(
      'Google connector is not connected. System panel → Connectors → Connect Google.'
    );
  }
  const accessToken = decryptSecret(unpackSecret(row.accessTokenEnc));
  const notExpired =
    row.expiryAt && row.expiryAt.getTime() - Date.now() > 60_000;
  if (notExpired) return accessToken;

  const refreshToken = row.refreshTokenEnc
    ? decryptSecret(unpackSecret(row.refreshTokenEnc))
    : '';
  if (!refreshToken) {
    throw new Error(
      'Google refresh token missing — reconnect the connector (System panel → Connectors).'
    );
  }
  const refreshed = await tokenRequest({
    client_id: (process.env.AGENTSCOPE_GOOGLE_CLIENT_ID ?? '').trim(),
    client_secret: (process.env.AGENTSCOPE_GOOGLE_CLIENT_SECRET ?? '').trim(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  await db.connectorToken.update({
    where: { connector: 'google' },
    data: {
      accessTokenEnc: packSecret(encryptSecret(refreshed.accessToken)),
      expiryAt: refreshed.expiryAt,
      scopes: refreshed.scope || row.scopes,
    },
  });
  return refreshed.accessToken;
}

// ---------- Calendar ----------

export interface CalendarEventDto {
  id: string;
  summary: string;
  start: string | null;
  end: string | null;
  location: string;
  hangoutLink: string;
  organizer: string;
}

/** READ: upcoming events (default: next 7 days, max 25). */
export async function listCalendarEvents(opts: {
  days?: number;
  max?: number;
  query?: string;
} = {}): Promise<CalendarEventDto[]> {
  const token = await getGoogleAccessToken();
  const days = Math.min(30, Math.max(1, opts.days ?? 7));
  const max = Math.min(25, Math.max(1, opts.max ?? 10));
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    timeMax: new Date(Date.now() + days * 86_400_000).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(max),
    ...(opts.query ? { q: opts.query } : {}),
  });
  const res = await fetch(`${CALENDAR_API}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    items?: Array<{
      id?: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      location?: string;
      hangoutLink?: string;
      organizer?: { email?: string };
    }>;
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(`Calendar read failed: ${json.error?.message ?? res.status}`.slice(0, 300));
  }
  return (json.items ?? []).map((it) => ({
    id: it.id ?? '',
    summary: it.summary ?? '(no title)',
    start: it.start?.dateTime ?? it.start?.date ?? null,
    end: it.end?.dateTime ?? it.end?.date ?? null,
    location: it.location ?? '',
    hangoutLink: it.hangoutLink ?? '',
    organizer: it.organizer?.email ?? '',
  }));
}

/**
 * WRITE: create an event / reminder. ALWAYS goes through the approval gate
 * (the tool is registered 'destructive') and is audit-logged.
 */
export async function createCalendarEvent(input: {
  title: string;
  startIso: string;
  endIso?: string;
  description?: string;
  location?: string;
}): Promise<{ id: string; link: string }> {
  const token = await getGoogleAccessToken();
  const start = new Date(input.startIso);
  if (Number.isNaN(start.getTime())) throw new Error('startIso is not a valid date');
  const end = input.endIso ? new Date(input.endIso) : new Date(start.getTime() + 30 * 60_000);
  const body = {
    summary: input.title.slice(0, 300),
    description: (input.description ?? '').slice(0, 2000),
    location: (input.location ?? '').slice(0, 300),
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };
  const res = await fetch(`${CALENDAR_API}/calendars/primary/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    htmlLink?: string;
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(`Calendar write failed: ${json.error?.message ?? res.status}`.slice(0, 300));
  }
  return { id: json.id ?? '', link: json.htmlLink ?? '' };
}

// ---------- Gmail (read-only) ----------

export interface GmailMessageDto {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

function headerOf(
  msg: { payload?: { headers?: { name: string; value: string }[] } },
  name: string
): string {
  const hit = msg.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  );
  return hit?.value ?? '';
}

/** READ: recent Gmail messages (never sends, never marks as read). */
export async function listGmailMessages(opts: {
  query?: string;
  max?: number;
} = {}): Promise<GmailMessageDto[]> {
  const token = await getGoogleAccessToken();
  const max = Math.min(20, Math.max(1, opts.max ?? 10));
  const params = new URLSearchParams({
    maxResults: String(max),
    q: opts.query || 'is:inbox newer_than:3d',
  });
  const listRes = await fetch(`${GMAIL_API}/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const listJson = (await listRes.json().catch(() => ({}))) as {
    messages?: { id: string }[];
    error?: { message?: string };
  };
  if (!listRes.ok) {
    throw new Error(`Gmail read failed: ${listJson.error?.message ?? listRes.status}`.slice(0, 300));
  }
  const out: GmailMessageDto[] = [];
  for (const m of (listJson.messages ?? []).slice(0, max)) {
    const msgRes = await fetch(`${GMAIL_API}/users/me/messages/${m.id}?format=metadata`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const msg = (await msgRes.json().catch(() => ({}))) as {
      id?: string;
      snippet?: string;
      internalDate?: string;
      payload?: { headers?: { name: string; value: string }[] };
    };
    if (!msgRes.ok) continue;
    out.push({
      id: msg.id ?? m.id,
      from: headerOf(msg, 'From'),
      subject: headerOf(msg, 'Subject') || '(no subject)',
      snippet: (msg.snippet ?? '').slice(0, 300),
      date: msg.internalDate
        ? new Date(Number(msg.internalDate)).toISOString()
        : '',
    });
  }
  return out;
}

// ---------- status ----------

export interface ConnectorStatus {
  connector: 'google';
  configured: boolean;
  connected: boolean;
  accountEmail: string;
  scopes: string;
  hasWrite: boolean;
  expiryAt: string | null;
  setupHint: string;
}

export async function googleConnectorStatus(): Promise<ConnectorStatus> {
  const configured = googleOAuthConfigured();
  let row: Awaited<ReturnType<typeof loadTokenRow>> = null;
  try {
    row = await loadTokenRow();
  } catch {
    /* db not ready */
  }
  return {
    connector: 'google',
    configured,
    connected: Boolean(row?.accessTokenEnc),
    accountEmail: row?.accountEmail ?? '',
    scopes: row?.scopes ?? '',
    hasWrite: (row?.scopes ?? '').includes(GOOGLE_CALENDAR_WRITE_SCOPE),
    expiryAt: row?.expiryAt ? row.expiryAt.toISOString() : null,
    setupHint: configured
      ? ''
      : 'Set AGENTSCOPE_GOOGLE_CLIENT_ID + AGENTSCOPE_GOOGLE_CLIENT_SECRET in .env (docs/GOOGLE_CONNECTOR_SETUP.md).',
  };
}

/** Disconnect: tokens deleted locally (revoke the app at
 * myaccount.google.com/permissions to kill the refresh token at Google). */
export async function disconnectGoogle(): Promise<void> {
  await db.connectorToken.deleteMany({ where: { connector: 'google' } });
}
