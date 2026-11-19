import type { LearnerCard, MissedQuestion, SyncedLearnerRow, WorkflowTrigger } from '@/lib/types';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { assessRisk, getLmsAdapter, type AssessmentRecord, type EngagementMetrics } from '@/lib/lms/lmsAdapter';
import { MoodleLmsAdapter, type MoodleDiagnostics } from '@/lib/lms/moodleAdapter';
import {
  loadMoodleSyncMetaFromDb,
  loadSyncedLearnersFromDb,
  recordLmsEvent,
  saveMoodleSyncMetaToDb,
  upsertSyncedLearnersToDb,
} from '@/lib/db/postgres';
import { getState, log, setAutomation, setLearners } from './store';
import { saveGradebooks, saveRoster, savedRoster } from '@/lib/lms/gradebook';
import { renderWorkflowGoal, workflowsForTrigger } from './workflows';

export interface MoodleSyncResult {
  learners: SyncedLearnerRow[];
  lmsError: string | null;
  diagnostics: (MoodleDiagnostics & { lastSyncedAt?: number | null }) | null;
  fromCache: boolean;
  queuedJobs: number;
  changesDetected: number;
}

type EnqueueFn = (job: {
  goal: string;
  trigger: { kind: 'workflow' | 'webhook'; label: string };
  focus?: string[];
  workflowId?: string;
  workflowInstructions?: string;
  missedQuestions?: MissedQuestion[];
}) => unknown;

const g = globalThis as unknown as {
  __thusoMoodleInFlight?: Map<string, Promise<MoodleSyncResult>>;
  __thusoSyncDedup?: Map<string, number>;
};

function dedupKey(tenantId: string, learnerId: string, trigger: WorkflowTrigger) {
  return `${tenantId}:${learnerId}:${trigger}`;
}

function recentlyTriggered(tenantId: string, learnerId: string, trigger: WorkflowTrigger, windowMs = 12 * 3600_000): boolean {
  if (!g.__thusoSyncDedup) g.__thusoSyncDedup = new Map();
  const ts = g.__thusoSyncDedup.get(dedupKey(tenantId, learnerId, trigger));
  return Boolean(ts && Date.now() - ts < windowMs);
}

function markTriggered(tenantId: string, learnerId: string, trigger: WorkflowTrigger) {
  if (!g.__thusoSyncDedup) g.__thusoSyncDedup = new Map();
  g.__thusoSyncDedup.set(dedupKey(tenantId, learnerId, trigger), Date.now());
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

export function cardsToSyncedRows(cards: LearnerCard[]): SyncedLearnerRow[] {
  return cards.map((l) => ({
    id: l.id,
    name: l.name,
    email: l.email,
    phone: '',
    cohort: l.cohort,
    programme: l.programme,
    module: l.weakTopic || null,
    checkpoint: l.quizAvg ?? null,
    avgScore: l.quizAvg ?? null,
    completionPct: l.completion ?? 0,
    daysSinceLogin: l.lastLoginDays ?? 0,
    riskScore: l.riskScore ?? 0,
    riskBand: l.riskScore >= 60 ? 'at_risk' : l.riskScore >= 35 ? 'watch' : 'on_track',
    weakTopic: l.weakTopic || null,
    status: l.status || 'on_track',
    lastEvent: l.lastEvent || null,
    source: 'db',
  }));
}

export function toLearnerCards(rows: SyncedLearnerRow[]): LearnerCard[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    cohort: r.cohort,
    programme: r.programme || 'Enrolled Programme',
    status:
      r.status === 'intervention' || r.status === 'recovered' || r.status === 'at_risk'
        ? r.status
        : r.riskBand === 'at_risk'
          ? 'at_risk'
          : 'on_track',
    riskScore: r.riskScore ?? 0,
    weakTopic: r.weakTopic || r.moduleTitle || null,
    lastLoginDays: r.daysSinceLogin ?? 0,
    completion: r.completionPct ?? 0,
    quizAvg: r.avgScore ?? r.checkpoint ?? 0,
    lastEvent: r.lastEvent || null,
  }));
}

