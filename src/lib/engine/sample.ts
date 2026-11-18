import type { Deliverable, InterventionPlan, RemedialQuiz } from '@/lib/types';
import type { StudentProfile } from '@/lib/lms/lmsAdapter';
import { MODULES } from '@/lib/lms/sandboxData';
import { draftLesson, draftRemedialQuiz } from '@/lib/ai/agents';
import { auditRemedialQuiz } from './audit';
import { fixQuiz } from '@/lib/ai/simulate';
import { getState, log, uid, upsertDeliverable } from './store';
import { quizEmail, sendMail } from '@/lib/email/send';
import { listCustomAgents } from './offices';
import { warmLessonAudio } from '@/lib/media/tts';
import { currentTenantId } from '@/lib/auth/tenantContext';

/* A sample study pack, on demand.
 *
 * Builds exactly what a learner gets after a failed assessment (the personal
 * video lesson that greets them by name and the N-question test, checked by the
 * same rules) for a sample student, not a real one, and puts the email in the
 * Inbox. Nothing is sent to anyone: it is for the team to see and click through. */

export async function buildSampleStudyPack(input: { name?: string; email?: string; moduleCode?: string; scorePct?: number; questionCount?: number }) {
  const name = (input.name || 'Nigel Sample').trim().slice(0, 60);
  const email = (input.email || 'sample.student@example.com').trim().toLowerCase();
  const mod = MODULES.find((m) => m.code === input.moduleCode) || MODULES[0];
  const topic = mod.topics[0];
  const score = Math.max(0, Math.min(100, Math.round(input.scorePct ?? 42)));
  const n = Math.max(3, Math.min(15, input.questionCount || 10));
  const student: StudentProfile = {
    id: `SAMPLE-${Date.now().toString(36)}`,
    name, email,
    cohort: 'Sample cohort', programme: mod.programmeCode, programmeCode: mod.programmeCode,
    enrolledAt: new Date().toISOString(), status: 'at_risk',
  };
  const plan: InterventionPlan = {
    learner: { id: student.id, name, email, cohort: student.cohort, programme: student.programme },
    riskScore: 60,
    signals: [`${mod.code} checkpoint scored ${score}%`],
    weakModule: { code: mod.code, title: mod.title },
    weakTopic: topic,
    topicKeywords: mod.keywords,
    summary: `Sample: ${name} scored ${score}% on ${mod.code}.`,
    actions: [],
  };
  const evidence = { scorePct: score, passMark: 70, assessmentTitle: `${mod.code} checkpoint`, missedTopics: mod.topics.slice(0, 3), missedCount: 4 };
  const quizId = uid('qz').replace('qz_', 'MA-');
  const tutorName = listCustomAgents().find((a) => a.id === 'ag_lindiwe')?.name || 'Lindiwe';

  log('learning', 'draft', `${tutorName} is building a sample study pack for ${name} (${mod.code}: ${topic}).`);
  const [q, l] = await Promise.all([
    draftRemedialQuiz(student, plan, mod, quizId, getState().settings.tutorLanguage || 'en', undefined, undefined, undefined, { questionCount: n, passMark: 70, evidence }),
    draftLesson(student, mod, topic, undefined, undefined, undefined, { questionCount: n, passMark: 70, evidence, tutorName }),
  ]);
  // The same rules a real pack passes before it can be sent.
  let quiz: RemedialQuiz = { ...q.value, lesson: l.value, evidence: q.value.evidence || evidence };
  const verdict = auditRemedialQuiz(quiz, mod.keywords);
  if (!verdict.pass) quiz = fixQuiz(quiz, verdict.badIds);

  const d: Deliverable<RemedialQuiz> = {
    id: uid('d'), taskId: `sample_${quizId}`, kind: 'remedial_quiz', title: 'Sample study pack', subject: name,
    owner: 'learning', dept: 'learning', version: 1, status: 'dispatched', content: quiz, previous: null,
    audit: [{ ts: Date.now(), by: 'coo', verdict: 'pass', version: 1, notes: ['Sample for the team: checked by the same rules as a real study pack.'] }],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  upsertDeliverable(d);
  if (quiz.lesson) warmLessonAudio(currentTenantId(), quizId, quiz.lesson.slides);
  const link = `${getState().caps.baseUrl}/quiz/${quizId}`;
  const mail = quizEmail(quiz, link);
  const sent = await sendMail({ to: email, toName: name, subject: `[Sample] ${mail.subject}`, html: mail.html, text: mail.text, link, taskId: d.taskId, deliverableId: d.id });
  log('learning', 'email', `Sample study pack for ${name} is in the Inbox: a personal video lesson and a ${quiz.questions.length}-question test. Lesson: ${link.replace('/quiz/', '/learn/')}`);
  return {
    quizId,
    mailId: sent.id,
    lessonUrl: link.replace('/quiz/', '/learn/'),
    testUrl: link,
    viaAi: q.viaAi && l.viaAi,
    questions: quiz.questions.length,
  };
}
