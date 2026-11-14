import type {
  CatchUpPlan, Cause, CheckInMessage, GoalPlan, InterventionPlan, LearnerCase, PlanStep, QuizQuestion, RemedialQuiz, StageKey, TutorLanguage,
} from '@/lib/types';
import type { AssessmentRecord, EngagementMetrics, ModuleSyllabus, RiskAssessment, StudentProfile } from '@/lib/lms/lmsAdapter';
import { complete, generateJSON, isNum, isStr, obj, strArr } from './llm';
import { COHORTS, STAGE_OWNER, fixQuiz, readScope, simApproval, simCheckIn, simCritique, simGoalPlan, simLesson, simQuiz } from './simulate';
import type { Lesson } from '@/lib/types';
import { auditCheckIn, auditRemedialQuiz } from '@/lib/engine/audit';
import { teach } from './instructions';

/* The agents' minds.
 *
 * Each function asks the model for a draft in a fixed JSON shape, validates
 * it hard, and falls back to the simulation when the model is off, slow or
 * wrong. Every result carries viaAi so the feed can say which it was. */

const ACADEMY = `The academy Thuso works for is a South African tech academy (Johannesburg) that trains career-changers through live online evening classes: Full-Stack Web Development (cohort FSWD-2026-Q3), Data Analytics with Python & SQL (DA-2026-Q3) and Cybersecurity Essentials (CYB-2026-Q3). Voice: warm, confident, specific, South African English, never preachy.`;

const JSON_ONLY = 'Reply with one JSON object only. No markdown, no code fences, no commentary before or after. Inside string values never use double quotes (use single quotes if you must quote) and keep each value on one line.';

export interface AiResult<T> { value: T; viaAi: boolean }

const STAGES: StageKey[] = ['scan', 'diagnose', 'act', 'review', 'deliver', 'follow_up'];

/* ── Planner: goal → plan ─────────────────────────────────────────────────── */

export async function planGoal(goal: string): Promise<AiResult<GoalPlan>> {
  const fallback = simGoalPlan(goal);
  const ai = await generateJSON<GoalPlan>({
    system: `You are Zanele, the Planner agent in the academy's student success team. A person gives you an outcome; you turn it into a plan the team can run without asking anyone again. Your team: Bongani (Student Success: reads the LMS, diagnoses why a learner is behind, writes personal check-ins), Lindiwe (Learning & Assessment: writes catch-up quizzes and tutoring), Musa (Reviewer: audits every output and sends back anything wrong). ${ACADEMY} ${JSON_ONLY}${teach('planner')}`,
    prompt: `The goal, in the person's words: "${goal}"

Cohorts that exist: ${COHORTS.join(', ')}.
The stages your team can run, in this order: scan (LMS scan and risk scoring), diagnose (why each flagged learner is behind: a topic gap or disengagement), act (catch-up quizzes for topic gaps, personal check-ins for disengaged learners), review (the Reviewer audits every output), deliver (send to learners, update the LMS), follow_up (watch for quiz results and flip learners back to On Track).

Decide the scope from the goal: which cohorts (empty list means all), how many learners at most (1 to 10; 10 if the goal says every/all), and the tutoring language (en, zu for isiZulu, st for Sesotho; en unless the goal asks).

JSON shape:
{"reading": "one or two sentences, first person: what outcome the person wants and how you will judge it done", "cohorts": ["..."], "limit": 10, "language": "en|zu|st", "successCriteria": "one sentence", "steps": [{"key": "scan|diagnose|act|review|deliver|follow_up", "text": "what this stage must achieve for THIS goal, under 16 words"}]}`,
    maxTokens: 6000,
    timeoutMs: 16000,
    validate: (x) => {
      const o = obj(x); if (!o) return null;
      if (!isStr(o.reading) || !isStr(o.successCriteria) || !Array.isArray(o.steps)) return null;
      const read = readScope(goal);
      const cohorts = Array.isArray(o.cohorts) ? (o.cohorts as unknown[]).filter((c): c is string => typeof c === 'string' && COHORTS.includes(c)) : [];
      const limit = isNum(o.limit) ? Math.max(1, Math.min(10, Math.round(o.limit))) : read.limit;
      const language = (['en', 'zu', 'st'].includes(String(o.language)) ? o.language : read.language) as TutorLanguage;
      const texts = new Map<StageKey, string>();
      for (const s of o.steps as unknown[]) {
        const q = obj(s);
        if (q && STAGES.includes(q.key as StageKey) && isStr(q.text)) texts.set(q.key as StageKey, (q.text as string).trim());
      }
      if (texts.size < 4) return null;
      const steps: PlanStep[] = STAGES.map((key) => ({ key, owner: STAGE_OWNER[key], text: texts.get(key) || fallback.steps.find((s) => s.key === key)!.text, status: 'todo' }));
      return {
        goal, reading: o.reading.trim(), successCriteria: o.successCriteria.trim(), steps, viaAi: true,
        scope: { cohorts: cohorts.length ? cohorts : [...COHORTS], limit, language },
      };
    },
  });
  return ai ? { value: ai, viaAi: true } : { value: fallback, viaAi: false };
}

