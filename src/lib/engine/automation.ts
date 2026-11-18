import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MissedQuestion, Trigger, WorkflowTrigger } from '@/lib/types';
import { getState, hydrateStoreFromDb, log, setAutomation } from './store';
import { runGoal } from './scenarios/goal';
import { readSheet, sheetStatus, type SheetChange } from '@/lib/lms/sheet';
import { emailReport } from '@/lib/musaReport';
import { hydrateWorkflowsFromDb, renderWorkflowGoal, workflowsForTrigger } from './workflows';
import { hydrateFollowUpsFromDb, markFollowUpRecovered, processDueFollowUps } from './followups';
import { hydrateOfficesFromDb } from './offices';
import { recordLmsEvent } from '@/lib/db/postgres';
import { DEFAULT_TENANT_ID, currentTenantId, withTenant } from '@/lib/auth/tenantContext';
import { hydrateAuthFromDb, getTenant, getTenantIntegrations, listTenantIds } from '@/lib/auth/accounts';
import { hydrateRecords } from '@/lib/data/records';
import { pollSources } from '@/lib/data/sources';
import { hydrateNurture } from '@/lib/nurture/store';
import { hydrateLmsSaved } from '@/lib/lms/gradebook';
import { pumpCampaigns } from '@/lib/nurture/campaigns';
import { checkReplies, hydrateMailWatch } from '@/lib/email/watch';
import { hydrateAgentRuns, resumeDueRuns } from './agentRuns';
import { dispatchRecordEvents, hydrateAgentSchedule, runScheduledAgents } from './agentTriggers';
import { ensureDepartmentModel } from './departments';

/* Always on.
 *
 * The colleague does not wait to be typed at. Things start by themselves:
 * an LMS webhook (Moodle, attendance, assignments, payments), Google Sheet
 * changes, recurring workflows, persistent follow-ups, and the weekly sweep.
 * Whatever arrives while the team is busy waits in a queue and runs next. */

export interface Job {
  goal: string;
  trigger: Trigger;
  focus?: string[];
  workflowId?: string;
  workflowInstructions?: string;
  missedQuestions?: MissedQuestion[];
  /** Mastery test length for the learner's study pack (default 10). */
  quizQuestions?: number;
  /** Pass mark for that test, in percent (default 70). */
  passMark?: number;
  /** The agent run that handed this job over, so the run can log the outcome. */
  agentRunId?: string;
}

const SWEEP_GOAL = 'Weekly sweep: check every cohort and get every learner who is falling behind back on track.';
const SWEEP_DAY = 1;      // Monday
const SWEEP_HOUR = 7;     // 07:00, server time (SAST)

type Hub = { queue: Job[]; nextSweep: number; lastSweep: number | null; reading: boolean; lastRead: number; nextReport: number; lastFollowUp?: number; lastMoodleSync?: number; syncingMoodle?: boolean; lastSourcePoll?: number; lastScheduleCheck?: number; lastCampaignPump?: number; lastMailCheck?: number; lastVideoCheck?: number; booted?: boolean };
const g = globalThis as unknown as { __ssAutoMap?: Map<string, Hub>; __ssTimer?: ReturnType<typeof setInterval> | null; __thusoBoot?: Promise<void> };

function hub(tenantId = currentTenantId()): Hub {
  if (!g.__ssAutoMap) g.__ssAutoMap = new Map();
  if (!g.__ssAutoMap.has(tenantId)) {
    g.__ssAutoMap.set(tenantId, {
      queue: [],
      nextSweep: nextSweepAfter(Date.now()),
      lastSweep: null,
      reading: false,
      lastRead: 0,
      nextReport: nextReportAfter(Date.now()),
    });
  }
  return g.__ssAutoMap.get(tenantId)!;
}

/** Musa's daily report: 17:00 every day. */
export function nextReportAfter(from: number) {
  const t = new Date(from); t.setHours(17, 0, 0, 0);
  if (t.getTime() <= from) t.setDate(t.getDate() + 1);
  return t.getTime();
}

