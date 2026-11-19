import type { SyncedLearnerRow, WorkflowTrigger } from '@/lib/types';
import { listRecords, upsertRecord } from '@/lib/data/records';
import { getSource, MOODLE_SOURCE_ID, type RecordEvent } from '@/lib/data/sources';
import { isoDate } from '@/lib/data/conditions';

/* Students from Moodle, as a list the department agents read.
 *
 * Every Moodle sync writes one record per student (keyed by email) with the
 * fields the agents' rules use: days since they were last active, overdue
 * work, their latest result, the next assignment due, whether they finished.
 * Student Success and Learning & Assessment then work from it like any other
 * list: a rule ("days_since_login at least 5"), a schedule ("every morning,
 * anyone with an assessment in 5 days"), a change ("course_completed became
 * yes"). Students who finished or left are never contacted. */

export type Lifecycle = 'active' | 'completed' | 'inactive';

/** Finished every course, or marked completed/graduated: no more nudges, placement instead. */
export function lifecycleOf(r: Pick<SyncedLearnerRow, 'status' | 'courses' | 'completionPct'>): Lifecycle {
  const st = (r.status || '').toLowerCase();
  if (/withdrawn|cancel|suspend|deregister|dropped|inactive|deferred/.test(st)) return 'inactive';
  if (/complet|graduat|finished|alumni/.test(st)) return 'completed';
  const courses = (r.courses || []).filter((c) => (c.totalActivities || 0) > 0 || c.progressPct != null);
  if (courses.length && courses.every((c) => (c.progressPct ?? 0) >= 100)) return 'completed';
  if ((r.completionPct ?? 0) >= 100) return 'completed';
  return 'active';
}

const dateOnly = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) && d.getTime() > 0 ? isoDate(d) : '';
};

/** The fields an agent sees for one student. */
export function studentFields(r: SyncedLearnerRow): Record<string, string> {
  const life = lifecycleOf(r);
  const grades = [...(r.recentGrades || [])].sort((a, b) => String(b.takenAt || '').localeCompare(String(a.takenAt || '')));
  const last = grades[0];
  const failed = grades.find((g) => !g.passed);
  const overdue = (r.incompleteActivities || []).filter((a) => /^overdue assignment:/i.test(a.name)).map((a) => a.name.replace(/^overdue assignment:\s*/i, ''));
  const open = (r.incompleteActivities || []).filter((a) => !/^overdue assignment:/i.test(a.name)).map((a) => a.name);
  const f: Record<string, string> = {
    id: r.id,
    first_name: r.name.split(/\s+/)[0] || r.name,
    programme: r.programme || '',
    cohort: r.cohort || '',
    group: (r.groups || []).join(', '),
    status: life,
    course_completed: life === 'completed' ? 'yes' : 'no',
    completion: String(r.completionPct ?? 0),
    days_since_login: r.neverLoggedIn ? '' : String(r.daysSinceLogin ?? ''),
    never_logged_in: r.neverLoggedIn ? 'yes' : 'no',
    last_active: dateOnly(r.lastActivityAt),
    missed_assignments: String(r.missedAssignments ?? 0),
    overdue_work: overdue.slice(0, 4).join('; '),
    open_activities: open.slice(0, 4).join('; '),
    avg_score: r.avgScore == null ? '' : String(r.avgScore),
    last_assessment: last ? `${last.title}${last.courseName ? ` (${last.courseName})` : ''}` : '',
    last_score: last ? String(last.scorePct) : '',
    last_passed: last ? (last.passed ? 'yes' : 'no') : '',
    failed_assessment: failed ? `${failed.title} (${failed.scorePct}%, pass mark ${failed.passMark}%)` : '',
    risk_score: String(r.riskScore ?? 0),
    risk_band: r.riskBand || 'on_track',
    risk_signals: (r.signals || []).slice(0, 4).join('; '),
    weak_topic: r.weakTopic || '',
    current_module: r.moduleTitle || r.module || '',
    next_assessment_date: dateOnly(r.nextDue?.dueAt),
    next_assessment_name: r.nextDue?.name || '',
    next_assessment_course: r.nextDue?.course || '',
    lms: r.source || 'moodle',
  };
  for (const k of Object.keys(f)) if (f[k] === '') delete f[k];
  return f;
}

/** Write this sync's students into the list. The first sync is the baseline: it starts nobody.
 *  Returns what changed, for the agents whose trigger is a change (a course finished). */
