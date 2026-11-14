import type { AuditVerdict, CatchUpPlan, CheckInMessage, RemedialQuiz } from '@/lib/types';

/* What the Reviewer holds every draft to.
 *
 * Rubrics are code, not vibes: the same draft always gets the same verdict,
 * whichever model wrote it. The model, when there is one, writes the critique
 * in words; these functions decide whether there is one to write. */

export function auditCatchUpPlan(plan: CatchUpPlan): AuditVerdict {
  const notes: string[] = [];
  if (!plan.cases.length) notes.push('The plan names no learners; either nobody needs help or the scan did not run.');
  for (const c of plan.cases) {
    const first = c.learner.name.split(' ')[0];
    if (c.signals.length < 1) notes.push(`${first}'s case cites no LMS evidence at all.`);
    if (!c.why || c.why.length < 30) notes.push(`${first}'s case does not say why the evidence points at ${c.cause === 'topic_gap' ? 'a topic gap' : 'disengagement'}.`);
    const failedCheckpoint = c.signals.some((s) => /checkpoint scored/i.test(s));
    if (c.cause === 'topic_gap' && !c.weakModule) notes.push(`${first} is marked as a topic gap but no weak module is named, so nothing can be re-taught.`);
    if (c.cause === 'disengaged' && failedCheckpoint) notes.push(`${first} failed a checkpoint but is marked disengaged; the marks say topic gap.`);
    if (c.cause === 'topic_gap' && c.action !== 'remedial_quiz') notes.push(`${first} has a topic gap but no catch-up quiz is planned.`);
    if (c.cause === 'disengaged' && c.action !== 'checkin') notes.push(`${first} is disengaged; a quiz will not bring them back, a check-in will.`);
  }
  return { pass: notes.length === 0, notes };
}

export interface QuizAudit extends AuditVerdict { badIds: string[] }

export function auditRemedialQuiz(q: RemedialQuiz, keywords: string[]): QuizAudit {
  const notes: string[] = [];
  const badIds: string[] = [];
  const kws = (keywords.length ? keywords : q.topicKeywords).map((k) => k.toLowerCase());
  if (q.questions.length < 3 || q.questions.length > 5) notes.push(`A remedial micro-quiz has 3 to 5 questions; this has ${q.questions.length}.`);
  q.questions.forEach((x, i) => {
    const hay = `${x.prompt} ${x.options.join(' ')} ${x.topicTag} ${x.explanation}`.toLowerCase();
    const onTopic = kws.some((k) => hay.includes(k));
    if (!onTopic) {
      badIds.push(x.id);
      notes.push(`Question ${i + 1} ("${x.prompt.slice(0, 60).replace(/\n/g, ' ')}…") tests ${x.topicTag || 'another topic'}, not ${q.module.code} ${q.topic}. It teaches the learner nothing about the module they are stuck on.`);
    }
    if (x.options.length < 3) { notes.push(`Question ${i + 1} has fewer than three options.`); if (!badIds.includes(x.id)) badIds.push(x.id); }
    if (new Set(x.options.map((o) => o.trim().toLowerCase())).size !== x.options.length) { notes.push(`Question ${i + 1} repeats an option.`); if (!badIds.includes(x.id)) badIds.push(x.id); }
    if (x.answerIndex < 0 || x.answerIndex >= x.options.length) { notes.push(`Question ${i + 1} points at an answer that does not exist.`); if (!badIds.includes(x.id)) badIds.push(x.id); }
    if (!x.explanation || x.explanation.length < 20) notes.push(`Question ${i + 1} needs an explanation the learner can learn from.`);
  });
  if (!q.tutoringSummary || q.tutoringSummary.length < 120) notes.push('The tutoring summary is too short to re-teach the topic.');
  if (q.keyPoints.length < 3) notes.push('Give at least three key points.');
  return { pass: notes.length === 0, notes, badIds };
}

/** A check-in is read by someone already pulling away: it must sound like a person. */
export function auditCheckIn(m: CheckInMessage): AuditVerdict {
  const notes: string[] = [];
  const first = m.learner.name.split(' ')[0];
  const text = `${m.subject} ${m.body} ${m.ask}`;
  if (!m.body.includes(first)) notes.push(`The message never uses ${first}'s name.`);
  if (/\bat[- ]risk\b|risk score|\bflagged\b|\bfailing\b|\bdeficien/i.test(text)) notes.push('It labels the learner (at risk, flagged, failing). Learners who read that disengage further; describe what we noticed, not what we call them.');
  const words = m.body.split(/\s+/).filter(Boolean).length;
  if (words > 140) notes.push(`At ${words} words it is too long for someone who has stopped opening the LMS; keep it under 140.`);
  if (words < 30) notes.push('It is too short to feel personal.');
  if (!m.ask || m.ask.length < 12) notes.push('It does not ask for one small, specific thing the learner can do today.');
  return { pass: notes.length === 0, notes };
}