export function nextSweepAfter(from: number) {
  const d = new Date(from);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), SWEEP_HOUR, 0, 0, 0);
  let add = (SWEEP_DAY - d.getDay() + 7) % 7;
  if (add === 0 && t.getTime() <= from) add = 7;
  t.setDate(t.getDate() + add);
  return t.getTime();
}

function publish() {
  const h = hub();
  const s = getState();
  setAutomation({
    queued: h.queue.length,
    sheet: sheetStatus(),
    writeBack: Boolean(process.env.SHEET_WRITEBACK_URL),
    schedule: { enabled: s.settings.scheduleEnabled !== false, label: 'Mondays 07:00', nextAt: s.settings.scheduleEnabled !== false ? h.nextSweep : null, lastAt: h.lastSweep },
  });
}

/** Load one workspace from the database and bring it onto departments-as-floors. */
async function bootTenant(tid: string) {
  const h = withTenant(tid, () => hub());
  if (h.booted) return;
  h.booted = true;
  await withTenant(tid, async () => {
    await Promise.all([
      hydrateStoreFromDb(), hydrateWorkflowsFromDb(), hydrateFollowUpsFromDb(), hydrateOfficesFromDb(),
      hydrateRecords(), hydrateAgentRuns(), hydrateAgentSchedule(), hydrateNurture(), hydrateMailWatch(), hydrateLmsSaved(),
    ]).catch(() => {});
    try { ensureDepartmentModel(); } catch (e) { console.warn('[thuso] department setup failed:', (e as Error).message); }
  });
  // Photos for the videos, resized once the server is up (the first viewer never waits for a 10 MB original).
  setTimeout(() => { void withTenant(tid, () => import('@/lib/nurture/media').then((m) => m.warmPhotos(tid))).catch(() => {}); }, 20_000);
  // The voice for every programme video (cached on disk: only missing scenes are made).
  setTimeout(() => {
    void withTenant(tid, async () => {
      const [{ listVideos }, { warmLessonAudio }] = await Promise.all([import('@/lib/nurture/video'), import('@/lib/media/tts')]);
      for (const v of listVideos()) warmLessonAudio(tid, v.id, v.slides);
    }).catch(() => {});
  }, 30_000);
}

/** Resolves once every workspace has been loaded (APIs wait for it before changing structure). */
export function bootReady(tenantId?: string): Promise<void> {
  ensureAutomation();
  const all = g.__thusoBoot || Promise.resolve();
  return tenantId ? all.then(() => bootTenant(tenantId)) : all;
}

/** Start the pump (idempotent): it runs queued jobs and fires the weekly sweep. */
export function ensureAutomation() {
  if (!g.__thusoBoot) {
    g.__thusoBoot = (async () => {
      await hydrateAuthFromDb().catch(() => {});
      for (const tid of listTenantIds()) await bootTenant(tid);
    })();
  }
  if (!g.__ssTimer) {
    g.__ssTimer = setInterval(tickAllTenants, 1500);
    keepAwake();
  }
  publish();
}

const first = (n: string) => n.split(' ')[0];

const SHEET_KIND_TO_TRIGGER: Record<Exclude<SheetChange['kind'], 'added'>, WorkflowTrigger> = {
  score: 'quiz.failed',
  attendance: 'attendance.missed',
  assignment: 'assignment.missed',
  payment: 'payment.overdue',
  days: 'login.gap',
};

