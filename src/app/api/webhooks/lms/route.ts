import { NextResponse } from 'next/server';
import type { MissedQuestion, WorkflowTrigger } from '@/lib/types';
import { getState, log, setAutomation } from '@/lib/engine/store';
import { bootReady, enqueue, ensureAutomation, verify } from '@/lib/engine/automation';
import { dispatchLmsEvent } from '@/lib/engine/agentTriggers';
import { getLmsAdapter, sandboxAdapter } from '@/lib/lms/lmsAdapter';
import { renderWorkflowGoal, workflowsForTrigger } from '@/lib/engine/workflows';
import { markFollowUpRecovered } from '@/lib/engine/followups';
import { findSyncedLearnerByEmailOrId, mergeLearnerPatchByEmailOrId, recordLmsEvent } from '@/lib/db/postgres';
import { setLearner } from '@/lib/engine/store';
import { runWithWebhookTenant } from '@/lib/auth/requestTenant';
import { getTenant } from '@/lib/auth/accounts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* The LMS (Moodle, Melsoft attendance tracker, billing sheet) calls this when
 * a learner event happens. Sign JSON with HMAC-SHA256 in X-LMS-Signature
 * ("sha256=<hex>") using LMS_WEBHOOK_SECRET, and Thuso routes it to the
 * matching workflow office. */

interface RawMissedQuestion {
  prompt?: string;
  givenAnswer?: string;
  given_answer?: string;
  correctAnswer?: string;
  correct_answer?: string;
  topic?: string;
}

interface Body {
  event?: string;
  learner_id?: string;
  learner_name?: string;
  email?: string;
  learner_email?: string;
  phone?: string;
  cohort?: string;
  programme?: string;
  data?: {
    checkpoint_score?: number;
    days_since_login?: number;
    missed_classes?: number;
    missed_assignments?: number;
    payment_status?: 'ok' | 'overdue' | 'arrangement';
    module?: string;
    session_name?: string;
    missed_questions?: RawMissedQuestion[];
  };
}

function normalizeMissedQuestions(raw?: RawMissedQuestion[]): MissedQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q) => typeof q?.prompt === 'string' && q.prompt.trim().length > 0)
    .slice(0, 8)
    .map((q) => ({
      prompt: q.prompt!.trim(),
      givenAnswer: (q.givenAnswer || q.given_answer || '').trim() || undefined,
      correctAnswer: (q.correctAnswer || q.correct_answer || '').trim() || undefined,
      topic: q.topic?.trim() || undefined,
    }));
}

function inferTrigger(event: string | undefined, d: NonNullable<Body['data']>): WorkflowTrigger {
  const ev = (event || '').toLowerCase();
  if (ev.includes('attendance') || (typeof d.missed_classes === 'number' && d.missed_classes > 0)) return 'attendance.missed';
  if (ev.includes('assignment') || (typeof d.missed_assignments === 'number' && d.missed_assignments > 0)) return 'assignment.missed';
  if (ev.includes('payment') || d.payment_status === 'overdue') return 'payment.overdue';
  if (ev.includes('login') || typeof d.days_since_login === 'number') return 'login.gap';
  if (ev.includes('quiz') || ev.includes('checkpoint') || typeof d.checkpoint_score === 'number') return 'quiz.failed';
  return 'manual';
}