/* ── Student Success: diagnosis ───────────────────────────────────────────── */

export interface Evidence { student: StudentProfile; e: EngagementMetrics; a: AssessmentRecord[]; risk: RiskAssessment }

/** One call for the whole caseload: the cause and the reason, per learner. */
export async function diagnose(list: Evidence[], fallback: LearnerCase[]): Promise<AiResult<LearnerCase[]>> {
  if (!list.length) return { value: [], viaAi: false };
  const ai = await generateJSON<{ id: string; cause: Cause; why: string }[]>({
    system: `You are Bongani, the Student Success agent in the academy. Before anyone acts, you work out why each learner is behind, from the LMS evidence only. ${ACADEMY} ${JSON_ONLY}${teach('success')}`,
    prompt: `Learners flagged by the scan:
${list.map(({ student, e, a, risk }) => JSON.stringify({ id: student.id, name: student.name, cohort: student.cohort, daysSinceLastLogin: e.daysSinceLastLogin, loginStreakDays: e.loginStreakDays, hoursThisWeek: e.hoursThisWeek, completionPct: e.completionPct, currentModule: e.currentModule, assessments: a.map((x) => ({ module: x.moduleCode, score: x.scorePct, passMark: x.passMark, passed: x.passed, weakTopics: x.weakTopics })), signals: risk.signals })).join('\n')}

For each learner decide the cause:
- "topic_gap": they failed a checkpoint on a specific topic; re-teaching it is the fastest way back.
- "disengaged": their marks are fine but they have gone quiet; a quiz will not help, a person reaching out will.

JSON shape: {"cases": [{"id": "learner id", "cause": "topic_gap|disengaged", "why": "one sentence citing the evidence, under 35 words"}]}`,
    maxTokens: 6000,
    timeoutMs: 16000,
    validate: (x) => {
      const o = obj(x); if (!o || !Array.isArray(o.cases)) return null;
      const out = (o.cases as unknown[]).map((c) => { const q = obj(c); return q && isStr(q.id) && (q.cause === 'topic_gap' || q.cause === 'disengaged') && isStr(q.why) ? { id: q.id, cause: q.cause as Cause, why: q.why.trim() } : null; });
      if (out.some((c) => !c)) return null;
      return out as { id: string; cause: Cause; why: string }[];
    },
  });
  if (!ai) return { value: fallback, viaAi: false };
  const byId = new Map(ai.map((c) => [c.id, c]));
  const merged = fallback.map((f) => {
    const m = byId.get(f.learner.id);
    if (!m) return f;
    const ev = list.find((x) => x.student.id === f.learner.id)!;
    const topic = m.cause === 'topic_gap';
    return {
      ...f,
      cause: m.cause,
      why: m.why,
      action: topic ? 'remedial_quiz' as const : 'checkin' as const,
      owner: topic ? 'learning' as const : 'success' as const,
      weakModule: topic ? (ev.risk.weakModule || null) : null,
      weakTopic: topic ? (ev.risk.weakTopic || ev.risk.weakModule?.title || null) : null,
    };
  });
  return { value: merged, viaAi: true };
}