export async function getCachedLearnersSnapshot(tenantId = currentTenantId()): Promise<{
  learners: SyncedLearnerRow[];
  diagnostics: (MoodleDiagnostics & { lastSyncedAt?: number | null }) | null;
}> {
  const [dbRows, meta] = await Promise.all([
    loadSyncedLearnersFromDb(tenantId),
    loadMoodleSyncMetaFromDb(tenantId),
  ]);
  if (dbRows.length) {
    return {
      learners: dbRows,
      diagnostics: (meta?.diagnostics as MoodleDiagnostics & { lastSyncedAt?: number | null }) || null,
    };
  }
  // No database: the last full sync saved in Thuso (courses, groups, grades, progress), not the short summary.
  const saved = savedRoster(tenantId);
  if (saved.rows.length) {
    return {
      learners: saved.rows,
      diagnostics: (meta?.diagnostics as MoodleDiagnostics & { lastSyncedAt?: number | null }) || (saved.syncedAt ? { coursesFound: new Set(saved.rows.flatMap((r) => (r.courses || []).map((c) => c.id))).size, studentsFound: saved.rows.length, lastSyncAt: saved.syncedAt, lastSyncedAt: saved.syncedAt, lastError: null, warnings: [] } : null),
    };
  }
  const stateCards = getState().learners;
  return {
    learners: cardsToSyncedRows(stateCards),
    diagnostics: (meta?.diagnostics as MoodleDiagnostics & { lastSyncedAt?: number | null }) || null,
  };
}

function effectiveActivityTiming(e: EngagementMetrics | null, assessments: AssessmentRecord[]) {
  const timestamps: number[] = [];
  if (e?.lastActivityAt) {
    const ms = Date.parse(e.lastActivityAt);
    if (Number.isFinite(ms) && ms > 0) timestamps.push(ms);
  }
  for (const a of assessments) {
    if (!a.takenAt) continue;
    const ms = Date.parse(a.takenAt);
    if (Number.isFinite(ms) && ms > 0) timestamps.push(ms);
  }
  const maxMs = timestamps.length ? Math.max(...timestamps) : 0;
  if (maxMs > 0) {
    const days = Math.max(0, Math.floor((Date.now() - maxMs) / 86_400_000));
    return {
      lastActivityAt: new Date(maxMs).toISOString(),
      neverLoggedIn: false,
      daysSinceActivity: days,
    };
  }
  return {
    lastActivityAt: e?.lastActivityAt || null,
    neverLoggedIn: Boolean(e?.neverLoggedIn ?? true),
    daysSinceActivity: e?.daysSinceLastLogin ?? 30,
  };
}

function classifyRowChange(
  prev: SyncedLearnerRow | undefined,
  curr: SyncedLearnerRow,
  inactivityThreshold: number,
): { trigger: WorkflowTrigger; reason: string; severity: number } | null {
  const currScore = curr.avgScore ?? curr.checkpoint ?? null;
  const prevScore = prev ? (prev.avgScore ?? prev.checkpoint ?? null) : null;
  const currDays = curr.daysSinceLogin ?? 0;
  const prevDays = prev ? (prev.daysSinceLogin ?? 0) : null;
  const currMissed = curr.missedAssignments ?? 0;
  const prevMissed = prev ? (prev.missedAssignments ?? 0) : 0;

  if (!prev) {
    if (currScore !== null && currScore < 60) {
      return {
        trigger: 'quiz.failed',
        reason: `scored ${currScore}% (${curr.weakTopic || curr.moduleTitle || curr.cohort})`,
        severity: (curr.riskScore ?? 60) + (60 - currScore),
      };
    }
    if (currMissed > 0) {
      return {
        trigger: 'assignment.missed',
        reason: `${currMissed} overdue assignment(s)`,
        severity: (curr.riskScore ?? 50) + currMissed * 10,
      };
    }
    if (currDays >= inactivityThreshold && !curr.neverLoggedIn) {
      return {
        trigger: 'login.gap',
        reason: `${currDays} days since last activity`,
        severity: (curr.riskScore ?? 40) + Math.min(30, currDays),
      };
    }
    if ((curr.riskScore ?? 0) >= 65) {
      return {
        trigger: 'quiz.failed',
        reason: `flagged at risk (${curr.riskScore}/100)`,
        severity: curr.riskScore ?? 65,
      };
    }
    return null;
  }

  // Incremental change detection compared to previously persisted PostgreSQL state
  if (
    currScore !== null &&
    currScore < 60 &&
    (prevScore === null || prevScore >= 60 || currScore <= prevScore - 5)
  ) {
    return {
      trigger: 'quiz.failed',
      reason:
        prevScore !== null
          ? `score dropped ${prevScore}% -> ${currScore}%`
          : `new score ${currScore}% below pass mark`,
      severity: 90 + (60 - currScore),
    };
  }

  if (currMissed > prevMissed) {
    return {
      trigger: 'assignment.missed',
      reason: `overdue assignments increased ${prevMissed} -> ${currMissed}`,
      severity: 80 + currMissed * 5,
    };
  }

  if (
    currDays >= inactivityThreshold &&
    (prevDays === null || prevDays < inactivityThreshold || currDays >= prevDays + 3)
  ) {
    return {
      trigger: 'login.gap',
      reason: `${currDays} days since last activity (was ${prevDays ?? 'unknown'}d)`,
      severity: 65 + Math.min(30, currDays),
    };
  }

  return null;
}

