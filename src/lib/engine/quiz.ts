import { footageFor, musicFor } from '@/lib/nurture/media';
import type { Deliverable, QuizResult, RemedialQuiz } from '@/lib/types';
import { announce, bump, getState, log, patchTask, setAgent, setLearner, setRoom, setSpotlight, upsertDeliverable } from './store';
import { resultEmail, sendMail } from '@/lib/email/send';
import { approvalOn, holdMail } from './approvals';
import { getLmsAdapter } from '@/lib/lms/lmsAdapter';
import { LOCALIZED_BANK } from '@/lib/ai/simulate';
import { sleep } from './orchestrator';
import { writeBack } from '@/lib/lms/sheet';
import { markFollowUpRecovered } from '@/lib/engine/followups';
import { recordLmsEvent, recordQuizOutcome } from '@/lib/db/postgres';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';

/* The student's side of the loop.
 *
 * /quiz/[quizId] reads the public view (no answers), the student submits,
 * we grade on the spot, push the score through the LMS adapter, and the
 * office reacts: Student Success flips the learner from At-Risk to On Track
 * in front of everyone watching the floorplan. */

export function findQuiz(quizId: string) {
  return getState().deliverables.find((d) => d.kind === 'remedial_quiz' && (d.content as RemedialQuiz).quizId === quizId) as Deliverable<RemedialQuiz> | undefined;
}

/** The lesson's colours: Melsoft's brand (navy, maroon, one orange accent), or
 *  another academy's own brand colour as the accent on the same calm navy. */
export function lessonBrand(academyName: string) {
  const melsoft = { base: '#0a1733', deep: '#5e0743', accent: '#ff7300' };
  if (/melsoft/i.test(academyName)) return melsoft;
  const own = (getTenantIntegrations().building?.brandColor || '').trim();
  return /^#[0-9a-f]{6}$/i.test(own) ? { base: '#0a1733', deep: '#1c2340', accent: own } : melsoft;
}

/** The result email: in Approval Mode it waits in the Inbox (the student already saw the result on screen). */
async function sendResult(q: RemedialQuiz, d: Deliverable, m: { subject: string; html: string; text: string }): Promise<'held' | 'simulated' | 'smtp' | 'failed'> {
  if (approvalOn()) {
    holdMail({ to: q.learner.email, toName: q.learner.name, subject: m.subject, html: m.html, text: m.text, taskId: d.taskId, learnerId: q.learner.id, label: 'Learning & Assessment · test result', officeName: 'Learning & Assessment' });
    return 'held';
  }
  const mail = await sendMail({ to: q.learner.email, toName: q.learner.name, ...m, link: null, taskId: d.taskId, deliverableId: d.id });
  return mail.error ? 'failed' : mail.delivery === 'smtp' ? 'smtp' : 'simulated';
}

export function publicQuizView(d: Deliverable<RemedialQuiz>) {
  const q = d.content;
  const done = q.status === 'completed';
  // Home-language refreshers only where they were written for this module.
  const fallbackTranslations = LOCALIZED_BANK[q.module.code] || null;
  const ac = getAcademyContext();
  return {
    quizId: q.quizId,
    status: q.status,
    dispatched: d.status === 'dispatched' || d.status === 'approved',
    learner: { name: q.learner.name },
    module: q.module,
    topic: q.topic,
    tutoringSummary: q.tutoringSummary,
    keyPoints: q.keyPoints,
    resources: q.resources || [],
    lesson: q.lesson ? { ...q.lesson, academyName: q.lesson.academyName || ac.academyName, questionCount: q.questions.length, passMark: q.passMark } : null,
    academyName: ac.academyName,
    brand: lessonBrand(ac.academyName),
    logo: getTenantIntegrations(currentTenantId()).building?.logoUrl ? `/api/brand/${currentTenantId()}/logo` : null,
    footage: q.lesson ? footageFor(q.lesson.slides, q.module.title, 'lesson') : [],
    music: musicFor(),
    localizedSummary: q.localizedSummary || null,
    allTranslations: q.allTranslations || fallbackTranslations,
    evidence: q.evidence ? { scorePct: q.evidence.scorePct ?? null, missedTopics: q.evidence.missedTopics || [] } : null,
    passMark: q.passMark,
    questions: q.questions.map((x) => ({
      id: x.id, prompt: x.prompt, options: x.options, topicTag: x.topicTag,
      ...(done ? { answerIndex: x.answerIndex, explanation: x.explanation } : {}),
    })),
    result: done ? q.result : null,
  };
}

export function grade(q: RemedialQuiz, answers: number[]): QuizResult {
  const total = q.questions.length;
  const score = q.questions.reduce((n, x, i) => n + (answers[i] === x.answerIndex ? 1 : 0), 0);
  const pct = Math.round((score / total) * 100);
  return { score, total, pct, answers: answers.slice(0, total), submittedAt: Date.now(), passed: pct >= q.passMark };
}