/** A case the Reviewer sent back is rebuilt from the evidence, which has the last word. */
export function reviseCatchUpPlan(plan: CatchUpPlan, evidenceCases: LearnerCase[]): CatchUpPlan {
  const byId = new Map(evidenceCases.map((c) => [c.learner.id, c]));
  return { ...plan, cases: plan.cases.map((c) => (c.cause !== byId.get(c.learner.id)?.cause ? byId.get(c.learner.id) || c : c)) };
}

/* ── Student Success: the personal check-in ───────────────────────────────── */

export async function draftCheckIn(c: LearnerCase, e: EngagementMetrics, notes: string[] = []): Promise<AiResult<CheckInMessage>> {
  const base = simCheckIn(c, e.daysSinceLastLogin);
  const first = c.learner.name.split(' ')[0];
  const ai = await generateJSON<CheckInMessage>({
    system: `You are Bongani, the Student Success agent in the academy. You write short, human check-ins to learners who have gone quiet. You never label a learner (no 'at risk', 'flagged', 'failing'); you say what you noticed and offer help. ${ACADEMY} ${JSON_ONLY}${teach('success')}`,
    prompt: `Learner: ${c.learner.name} (${c.learner.cohort}). Evidence: ${c.signals.join('; ')}. Why we think they are behind: ${c.why}
${notes.length ? `\nThe Reviewer sent your last draft back:\n- ${notes.join('\n- ')}\nFix exactly that.\n` : ''}
Write the check-in email. Use ${first}'s first name in the body, sign as Bongani, 60 to 120 words, warm, no guilt, and one small specific ask they can do today. JSON shape: {"subject": "under 8 words", "body": "the email body, one paragraph", "ask": "the one small thing we ask, one sentence"}`,
    maxTokens: 6000,
    timeoutMs: 16000,
    validate: (x) => {
      const o = obj(x); if (!o || !isStr(o.subject) || !isStr(o.body) || !isStr(o.ask)) return null;
      return { learner: base.learner, subject: o.subject.trim(), body: o.body.trim(), ask: o.ask.trim() };
    },
  });
  return ai ? { value: ai, viaAi: true } : { value: base, viaAi: false };
}

export async function reviseCheckIn(c: LearnerCase, e: EngagementMetrics, notes: string[]): Promise<AiResult<CheckInMessage>> {
  const r = await draftCheckIn(c, e, notes);
  if (auditCheckIn(r.value).pass) return r;
  return { value: simCheckIn(c, e.daysSinceLastLogin), viaAi: false };
}

/* ── Learning & Assessment: remedial quiz ─────────────────────────────────── */

function validateQuestions(x: unknown, min = 3, max = 5): QuizQuestion[] | null {
  if (!Array.isArray(x) || x.length < min || x.length > max) return null;
  const out: QuizQuestion[] = [];
  for (let i = 0; i < x.length; i++) {
    const q = obj(x[i]); if (!q) return null;
    const options = strArr(q.options, 3);
    if (!isStr(q.prompt) || !options || options.length > 5 || !isNum(q.answerIndex) || !isStr(q.explanation)) return null;
    if (q.answerIndex < 0 || q.answerIndex >= options.length) return null;
    out.push({ id: `q${i + 1}`, prompt: q.prompt, options, answerIndex: Math.round(q.answerIndex), explanation: q.explanation, topicTag: isStr(q.topicTag) ? q.topicTag : '' });
  }
  return out;
}

