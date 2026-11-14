import { NextResponse } from 'next/server';
import { getState, log, setAutomation } from '@/lib/engine/store';
import { enqueue, ensureAutomation, verify } from '@/lib/engine/automation';
import { sandboxAdapter } from '@/lib/lms/lmsAdapter';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* The LMS calls this when a learner's record changes. Any LMS can: send JSON
 * signed with HMAC-SHA256 of the raw body in the X-LMS-Signature header
 * ("sha256=<hex>"), using LMS_WEBHOOK_SECRET. The colleague takes it from
 * there; nobody types anything.
 *
 *   { "event": "checkpoint.scored" | "login.gap", "learner_id": "MA-2041",
 *     "learner_name": "Naledi Khumalo", "data": { "checkpoint_score": 40, "days_since_login": 14 } } */

interface Body { event?: string; learner_id?: string; learner_name?: string; data?: { checkpoint_score?: number; days_since_login?: number; module?: string } }

export async function POST(req: Request) {
  ensureAutomation();
  const raw = await req.text();
  if (!verify(raw, req.headers.get('x-lms-signature'))) {
    log('lms', 'error', 'Webhook rejected: bad or missing signature.');
    return NextResponse.json({ error: 'Bad signature.' }, { status: 401 });
  }
  let body: Body;
  try { body = JSON.parse(raw) as Body; } catch { return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 }); }
  const id = String(body.learner_id || '');
  const student = await sandboxAdapter().getStudent(id);
  if (!student) return NextResponse.json({ error: `Unknown learner ${id}.` }, { status: 404 });
  const name = body.learner_name || student.name;
  const first = name.split(' ')[0];
  const d = body.data || {};
  const parts: string[] = [];
  if (typeof d.checkpoint_score === 'number') parts.push(`scored ${d.checkpoint_score}% on the ${d.module || 'current'} checkpoint`);
  if (typeof d.days_since_login === 'number') parts.push(`has not logged in for ${d.days_since_login} days`);
  const what = parts.join(' and ') || 'had their record updated';
  log('lms', 'lms', `Webhook received · ${body.event || 'learner.updated'} · ${name} ${what} · signature verified.`, { toolCall: { tool: 'lms.webhook', payload: body } });
  setAutomation({ lastEvent: { at: Date.now(), event: body.event || 'learner.updated', learner: name, detail: what }, events: (getState().automation?.events || 0) + 1 });
  const r = enqueue({
    goal: `LMS alert: ${name} ${what}. Find out why and get ${first} back on track.`,
    trigger: { kind: 'webhook', label: `LMS webhook · ${first} ${what}` },
    focus: [id],
  });
  return NextResponse.json({ accepted: true, queued: r.queued }, { status: 202 });
}

export async function GET() {
  return NextResponse.json({ endpoint: '/api/webhooks/lms', method: 'POST', signature: 'X-LMS-Signature: sha256=<hmac of raw body>', events: ['checkpoint.scored', 'login.gap'] });
}
