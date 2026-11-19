import { NextResponse } from 'next/server';
import { assessRisk, getLmsAdapter, sandboxAdapter } from '@/lib/lms/lmsAdapter';
import { MoodleLmsAdapter } from '@/lib/lms/moodleAdapter';
import { enqueue, sign } from '@/lib/engine/automation';
import {
  getCachedLearnersSnapshot,
  syncMoodleCohort,
  toLearnerCards,
  triggerWorkflowsOnAtRisk,
} from '@/lib/engine/moodleSync';
import { deleteLearnerFromDb, mergeLearnerPatchByEmailOrId, upsertSyncedLearnersToDb } from '@/lib/db/postgres';
import { getState, setLearners } from '@/lib/engine/store';
import { runWithSessionTenant } from '@/lib/auth/requestTenant';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { getTenant, getTenantIntegrations } from '@/lib/auth/accounts';
import type { SyncedLearnerRow } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  return runWithSessionTenant(req, async () => {
    const tid = currentTenantId();
    const ti = getTenantIntegrations(tid);
    const url = new URL(req.url);
    const forceSync = url.searchParams.get('sync') === '1';

    if (ti.lmsProvider === 'moodle') {
      const cached = await getCachedLearnersSnapshot(tid);

      // Normal page visit: serve saved PostgreSQL learners immediately without hitting Moodle.
      if (!forceSync && cached.learners.length > 0) {
        return NextResponse.json({
          learners: cached.learners,
          busy: getState().busy,
          lmsProvider: ti.lmsProvider,
          lmsError: null,
          diagnostics: cached.diagnostics,
          fromCache: true,
          queuedJobs: 0,
        });
      }

      // If DB is empty and ?auto=0 wasn't passed, or if explicit ?sync=1 was requested, sync Moodle safely.
      if (forceSync || url.searchParams.get('auto') !== '0') {
        const res = await syncMoodleCohort({
          forceRefresh: forceSync,
          enqueue,
          triggerOnChanges: true,
          tenantId: tid,
        });
        return NextResponse.json({
          learners: res.learners,
          busy: getState().busy,
          lmsProvider: ti.lmsProvider,
          lmsError: res.lmsError,
          diagnostics: res.diagnostics,
          fromCache: res.fromCache,
          queuedJobs: res.queuedJobs,
          changesDetected: res.changesDetected,
        });
      }

      return NextResponse.json({
        learners: cached.learners,
        busy: getState().busy,
        lmsProvider: ti.lmsProvider,
        lmsError: null,
        diagnostics: cached.diagnostics,
        fromCache: true,
        queuedJobs: 0,
      });
    }

    // Non-Moodle providers (rest / sheet / webhook / sandbox)
    const lms = getLmsAdapter(getState().settings.lmsMode);
    let students: Awaited<ReturnType<typeof lms.listStudents>> = [];
    let lmsError: string | null = null;
    try {
      students = await lms.listStudents();
    } catch (e) {
      lmsError = (e as Error).message;
      if (ti.lmsProvider !== 'rest') {
        students = await sandboxAdapter().listStudents();
      }
    }

    if (!students.length) {
      const cached = await getCachedLearnersSnapshot(tid);
      if (cached.learners.length) {
        return NextResponse.json({
          learners: cached.learners,
          busy: getState().busy,
          lmsProvider: ti.lmsProvider,
          lmsError,
          diagnostics: cached.diagnostics,
          fromCache: true,
        });
      }
    }

    const cards = new Map(getState().learners.map((l) => [l.id, l]));
    const rows: SyncedLearnerRow[] = await Promise.all(
      students.map(async (s) => {
        const [e, a] = await Promise.all([
          lms.getEngagement(s.id).catch(() => null),
          lms.getAssessments(s.id).catch(() => []),
        ]);
        const risk = e ? assessRisk(e, a) : null;
        const cur = e?.currentModule.code;
        const cp = [...a].reverse().find((x) => x.moduleCode === cur && x.kind === 'quiz') || [...a].reverse()[0] || null;
        const avgScore = a.length ? Math.round(a.reduce((sum, x) => sum + x.scorePct, 0) / a.length) : null;
        const card = cards.get(s.id);
        return {
          id: s.id,
          name: s.name,
          email: s.email,
          phone: s.phone || '',
          cohort: s.cohort,
          programme: s.programme,
          module: cur || card?.weakTopic || null,
          moduleTitle: e?.currentModule.title,
          checkpoint: cp ? cp.scorePct : (card?.quizAvg ?? null),
          avgScore,
          assessmentsCount: a.length,
          recentGrades: a.slice(0, 12).map((x) => ({
            id: x.id,
            title: x.title,
            courseName: x.courseName || x.moduleCode,
            scorePct: x.scorePct,
            passMark: x.passMark,
            passed: x.passed,
            feedback: x.feedback || null,
            missedQuestions: x.missedQuestions?.length || 0,
            takenAt: x.takenAt,
          })),
          completionPct: e?.completionPct ?? card?.completion ?? 0,
          completedActivities: e?.modulesCompleted ?? 0,
          totalActivities: e?.modulesTotal ?? 0,
          courses: e?.courses || [],
          incompleteActivities: e?.incompleteActivities || [],
          daysSinceLogin: e?.daysSinceLastLogin ?? card?.lastLoginDays ?? null,
          neverLoggedIn: Boolean(e?.neverLoggedIn),
          lastActivityAt: e?.lastActivityAt || null,
          missedClasses: e?.missedClasses ?? 0,
          missedAssignments: e?.missedAssignments ?? 0,
          paymentStatus: e?.paymentStatus ?? 'ok',
          riskScore: risk?.score ?? card?.riskScore ?? 0,
          riskBand: risk?.band ?? 'on_track',
          signals: risk?.signals || [],
          weakTopic: risk?.weakTopic || card?.weakTopic || null,
          status: card?.status || (risk?.band === 'at_risk' ? 'at_risk' : s.status) || 'on_track',
          lastEvent: card?.lastEvent || null,
          source: ti.lmsProvider || 'webhook',
        };
      }),
    );

    if (rows.length) {
      setLearners(toLearnerCards(rows));
      await upsertSyncedLearnersToDb(rows, ti.lmsProvider || 'webhook', tid);
    }

    const diagnostics = lms instanceof MoodleLmsAdapter ? lms.getDiagnostics() : null;
    return NextResponse.json({
      learners: rows,
      busy: getState().busy,
      lmsProvider: ti.lmsProvider,
      lmsError,
      diagnostics,
      fromCache: false,
    });
  });
}