export async function draftRemedialQuiz(student: StudentProfile, plan: InterventionPlan, mod: ModuleSyllabus, quizId: string, tutorLanguage: TutorLanguage = 'en'): Promise<AiResult<RemedialQuiz>> {
  const base = simQuiz(student, plan, mod, quizId, tutorLanguage);
  const langName = tutorLanguage === 'zu' ? 'isiZulu' : tutorLanguage === 'st' ? 'Sesotho' : null;
  const ai = await generateJSON<Pick<RemedialQuiz, 'tutoringSummary' | 'keyPoints' | 'questions'> & { localizedSummary?: { summary: string; keyPoints: string[] } }>({
    system: `You are Lindiwe, the Learning & Assessment agent in the academy. You write targeted remedial micro-quizzes and short tutoring guides${langName ? ` with grounded South African ${langName} explanations alongside English` : ''}. ${ACADEMY} ${JSON_ONLY}${teach('learning')}`,
    prompt: `Learner ${student.name} (${student.cohort}) failed the ${mod.code} checkpoint. Weak topic: "${plan.weakTopic}". Module: ${mod.title}. Syllabus topics: ${mod.topics.join('; ')}.\n\nWrite a 3-question multiple-choice remedial micro-quiz that tests ONLY this module and topic, plus a tutoring summary that re-teaches it in plain language.${langName ? ` Also provide a natural, accurate ${langName} translation of the tutoring summary and key points so the learner can study in their home language alongside English.` : ''} Each question: 4 options, exactly one correct, and an explanation that teaches. JSON shape:\n{"tutoringSummary": "120-220 words", "keyPoints": ["4 to 5 short points"],${langName ? ` "localizedSummary": {"summary": "${langName} translation (80-160 words)", "keyPoints": ["4 short points in ${langName}"]},` : ''} "questions": [{"prompt": "...", "options": ["...","...","...","..."], "answerIndex": 0-3, "explanation": "...", "topicTag": "sub-topic"}]}`,
    maxTokens: 22000,
    timeoutMs: 34000,
    validate: (x) => {
      const o = obj(x); if (!o) return null;
      const questions = validateQuestions(o.questions, 3, 3);
      const keyPoints = strArr(o.keyPoints, 3);
      if (!isStr(o.tutoringSummary) || !keyPoints || !questions) return null;
      const loc = obj(o.localizedSummary);
      const localizedSummary = loc && isStr(loc.summary) && strArr(loc.keyPoints, 3)
        ? { summary: loc.summary, keyPoints: strArr(loc.keyPoints, 3) as string[] }
        : undefined;
      return { tutoringSummary: o.tutoringSummary, keyPoints, questions, localizedSummary };
    },
  });
  if (!ai) return { value: base, viaAi: false };
  const localizedSummary = (tutorLanguage === 'zu' || tutorLanguage === 'st')
    ? (ai.localizedSummary ? { language: tutorLanguage, label: langName as string, ...ai.localizedSummary } : base.localizedSummary)
    : null;
  const merged: RemedialQuiz = { ...base, tutoringSummary: ai.tutoringSummary, keyPoints: ai.keyPoints, questions: ai.questions, localizedSummary };
  // A model quiz that already fails the rubric is not a useful draft; use the bank.
  return auditRemedialQuiz(merged, mod.keywords).pass ? { value: merged, viaAi: true } : { value: base, viaAi: false };
}

/* ── Learning & Assessment: the 3-minute video lesson ─────────────────────── */

