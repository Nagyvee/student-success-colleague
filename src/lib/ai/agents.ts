import type {
  CatchUpPlan, Cause, CheckInMessage, GoalPlan, InterventionPlan, LearnerCase, MissedQuestion, PlanStep, QuizQuestion, RemedialQuiz, StageKey, TutorLanguage,
} from '@/lib/types';
import type { AssessmentRecord, EngagementMetrics, ModuleSyllabus, RiskAssessment, StudentProfile } from '@/lib/lms/lmsAdapter';
import { complete, generateJSON, isNum, isStr, obj, strArr } from './llm';
import { COHORTS, STAGE_OWNER, clampPassMark, clampQuestions, fixQuiz, noticedLine, readScope, simApproval, simCheckIn, simCritique, simGoalPlan, simLesson, simQuiz } from './simulate';
import type { Lesson, LessonEvidence, LessonSlide, SlideVisual } from '@/lib/types';
import { SCENE_ICONS, SCENE_VISUALS, clampWords, cleanScene, sceneComplete, visualOf } from '@/lib/lessonScene';
import { auditCheckIn, auditRemedialQuiz } from '@/lib/engine/audit';
import { teach } from './instructions';
import { getAcademyContext } from '@/lib/auth/accounts';

/* The agents' minds.
 *
 * Each function asks the model for a draft in a fixed JSON shape, validates
 * it hard, and falls back to the simulation when the model is off, slow or
 * wrong. Every result carries viaAi so the feed can say which it was. */

function academyContextPrompt() {
  const ac = getAcademyContext();
  return {
    ...ac,
    voice: `The academy you work for is ${ac.academyName}. Always refer to ${ac.academyName} by name (never generic 'the academy'). Sign student-facing outreach as ${ac.senderName} (${ac.senderTitle} at ${ac.academyName}). Voice: warm, confident, practical, South African English, never preachy or guilt-tripping.`,
  };
}