export async function POST(req: Request) {
  return runWithSessionTenant(req, async () => {
    const tid = currentTenantId();
    const ti = getTenantIntegrations(tid);
    const body = (await req.json().catch(() => ({}))) as {
      action?: 'add' | 'remove' | 'import' | 'sync' | 'trigger_at_risk';
      limit?: number;
      id?: string;
      name?: string;
      cohort?: string;
      programme?: string;
      module?: string;
      checkpoint?: number | null;
      daysSinceLogin?: number | null;
      email?: string;
      phone?: string;
      rows?: Array<{
        id?: string;
        name?: string;
        email?: string;
        phone?: string;
        cohort?: string;
        programme?: string;
        module?: string;
        checkpoint?: number | null;
        daysSinceLogin?: number | null;
      }>;
    };

    if (body.action === 'trigger_at_risk') {
      const res = await triggerWorkflowsOnAtRisk(body.limit || 5, tid);
      return NextResponse.json({ ok: true, ...res });
    }

    const lms = sandboxAdapter();

    if (body.action === 'import' && Array.isArray(body.rows)) {
      let imported = 0;
      for (const r of body.rows) {
        const name = String(r.name || '').trim();
        const email = String(r.email || '').trim();
        if (name.length < 2 || !email.includes('@')) continue;
        const cp = typeof r.checkpoint === 'number' && Number.isFinite(r.checkpoint) ? r.checkpoint : null;
        const days = typeof r.daysSinceLogin === 'number' && Number.isFinite(r.daysSinceLogin) ? r.daysSinceLogin : null;
        const cohort = r.cohort?.trim() || undefined;
        const programme = r.programme?.trim() || undefined;
        const { row: merged } = await mergeLearnerPatchByEmailOrId(
          {
            id: r.id?.trim() || undefined,
            name,
            email,
            phone: r.phone?.trim() || undefined,
            cohort,
            programme,
            module: r.module?.trim() || undefined,
            checkpoint: cp,
            daysSinceLogin: days,
            lastEvent: 'CSV import merged',
            source: ti.lmsProvider || 'csv',
          },
          tid,
        );
        lms.upsertExternalLearner({
          id: merged.id,
          name: merged.name,
          email: merged.email,
          phone: merged.phone || undefined,
          cohort: merged.cohort,
          programme: merged.programme,
          moduleCode: r.module?.trim(),
          checkpoint: cp,
          daysSinceLogin: days ?? 0,
        });
        imported += 1;
      }
      if (imported > 0) {
        const snap = await getCachedLearnersSnapshot(tid);
        setLearners(toLearnerCards(snap.learners));
      }
      return NextResponse.json({ ok: true, imported });
    }

    if (body.action === 'add') {
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim();
      if (name.length < 2) return NextResponse.json({ error: 'Give the learner a name.' }, { status: 400 });
      if (!/.+@.+\..+/.test(email)) return NextResponse.json({ error: 'Give the learner a real email address.' }, { status: 400 });
      const cp = typeof body.checkpoint === 'number' && Number.isFinite(body.checkpoint) ? body.checkpoint : null;
      const days = typeof body.daysSinceLogin === 'number' && Number.isFinite(body.daysSinceLogin) ? body.daysSinceLogin : null;
      const { row: merged } = await mergeLearnerPatchByEmailOrId(
        {
          id: String(body.id || '').trim() || undefined,
          name,
          email,
          phone: String(body.phone || '').trim() || undefined,
          cohort: String(body.cohort || '').trim() || undefined,
          programme: String(body.programme || '').trim() || undefined,
          module: body.module || undefined,
          checkpoint: cp,
          daysSinceLogin: days,
          lastEvent: 'Manual entry merged',
          source: ti.lmsProvider || 'manual',
        },
        tid,
      );
      lms.upsertExternalLearner({
        id: merged.id,
        name: merged.name,
        email: merged.email,
        phone: merged.phone || undefined,
        cohort: merged.cohort,
        programme: merged.programme,
        moduleCode: body.module,
        checkpoint: cp,
        daysSinceLogin: days ?? 0,
      });
      const snap = await getCachedLearnersSnapshot(tid);
      setLearners(toLearnerCards(snap.learners));
      return NextResponse.json({ ok: true, id: merged.id });
    }

    if (body.action === 'remove' && body.id) {
      lms.remove(body.id);
      await deleteLearnerFromDb(body.id, tid);
      const snap = await getCachedLearnersSnapshot(tid);
      setLearners(toLearnerCards(snap.learners));
      return NextResponse.json({ ok: true });
    }

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
    const payload = JSON.stringify({
      event: patch.checkpoint !== undefined ? 'checkpoint.scored' : 'login.gap',
      learner_id: s.id,
      learner_name: s.name,
      email: s.email,
      cohort: s.cohort,
      data: {
        ...(patch.checkpoint !== undefined ? { checkpoint_score: patch.checkpoint, module: e?.currentModule.code } : {}),
        ...(patch.daysQuiet !== undefined ? { days_since_login: patch.daysQuiet } : {}),
      },
      sent_at: new Date().toISOString(),
    });
    const port = new URL(req.url).port || process.env.PORT || '3000';
    const tenant = getTenant(currentTenantId());
    let status = 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/lms?tenant=${encodeURIComponent(tenant.slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LMS-Signature': sign(payload, tenant.webhookSecret) },
        body: payload,
        cache: 'no-store',
      });
      status = res.status;
    } catch {
      status = 0;
    }
    return NextResponse.json({ ok: true, webhook: { status, payload: JSON.parse(payload) } });
  });
}
