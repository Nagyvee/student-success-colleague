import { NextResponse } from 'next/server';
import { runWithInboundAuth, runWithWebhookTenant } from '@/lib/auth/requestTenant';
import { handleInboundStudentReply } from '@/lib/engine/inboundReply';
import { dispatchReply } from '@/lib/engine/agentTriggers';
import { sessionFromRequest } from '@/lib/auth/accounts';
import { findRecordsByEmail } from '@/lib/data/records';
import { LEADS_SOURCE_ID } from '@/lib/data/sources';
import { appendMailReply, getState } from '@/lib/engine/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* Inbound Email Reply Webhook
 * Accepts POST payloads from email forwarders (SendGrid Inbound Parse, Mailgun, Postmark,
 * Google Apps Script / Gmail filter, Zapier/Make) or the in-app "Log Student Reply" modal.
 */

export async function POST(req: Request) {
  // Email forwarders send the workspace inbound token; the in-app modal sends the staff session.
  return runWithInboundAuth(req, async (tid) => {
    try {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const rawFrom = String(body.from || body.email || body.fromEmail || body.sender || '').trim();
      // Extract email if formatted as "Name <email@domain.com>"
      const match = rawFrom.match(/<([^>]+)>/);
      const fromEmail = (match ? match[1] : rawFrom).trim().toLowerCase();
      const fromName = String(body.fromName || body.name || (match ? rawFrom.replace(/<[^>]+>/, '').trim() : '') || '').trim();
      const subject = String(body.subject || '').trim();
      const text = String(body.text || body.body || body.strippedText || body['stripped-text'] || body.message || '').trim();

      if (!fromEmail || !text) {
        return NextResponse.json(
          { ok: false, error: 'Both `from` (or `email`) and `text` (or `body`) are required.' },
          { status: 400 },
        );
      }

      // Department agents hear the reply too: follow-up loops for this person stop, and reply-driven agents start.
      // A reply typed into the Inbox by a signed-in person is a test: it runs even with autopilot off.
      const manual = Boolean(sessionFromRequest(req));
      const agentsStarted = await dispatchReply(fromEmail, text, fromName || undefined, { subject: subject || undefined, manual }).catch(() => 0);

      // A lead (not a student) is answered by Admissions only; the student flow would treat them as enrolled.
      const isLead = findRecordsByEmail(fromEmail).some((r) => r.sourceId === LEADS_SOURCE_ID);
      const isLearner = getState().learners.some((l) => l.email.toLowerCase() === fromEmail);
      if (isLead && !isLearner) {
        appendMailReply(fromEmail, { from: `${fromName || fromEmail} <${fromEmail}>`, text, ts: Date.now() });
        return NextResponse.json({
          ok: true,
          agentsStarted,
          note: agentsStarted ? 'Passed to Admissions: the answer appears in the Inbox.' : 'Noted on the lead. No Admissions agent answers replies right now (check that Thabo is on).',
        });
      }
      // A student a department agent is answering (Student Support): the older reply flow would answer twice.
      if (agentsStarted && isLearner) {
        appendMailReply(fromEmail, { from: `${fromName || fromEmail} <${fromEmail}>`, text, ts: Date.now() });
        return NextResponse.json({ ok: true, agentsStarted, note: 'Passed to Student Support: the answer appears in the Inbox.' });
      }
      const result = await handleInboundStudentReply({
        fromEmail,
        fromName: fromName || undefined,
        subject: subject || undefined,
        text,
        tenantId: tid,
      });
      if (agentsStarted && result.ok) return NextResponse.json({ ...result, agentsStarted });
      if (agentsStarted && !result.ok) return NextResponse.json({ ok: true, agentsStarted, note: 'Passed to the department agents.' });

      if (!result.ok) {
        return NextResponse.json(result, { status: 400 });
      }
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: (e as Error).message || 'Inbound reply processing failed.' },
        { status: 500 },
      );
    }
  });
}

export async function GET(req: Request) {
  return runWithWebhookTenant(req, async (tid) => {
    return NextResponse.json({
      endpoint: '/api/webhooks/email-reply',
      tenantId: tid,
      accepts: {
        from: 'student@example.com (or "Student Name <student@example.com>")',
        subject: 'Re: Checking in on your progress',
        text: 'Student reply body text',
      },
    });
  });
}