function selectWorkflow(trigger: WorkflowTrigger) {
  const candidates = workflowsForTrigger(trigger);
  if (trigger === 'assignment.missed') {
    const academic = candidates.find((w) => w.domain !== 'finance' && w.trigger === 'assignment.missed');
    if (academic) return academic;
    return workflowsForTrigger('quiz.failed')[0] || null;
  }
  return candidates[0] || null;
}

export async function queueRowsForWorkflows(
  candidates: { row: SyncedLearnerRow; trigger: WorkflowTrigger; reason: string; missedQuestions?: MissedQuestion[] }[],
  tenantId: string,
  enqueue: EnqueueFn,
  cap: number,
  sourceLabel: string,
): Promise<number> {
  if (!candidates.length || cap <= 0) return 0;

  const state = getState();
  const pendingIds = new Set(
    (state.pendingOutreach || []).filter((p) => p.status === 'pending').map((p) => p.learnerId),
  );

  let queued = 0;
  for (const item of candidates) {
    if (queued >= cap) break;
    const { row, trigger, reason } = item;
    if (row.status === 'intervention' || row.status === 'recovered' || pendingIds.has(row.id)) {
      continue;
    }
    if (recentlyTriggered(tenantId, row.id, trigger)) continue;

    const wf = selectWorkflow(trigger);
    const first = row.name.split(' ')[0];
    const moduleLabel = row.weakTopic || row.module || row.cohort;
    const score = row.avgScore ?? row.checkpoint ?? '';
    const days = row.daysSinceLogin ?? '';

    const goal = wf
      ? renderWorkflowGoal(wf, {
          name: row.name,
          first,
          module: moduleLabel,
          score,
          days,
          detail: reason,
        })
      : `${sourceLabel}: ${row.name} (${row.cohort}) — ${reason}. Check ${first}'s latest LMS work and send a helpful intervention.`;

    markTriggered(tenantId, row.id, trigger);
    row.lastEvent = reason;

    void recordLmsEvent({
      tenantId,
      learnerId: row.id,
      eventType: `moodle.${trigger}`,
      source: 'moodle',
      moduleCode: row.module || null,
      scorePct: typeof score === 'number' ? score : null,
      daysSinceLogin: typeof days === 'number' ? days : null,
      missedAssignments: row.missedAssignments ?? 0,
      paymentStatus: row.paymentStatus || 'ok',
      detail: reason,
      rawPayload: { source: sourceLabel, trigger, reason },
    });

    enqueue({
      goal,
      trigger: {
        kind: wf ? 'workflow' : 'webhook',
        label: wf ? `${wf.officeName || wf.name} · ${first}` : `Moodle · ${first}: ${reason}`,
      },
      focus: [row.id],
      workflowId: wf?.id,
      workflowInstructions: wf?.instructions,
      missedQuestions: item.missedQuestions,
    });

    setAutomation({
      lastEvent: { at: Date.now(), event: `moodle.${trigger}`, learner: row.name, detail: reason },
      events: (getState().automation?.events || 0) + 1,
    });
    queued += 1;
  }

  return queued;
}