/** One job per learner whose row changed, routed through matching workflow offices. */
function jobFor(c: SheetChange): Job | null {
  const r = c.row;
  const f = first(r.name);
  if (c.kind === 'added') {
    return {
      goal: `New learner in the sheet: ${r.name} (${r.cohort})${r.score !== null ? `, checkpoint ${r.score}%` : ''}${r.days !== null ? `, ${r.days} days since login` : ''}. Check ${f} and act if needed.`,
      trigger: { kind: 'sheet', label: `Google Sheet · new row: ${r.name}` },
      focus: [r.id],
    };
  }
  if (c.kind === 'payment' && c.to === 'ok') {
    markFollowUpRecovered(r.id);
    return null;
  }
  if (c.kind === 'score' && typeof c.to === 'number' && c.to >= 70) {
    markFollowUpRecovered(r.id);
    return null;
  }

  const wfTrigger = SHEET_KIND_TO_TRIGGER[c.kind];
  const wf = workflowsForTrigger(wfTrigger)[0];

  let defaultGoal = `Sheet update: ${r.name} has not logged in for ${c.to} days (was ${c.from ?? 'blank'}). Find out why and get ${f} back on track.`;
  let triggerLabel = `Google Sheet · ${f}: ${c.to} days without logging in`;
  let detail = '';

  if (c.kind === 'score') {
    defaultGoal = `Sheet update: ${r.name}'s ${r.module || 'checkpoint'} score changed from ${c.from ?? 'blank'} to ${c.to ?? 'blank'}%. Find out why and get ${f} back on track.`;
    triggerLabel = `Google Sheet · ${f}'s score ${c.from ?? '–'} → ${c.to ?? '–'}`;
    detail = `${r.module || 'checkpoint'} score changed from ${c.from ?? '–'} to ${c.to ?? '–'}%`;
  } else if (c.kind === 'attendance') {
    defaultGoal = `Attendance alert: ${r.name} now has ${c.to} missed classes (was ${c.from ?? 0}). Check in warmly, share the class recording/notes, and get ${f} back on track.`;
    triggerLabel = `Google Sheet · ${f}: ${c.to} missed classes`;
    detail = `missed ${c.to} classes`;
  } else if (c.kind === 'assignment') {
    defaultGoal = `Assignment alert: ${r.name} has ${c.to} missed assignments (was ${c.from ?? 0}). Check what blocked ${f} and help them catch up.`;
    triggerLabel = `Google Sheet · ${f}: ${c.to} missed assignments`;
    detail = `has ${c.to} missed assignments`;
  } else if (c.kind === 'payment') {
    defaultGoal = `Tuition support alert: ${r.name}'s payment status is now "${c.to}". Send a confidential, supportive check-in about payment arrangements or Bursary support without shaming.`;
    triggerLabel = `Google Sheet · ${f}: payment ${c.to}`;
    detail = `payment status is ${c.to}`;
  } else {
    detail = `${c.to} days without logging in`;
  }

  return {
    goal: wf
      ? renderWorkflowGoal(wf, {
          name: r.name,
          first: f,
          module: r.module || 'current module',
          score: c.kind === 'score' ? (c.to ?? '') : (r.score ?? ''),
          days: c.kind === 'days' ? (c.to ?? '') : (r.days ?? ''),
          detail,
        })
      : defaultGoal,
    trigger: { kind: wf ? 'workflow' : 'sheet', label: wf ? `${wf.officeName || wf.name} · ${f}` : triggerLabel },
    focus: [r.id],
    workflowId: wf?.id,
    workflowInstructions: wf?.instructions,
  };
}

function describeSheetChange(c: SheetChange): string {
  if (c.kind === 'added') return 'new row added';
  if (c.kind === 'score') return `checkpoint_score ${c.from ?? '–'} → ${c.to ?? '–'}`;
  if (c.kind === 'attendance') return `missed_classes ${c.from ?? '–'} → ${c.to ?? '–'}`;
  if (c.kind === 'assignment') return `missed_assignments ${c.from ?? '–'} → ${c.to ?? '–'}`;
  if (c.kind === 'payment') return `payment_status ${c.from ?? '–'} → ${c.to ?? '–'}`;
  return `days_since_login ${c.from ?? '–'} → ${c.to ?? '–'}`;
}