export async function draftLesson(student: StudentProfile, mod: ModuleSyllabus, topic: string): Promise<AiResult<Lesson>> {
  const fallback = simLesson(student.name, mod, topic);
  const first = student.name.split(' ')[0];
  const ai = await generateJSON<Lesson>({
    system: `You are Lindiwe, the Learning & Assessment agent in the academy. You make short narrated slide lessons that re-teach one topic to one learner, warmly and clearly, in South African English. ${ACADEMY} ${JSON_ONLY}${teach('learning')}`,
    prompt: `Make a 3-minute video lesson for ${student.name} (${student.cohort}) on ${mod.code} ${mod.title}, weak topic "${topic}". Syllabus topics: ${mod.topics.join('; ')}.

8 slides. Slide 1 greets ${first} by name and says what we will fix. Slides 2 to 6 teach the topic step by step, with one small code example where it helps. Slide 7 recaps. Slide 8 sends ${first} to a 3-question quiz on exactly this.
Each slide: a short heading, 1 to 3 short on-screen points, an optional code snippet (max 6 lines), and the narration the voice reads ("say"): 45 to 70 words, spoken style, no markdown, never read the code symbol by symbol.

JSON shape: {"title": "short lesson title", "slides": [{"heading": "...", "points": ["..."], "code": "optional", "say": "..."}]}`,
    maxTokens: 14000,
    timeoutMs: 34000,
    validate: (x) => {
      const o = obj(x); if (!o || !isStr(o.title) || !Array.isArray(o.slides) || o.slides.length < 5 || o.slides.length > 10) return null;
      const slides = (o.slides as unknown[]).map((v) => {
        const q = obj(v); if (!q || !isStr(q.heading) || !isStr(q.say)) return null;
        const points = strArr(q.points, 1) || [];
        return { heading: q.heading.trim(), points: points.slice(0, 3), code: isStr(q.code) ? q.code.slice(0, 400) : undefined, say: q.say.trim() };
      });
      if (slides.some((x) => !x)) return null;
      return { title: o.title.trim(), slides: slides as Lesson['slides'], viaAi: true };
    },
  });
  return ai ? { value: ai, viaAi: true } : { value: fallback, viaAi: false };
}

export async function reviseRemedialQuiz(quiz: RemedialQuiz, notes: string[], badIds: string[], mod: ModuleSyllabus): Promise<AiResult<RemedialQuiz>> {
  const ai = await generateJSON<RemedialQuiz>({
    system: `You are Lindiwe, the Learning & Assessment agent in the academy. The Reviewer rejected a question in your remedial quiz. Replace exactly the flagged question(s) with new ones on ${mod.code} ${quiz.topic}; keep the others and the summary unchanged. ${JSON_ONLY}${teach('learning')}`,
    prompt: `Reviewer critique:\n- ${notes.join('\n- ')}\n\nFlagged question ids: ${badIds.join(', ')}\nModule keywords the Reviewer checks for: ${mod.keywords.slice(0, 12).join(', ')}\n\nYour draft questions:\n${JSON.stringify(quiz.questions, null, 2)}\n\nReturn {"questions": [all questions in order, same ids, flagged ones replaced]}`,
    maxTokens: 16000,
    timeoutMs: 22000,
    validate: (x) => {
      const o = obj(x); if (!o) return null;
      const questions = validateQuestions(o.questions, quiz.questions.length, quiz.questions.length);
      return questions ? { ...quiz, questions } : null;
    },
  });
  if (ai && auditRemedialQuiz(ai, mod.keywords).pass) return { value: ai, viaAi: true };
  const fixed = fixQuiz(ai || quiz, ai ? auditRemedialQuiz(ai, mod.keywords).badIds : badIds);
  return { value: fixed, viaAi: Boolean(ai) };
}

/* ── Reviewer: words for the verdict ──────────────────────────────────────── */