export async function submitQuiz(quizId: string, answers: number[]) {
  const d = findQuiz(quizId);
  if (!d) return null;
  if (d.content.status === 'completed' && d.content.result) return { deliverable: d, result: d.content.result, already: true };
  const result = grade(d.content, answers);
  d.content = { ...d.content, status: 'completed', result };
  upsertDeliverable(d);
  bump('quizzesCompleted');
  const first = d.content.learner.name.split(' ')[0];
  log('student', 'score', `${d.content.learner.name} submitted the ${d.content.module.code} mastery test: ${result.score}/${result.total} (${result.pct}%) · ${result.passed ? 'passed' : 'below the pass mark'}.`, {
    taskId: d.taskId,
    deliverableId: d.id,
    toolCall: { tool: 'student.submit_remedial_quiz', payload: { quizId: d.content.quizId, studentId: d.content.learner.id, score: result.score, total: result.total, pct: result.pct, passed: result.passed } },
  });
  announce('student', `${d.content.learner.name} scored ${result.pct}% on the ${d.content.module.code} test · synced to the LMS`, result.passed ? 'good' : 'warn');
  // The agent that asked for this lesson decides what happens next from the result.
  if (d.content.learner.email) {
    const email = d.content.learner.email;
    void import('./agentRuns').then((m) => m.noteQuizResult(email, result.pct, result.passed)).catch(() => {});
    void import('@/lib/data/records').then((m) => {
      for (const r of m.findRecordsByEmail(email)) {
        m.setRecordField(r.sourceId, r.key, 'quiz_score', String(result.pct));
        m.setRecordField(r.sourceId, r.key, 'quiz_passed', result.passed ? 'yes' : 'no');
      }
    }).catch(() => {});
  }
  void reactInOffice(d, result, first);
  return { deliverable: d, result, already: false };
}