async function pollSheet() {
  const h = hub();
  if (h.reading || Date.now() - h.lastRead < 4000) return;
  h.reading = true; h.lastRead = Date.now();
  try {
    const changes = await readSheet();
    const seen = new Set<string>();
    for (const c of changes) {
      if (seen.has(c.row.id)) continue;
      seen.add(c.row.id);
      const what = describeSheetChange(c);
      void recordLmsEvent({
        learnerId: c.row.id,
        eventType: `sheet.${c.kind}`,
        source: 'sheet',
        moduleCode: c.row.module || null,
        scorePct: c.row.score,
        daysSinceLogin: c.row.days,
        missedClasses: c.row.missedClasses,
        missedAssignments: c.row.missedAssignments,
        paymentStatus: c.row.paymentStatus,
        detail: what,
        rawPayload: c,
      });
      log('lms', 'lms', `Google Sheet changed: ${c.row.name} · ${what}. Starting the colleague, nobody pressed anything.`, { toolCall: { tool: 'sheet.watch_changes', payload: { learner_id: c.row.id, change: c.kind, from: c.from, to: c.to, row: c.row } } });
      setAutomation({ lastEvent: { at: Date.now(), event: `sheet.${c.kind}`, learner: c.row.name, detail: what }, events: (getState().automation?.events || 0) + 1 });
      const job = jobFor(c);
      if (job) h.queue.push(job);
    }
  } finally { h.reading = false; publish(); }
}

function pollMoodleChanges() {
  const h = hub();
  const tid = currentTenantId();
  const ti = getTenantIntegrations(tid);
  if (ti.lmsProvider !== 'moodle') return;
  // Background diff sync only runs after initial learner roster exists, every 5 minutes
  if (!getState().learners.length) return;
  if (h.syncingMoodle || (h.lastMoodleSync && Date.now() - h.lastMoodleSync < 5 * 60_000)) return;
  h.syncingMoodle = true;
  h.lastMoodleSync = Date.now();
  void (async () => {
    try {
      const { syncMoodleCohort } = await import('./moodleSync');
      await withTenant(tid, () =>
        syncMoodleCohort({ forceRefresh: true, enqueue, triggerOnChanges: true, tenantId: tid }),
      );
    } catch {
      /* errors recorded cleanly inside moodleSync / kept cached */
    } finally {
      h.syncingMoodle = false;
    }
  })();
}

function tickAllTenants() {
  for (const tid of listTenantIds()) {
    withTenant(tid, () => tick());
  }
}

