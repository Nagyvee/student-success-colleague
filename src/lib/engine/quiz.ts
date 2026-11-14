import type { Deliverable, QuizResult, RemedialQuiz } from '@/lib/types';
import { announce, bump, getState, log, patchTask, setAgent, setLearner, setRoom, upsertDeliverable } from './store';
import { getLmsAdapter } from '@/lib/lms/lmsAdapter';
import { LOCALIZED_BANK } from '@/lib/ai/simulate';
import { sleep } from './orchestrator';
import { writeBack } from '@/lib/lms/sheet';

/* The student's side of the loop.
 *
 * /quiz/[quizId] reads the public view (no answers), the student submits,
 * we grade on the spot, push the score through the LMS adapter, and the
 * office reacts: Student Success flips the learner from At-Risk to On Track
 * in front of everyone watching the floorplan. */

export function findQuiz(quizId: string) {
  return getState().deliverables.find((d) => d.kind === 'remedial_quiz' && (d.content as RemedialQuiz).quizId === quizId) as Deliverable<RemedialQuiz> | undefined;
}

export function publicQuizView(d: Deliverable<RemedialQuiz>) {
  const q = d.content;
  const done = q.status === 'completed';
  const fallbackTranslations = LOCALIZED_BANK[q.module.code] || LOCALIZED_BANK['JS-07'];
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
    lesson: q.lesson || null,
    localizedSummary: q.localizedSummary || null,
    allTranslations: q.allTranslations || fallbackTranslations,
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
  log('student', 'score', `${d.content.learner.name} submitted the ${d.content.module.code} micro-quiz: ${result.score}/${result.total} (${result.pct}%) · ${result.passed ? 'passed' : 'below the pass mark'}.`, {
    taskId: d.taskId,
    deliverableId: d.id,
    toolCall: { tool: 'student.submit_remedial_quiz', payload: { quizId: d.content.quizId, studentId: d.content.learner.id, score: result.score, total: result.total, pct: result.pct, passed: result.passed } },
  });
  announce('student', `${d.content.learner.name} scored ${result.pct}% on the ${d.content.module.code} quiz · synced to the LMS`, result.passed ? 'good' : 'warn');
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
  // 2 · Student Success reacts
  setRoom('success', 'busy', `Score in · ${first} ${result.pct}%`);
  setAgent('success', { status: 'thinking', thought: `${first} just finished the ${q.module.code} quiz: ${result.score}/${result.total}. Checking it against the pass mark…` });
  await sleep(1600);
  if (result.passed) {
    const status = 'recovered';
    try { await adapter.updateStudentStatus(q.learner.id, status, `Passed ${q.module.code} remedial quiz with ${result.pct}%`); } catch { /* logged above */ }
    setLearner(q.learner.id, { status, lastEvent: `Passed ${q.module.code} remedial · ${result.pct}%`, quizAvg: Math.min(100, (getState().learners.find((l) => l.id === q.learner.id)?.quizAvg || 50) + 10), weakTopic: null, riskScore: Math.max(8, Math.round((getState().learners.find((l) => l.id === q.learner.id)?.riskScore || 60) * 0.3)) });
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
  } else {
    try { await adapter.updateStudentStatus(q.learner.id, 'intervention', `Scored ${result.pct}% on ${q.module.code} remedial; 1:1 booked`); } catch { /* logged above */ }
    setLearner(q.learner.id, { status: 'intervention', lastEvent: `Scored ${result.pct}% on ${q.module.code} remedial · 1:1 booked` });
    setRoom('success', 'amber', `${first}: ${result.pct}% · booking a 1:1`);
    setAgent('success', { status: 'working', thought: `${first} scored ${result.pct}%, under the ${q.passMark}% pass mark. Booking the 20-minute 1:1 from the plan.` });
    log('success', 'info', `${q.learner.name} scored ${result.pct}% on the ${q.module.code} remedial. Below the pass mark: the plan's 1:1 is triggered and the learner stays in intervention.`, { taskId: d.taskId, deliverableId: d.id });
    setAgent('learning', { status: 'working', thought: `Preparing the 1:1 on ${q.topic} for ${first}.` });
  }
  // The plan's last step closes on the learner's own result.
  const task = getState().tasks.find((t) => t.id === d.taskId);
  if (task?.plan) {
    const steps = task.plan.steps.map((s) => (s.key === 'follow_up'
      ? { ...s, status: result.passed ? 'done' as const : 'doing' as const, result: `${first} ${result.passed ? `passed ${result.pct}% · On Track` : `scored ${result.pct}% · 1:1 booked`}` }
      : s));
    patchTask(task.id, { plan: { ...task.plan, steps } });
  }
  await sleep(16000);
  setRoom('success', 'calm', null);
  setAgent('success', { status: 'idle', thought: null });
  setAgent('learning', { status: 'idle', thought: null });
}
