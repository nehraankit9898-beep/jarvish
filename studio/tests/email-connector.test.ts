// E-mail / meeting-invite tests — validation, ICS output, delivery verification, approval gate.
// Run: bun test tests/email-connector.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildIcs,
  sendEmail,
  validateEmail,
  type EmailMessage,
  type MailTransport,
} from '../src/lib/agentic/email-connector';
import {
  classifyHostAction,
  clearPendingHostActions,
  requestHostAction,
  resolveHostApproval,
} from '../src/lib/agentic/host-control';

const base: EmailMessage = { to: ['client@example.com'], subject: 'Meeting tomorrow', body: 'See you at 3.' };
const meeting = { title: 'Project sync', start: '2026-11-02T15:00:00+05:30', end: '2026-11-02T15:30:00+05:30', location: 'Google Meet' };

function fake(reply: { accepted?: string[]; rejected?: string[]; response?: string }): MailTransport & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    async sendMail(mail) {
      sent.push(mail);
      return { messageId: '<id@test>', accepted: reply.accepted ?? [], rejected: reply.rejected ?? [], response: reply.response };
    },
  };
}

describe('validation', () => {
  test('accepts a normal message', () => expect(validateEmail(base)).toBeNull());

  test('rejects bad recipients', () => {
    for (const to of [[], ['not-an-email'], ['a@b'], ['x@y.com, evil@z.com'], ['"a b"@x.com']]) {
      expect(validateEmail({ ...base, to })).not.toBeNull();
    }
  });

  test('rejects header injection through the subject', () => {
    expect(validateEmail({ ...base, subject: 'Hi\r\nBcc: attacker@evil.com' })).not.toBeNull();
  });

  test('caps the recipient count', () => {
    const many = Array.from({ length: 11 }, (_, i) => `u${i}@example.com`);
    expect(validateEmail({ ...base, to: many })).not.toBeNull();
  });

  test('meeting must end after it starts and use real dates', () => {
    expect(validateEmail({ ...base, meeting: { ...meeting, end: meeting.start } })).not.toBeNull();
    expect(validateEmail({ ...base, meeting: { ...meeting, start: 'tomorrow' } })).not.toBeNull();
    expect(validateEmail({ ...base, meeting })).toBeNull();
  });
});

describe('ICS', () => {
  const ics = buildIcs(meeting, ['client@example.com'], 'me@example.com', 'fixed-uid@agentscope');

  test('is a valid REQUEST with UTC times', () => {
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('UID:fixed-uid@agentscope');
    expect(ics).toContain('DTSTART:20261102T093000Z'); // 15:00 IST = 09:30 UTC
    expect(ics).toContain('DTEND:20261102T100000Z');
    expect(ics).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:client@example.com');
    expect(ics).toContain('ORGANIZER:mailto:me@example.com');
  });

  test('uses CRLF line endings and no line is over 75 octets', () => {
    expect(ics.includes('\r\n')).toBe(true);
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });

  test('escapes commas, semicolons and newlines in text', () => {
    const e = buildIcs({ ...meeting, title: 'a, b; c', description: 'line1\nline2' }, ['x@example.com'], 'me@example.com');
    expect(e).toContain('SUMMARY:a\\, b\\; c');
    expect(e).toContain('DESCRIPTION:line1\\nline2');
  });
});

describe('sending', () => {
  test('success needs every recipient accepted AND a 2xx reply', async () => {
    const t = fake({ accepted: ['client@example.com'], response: '250 2.0.0 OK queued' });
    const r = await sendEmail(base, t);
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe('<id@test>');
    expect(t.sent).toHaveLength(1);
  });

  test('a partially rejected message is NOT reported as success', async () => {
    const msg = { ...base, to: ['a@example.com', 'b@example.com'] };
    const r = await sendEmail(msg, fake({ accepted: ['a@example.com'], rejected: ['b@example.com'], response: '250 OK' }));
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual(['b@example.com']);
  });

  test('a non-2xx reply is NOT reported as success', async () => {
    const r = await sendEmail(base, fake({ accepted: ['client@example.com'], response: '451 try later' }));
    expect(r.ok).toBe(false);
  });

  test('a transport that throws becomes an error result, not a crash', async () => {
    const t: MailTransport = { sendMail: async () => { throw new Error('connect ECONNREFUSED'); } };
    const r = await sendEmail(base, t);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });

  test('a meeting adds an iCal REQUEST to the mail', async () => {
    const t = fake({ accepted: ['client@example.com'], response: '250 OK' });
    await sendEmail({ ...base, meeting }, t);
    const ev = t.sent[0].icalEvent as { method: string; content: string };
    expect(ev.method).toBe('REQUEST');
    expect(ev.content).toContain('SUMMARY:Project sync');
  });

  test('invalid mail never reaches the transport', async () => {
    const t = fake({});
    const r = await sendEmail({ ...base, subject: 'x\ny' }, t);
    expect(r.ok).toBe(false);
    expect(t.sent).toHaveLength(0);
  });
});

describe('approval gate', () => {
  const saved = { mode: process.env.AGENTSCOPE_HOST_MODE, dirs: process.env.AGENTSCOPE_HOST_TRUSTED_DIRS, smtp: process.env.AGENTSCOPE_SMTP_URL };
  beforeEach(() => {
    clearPendingHostActions();
    delete process.env.AGENTSCOPE_SMTP_URL;
  });
  afterEach(() => {
    for (const [k, v] of [['AGENTSCOPE_HOST_MODE', saved.mode], ['AGENTSCOPE_HOST_TRUSTED_DIRS', saved.dirs], ['AGENTSCOPE_SMTP_URL', saved.smtp]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('sending mail is destructive-class and waits for the user, even in trusted mode', async () => {
    process.env.AGENTSCOPE_HOST_MODE = 'trusted';
    process.env.AGENTSCOPE_HOST_TRUSTED_DIRS = '/';
    expect(classifyHostAction({ kind: 'email', ...base }).permission).toBe('destructive');
    const out = await requestHostAction({ kind: 'email', ...base }, 'agent');
    expect(out.status).toBe('approval_required');
  });

  test('an invalid message is refused outright', async () => {
    const out = await requestHostAction({ kind: 'email', ...base, to: ['nope'] }, 'agent');
    expect(out.status).toBe('refused');
  });

  test('approved but SMTP not configured → a clear error, nothing is claimed as sent', async () => {
    const out = await requestHostAction({ kind: 'email', ...base }, 'agent');
    if (out.status !== 'approval_required') throw new Error('unreachable');
    const res = await resolveHostApproval(out.id, true);
    expect(res.ok).toBe(true);
    expect(res.result?.ok).toBe(false);
    expect(res.result?.error).toContain('SMTP is not configured');
  });
});