export async function POST(req: Request) {
  return runWithWebhookTenant(req, async (tid) => {
    ensureAutomation();
    const raw = await req.text();
    const tenant = getTenant(tid);
    if (!verify(raw, req.headers.get('x-lms-signature'), tenant.webhookSecret)) {
      log('lms', 'error', 'Webhook rejected: bad or missing signature.');
      return NextResponse.json({ error: 'Bad signature.' }, { status: 401 });
    }
    let body: Body;
    try { body = JSON.parse(raw) as Body; } catch { return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 }); }
    const rawId = String(body.learner_id || '').trim();
    const rawEmail = String(body.email || body.learner_email || (rawId.includes('@') ? rawId : '')).trim();
    const id = rawId || rawEmail;
    if (!id) return NextResponse.json({ error: 'learner_id or email is required.' }, { status: 400 });
    const d = body.data || {};
    const adapter = getLmsAdapter(getState().settings.lmsMode);

    // Resolve existing learner in PostgreSQL by email first (so webhook updates Moodle/DB students without duplicating)
    const dbMatch = await findSyncedLearnerByEmailOrId(rawEmail || undefined, rawId || undefined, tid);
    const canonicalId = dbMatch?.id || rawId || rawEmail;

    let student = await adapter.getStudent(canonicalId).catch(() => null);
    if (!student && dbMatch) {
      student = {
        id: dbMatch.id,
        name: dbMatch.name,
        email: dbMatch.email,
        phone: dbMatch.phone || undefined,
        cohort: dbMatch.cohort,
        programme: dbMatch.programme || 'Enrolled Programme',
        programmeCode: (dbMatch.cohort || 'GEN').split(/[-_\s]/)[0],
        enrolledAt: new Date().toISOString(),
        status: (dbMatch.status as 'on_track' | 'at_risk' | 'intervention' | 'recovered') || 'on_track',
      };
    }
    if (student || body.learner_name || rawEmail) {
      const { row: merged } = await mergeLearnerPatchByEmailOrId(
        {
          id: canonicalId,
          name: body.learner_name || student?.name || rawEmail.split('@')[0] || canonicalId,
          email: rawEmail || student?.email || undefined,
          phone: body.phone?.trim() || student?.phone || undefined,
          cohort: body.cohort?.trim() || student?.cohort,
          programme: body.programme?.trim() || student?.programme,
          module: d.module,
          checkpoint: typeof d.checkpoint_score === 'number' ? d.checkpoint_score : null,
          daysSinceLogin: typeof d.days_since_login === 'number' ? d.days_since_login : null,
          missedClasses: typeof d.missed_classes === 'number' ? d.missed_classes : null,
          missedAssignments: typeof d.missed_assignments === 'number' ? d.missed_assignments : null,
          paymentStatus: d.payment_status || null,
          lastEvent: `Webhook · ${body.event || 'learner.updated'}`,
          source: dbMatch?.source || 'webhook',
        },
        tid,
      );
      setLearner(merged.id, {
        riskScore: merged.riskScore ?? 0,
        quizAvg: merged.avgScore ?? merged.checkpoint ?? 0,
        lastLoginDays: merged.daysSinceLogin ?? 0,
        lastEvent: merged.lastEvent ?? null,
      });
      if (adapter.mode === 'sandbox') {
        sandboxAdapter().upsertExternalLearner({
          id: merged.id,
          name: merged.name,
          email: merged.email,
          phone: merged.phone || undefined,
          cohort: merged.cohort,
          programme: merged.programme,
          moduleCode: d.module,
          checkpoint: typeof d.checkpoint_score === 'number' ? d.checkpoint_score : null,
          daysSinceLogin: typeof d.days_since_login === 'number' ? d.days_since_login : null,
          missedClasses: typeof d.missed_classes === 'number' ? d.missed_classes : null,
          missedAssignments: typeof d.missed_assignments === 'number' ? d.missed_assignments : null,
          paymentStatus: d.payment_status || null,
        });
        student = await adapter.getStudent(merged.id);
      } else if (!student) {
        student = {
          id: merged.id,
          name: merged.name,
          email: merged.email,
          phone: merged.phone || undefined,
          cohort: merged.cohort,
          programme: merged.programme || 'Enrolled Programme',
          programmeCode: (merged.cohort || 'GEN').split(/[-_\s]/)[0],
          enrolledAt: new Date().toISOString(),
          status: 'on_track',
        };
      }
    }
    if (!student) return NextResponse.json({ error: `Unknown learner ${id}. Include learner_name and email in the webhook to enroll automatically.` }, { status: 404 });

  const name = body.learner_name || student.name;
  const first = name.split(' ')[0];
  const missedQuestions = normalizeMissedQuestions(d.missed_questions);

  const parts: string[] = [];
  if (typeof d.checkpoint_score === 'number') parts.push(`scored ${d.checkpoint_score}% on the ${d.module || 'current'} checkpoint`);
  if (typeof d.missed_classes === 'number') parts.push(`missed ${d.missed_classes} class${d.missed_classes === 1 ? '' : 'es'}${d.session_name ? ` (${d.session_name})` : ''}`);
  if (typeof d.missed_assignments === 'number') parts.push(`has ${d.missed_assignments} missed assignment${d.missed_assignments === 1 ? '' : 's'}`);
  if (d.payment_status === 'overdue') parts.push('has an overdue tuition payment flag');
  if (typeof d.days_since_login === 'number') parts.push(`has not logged in for ${d.days_since_login} days`);
  if (missedQuestions.length) parts.push(`missed ${missedQuestions.length} specific quiz question${missedQuestions.length === 1 ? '' : 's'}`);
  const what = parts.join(' and ') || 'had their record updated';

  log('lms', 'lms', `Webhook received · ${body.event || 'learner.updated'} · ${name} ${what} · signature verified.`, { toolCall: { tool: 'lms.webhook', payload: body } });
  void recordLmsEvent({
    learnerId: id,
    eventType: body.event || 'learner.updated',
    source: 'webhook',
    moduleCode: d.module || null,
    scorePct: typeof d.checkpoint_score === 'number' ? d.checkpoint_score : null,
    daysSinceLogin: typeof d.days_since_login === 'number' ? d.days_since_login : null,
    missedClasses: typeof d.missed_classes === 'number' ? d.missed_classes : null,
    missedAssignments: typeof d.missed_assignments === 'number' ? d.missed_assignments : null,
    paymentStatus: d.payment_status || null,
    missedQuestions,
    detail: what,
    rawPayload: body,
  });
  setAutomation({ lastEvent: { at: Date.now(), event: body.event || 'learner.updated', learner: name, detail: what }, events: (getState().automation?.events || 0) + 1 });

  if (d.payment_status === 'ok' || (typeof d.checkpoint_score === 'number' && d.checkpoint_score >= 70 && !d.missed_classes && !d.missed_assignments)) {
    markFollowUpRecovered(id);
    return NextResponse.json({ accepted: true, queued: false, recovered: true }, { status: 202 });
  }

  const wfTrigger = inferTrigger(body.event, d);

  // Department agents first: an agent whose trigger is this LMS event takes it.
  const agentFields: Record<string, string> = {
    id: student.id,
    programme: student.programme || '',
    cohort: student.cohort || '',
    ...(d.module ? { module: d.module } : {}),
    ...(typeof d.checkpoint_score === 'number' ? { score: String(d.checkpoint_score), checkpoint_score: String(d.checkpoint_score) } : {}),
    ...(typeof d.days_since_login === 'number' ? { days_since_login: String(d.days_since_login) } : {}),
    ...(typeof d.missed_classes === 'number' ? { missed_classes: String(d.missed_classes) } : {}),
    ...(typeof d.missed_assignments === 'number' ? { missed_assignments: String(d.missed_assignments) } : {}),
    ...(d.session_name ? { session_name: d.session_name } : {}),
    ...(missedQuestions.length ? { missed_questions: missedQuestions.map((q) => q.prompt).join(' | ').slice(0, 800) } : {}),
  };
  await bootReady(tid);
  const agentsStarted = await dispatchLmsEvent(
    wfTrigger,
    { id: student.id, name, email: student.email || '', phone: student.phone || body.phone || '', fields: agentFields },
    `LMS event: ${first} ${what}`,
  );
  if (agentsStarted > 0) {
    return NextResponse.json({ accepted: true, queued: true, agents: agentsStarted, tenant: tenant.slug }, { status: 202 });
  }

  const wf = workflowsForTrigger(wfTrigger)[0] || workflowsForTrigger('manual')[0];
  const goal = wf
    ? renderWorkflowGoal(wf, {
        name,
        first,
        module: d.module || 'current module',
        score: typeof d.checkpoint_score === 'number' ? d.checkpoint_score : '',
        days: typeof d.days_since_login === 'number' ? d.days_since_login : '',
        detail: what,
      })
    : `LMS alert: ${name} ${what}. Find out why and get ${first} back on track.`;

  const r = enqueue({
    goal,
    trigger: { kind: wf ? 'workflow' : 'webhook', label: wf ? `${wf.officeName || wf.name} · ${first}` : `LMS webhook · ${first} ${what}` },
    focus: [id],
    workflowId: wf?.id,
    workflowInstructions: wf?.instructions,
    missedQuestions: missedQuestions.length ? missedQuestions : undefined,
  });
  return NextResponse.json({ accepted: true, queued: r.queued, workflow: wf?.id || null, tenant: tenant.slug }, { status: 202 });
  });
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/webhooks/lms',
    method: 'POST',
    signature: 'X-LMS-Signature: sha256=<hmac of raw body>',
    events: ['checkpoint.scored', 'quiz.failed', 'moodle.quiz_attempt_submitted', 'attendance.missed', 'assignment.missed', 'payment.overdue', 'login.gap'],
  });
}