export async function syncMoodleCohort(options: {
  forceRefresh?: boolean;
  enqueue?: EnqueueFn;
  triggerOnChanges?: boolean;
  tenantId?: string;
} = {}): Promise<MoodleSyncResult> {
  const tenantId = options.tenantId || currentTenantId();
  if (!g.__thusoMoodleInFlight) g.__thusoMoodleInFlight = new Map();
  const existing = g.__thusoMoodleInFlight.get(tenantId);
  if (existing) return existing;

  const task = (async (): Promise<MoodleSyncResult> => {
    try {
      const ti = getTenantIntegrations(tenantId);
      const lms = getLmsAdapter(getState().settings.lmsMode);
      if (options.forceRefresh && lms instanceof MoodleLmsAdapter) {
        lms.forceRefresh();
      }

      const prevSnapshot = await getCachedLearnersSnapshot(tenantId);
      const prevMap = new Map(prevSnapshot.learners.map((l) => [l.id, l]));
      const stateCards = new Map(getState().learners.map((l) => [l.id, l]));

      let students: Awaited<ReturnType<typeof lms.listStudents>> = [];
      let lmsError: string | null = null;
      try {
        students = await lms.listStudents();
      } catch (e) {
        lmsError = (e as Error).message;
      }

      // If live Moodle failed or returned empty while DB already has synced learners, keep DB data!
      if ((!students.length || lmsError) && prevSnapshot.learners.length > 0 && ti.lmsProvider === 'moodle') {
        return {
          learners: prevSnapshot.learners,
          lmsError: lmsError || 'Moodle returned no roster entries; displaying saved PostgreSQL records.',
          diagnostics: prevSnapshot.diagnostics,
          fromCache: true,
          queuedJobs: 0,
          changesDetected: 0,
        };
      }

      const missedQuestionsByLearner = new Map<string, MissedQuestion[]>();

      const rows = await mapWithConcurrency(students, 5, async (s): Promise<SyncedLearnerRow> => {
        const [e, a] = await Promise.all([
          lms.getEngagement(s.id).catch(() => null),
          // Stage 1: concise gradebook summary only — missed quiz questions are fetched lazily when coaching a specific student.
          lms.getAssessments(s.id, { includeMissedQuestions: false }).catch(() => []),
        ]);

        const activity = effectiveActivityTiming(e, a);
        const effEngagement: EngagementMetrics | null = e
          ? {
              ...e,
              daysSinceLastLogin: activity.daysSinceActivity,
              neverLoggedIn: activity.neverLoggedIn,
              lastActivityAt: activity.lastActivityAt || e.lastActivityAt,
              loginStreakDays: activity.neverLoggedIn ? 0 : activity.daysSinceActivity <= 1 ? 3 : 0,
            }
          : null;

        const risk = effEngagement ? assessRisk(effEngagement, a) : null;
        const cur = effEngagement?.currentModule.code;
        const cp = [...a].reverse().find((x) => x.moduleCode === cur && x.kind === 'quiz') || [...a].reverse()[0] || null;
        const avgScore = a.length ? Math.round(a.reduce((sum, x) => sum + x.scorePct, 0) / a.length) : null;
        const prevCard = stateCards.get(s.id);
        const prevRow = prevMap.get(s.id);

        const failedWithQs = a.find((x) => !x.passed && x.missedQuestions?.length);
        if (failedWithQs?.missedQuestions?.length) {
          missedQuestionsByLearner.set(s.id, failedWithQs.missedQuestions);
        }

        const preservedStatus =
          prevCard && (prevCard.status === 'intervention' || prevCard.status === 'recovered')
            ? prevCard.status
            : risk?.band === 'at_risk'
              ? 'at_risk'
              : s.status || 'on_track';

        return {
          id: s.id,
          name: s.name,
          email: s.email,
          phone: s.phone || prevRow?.phone || '',
          cohort: s.cohort,
          programme: s.programme,
          module: cur || prevRow?.module || prevCard?.weakTopic || null,
          moduleTitle: effEngagement?.currentModule.title,
          checkpoint: cp ? cp.scorePct : (prevCard?.quizAvg ?? prevRow?.checkpoint ?? null),
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
          completionPct: effEngagement?.completionPct ?? prevCard?.completion ?? 0,
          completedActivities: effEngagement?.modulesCompleted ?? 0,
          totalActivities: effEngagement?.modulesTotal ?? 0,
          courses: effEngagement?.courses || [],
          incompleteActivities: effEngagement?.incompleteActivities || [],
          nextDue: effEngagement?.upcoming?.[0] || null,
          groups: s.groups ?? prevRow?.groups ?? [],
          daysSinceLogin: effEngagement ? activity.daysSinceActivity : (prevCard?.lastLoginDays ?? null),
          neverLoggedIn: Boolean(effEngagement ? activity.neverLoggedIn : prevRow?.neverLoggedIn),
          lastActivityAt: activity.lastActivityAt,
          missedClasses: effEngagement?.missedClasses ?? 0,
          missedAssignments: effEngagement?.missedAssignments ?? 0,
          paymentStatus: effEngagement?.paymentStatus ?? 'ok',
          riskScore: risk?.score ?? prevCard?.riskScore ?? 0,
          riskBand: risk?.band ?? 'on_track',
          signals: risk?.signals || [],
          weakTopic: risk?.weakTopic || prevCard?.weakTopic || null,
          status: preservedStatus,
          lastEvent: prevCard?.lastEvent || prevRow?.lastEvent || null,
          source: ti.lmsProvider || 'moodle',
        };
      });

      const baseDiag = lms instanceof MoodleLmsAdapter ? lms.getDiagnostics() : null;
      const diagnostics = baseDiag ? { ...baseDiag, lastSyncedAt: Date.now() } : null;

      let queuedJobs = 0;
      let changesDetected = 0;

      if (rows.length) {
        // Keep this sync: the full rows and every course's gradebook, so they are there even when Moodle is not.
        saveRoster(rows, tenantId);
        if (lms instanceof MoodleLmsAdapter) {
          try {
            saveGradebooks(await lms.getGradebooks(), tenantId);
          } catch (e) {
            log('lms', 'lms', `Gradebooks not saved this time: ${(e as Error).message}. The last saved copy stays.`);
          }
        }

        // The students list the department agents read (the first sync is a baseline: it starts nobody).
        const { mirrorStudents, refreshRunFacts, routeStudentEvent, lifecycleOf } = await import('@/lib/lms/students');
        const studentEvents = mirrorStudents(rows);
        await refreshRunFacts(rows).catch(() => {});

        const enqueueFn: EnqueueFn | undefined =
          options.enqueue ||
          (options.triggerOnChanges !== false ? (await import('./automation')).enqueue : undefined);

        const { autopilotForKinds } = await import('./agentTriggers');
        const autoEnabled = Boolean(ti.autoRunMode || getState().settings.autoRunMode) && autopilotForKinds(['student_success', 'learning']);
        if (options.triggerOnChanges !== false && autoEnabled && enqueueFn) {
          const inactivityWorkflow = workflowsForTrigger('login.gap')[0];
          const inactivityThreshold = inactivityWorkflow?.threshold ?? 5;
          const candidates: {
            row: SyncedLearnerRow;
            trigger: WorkflowTrigger;
            reason: string;
            severity: number;
            missedQuestions?: MissedQuestion[];
          }[] = [];

          for (const row of rows) {
            const change = classifyRowChange(prevMap.get(row.id), row, inactivityThreshold);
            if (!change) continue;
            candidates.push({
              row,
              trigger: change.trigger,
              reason: change.reason,
              severity: change.severity,
              missedQuestions: missedQuestionsByLearner.get(row.id),
            });
          }

          changesDetected = candidates.length;
          candidates.sort((a, b) => b.severity - a.severity);

          // On initial large import, auto-start top 3 highest-risk cases so workflows run without flooding 200+ items at once.
          const cap = prevMap.size === 0 ? 3 : 10;
          // The department agents (Student Success, Learning & Assessment) take what they listen for;
          // the older tutoring flow only gets events no agent listens for. Finished students are left alone.
          const legacy: typeof candidates = [];
          let agentsStarted = 0;
          for (const c of candidates) {
            if (agentsStarted + legacy.length >= cap) break;
            if (lifecycleOf(c.row) !== 'active') continue;
            // Bongani reaches out when a student goes quiet, not again every few days they stay quiet
            // (his own follow-ups and the weekly report cover the rest).
            const before = prevMap.get(c.row.id);
            if (c.trigger === 'login.gap' && before && (before.daysSinceLogin ?? 0) >= inactivityThreshold) continue;
            const n = await routeStudentEvent(c.row, c.trigger, c.reason);
            if (n < 0) { legacy.push(c); continue; }
            if (n > 0) {
              agentsStarted += n;
              c.row.lastEvent = c.reason;
              void recordLmsEvent({
                tenantId, learnerId: c.row.id, eventType: `moodle.${c.trigger}`, source: 'moodle', moduleCode: c.row.module || null,
                scorePct: c.row.avgScore ?? null, daysSinceLogin: c.row.daysSinceLogin ?? null, missedAssignments: c.row.missedAssignments ?? 0,
                paymentStatus: c.row.paymentStatus || 'ok', detail: c.reason, rawPayload: { source: 'Moodle sync', trigger: c.trigger, reason: c.reason, agents: n },
              });
            }
          }
          queuedJobs = agentsStarted + await queueRowsForWorkflows(legacy, tenantId, enqueueFn, Math.max(0, cap - agentsStarted), 'Moodle sync');

          if (queuedJobs > 0) {
            log(
              'lms',
              'lms',
              prevMap.size === 0
                ? `Moodle initial sync saved ${rows.length} student(s). Auto-started ${queuedJobs} high-priority workflow(s) (${candidates.length} at-risk total).`
                : `Moodle sync detected ${candidates.length} student change(s) and queued ${queuedJobs} workflow(s).`,
            );
          }
        }

        // A course finished (and other changes): agents whose trigger is a change on the students list.
        if (studentEvents.length && autoEnabled && options.triggerOnChanges !== false) {
          const { dispatchRecordEvents } = await import('./agentTriggers');
          await dispatchRecordEvents(studentEvents).catch(() => 0);
        }

        setLearners(toLearnerCards(rows));
        await upsertSyncedLearnersToDb(rows, ti.lmsProvider || 'moodle', tenantId);
        if (diagnostics) {
          await saveMoodleSyncMetaToDb({ diagnostics, lastSyncedAt: diagnostics.lastSyncedAt }, tenantId);
        }
      }

      return {
        learners: rows,
        lmsError,
        diagnostics,
        fromCache: false,
        queuedJobs,
        changesDetected,
      };
    } finally {
      g.__thusoMoodleInFlight?.delete(tenantId);
    }
  })();

  g.__thusoMoodleInFlight.set(tenantId, task);
  return task;
}