export function mirrorStudents(rows: SyncedLearnerRow[]): RecordEvent[] {
  const source = getSource(MOODLE_SOURCE_ID);
  if (!source) return [];
  const baseline = listRecords(MOODLE_SOURCE_ID).length === 0;
  const events: RecordEvent[] = [];
  for (const r of rows) {
    const email = (r.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    const out = upsertRecord(MOODLE_SOURCE_ID, { key: email, name: r.name, email, phone: r.phone || '', fields: { email, ...studentFields(r) } });
    if (baseline) continue;
    if (out.created) events.push({ source, record: out.record, kind: 'added', changed: [] });
    else if (out.changed.length) events.push({ source, record: out.record, kind: 'changed', changed: out.changed });
  }
  return events;
}

/** Runs already working on a student see this sync's facts (work handed in ends a follow-up loop). */
export async function refreshRunFacts(rows: SyncedLearnerRow[]): Promise<void> {
  const { listAgentRuns, noteFacts } = await import('@/lib/engine/agentRuns');
  const busy = new Set(listAgentRuns({ active: true, limit: 100000 }).map((r) => r.record.email.toLowerCase()).filter(Boolean));
  for (const r of rows) {
    const email = (r.email || '').trim().toLowerCase();
    if (email && busy.has(email)) noteFacts(email, studentFields(r));
  }
}

/** Moodle noticed something about a student: the department agent for it starts (held for approval in Approval Mode).
 *  Students who finished or left are skipped. Returns how many agents started, or -1 when no agent listens for it. */
export async function routeStudentEvent(row: SyncedLearnerRow, event: WorkflowTrigger, reason: string, opts: { manual?: boolean } = {}): Promise<number> {
  const { agentWorkflows, dispatchLmsEvent } = await import('@/lib/engine/agentTriggers');
  const listening = agentWorkflows().some((w) => w.agentTrigger?.kind === 'lms.event' && w.agentTrigger.lmsEvent === event);
  if (!listening) return -1;
  if (lifecycleOf(row) !== 'active') return 0;
  return dispatchLmsEvent(event, { id: row.id, name: row.name, email: row.email, phone: row.phone, fields: studentFields(row) }, `Moodle: ${reason}`, opts);
}

/** One paragraph about the students for weekly reports (no AI). */
export function studentsSummary(): string {
  const recs = listRecords(MOODLE_SOURCE_ID).map((r) => ({ r, f: r.fields }));
  if (!recs.length) return '';
  const active = recs.filter(({ f }) => f.status === 'active');
  const n = (xs: unknown[]) => xs.length;
  const names = (xs: typeof recs, k = 8, extra?: (f: Record<string, string>) => string) => xs.slice(0, k).map(({ r, f }) => `${r.name}${extra ? ` (${extra(f)})` : ''}`).join('; ');
  const atRisk = active.filter(({ f }) => f.risk_band === 'at_risk').sort((a, b) => Number(b.f.risk_score || 0) - Number(a.f.risk_score || 0));
  const quiet = active.filter(({ f }) => Number(f.days_since_login || 0) >= 7 || f.never_logged_in === 'yes');
  const overdue = active.filter(({ f }) => Number(f.missed_assignments || 0) > 0).sort((a, b) => Number(b.f.missed_assignments) - Number(a.f.missed_assignments));
  const failed = active.filter(({ f }) => f.last_passed === 'no');
  const soon = active.filter(({ f }) => {
    if (!f.next_assessment_date) return false;
    const days = (Date.parse(f.next_assessment_date) - Date.now()) / 86_400_000;
    return days >= -1 && days <= 7;
  });
  const done = recs.filter(({ f }) => f.status === 'completed');
  const lines = [
    `Students from Moodle: ${n(recs)} in total, ${n(active)} studying, ${n(done)} finished.`,
    `At risk: ${n(atRisk)}${atRisk.length ? `: ${names(atRisk, 10, (f) => `risk ${f.risk_score}${f.weak_topic ? `, ${f.weak_topic}` : ''}`)}` : ''}.`,
    `Quiet for a week or more (or never logged in): ${n(quiet)}${quiet.length ? `: ${names(quiet, 8, (f) => (f.never_logged_in === 'yes' ? 'never logged in' : `${f.days_since_login} days`))}` : ''}.`,
    `Overdue work: ${n(overdue)}${overdue.length ? `: ${names(overdue, 8, (f) => `${f.missed_assignments} overdue`)}` : ''}.`,
    `Latest result below the pass mark: ${n(failed)}${failed.length ? `: ${names(failed, 8, (f) => f.last_assessment || 'assessment')}` : ''}.`,
    `Assessments due in the next 7 days: ${n(soon)}${soon.length ? `: ${names(soon, 8, (f) => `${f.next_assessment_name || 'assessment'} on ${f.next_assessment_date}`)}` : ''}.`,
  ];
  return lines.join(' ');
}