function normalizeEmailBody(raw: string, first: string, ac: { academyName: string; senderName: string; senderTitle: string }): string {
  let txt = raw.replace(/\r\n/g, '\n').trim();
  // Ensure greeting starts on its own paragraph
  txt = txt.replace(new RegExp(`^(Hi|Hello|Hey)\\s+${first}[,!.]?\\s+`, 'i'), `$1 ${first},\n\n`);
  // Split signature if glued to sentence end
  txt = txt.replace(/\s+(Warm regards|Kind regards|Best regards|Best|Cheers),?\s+/i, '\n\n$1,\n');
  // If body still has no paragraph breaks and is >220 chars, break after sentence ~2
  if (!txt.includes('\n\n') && txt.length > 220) {
    const parts = txt.split(/(?<=[.!?])\s+/);
    if (parts.length >= 3) {
      const mid = Math.ceil(parts.length / 2);
      txt = `${parts.slice(0, mid).join(' ')}\n\n${parts.slice(mid).join(' ')}`;
    }
  }
  if (!new RegExp(ac.senderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(txt)) {
    txt = `${txt}\n\nWarm regards,\n${ac.senderName}\n${ac.senderTitle} · ${ac.academyName}`;
  }
  return txt;
}

const JSON_ONLY = 'Reply with one JSON object only. No markdown, no code fences, no commentary before or after. Inside string values never use double quotes (use single quotes if you must quote). You may use \\n\\n inside email body strings for clean paragraph breaks.';

export interface AiResult<T> { value: T; viaAi: boolean }

const STAGES: StageKey[] = ['scan', 'diagnose', 'act', 'review', 'deliver', 'follow_up'];

/* ── Planner: goal → plan ─────────────────────────────────────────────────── */

export async function planGoal(goal: string): Promise<AiResult<GoalPlan>> {
  const fallback = simGoalPlan(goal);
  const ac = academyContextPrompt();
  const ai = await generateJSON<GoalPlan>({
    system: `You are Zanele, the Planner agent in ${ac.academyName}'s student success team. A person gives you an outcome; you turn it into a plan the team can run without asking anyone again. Your team: ${ac.senderName} (${ac.senderTitle}: reads the LMS, diagnoses why a learner is behind, writes personal check-ins), Lindiwe (Learning & Assessment: writes catch-up quizzes and tutoring), Musa (Reviewer: audits every output and sends back anything wrong). ${ac.voice} ${JSON_ONLY}${teach('planner')}`,
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

export interface Evidence { student: StudentProfile; e: EngagementMetrics; a: AssessmentRecord[]; risk: RiskAssessment; memory?: string }

/** One call for the whole caseload: the cause and the reason, per learner. */
export async function diagnose(list: Evidence[], fallback: LearnerCase[]): Promise<AiResult<LearnerCase[]>> {
  if (!list.length) return { value: [], viaAi: false };
  const ac = academyContextPrompt();
  const ai = await generateJSON<{ id: string; cause: Cause; why: string }[]>({
    system: `You are ${ac.senderName}, the ${ac.senderTitle} agent at ${ac.academyName}. Before anyone acts, you work out why each learner is behind, from the concise LMS gradebook summary and memory only. ${ac.voice} ${JSON_ONLY}${teach('success')}`,
    prompt: `Learners flagged by the scan:
${list
  .map(({ student, e, a, risk, memory }) => {
    const failed = a
      .filter((x) => !x.passed || x.scorePct < x.passMark)
      .slice(0, 4)
      .map((x) => ({ title: x.title, module: x.moduleCode, score: x.scorePct, passMark: x.passMark, weakTopics: x.weakTopics }));
    const passedCount = a.filter((x) => x.passed).length;
    return JSON.stringify({
      id: student.id,
      name: student.name,
      cohort: student.cohort,
      daysSinceLastLogin: e.daysSinceLastLogin,
      completionPct: e.completionPct,
      currentModule: e.currentModule.code,
      passedQuizzes: passedCount,
      flaggedAssessments: failed,
      signals: risk.signals.slice(0, 4),
      pastMemory: memory || undefined,
    });
  })
  .join('\n')}

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

export async function draftCheckIn(c: LearnerCase, e: EngagementMetrics, notes: string[] = [], workflowInstructions?: string, memory?: string): Promise<AiResult<CheckInMessage>> {
  const ac = academyContextPrompt();
  const base = simCheckIn(c, e.daysSinceLastLogin, ac);
  const first = c.learner.name.split(' ')[0];
  const extra = workflowInstructions?.trim() ? `\nWorkflow instructions: ${workflowInstructions.trim()}` : '';
  const memLine = memory?.trim() ? `\nPast memory for this learner (avoid repeating old advice): ${memory.trim()}` : '';
  const ai = await generateJSON<CheckInMessage>({
    system: `You are ${ac.senderName} (${ac.senderTitle}) at ${ac.academyName}. You write clean, well-spaced, human check-in emails to learners who need support (missed classes, quiet logins, overdue work, or account check-ins). Never label a learner ('at risk', 'flagged', 'failing'); refer to ${ac.academyName} by name instead of generic 'the academy'. Break the body into 3 short paragraphs separated by \\n\\n for comfortable reading. ${ac.voice} ${JSON_ONLY}${teach('success')}${extra}`,
    prompt: `Learner: ${c.learner.name} (Cohort / Group: ${c.learner.cohort}). Evidence: ${c.signals.join('; ')}. Context: ${c.why}${memLine}
${notes.length ? `\nThe Reviewer sent your last draft back:\n- ${notes.join('\n- ')}\nFix exactly that.\n` : ''}
Write a warm, well-formatted check-in email (70 to 130 words). Format "body" with blank lines (\\n\\n) between paragraphs:
1) Greeting ("Hi ${first},")
2) 1-2 short warm sentences noting we work together at ${ac.academyName} and what we noticed without guilt
3) 1 short helpful offer of support + sign-off ("Warm regards,\\n${ac.senderName}\\n${ac.senderTitle} · ${ac.academyName}")

JSON shape: {"subject": "under 9 words", "body": "well-spaced paragraphs separated by \\n\\n", "ask": "the one small thing we ask, one sentence"}`,
    maxTokens: 6000,
    timeoutMs: 16000,
    validate: (x) => {
      const o = obj(x); if (!o || !isStr(o.subject) || !isStr(o.body) || !isStr(o.ask)) return null;
      return { learner: base.learner, subject: o.subject.trim(), body: normalizeEmailBody(o.body, first, ac), ask: o.ask.trim() };
    },
  });
  return ai ? { value: ai, viaAi: true } : { value: base, viaAi: false };
}

export async function reviseCheckIn(c: LearnerCase, e: EngagementMetrics, notes: string[], workflowInstructions?: string, memory?: string): Promise<AiResult<CheckInMessage>> {
  const r = await draftCheckIn(c, e, notes, workflowInstructions, memory);
  if (auditCheckIn(r.value).pass) return r;
  return { value: simCheckIn(c, e.daysSinceLastLogin), viaAi: false };
}

/* ── Learning & Assessment: the mastery test ──────────────────────────────── */

function validateQuestions(x: unknown, min = 3, max = 15): QuizQuestion[] | null {
  if (!Array.isArray(x) || x.length < min || x.length > max) return null;
  const out: QuizQuestion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < x.length; i++) {
    const q = obj(x[i]); if (!q) return null;
    const options = strArr(q.options, 3);
    if (!isStr(q.prompt) || !options || options.length > 5 || !isNum(q.answerIndex) || !isStr(q.explanation)) return null;
    const answerIndex = Math.round(q.answerIndex);
    if (answerIndex < 0 || answerIndex >= options.length) return null;
    const key = q.prompt.trim().toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    out.push({ id: `q${i + 1}`, prompt: q.prompt.trim(), options, answerIndex, explanation: q.explanation.trim(), topicTag: isStr(q.topicTag) ? q.topicTag.trim() : '' });
  }
  return out;
}

function formatMissed(missed?: MissedQuestion[]) {
  if (!missed?.length) return '';
  const rows = missed.slice(0, 8).map((q, i) =>
    `${i + 1}. ${q.prompt}${q.topic ? ` [topic: ${q.topic}]` : ''}${q.givenAnswer ? ` | learner answered: ${q.givenAnswer}` : ''}${q.correctAnswer ? ` | expected: ${q.correctAnswer}` : ''}`
  );
  return `\nExact quiz questions the learner missed in the LMS:\n${rows.join('\n')}\nAddress these specific misconceptions directly in the tutoring and questions.\n`;
}

/** What the tutor knows about this learner's result, in one line for the prompt. */
function evidenceLine(e: LessonEvidence | null | undefined) {
  if (!e) return '';
  const bits = [
    typeof e.scorePct === 'number' ? `scored ${Math.round(e.scorePct)}%${e.passMark ? ` (pass mark ${e.passMark}%)` : ''}${e.assessmentTitle ? ` on "${e.assessmentTitle}"` : ''}` : '',
    e.missedTopics?.length ? `missed questions on: ${e.missedTopics.slice(0, 4).join(', ')}` : '',
    typeof e.daysSinceLogin === 'number' && e.daysSinceLogin >= 3 ? `${e.daysSinceLogin} days since last login` : '',
  ].filter(Boolean);
  return bits.length ? `\nWhat we noticed: ${bits.join('; ')}.` : '';
}

export interface PackDraftOptions { questionCount?: number; passMark?: number; evidence?: LessonEvidence | null }

export async function draftRemedialQuiz(
  student: StudentProfile,
  plan: InterventionPlan,
  mod: ModuleSyllabus,
  quizId: string,
  tutorLanguage: TutorLanguage = 'en',
  missedQuestions?: MissedQuestion[],
  workflowInstructions?: string,
  memory?: string,
  opts: PackDraftOptions = {},
): Promise<AiResult<RemedialQuiz>> {
  const n = clampQuestions(opts.questionCount);
  const base = simQuiz(student, plan, mod, quizId, tutorLanguage, opts);
  const langName = tutorLanguage === 'zu' ? 'isiZulu' : tutorLanguage === 'st' ? 'Sesotho' : null;
  const ac = academyContextPrompt();
  const extra = workflowInstructions?.trim() ? `\nWorkflow instructions: ${workflowInstructions.trim()}` : '';
  const memLine = memory?.trim() ? `\nPast memory for this learner (build on previous attempts cleanly): ${memory.trim()}` : '';
  const ai = await generateJSON<Pick<RemedialQuiz, 'tutoringSummary' | 'keyPoints' | 'questions'> & { localizedSummary?: { summary: string; keyPoints: string[] } }>({
    system: `You are Lindiwe, the Learning & Assessment specialist at ${ac.academyName}. You write targeted mastery tests and short tutoring guides${langName ? ` with grounded South African ${langName} explanations alongside English` : ''}. Every question is accurate, unambiguous and has exactly one correct option. ${ac.voice} ${JSON_ONLY}${teach('learning')}${extra}`,
    prompt: `Learner ${student.name} (${student.cohort}) is behind on ${mod.code} ${mod.title}. Weak topic: "${plan.weakTopic}". Syllabus topics: ${mod.topics.join('; ')}.${evidenceLine(opts.evidence)}${memLine}${formatMissed(missedQuestions)}

Write a ${n}-question multiple-choice mastery test that tests ONLY this module and topic, plus a tutoring summary that re-teaches it in plain language.${langName ? ` Also provide a natural, accurate ${langName} translation of the tutoring summary and key points so the learner can study in their home language alongside English.` : ''}
Rules for the questions:
- Exactly ${n} questions, ordered from easy (recall the idea) to harder (apply it, predict the output, spot the bug).
- Cover every missed sub-topic above at least once, then the rest of the weak topic.
- 4 options each, exactly one correct, plausible distractors based on real misconceptions, no "all of the above".
- Every question names the module's own vocabulary (for example: ${mod.keywords.slice(0, 6).join(', ')}).
- The explanation teaches why the answer is right in 1 to 2 sentences.
- No two questions test the same fact.
- The test length here (${n} questions) overrides any question count in your standing instructions.

JSON shape:
{"tutoringSummary": "120-220 words", "keyPoints": ["4 to 5 short points"],${langName ? ` "localizedSummary": {"summary": "${langName} translation (80-160 words)", "keyPoints": ["4 short points in ${langName}"]},` : ''} "questions": [{"prompt": "...", "options": ["...","...","...","..."], "answerIndex": 0-3, "explanation": "...", "topicTag": "sub-topic"}]}`,
    maxTokens: 28000,
    timeoutMs: 60000,
    validate: (x) => {
      const o = obj(x); if (!o) return null;
      const questions = validateQuestions(o.questions, n, n);
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
  // A model test that already fails the rubric is not a useful draft: keep the
  // good questions and top up from the bank, or fall back to the bank.
  const audit = auditRemedialQuiz(merged, mod.keywords);
  if (audit.pass) return { value: merged, viaAi: true };
  const onlyTopicIssues = audit.badIds.length > 0 && audit.badIds.length <= Math.ceil(n / 3);
  if (onlyTopicIssues) {
    const topped = fixQuiz(merged, audit.badIds);
    if (auditRemedialQuiz(topped, mod.keywords).pass) return { value: topped, viaAi: true };
  }
  return { value: base, viaAi: false };
}

/* ── Learning & Assessment: the personalised video lesson ─────────────────── */

const VISUALS: SlideVisual[] = SCENE_VISUALS;

export interface LessonDraftOptions extends PackDraftOptions { tutorName?: string }

export async function draftLesson(
  student: StudentProfile,
  mod: ModuleSyllabus,
  topic: string,
  missedQuestions?: MissedQuestion[],
  workflowInstructions?: string,
  memory?: string,
  opts: LessonDraftOptions = {},
): Promise<AiResult<Lesson>> {
  const ac = academyContextPrompt();
  const n = clampQuestions(opts.questionCount);
  const pass = clampPassMark(opts.passMark);
  const tutorName = opts.tutorName || 'Lindiwe';
  const fallback = simLesson(student.name, mod, topic, { ...opts, tutorName, academyName: ac.academyName });
  const first = student.name.split(' ')[0];
  const noticed = noticedLine(opts.evidence, mod, topic);
  const extra = workflowInstructions?.trim() ? `\nWorkflow instructions: ${workflowInstructions.trim()}` : '';
  const memLine = memory?.trim() ? `\nPast memory for this learner: ${memory.trim()}` : '';
  const ai = await generateJSON<Lesson>({
    system: `You are ${tutorName}, the Learning & Assessment tutor at ${ac.academyName}, and you script short animated explainer videos (think a great YouTube explainer, not a slide deck) that re-teach one topic to one learner. You speak to the learner directly, like a warm, upbeat tutor on a video call, in natural South African English. ${ac.voice} ${JSON_ONLY}${teach('learning')}${extra}`,
    prompt: `Script a 3-minute personal explainer video for ${student.name} (${student.cohort}) on ${mod.code} ${mod.title}, weak topic "${topic}". Syllabus topics: ${mod.topics.join('; ')}.${evidenceLine(opts.evidence)}${memLine}${formatMissed(missedQuestions)}

THE GOLDEN RULE: the screen SHOWS, the voice TELLS. Every scene is an animation (icons, arrows, a split screen, typed code, one big number). On-screen words are tiny labels, never sentences. The explaining happens in the narration.

8 scenes, in this order of purpose (choose the visual that best SHOWS each idea):
1. "greeting": narration opens exactly "Hey ${first}, how are you?", then what you noticed (${noticed}) kindly and without labels, then "so I made this lesson just for you", introduce yourself as ${tutorName}, say what you'll fix together.
2 to 6. Teach the topic, one idea per scene, fixing the exact misconceptions above. Use at least 4 DIFFERENT visuals from:
   - "flow": something moving through 3 to 5 stages in order (each stage leads to the next). scene.nodes = [{"label": "max 3 words", "icon": "...", "note": "optional, max 5 words"}].
   - "branch": one thing that ends one of two ways (succeeds or fails, matches or not, true or false). scene.from, scene.yes, scene.no (each {"label", "icon"}). Use this, not "flow", when there are two possible outcomes.
   - "compare": the common mistake vs the fix. scene.left = the mistake, scene.right = the fix (each {"label": "max 6 words", "icon", "code": "optional, max 3 lines"}).
   - "code": only if the subject is code: "code" (max 8 lines), scene.highlight = [line numbers to point at], scene.caption = "max 8 words".
   - "analogy": an everyday South African thing ≈ the concept. scene.left = the everyday thing, scene.right = the concept (each {"label": "max 3 words", "icon"}), scene.caption = "max 10 words".
   - "big": one number or short phrase that sticks, e.g. "3 states" or "Always return". scene.value (max 3 words), scene.caption (max 10 words).
7. "recap": scene.nodes = 3 to 4 things to remember, each {"label": "max 6 words", "icon"}.
8. "cta": send ${first} to the ${n}-question test (pass mark ${pass}%), short and encouraging.

Labels must make sense on their own: a short noun phrase ("First taxi", "Promise.race"), never a cut-off sentence.
Icons: pick from exactly this list: ${SCENE_ICONS.join(', ')}.

Every scene: "visual", "heading" (max 5 words, a title not a sentence), "scene" (as above), "points": [] (leave empty), and "say": the narration, 40 to 70 words. Write "say" for the ear: short sentences, contractions (you'll, it's, let's), a friendly rhythm, point at what's on screen ("see how the arrow splits here?"), never read the labels or code out symbol by symbol, never say "at risk" or "failing", no markdown, no emoji.

JSON shape: {"title": "short lesson title", "slides": [{"visual": "flow", "heading": "...", "scene": {...}, "points": [], "code": "only for code scenes", "say": "..."}]}`,
    maxTokens: 18000,
    timeoutMs: 50000,
    validate: (x) => {
      const o = obj(x); if (!o || !isStr(o.title) || !Array.isArray(o.slides) || o.slides.length < 5 || o.slides.length > 12) return null;
      const slides = (o.slides as unknown[]).map((v, i, all) => {
        const q = obj(v); if (!q || !isStr(q.heading) || !isStr(q.say)) return null;
        const wanted = visualOf(q);
        let visual: SlideVisual = wanted && VISUALS.includes(wanted) ? wanted : (isStr(q.code) ? 'code' : 'big');
        if (i === 0) visual = 'greeting';
        if (i === all.length - 1) visual = 'cta';
        // The scene before the call to action is the recap, whatever the model called it.
        if (i === all.length - 2 && (visual === 'flow' || /recap|remember|summary|wrap/i.test(q.heading))) visual = 'recap';
        let scene = cleanScene(visual, q.scene);
        const code = isStr(q.code) ? q.code.replace(/\r\n/g, '\n').split('\n').slice(0, 10).join('\n').slice(0, 520) : undefined;
        if (visual === 'code' && !code) visual = 'big';
        // A scene the model left half-drawn becomes one big line instead of an empty screen.
        if (!sceneComplete(visual, scene)) {
          visual = visual === 'greeting' || visual === 'cta' || visual === 'code' ? visual : 'big';
          scene = visual === 'big' ? { value: clampWords(q.heading, 5), caption: scene?.caption } : scene;
        }
        return { heading: clampWords(q.heading, 6), points: [], code, say: q.say.trim(), visual, scene } as LessonSlide;
      });
      if (slides.some((s) => !s)) return null;
      return { title: o.title.trim(), slides: slides as LessonSlide[], viaAi: true };
    },
  });
  if (!ai) return { value: fallback, viaAi: false };
  // The greeting is the point of the video: make sure it is personal, whatever the model wrote.
  const [open, ...rest] = ai.slides;
  const greeting = fallback.greeting as string;
  const say = new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(open.say)
    ? open.say
    : `${greeting} ${open.say}`;
  const slides: LessonSlide[] = [
    { ...open, visual: 'greeting', heading: /\b(hey|hi|hello|sawubona|dumela)\b/i.test(open.heading) ? open.heading : `Hey ${first}`, say },
    ...rest,
  ];
  return {
    value: { ...ai, slides, greeting, tutorName, academyName: ac.academyName, questionCount: n, passMark: pass, viaAi: true },
    viaAi: true,
  };
}

export async function reviseRemedialQuiz(quiz: RemedialQuiz, notes: string[], badIds: string[], mod: ModuleSyllabus): Promise<AiResult<RemedialQuiz>> {
  const n = quiz.questions.length;
  const ai = await generateJSON<RemedialQuiz>({
    system: `You are Lindiwe, the Learning & Assessment agent in the academy. The Reviewer rejected question(s) in your mastery test. Replace exactly the flagged question(s) with new ones on ${mod.code} ${quiz.topic}; keep the others and the summary unchanged. ${JSON_ONLY}${teach('learning')}`,
    prompt: `Reviewer critique:\n- ${notes.join('\n- ')}\n\nFlagged question ids: ${badIds.join(', ')}\nModule keywords the Reviewer checks for: ${mod.keywords.slice(0, 12).join(', ')}\n\nYour draft questions:\n${JSON.stringify(quiz.questions, null, 2)}\n\nReturn {"questions": [all ${n} questions in order, same ids, flagged ones replaced]}`,
    maxTokens: 20000,
    timeoutMs: 40000,
    validate: (x) => {
      const o = obj(x); if (!o) return null;
      const questions = validateQuestions(o.questions, n, n);
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

/* ── Persistent follow-ups ────────────────────────────────────────────────── */

export async function draftFollowUp(input: {
  learnerName: string;
  cohort: string;
  attempt: number;
  reason: string;
  workflowName: string;
  moduleCode: string | null;
  topic: string | null;
  hasLink: boolean;
  memory?: string;
}): Promise<AiResult<{ subject: string; body: string; ask: string }>> {
  const first = input.learnerName.split(' ')[0];
  const ac = academyContextPrompt();
  const fallback = {
    subject: input.attempt <= 2
      ? `${first}, quick check-in on ${input.moduleCode || input.cohort}`
      : `${first}, ${ac.academyName} is still in your corner`,
    body: input.hasLink
      ? [
          `Hi ${first},`,
          `It's ${ac.senderName} from ${ac.academyName} checking back in. We shared your ${input.moduleCode || ''} catch-up pack${input.topic ? ` on ${input.topic}` : ''} earlier and haven't seen it opened yet.`,
          `No pressure at all — it only takes about 3 minutes and updates your progress straight away.`,
          `Warm regards,\n${ac.senderName}\n${ac.senderTitle} · ${ac.academyName}`,
        ].join('\n\n')
      : [
          `Hi ${first},`,
          `It's ${ac.senderName} (${ac.senderTitle}) at ${ac.academyName}, following up from ${input.workflowName} (${input.reason}).`,
          `Life gets busy and we are happy to work around whatever got in the way so you stay on track in ${input.cohort}.`,
          `Warm regards,\n${ac.senderName}\n${ac.senderTitle} · ${ac.academyName}`,
        ].join('\n\n'),
    ask: input.hasLink
      ? 'Open the study pack link today, or reply with one line if you want a 15-minute tutor call instead.'
      : 'Reply with one line on what would help most right now (a recap, a call, or a flexible plan).',
  };

  const ai = await generateJSON<{ subject: string; body: string; ask: string }>({
    system: `You are ${ac.senderName} (${ac.senderTitle}) at ${ac.academyName}. You write follow-up #${input.attempt} to a learner who has not yet responded or completed their catch-up step. Never label them ('at risk', 'flagged', 'failing') and never guilt-trip. Use clean paragraph spacing (\\n\\n) and mention ${ac.academyName} by name. ${ac.voice} ${JSON_ONLY}${teach('success')}`,
    prompt: `Learner: ${input.learnerName} (${input.cohort}). Workflow: ${input.workflowName}. Follow-up attempt: #${input.attempt}. Original context: ${input.reason}. ${input.moduleCode ? `Module: ${input.moduleCode} (${input.topic || ''}).` : ''} ${input.hasLink ? 'They have a direct link to their personal video lesson and mastery test in this email.' : 'No quiz link; invite a quick reply or 1:1 session.'}${input.memory ? `\nLearner memory from DB: ${input.memory}` : ''}
JSON shape: {"subject": "under 8 words", "body": "well-spaced paragraphs separated by \\n\\n, signed ${ac.senderName}", "ask": "one small specific action they can do today"}`,
    maxTokens: 4000,
    timeoutMs: 14000,
    validate: (x) => {
      const o = obj(x);
      if (!o || !isStr(o.subject) || !isStr(o.body) || !isStr(o.ask)) return null;
      const combined = `${o.subject} ${o.body} ${o.ask}`;
      if (/\bat[- ]risk\b|risk score|\bflagged\b|\bfailing\b/i.test(combined)) return null;
      return { subject: o.subject.trim(), body: normalizeEmailBody(o.body, first, ac), ask: o.ask.trim() };
    },
  });
  return ai ? { value: ai, viaAi: true } : { value: fallback, viaAi: false };
}

export async function draftInboundReplyContinuation(input: {
  learnerName: string;
  cohort: string;
  replyText: string;
  previousContext: string;
  memory?: string;
}): Promise<AiResult<{ outcome: 'resolved' | 'needs_support' | 'handoff'; summary: string; subject: string; body: string; ask: string }>> {
  const first = input.learnerName.split(' ')[0];
  const ac = academyContextPrompt();
  const isPositive = /done|completed|submitted|paid|sorted|back on|will do tonight|finished|passed|thank/i.test(input.replyText);
  const needsHuman = /refund|cancel|drop out|hospital|emergency|complaint|call me|human|manager/i.test(input.replyText);

  const fallback = {
    outcome: (needsHuman ? 'handoff' : isPositive ? 'resolved' : 'needs_support') as 'resolved' | 'needs_support' | 'handoff',
    summary: needsHuman
      ? `${first} requested personal/urgent assistance in their reply — flagged for human follow-up.`
      : isPositive
        ? `${first} confirmed progress in their reply — continuing encouragement.`
        : `${first} shared what is getting in the way — tailored next support step drafted.`,
    subject: isPositive ? `Great to hear from you, ${first}` : `Re: Supporting you in ${input.cohort}`,
    body: normalizeEmailBody(
      isPositive
        ? `Hi ${first},\n\nThank you for letting us know! We have updated your support record at ${ac.academyName} and we are cheering you on in ${input.cohort}.\n\nReach out anytime if anything else comes up.\n\nWarm regards,\n${ac.senderName}\n${ac.senderTitle} · ${ac.academyName}`
        : `Hi ${first},\n\nThank you for replying and letting us know what is going on. At ${ac.academyName}, we want to work around real life so you can succeed in ${input.cohort}.\n\nWe will align your next step based on your note so there is no overwhelm.\n\nWarm regards,\n${ac.senderName}\n${ac.senderTitle} · ${ac.academyName}`,
      first,
      ac,
    ),
    ask: isPositive
      ? 'Keep going with your next module activity when you are ready.'
      : 'Let us know which day this week works best for a quick 15-minute check-in or lighter catch-up schedule.',
  };

  const ai = await generateJSON<{ outcome: 'resolved' | 'needs_support' | 'handoff'; summary: string; subject: string; body: string; ask: string }>({
    system: `You are ${ac.senderName} (${ac.senderTitle}) at ${ac.academyName}. A student just replied to an outreach email. Analyze their reply, decide whether the case is "resolved" (student completed/sorted it), "needs_support" (continue coaching with a tailored helpful email), or "handoff" (needs human staff attention), and write a warm, well-spaced continuation email. ${ac.voice} ${JSON_ONLY}${teach('success')}`,
    prompt: `Learner: ${input.learnerName} (${input.cohort}).
Context: ${input.previousContext}.
${input.memory ? `Past memory: ${input.memory}` : ''}
Student's email reply: "${input.replyText.slice(0, 1200)}"

JSON shape: {"outcome": "resolved|needs_support|handoff", "summary": "1-sentence internal summary of what the student said", "subject": "Re: concise subject", "body": "well-spaced reply paragraphs separated by \\n\\n, signed ${ac.senderName}", "ask": "clear single next step"}`,
    maxTokens: 5000,
    timeoutMs: 16000,
    validate: (x) => {
      const o = obj(x);
      if (!o || !isStr(o.summary) || !isStr(o.subject) || !isStr(o.body) || !isStr(o.ask)) return null;
      const outcome = (o.outcome === 'resolved' || o.outcome === 'handoff' || o.outcome === 'needs_support') ? o.outcome : 'needs_support';
      return {
        outcome,
        summary: o.summary.trim(),
        subject: o.subject.trim(),
        body: normalizeEmailBody(o.body, first, ac),
        ask: o.ask.trim(),
      };
    },
  });

  return ai ? { value: ai, viaAi: true } : { value: fallback, viaAi: false };
}