/** A compact description of a deliverable, so the Reviewer speaks about what it read. */
export function describeDeliverable(kind: string, content: unknown): string {
  try {
    switch (kind) {
      case 'catchup_plan': {
        const p = content as CatchUpPlan;
        return `Catch-up plan for "${p.goal}" (${p.scope}): ${p.checked} learners checked, ${p.cases.length} need help. ${p.cases.map((c) => `${c.learner.name}: ${c.cause === 'topic_gap' ? `topic gap on ${c.weakModule?.code} ${c.weakTopic}` : 'disengaged'}, action ${c.action === 'remedial_quiz' ? 'catch-up quiz' : 'personal check-in'}, because ${c.why}`).join(' / ')}`;
      }
      case 'checkin_message': {
        const m = content as CheckInMessage;
        return `Check-in email to ${m.learner.name}. Subject: ${m.subject}. Body: ${m.body} Ask: ${m.ask}`;
      }
      case 'remedial_quiz': {
        const q = content as RemedialQuiz;
        return `Remedial micro-quiz for ${q.learner.name} on ${q.module.code} ${q.module.title}, weak topic "${q.topic}", pass mark ${q.passMark}%. Questions: ${q.questions.map((x, i) => `Q${i + 1} [${x.topicTag}] ${x.prompt.replace(/\s+/g, ' ').slice(0, 110)}`).join(' / ')}.`;
      }
    }
  } catch { /* fall through */ }
  return JSON.stringify(content).slice(0, 800);
}

const KIND_NAME: Record<string, string> = { catchup_plan: 'catch-up plan', checkin_message: 'check-in message', remedial_quiz: 'remedial quiz' };

export async function writeCritique(kind: string, subject: string, notes: string[], content?: unknown): Promise<AiResult<string>> {
  const text = await complete({
    system: `You are Musa, the Reviewer agent in the academy's student success team. You audit every output before it reaches a learner. You are exacting, fair and brief. You write from the material in front of you and never ask for more information. Plain text only: no markdown, no lists, no headings, no placeholders, no preamble.${teach('coo')}`,
    prompt: `You audited this ${KIND_NAME[kind] || kind} for ${subject}:\n${content !== undefined ? describeDeliverable(kind, content) : '(not shown)'}\n\nThe rubric failed it for these reasons:\n- ${notes.join('\n- ')}\n\nWrite the critique you send back: two or three sentences, specific, naming what is wrong and what a pass looks like. Under 70 words. Start with the problem, not with a greeting.`,
    maxTokens: 6000,
    timeoutMs: 12000,
    json: false,
  });
  const clean = text ? tidy(text) : null;
  return clean ? { value: clean, viaAi: true } : { value: simCritique(kind, notes, subject), viaAi: false };
}

export async function writeApproval(kind: string, subject: string, content?: unknown): Promise<AiResult<string>> {
  const text = await complete({
    system: `You are Musa, the Reviewer agent in the academy's student success team. You write from the material in front of you and never ask for more information. Plain text only: no markdown, no placeholders, no preamble, no "Approved:" prefix.${teach('coo')}`,
    prompt: `You audited this ${KIND_NAME[kind] || kind} for ${subject} and it passed every rubric check:\n${content !== undefined ? describeDeliverable(kind, content) : '(not shown)'}\n\nThe decision is already made: it is approved. Write the one-sentence approval note you stamp on it, under 30 words, naming the specific thing that made it pass. Do not withhold, condition or qualify the approval.`,
    maxTokens: 6000,
    timeoutMs: 10000,
    json: false,
  });
  const clean = text ? tidy(text) : null;
  if (clean && /withheld|not approved|cannot approve|can't approve|reject|before (this|it) (is|gets) stamped|retarget|fix(ed)? before/i.test(clean)) return { value: simApproval(kind), viaAi: false };
  return clean ? { value: clean, viaAi: true } : { value: simApproval(kind), viaAi: false };
}

/** One paragraph, no leftover labels, and never a note that asks for the thing it was given. */
function tidy(text: string): string | null {
  const t = text.replace(/^\s*(approved|approval note|critique)\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 12) return null;
  if (/\[(specific|insert|name|detail)/i.test(t) || /don'?t have (the )?details|in front of me|slots for/i.test(t)) return null;
  return t.length > 420 ? `${t.slice(0, 417).trimEnd()}…` : t;
}
