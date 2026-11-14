import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Trigger } from '@/lib/types';
import { getState, log, setAutomation } from './store';
import { runGoal } from './scenarios/goal';
import { readSheet, sheetStatus, type SheetChange } from '@/lib/lms/sheet';
import { emailReport } from '@/lib/musaReport';

/* Always on.
 *
 * The colleague does not wait to be typed at. Two things start it by
 * themselves: an LMS webhook (a learner's mark or activity changed) and the
 * weekly sweep (every Monday at 07:00, all cohorts). A manager's goal is the
 * third way in. Whatever arrives while the team is busy waits in a queue and
 * runs as soon as they are free. */

export interface Job { goal: string; trigger: Trigger; focus?: string[] }

const SWEEP_GOAL = 'Weekly sweep: check every cohort and get every learner who is falling behind back on track.';
const SWEEP_DAY = 1;      // Monday
const SWEEP_HOUR = 7;     // 07:00, server time (SAST)

type Hub = { queue: Job[]; timer: ReturnType<typeof setInterval> | null; nextSweep: number; lastSweep: number | null; reading: boolean; lastRead: number; nextReport: number };
const g = globalThis as unknown as { __ssAuto?: Hub };

function hub(): Hub {
  if (!g.__ssAuto) g.__ssAuto = { queue: [], timer: null, nextSweep: nextSweepAfter(Date.now()), lastSweep: null, reading: false, lastRead: 0, nextReport: nextReportAfter(Date.now()) };
  g.__ssAuto.nextReport ??= nextReportAfter(Date.now());
  return g.__ssAuto;
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

/** Start the pump (idempotent): it runs queued jobs and fires the weekly sweep. */
export function ensureAutomation() {
  const h = hub();
  if (h.timer) return;
  h.timer = setInterval(tick, 1500);
  publish();
}

const first = (n: string) => n.split(' ')[0];

/** One job per learner whose row changed, worded the way the sheet changed. */
function jobFor(c: SheetChange): Job {
  const r = c.row;
  const f = first(r.name);
  if (c.kind === 'added') {
    return { goal: `New learner in the sheet: ${r.name} (${r.cohort})${r.score !== null ? `, checkpoint ${r.score}%` : ''}${r.days !== null ? `, ${r.days} days since login` : ''}. Check ${f} and act if needed.`,
      trigger: { kind: 'sheet', label: `Google Sheet · new row: ${r.name}` }, focus: [r.id] };
  }
  if (c.kind === 'score') {
    return { goal: `Sheet update: ${r.name}'s ${r.module || 'checkpoint'} score changed from ${c.from ?? 'blank'} to ${c.to ?? 'blank'}%. Find out why and get ${f} back on track.`,
      trigger: { kind: 'sheet', label: `Google Sheet · ${f}'s score ${c.from ?? '–'} → ${c.to ?? '–'}` }, focus: [r.id] };
  }
  return { goal: `Sheet update: ${r.name} has not logged in for ${c.to} days (was ${c.from ?? 'blank'}). Find out why and get ${f} back on track.`,
    trigger: { kind: 'sheet', label: `Google Sheet · ${f}: ${c.to} days without logging in` }, focus: [r.id] };
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
      const what = c.kind === 'added' ? 'new row added' : c.kind === 'score' ? `checkpoint_score ${c.from ?? '–'} → ${c.to ?? '–'}` : `days_since_login ${c.from ?? '–'} → ${c.to ?? '–'}`;
      log('lms', 'lms', `Google Sheet changed: ${c.row.name} · ${what}. Starting the colleague, nobody pressed anything.`, { toolCall: { tool: 'sheet.watch_changes', payload: { learner_id: c.row.id, change: c.kind, from: c.from, to: c.to, row: c.row } } });
      setAutomation({ lastEvent: { at: Date.now(), event: `sheet.${c.kind}`, learner: c.row.name, detail: what }, events: (getState().automation?.events || 0) + 1 });
      h.queue.push(jobFor(c));
    }
  } finally { h.reading = false; publish(); }
}

function tick() {
  const h = hub();
  const s = getState();
  void pollSheet();
  if (Date.now() >= h.nextReport) {
    h.nextReport = nextReportAfter(Date.now() + 60_000);
    const to = process.env.MANAGER_EMAIL;
    if (to) void emailReport('today', to).catch(() => { /* logged by the mailer */ });
  }
  if (s.settings.scheduleEnabled !== false && Date.now() >= h.nextSweep) {
    h.lastSweep = Date.now();
    h.nextSweep = nextSweepAfter(Date.now() + 60_000);
    log('system', 'system', 'Scheduler: the weekly sweep is due. Starting it with nobody asked.');
    h.queue.push({ goal: SWEEP_GOAL, trigger: { kind: 'schedule', label: 'Weekly sweep · Mondays 07:00' } });
    publish();
  }
  if (!s.busy && h.queue.length) {
    const job = h.queue.shift() as Job;
    runGoal(job.goal, { trigger: job.trigger, focus: job.focus });
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

export function webhookSecret() {
  return process.env.LMS_WEBHOOK_SECRET || 'thuso-lms-demo-secret';
}

export function sign(body: string) {
  return `sha256=${createHmac('sha256', webhookSecret()).update(body).digest('hex')}`;
}

export function verify(body: string, header: string | null) {
  if (!header) return false;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}
