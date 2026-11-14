import type { CheckInMessage, RemedialQuiz, WorldState } from '@/lib/types';

/* What happened at the school, for a period: the numbers, the learners, the
 * mistakes the Reviewer caught and every run with what started it. One pure
 * function, used by the Reports page and by Musa when he writes the report. */

export type Period = 'today' | 'week' | 'all';

export function periodStart(p: Period, now = Date.now()) {
  if (p === 'all') return 0;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (p === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return d.getTime();
}

export function buildReport(s: WorldState, period: Period) {
  const from = periodStart(period);
  const tasks = s.tasks.filter((t) => t.startedAt >= from);
  const done = tasks.filter((t) => t.status === 'done');
  const dels = s.deliverables.filter((d) => d.createdAt >= from);
  const quizzes = dels.filter((d) => d.kind === 'remedial_quiz');
  const sentQuizzes = quizzes.filter((d) => d.status === 'dispatched');
  const completed = quizzes.filter((d) => (d.content as RemedialQuiz).status === 'completed');
  const passed = completed.filter((d) => (d.content as RemedialQuiz).result?.passed);
  const checkins = dels.filter((d) => d.kind === 'checkin_message' && d.status === 'dispatched');
  const mistakes = dels.flatMap((d) => d.audit.filter((a) => a.verdict === 'fail' && a.ts >= from).map((a) => ({
    at: a.ts, kind: d.kind, title: d.title, subject: d.subject, note: a.notes[0] || 'Failed review', fixed: d.audit.some((b) => b.verdict === 'pass' && b.ts > a.ts),
  }))).sort((x, y) => y.at - x.at);
  const byTrigger = { webhook: 0, sheet: 0, schedule: 0, manager: 0 } as Record<string, number>;
  for (const t of tasks) byTrigger[t.trigger?.kind || 'manager'] += 1;

  const helped = new Map<string, { name: string; what: string; at: number }>();
  for (const d of dels) {
    if (d.status !== 'dispatched') continue;
    if (d.kind === 'remedial_quiz') { const q = d.content as RemedialQuiz; helped.set(q.learner.id, { name: q.learner.name, what: `Study pack, lesson and quiz on ${q.module.code} · ${q.topic}${q.status === 'completed' ? ` · scored ${q.result?.pct}%` : ''}`, at: d.updatedAt }); }
    if (d.kind === 'checkin_message') { const m = d.content as CheckInMessage; helped.set(m.learner.id, { name: m.learner.name, what: `Personal check-in: "${m.subject}"`, at: d.updatedAt }); }
  }

  return {
    period, from,
    numbers: {
      runs: tasks.length,
      checked: done.reduce((n, t) => n + (t.summary?.checked || 0), 0),
      helped: helped.size,
      studyPacks: sentQuizzes.length,
      checkIns: checkins.length,
      quizzesDone: completed.length,
      passRate: completed.length ? Math.round((passed.length / completed.length) * 100) : null,
      mistakesCaught: mistakes.length,
      mistakesFixed: mistakes.filter((m) => m.fixed).length,
      humanInterventions: 0,
      minutesWorking: Math.round(done.reduce((n, t) => n + ((t.endedAt || t.startedAt) - t.startedAt), 0) / 60000),
    },
    byTrigger,
    learners: s.learners.map((l) => ({ id: l.id, name: l.name, cohort: l.cohort, status: l.status, risk: l.riskScore, lastEvent: l.lastEvent })),
    helped: [...helped.values()].sort((x, y) => y.at - x.at),
    mistakes,
    runs: tasks.map((t) => ({ id: t.id, at: t.startedAt, trigger: t.trigger?.label || "Manager's goal", status: t.status, summary: t.summary, corrections: t.corrections, ms: (t.endedAt || Date.now()) - t.startedAt })),
  };
}

export type Report = ReturnType<typeof buildReport>;
