import { NextResponse } from 'next/server';
import { sandboxAdapter } from '@/lib/lms/lmsAdapter';
import { sign } from '@/lib/engine/automation';
import { getState } from '@/lib/engine/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* The sandbox LMS: the learner records, and the console's edits.
 *
 * GET lists every learner as the LMS holds them. POST changes one learner's
 * record (checkpoint score, days since login, email) and then does what a
 * real LMS does: it sends a signed webhook to the colleague over HTTP. */

export async function GET() {
  const lms = sandboxAdapter();
  const students = await lms.listStudents();
  const cards = new Map(getState().learners.map((l) => [l.id, l]));
  const rows = await Promise.all(students.map(async (s) => {
    const [e, a] = await Promise.all([lms.getEngagement(s.id), lms.getAssessments(s.id)]);
    const cur = e?.currentModule.code;
    const cp = [...a].reverse().find((x) => x.moduleCode === cur && x.kind === 'quiz') || null;
    const card = cards.get(s.id);
    return {
      id: s.id, name: s.name, email: s.email, phone: s.phone || '', cohort: s.cohort, module: cur, moduleTitle: e?.currentModule.title,
      checkpoint: cp ? cp.scorePct : null, daysSinceLogin: e?.daysSinceLastLogin ?? null,
      status: card?.status || 'on_track', lastEvent: card?.lastEvent || null,
    };
  }));
  return NextResponse.json({ learners: rows, busy: getState().busy });
}

const COHORTS = ['FSWD-2026-Q3', 'DA-2026-Q3', 'CYB-2026-Q3'];

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: 'add' | 'remove' | 'demo'; hide?: boolean; id?: string; name?: string; cohort?: string; module?: string;
    checkpoint?: number | null; daysSinceLogin?: number | null; email?: string; phone?: string;
  };
  const lms = sandboxAdapter();
  if (body.action === 'add') {
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    if (name.length < 2) return NextResponse.json({ error: 'Give the learner a name.' }, { status: 400 });
    if (!/.+@.+\..+/.test(email)) return NextResponse.json({ error: 'Give the learner a real email address.' }, { status: 400 });
    const id = `ST-${Math.floor(1000 + Math.random() * 9000)}`;
    lms.addLearner({
      id, name, email, phone: String(body.phone || '').trim(), cohort: COHORTS.includes(String(body.cohort)) ? String(body.cohort) : COHORTS[0], module: body.module,
      checkpoint: typeof body.checkpoint === 'number' && Number.isFinite(body.checkpoint) ? body.checkpoint : null,
      daysSinceLogin: typeof body.daysSinceLogin === 'number' && Number.isFinite(body.daysSinceLogin) ? body.daysSinceLogin : 1,
    });
    return NextResponse.json({ ok: true, id });
  }
  if (body.action === 'remove' && body.id) { lms.remove(body.id); return NextResponse.json({ ok: true }); }
  if (body.action === 'demo') { lms.setDemoHidden(Boolean(body.hide)); return NextResponse.json({ ok: true }); }
  const s = body.id ? await lms.getStudent(body.id) : null;
  if (!s) return NextResponse.json({ error: 'Unknown learner.' }, { status: 404 });
  if (typeof body.email === 'string' && /.+@.+\..+/.test(body.email.trim())) lms.override(s.id, { email: body.email.trim() });
  if (typeof body.phone === 'string') lms.override(s.id, { phone: body.phone.trim() });
  const patch: { checkpoint?: number; daysQuiet?: number } = {};
  if (typeof body.checkpoint === 'number' && Number.isFinite(body.checkpoint)) patch.checkpoint = Math.max(0, Math.min(100, Math.round(body.checkpoint)));
  if (typeof body.daysSinceLogin === 'number' && Number.isFinite(body.daysSinceLogin)) patch.daysQuiet = Math.max(0, Math.min(90, Math.round(body.daysSinceLogin)));
  if (!Object.keys(patch).length) return NextResponse.json({ ok: true, saved: 'contact details' });
  lms.edit(s.id, patch);
  const e = await lms.getEngagement(s.id);
  // What a real LMS does next: a signed webhook, over HTTP, to the colleague.
  const payload = JSON.stringify({
    event: patch.checkpoint !== undefined ? 'checkpoint.scored' : 'login.gap',
    learner_id: s.id, learner_name: s.name,
    data: { ...(patch.checkpoint !== undefined ? { checkpoint_score: patch.checkpoint, module: e?.currentModule.code } : {}), ...(patch.daysQuiet !== undefined ? { days_since_login: patch.daysQuiet } : {}) },
    sent_at: new Date().toISOString(),
  });
  const port = new URL(req.url).port || process.env.PORT || '3200';
  let status = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/lms`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LMS-Signature': sign(payload) }, body: payload, cache: 'no-store' });
    status = res.status;
  } catch { status = 0; }
  return NextResponse.json({ ok: true, webhook: { status, payload: JSON.parse(payload) } });
}