function tick() {
  const h = hub();
  const s = getState();
  const tid = currentTenantId();
  const ti = getTenantIntegrations(tid);
  // Department agents: continue waiting runs, read the sheets, run scheduled checks.
  if (h.booted) {
    resumeDueRuns();
    if (!h.lastSourcePoll || Date.now() - h.lastSourcePoll >= 5000) {
      h.lastSourcePoll = Date.now();
      void pollSources().then((events) => dispatchRecordEvents(events)).catch(() => { /* status is on the source */ });
    }
    // Campaigns: a few saved messages at a time, so a big list never floods the mail server.
    if (!h.lastCampaignPump || Date.now() - h.lastCampaignPump >= 5000) {
      h.lastCampaignPump = Date.now();
      void pumpCampaigns().catch(() => { /* next tick */ });
    }
    // Replies in the mailbox (IMAP), once a minute when switched on.
    // Programme videos that quote an offer which has ended are rewritten with what is current.
    if (!h.lastVideoCheck || Date.now() - h.lastVideoCheck >= 3_600_000) {
      h.lastVideoCheck = Date.now();
      void import('@/lib/nurture/video').then((v) => v.refreshExpiredVideos()).catch(() => { /* next hour */ });
    }
    if (!h.lastMailCheck || Date.now() - h.lastMailCheck >= 60_000) {
      h.lastMailCheck = Date.now();
      void checkReplies().catch(() => { /* the error is on the watch status */ });
    }
    if (!h.lastScheduleCheck || Date.now() - h.lastScheduleCheck >= 60_000) {
      h.lastScheduleCheck = Date.now();
      void runScheduledAgents().catch(() => { /* next minute */ });
    }
  }
  if (s.settings.autoRunMode) {
    void pollSheet();
    pollMoodleChanges();
  }
  if (s.settings.autoRunMode && (!h.lastFollowUp || Date.now() - h.lastFollowUp >= 30_000)) {
    h.lastFollowUp = Date.now();
    void processDueFollowUps().catch(() => { /* logged in followups */ });
  }
  if (Date.now() >= h.nextReport) {
    h.nextReport = nextReportAfter(Date.now() + 60_000);
    const to = (ti.managerEmail || (tid === DEFAULT_TENANT_ID ? process.env.MANAGER_EMAIL : '') || '').trim();
    const isPlaceholder = !to || /^your\.email@/i.test(to);
    if (s.settings.autoRunMode && ti.liveOutreachEnabled && !isPlaceholder) {
      void emailReport('today', to).catch(() => { /* logged by the mailer */ });
    }
  }
  if (s.settings.autoRunMode && s.settings.scheduleEnabled !== false && Date.now() >= h.nextSweep) {
    h.lastSweep = Date.now();
    h.nextSweep = nextSweepAfter(Date.now() + 60_000);
    log('system', 'system', 'Scheduler: the weekly sweep is due. Starting it with nobody asked.');
    h.queue.push({ goal: SWEEP_GOAL, trigger: { kind: 'schedule', label: 'Weekly sweep · Mondays 07:00' } });
    publish();
  }
  if (!s.busy && h.queue.length) {
    const job = h.queue.shift() as Job;
    runGoal(job.goal, {
      trigger: job.trigger,
      focus: job.focus,
      workflowId: job.workflowId,
      workflowInstructions: job.workflowInstructions,
      missedQuestions: job.missedQuestions,
      quizQuestions: job.quizQuestions,
      passMark: job.passMark,
      agentRunId: job.agentRunId,
    });
    publish();
  }
}

export function enqueue(job: Job) {
  ensureAutomation();
  const h = hub();
  h.queue.push(job);
  publish();
  if (getState().busy) log('system', 'system', `Queued: "${job.goal}" starts as soon as the team is free.`);
  tick();
  return { queued: Boolean(getState().busy) || h.queue.length > 0 };
}

/** Run the weekly sweep now, exactly as the scheduler would. */
export function sweepNow() {
  hub().lastSweep = Date.now();
  return enqueue({ goal: SWEEP_GOAL, trigger: { kind: 'schedule', label: 'Weekly sweep · run now' } });
}

export function schedulingChanged() { publish(); }

/* ── Webhook signatures ───────────────────────────────────────────────────── */

/** The default workspace's webhook secret (the environment's, or its own). */
export function webhookSecret() {
  return getTenant(DEFAULT_TENANT_ID).webhookSecret;
}

export function sign(body: string, secret = webhookSecret()) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Checks X-LMS-Signature against this workspace's secret only. A signature
 *  made with another workspace's secret, or a demo value, never passes. */
export function verify(body: string, header: string | null, tenantSecret: string) {
  if (!header || !tenantSecret) return false;
  const got = Buffer.from(header.trim());
  const want = Buffer.from(sign(body, tenantSecret));
  return want.length === got.length && timingSafeEqual(want, got);
}

/* On Render's free plan a service sleeps after 15 minutes without a visitor,
 * and an always-on colleague must not sleep. When Render tells us our public
 * address, we visit ourselves every 10 minutes. Elsewhere this does nothing. */
const ga = globalThis as unknown as { __ssAwake?: ReturnType<typeof setInterval> };
function keepAwake() {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_AWAKE_URL;
  if (!url || ga.__ssAwake) return;
  const ping = () => { fetch(`${url.replace(/\/$/, '')}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }).catch(() => { /* next time */ }); };
  ga.__ssAwake = setInterval(ping, 10 * 60_000);
  setTimeout(ping, 30_000);
}