export async function triggerWorkflowsOnAtRisk(limit = 5, tenantId = currentTenantId()): Promise<{
  queued: number;
  eligible: number;
}> {
  const snap = await getCachedLearnersSnapshot(tenantId);
  const inactivityThreshold = workflowsForTrigger('login.gap')[0]?.threshold ?? 5;
  const candidates: {
    row: SyncedLearnerRow;
    trigger: WorkflowTrigger;
    reason: string;
    severity: number;
  }[] = [];

  for (const row of snap.learners) {
    if (row.status === 'intervention' || row.status === 'recovered') continue;
    const score = row.avgScore ?? row.checkpoint ?? null;
    if (row.status === 'at_risk' || (row.riskScore ?? 0) >= 60 || (score !== null && score < 60)) {
      const change = classifyRowChange(undefined, row, inactivityThreshold);
      candidates.push({
        row,
        trigger: change?.trigger || 'quiz.failed',
        reason: change?.reason || `risk score ${row.riskScore ?? 60}/100`,
        severity: change?.severity ?? row.riskScore ?? 60,
      });
    }
  }

  candidates.sort((a, b) => b.severity - a.severity);
  // Department agents first (finished students are skipped); the older tutoring flow gets the rest.
  const { routeStudentEvent, lifecycleOf } = await import('@/lib/lms/students');
  const legacy: typeof candidates = [];
  let started = 0;
  for (const c of candidates) {
    if (started + legacy.length >= limit) break;
    if (lifecycleOf(c.row) !== 'active') continue;
    const n = await routeStudentEvent(c.row, c.trigger, c.reason, { manual: true });
    if (n < 0) legacy.push(c); else started += n;
  }
  const { enqueue } = await import('./automation');
  const queued = started + await queueRowsForWorkflows(legacy, tenantId, enqueue, Math.max(0, limit - started), 'Cohort scan');
  if (queued > 0) {
    log('system', 'info', `Started workflows for ${queued} at-risk learner(s) from the saved cohort.`);
  }
  return { queued, eligible: candidates.length };
}

