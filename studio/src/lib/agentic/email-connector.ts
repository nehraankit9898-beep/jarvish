// email-connector.ts — send e-mail and meeting invites (Feature 1).
//
// Real SMTP through nodemailer. It is only ever called from host-control's
// approval gate: a send is irreversible, so it is ALWAYS destructive-class and
// waits for the user, in every mode.
//
// Success is the SMTP server's own answer, never "the call did not throw":
// every recipient must appear in `accepted` and the reply code must be 2xx.
//
// Configuration (server side only, never sent to the browser):
//   AGENTSCOPE_SMTP_URL   smtps://user:app-password@smtp.gmail.com:465
//   AGENTSCOPE_SMTP_FROM  "Your Name <you@example.com>"  (defaults to the URL user)

import { randomUUID } from 'node:crypto';

export interface MeetingInvite {
  title: string;
  /** ISO 8601 date-time, e.g. 2026-11-02T15:00:00+05:30 */
  start: string;
  end: string;
  location?: string;
  description?: string;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  body: string;
  meeting?: MeetingInvite;
}

export interface MailTransport {
  sendMail(mail: Record<string, unknown>): Promise<{
    accepted?: unknown[];
    rejected?: unknown[];
    response?: string;
    messageId?: string;
  }>;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  accepted: string[];
  rejected: string[];
  response?: string;
  error?: string;
}

const EMAIL_RE = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]{2,}$/;
const MAX_RECIPIENTS = 10;
const MAX_SUBJECT = 200;
const MAX_BODY = 100_000;

/** Returns an error message, or null when the message is acceptable. */
export function validateEmail(msg: EmailMessage): string | null {
  if (!Array.isArray(msg.to) || msg.to.length === 0) return 'at least one recipient is required';
  if (msg.to.length > MAX_RECIPIENTS) return `at most ${MAX_RECIPIENTS} recipients per message`;
  for (const addr of msg.to) {
    if (typeof addr !== 'string' || !EMAIL_RE.test(addr.trim())) return `invalid recipient address: ${String(addr).slice(0, 80)}`;
  }
  if (typeof msg.subject !== 'string' || !msg.subject.trim()) return 'subject is required';
  // header injection: a newline in the subject would let the caller add Bcc: headers
  if (/[\r\n]/.test(msg.subject)) return 'subject must be a single line';
  if (msg.subject.length > MAX_SUBJECT) return `subject longer than ${MAX_SUBJECT} characters`;
  if (typeof msg.body !== 'string' || !msg.body.trim()) return 'body is required';
  if (msg.body.length > MAX_BODY) return `body longer than ${MAX_BODY} characters`;
  if (msg.meeting) {
    const s = Date.parse(msg.meeting.start);
    const e = Date.parse(msg.meeting.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return 'meeting start/end must be ISO 8601 date-times';
    if (e <= s) return 'meeting must end after it starts';
    if (!msg.meeting.title?.trim() || /[\r\n]/.test(msg.meeting.title)) return 'meeting title must be one non-empty line';
  }
  return null;
}

// ---------- ICS (RFC 5545) ----------

function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold a content line at 75 octets, as the RFC requires. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, 'utf8') > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

export function buildIcs(meeting: MeetingInvite, attendees: string[], organizer: string, uid = `${randomUUID()}@agentscope`): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AgentScope Studio//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(meeting.start)}`,
    `DTEND:${icsDate(meeting.end)}`,
    `SUMMARY:${icsText(meeting.title)}`,
    ...(meeting.location ? [`LOCATION:${icsText(meeting.location)}`] : []),
    ...(meeting.description ? [`DESCRIPTION:${icsText(meeting.description)}`] : []),
    `ORGANIZER:mailto:${organizer}`,
    ...attendees.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${a}`),
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------- sending ----------

export function smtpConfigured(): boolean {
  return Boolean(process.env.AGENTSCOPE_SMTP_URL?.trim());
}

function senderAddress(): string {
  const explicit = process.env.AGENTSCOPE_SMTP_FROM?.trim();
  if (explicit) return explicit;
  try {
    return decodeURIComponent(new URL(process.env.AGENTSCOPE_SMTP_URL ?? '').username);
  } catch {
    return '';
  }
}

async function defaultTransport(): Promise<MailTransport> {
  const nodemailer = await import('nodemailer');
  return nodemailer.createTransport(process.env.AGENTSCOPE_SMTP_URL ?? '') as unknown as MailTransport;
}

export async function sendEmail(msg: EmailMessage, transport?: MailTransport): Promise<SendResult> {
  const invalid = validateEmail(msg);
  if (invalid) return { ok: false, accepted: [], rejected: [], error: invalid };
  if (!transport && !smtpConfigured()) {
    return { ok: false, accepted: [], rejected: [], error: 'SMTP is not configured — set AGENTSCOPE_SMTP_URL (and AGENTSCOPE_SMTP_FROM) in .env' };
  }

  const to = msg.to.map((a) => a.trim());
  const from = senderAddress();
  const mail: Record<string, unknown> = { from: from || undefined, to, subject: msg.subject, text: msg.body };
  if (msg.meeting) {
    const organizerEmail = (from.match(/<([^>]+)>/)?.[1] ?? from).trim();
    mail.icalEvent = { method: 'REQUEST', content: buildIcs(msg.meeting, to, organizerEmail) };
  }

  try {
    const t = transport ?? (await defaultTransport());
    const info = await t.sendMail(mail);
    const accepted = (info.accepted ?? []).map(String);
    const rejected = (info.rejected ?? []).map(String);
    const everyoneAccepted = to.every((a) => accepted.map((x) => x.toLowerCase()).includes(a.toLowerCase()));
    const replyOk = /^2\d\d/.test(info.response ?? '');
    const ok = everyoneAccepted && rejected.length === 0 && replyOk;
    return {
      ok,
      messageId: info.messageId,
      accepted,
      rejected,
      response: info.response,
      error: ok ? undefined : `the mail server did not confirm delivery to every recipient (accepted: ${accepted.length}/${to.length}, reply: ${info.response ?? 'none'})`,
    };
  } catch (e) {
    return { ok: false, accepted: [], rejected: [], error: (e as Error).message };
  }
}