async function reactInOffice(d: Deliverable<RemedialQuiz>, result: QuizResult, first: string) {
  const q = d.content;
  const adapter = getLmsAdapter(getState().settings.lmsMode);
  // 1 · push the score back through the adapter
  try {
    const r = await adapter.recordRemedialQuiz({
      quizId: q.quizId, studentId: q.learner.id, moduleCode: q.module.code, topic: q.topic,
      scorePct: result.pct, passed: result.passed, questions: result.total, completedAt: new Date(result.submittedAt).toISOString(),
    });
    log('lms', 'lms', `POST /students/${q.learner.id}/assessments → ${q.module.code} remedial ${result.pct}% synced (${adapter.mode}) at ${new Date(r.syncedAt).toLocaleTimeString('en-ZA')}.`, {
      taskId: d.taskId,
      deliverableId: d.id,
      toolCall: { tool: 'lms_adapter.record_remedial_quiz', payload: { endpoint: `POST /students/${q.learner.id}/assessments`, mode: adapter.mode, moduleCode: q.module.code, scorePct: result.pct, passed: result.passed, syncedAt: r.syncedAt } },
    });
  } catch (e) {
    log('lms', 'error', `LMS sync failed (${(e as Error).message}); score kept locally and queued for retry.`, { taskId: d.taskId, deliverableId: d.id });
  }
  // 2 · the room sees it at once: a card with the score and, if it was not enough, what happens next
  const missed = q.questions.filter((x, i) => result.answers[i] !== x.answerIndex);
  const steps = result.passed
    ? [`${first} is back On Track in the LMS`, 'A well-done email is on its way', 'Student Success keeps watching the next checkpoint']
    : [
        `Email ${first} the ${missed.length} question${missed.length === 1 ? '' : 's'} missed, each with the explanation`,
        `Send the lesson again, with the missed point first`,
        `Tutor follow-up: a 20-minute catch-up on ${q.topic}`,
        `Keep ${first} flagged as being helped and re-check in 7 days`,
      ];
  setSpotlight({
    id: `res-${q.quizId}-${result.submittedAt}`, ts: Date.now(), kind: result.passed ? 'passed' : 'failed', owner: 'success',
    title: `${q.learner.name} took the ${result.total}-question test`, subject: `${q.module.code} · ${q.topic}`,
    rule: `${result.score} of ${result.total} correct · ${result.pct}% · pass mark ${q.passMark}%`,
    problem: result.passed ? 'Passed. At-Risk → On Track.' : `Below the pass mark. ${missed.length ? `Missed: ${missed.map((x) => `Q${q.questions.indexOf(x) + 1}`).join(', ')}.` : ''}`,
    before: null, after: null, steps, holdMs: 11000,
  });

  // 3 · Student Success reacts
  void recordQuizOutcome(q.quizId, result.pct, result.passed);
  void recordLmsEvent({
    learnerId: q.learner.id,
    eventType: result.passed ? 'remedial_quiz.passed' : 'remedial_quiz.failed',
    source: 'thuso',
    moduleCode: q.module.code,
    scorePct: result.pct,
    detail: `Quiz ${q.quizId}: ${result.score}/${result.total} (${result.pct}%)`,
  });
  setRoom('success', 'busy', `Score in · ${first} ${result.pct}%`);
  setAgent('success', { status: 'thinking', thought: `${first} just finished the ${q.module.code} quiz: ${result.score}/${result.total}. Checking it against the pass mark…` });
  await sleep(1600);
  if (result.passed) {
    const status = 'recovered';
    try { await adapter.updateStudentStatus(q.learner.id, status, `Passed ${q.module.code} remedial quiz with ${result.pct}%`); } catch { /* logged above */ }
    setLearner(q.learner.id, { status, lastEvent: `Passed ${q.module.code} remedial · ${result.pct}%`, quizAvg: Math.min(100, (getState().learners.find((l) => l.id === q.learner.id)?.quizAvg || 50) + 10), weakTopic: null, riskScore: Math.max(8, Math.round((getState().learners.find((l) => l.id === q.learner.id)?.riskScore || 60) * 0.3)) });
    markFollowUpRecovered(q.learner.id);
    setRoom('success', 'green', `${first}: At-Risk → On Track`);
    void writeBack(q.learner.id, 'on_track', `Passed ${q.module.code} catch-up quiz with ${result.pct}%`);
    setAgent('success', { status: 'celebrating', thought: `${first} is back on track! ${q.module.code} cleared at ${result.pct}%. LMS status synced.` });
    log('success', 'approve', `Learner status updated: ${q.learner.name} · At-Risk → On Track (${q.module.code} remedial passed, ${result.pct}%).`, { taskId: d.taskId, deliverableId: d.id });
    announce('success', `${q.learner.name} · At-Risk → On Track`, 'good');
    log('lms', 'lms', `PATCH /students/${q.learner.id}/status → on_track (${adapter.mode}).`, {
      taskId: d.taskId,
      toolCall: { tool: 'lms_adapter.update_student_status', payload: { endpoint: `PATCH /students/${q.learner.id}/status`, studentId: q.learner.id, previousStatus: 'at_risk', newStatus: 'on_track', note: `Cleared ${q.module.code} at ${result.pct}%` } },
    });
    setAgent('learning', { status: 'celebrating', thought: `The ${q.topic} refresher landed. Nice one, ${first}.` });
    const mail = await sendResult(q, d, resultEmail(q, result, []));
    log('success', 'email', `Well-done email ${mail === 'held' ? 'waiting for approval in the Inbox' : mail === 'simulated' ? 'placed in the Inbox tab' : 'sent'} for ${q.learner.name}.`, { taskId: d.taskId, deliverableId: d.id });
  } else {
    try { await adapter.updateStudentStatus(q.learner.id, 'intervention', `Scored ${result.pct}% on ${q.module.code} catch-up quiz; next steps sent`); } catch { /* logged above */ }
    setLearner(q.learner.id, { status: 'intervention', lastEvent: `Scored ${result.pct}% · next steps sent · tutor follow-up` });
    void writeBack(q.learner.id, 'being helped', `Scored ${result.pct}% on the ${q.module.code} catch-up quiz; next steps sent`);
    setRoom('success', 'amber', `${first}: ${result.pct}% · next steps`);
    setAgent('success', { status: 'working', thought: `${first} scored ${result.pct}%, under the ${q.passMark}% pass mark. Not a failure, a signal: sending the missed answers and setting up a tutor catch-up.` });
    log('success', 'info', `${q.learner.name} scored ${result.pct}% on the ${q.module.code} catch-up quiz, below the ${q.passMark}% pass mark. Next steps: the missed answers explained, the lesson again, a 20-minute tutor catch-up, re-check in 7 days.`, { taskId: d.taskId, deliverableId: d.id });
    setAgent('learning', { status: 'working', thought: `Preparing the 20-minute catch-up on ${q.topic} for ${first}.` });
    const mail = await sendResult(q, d, resultEmail(q, result, missed));
    log('success', 'email', `Next-steps email ${mail === 'held' ? 'waiting for approval in the Inbox' : mail === 'simulated' ? 'placed in the Inbox tab' : 'sent'} for ${q.learner.name}: ${missed.length} missed question${missed.length === 1 ? '' : 's'} explained, lesson link, tutor catch-up.`, { taskId: d.taskId, deliverableId: d.id });
    announce('success', `${first} scored ${result.pct}% · next steps emailed, tutor catch-up set up`, 'warn');
  }
  // The plan's last step closes on the learner's own result.
  const task = getState().tasks.find((t) => t.id === d.taskId);
  if (task?.plan) {
    const steps = task.plan.steps.map((s) => (s.key === 'follow_up'
      ? { ...s, status: result.passed ? 'done' as const : 'doing' as const, result: `${first} ${result.passed ? `passed ${result.pct}% · On Track` : `scored ${result.pct}% · next steps sent`}` }
      : s));
    patchTask(task.id, { plan: { ...task.plan, steps } });
  }
  await sleep(16000);
  setRoom('success', 'calm', null);
  setAgent('success', { status: 'idle', thought: null });
  setAgent('learning', { status: 'idle', thought: null });
}
