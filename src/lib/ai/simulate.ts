import { clampWords } from '@/lib/lessonScene';
import type {
  CheckInMessage, GoalPlan, InterventionPlan, LearnerCase, Lesson, LessonEvidence, LessonSlide, LocalizedTutoring, PlanStep, QuizQuestion, RemedialQuiz, TutorLanguage,
} from '@/lib/types';
import type { EngagementMetrics, ModuleSyllabus, RiskAssessment, StudentProfile } from '@/lib/lms/lmsAdapter';
import { Q, QUESTION_BANK, bankFor, clampPassMark, clampQuestions, noticedLine, syllabusFor } from './questionBank';

/* Smart simulation.
 *
 * Everything an agent can produce, written out in full, so the colleague does
 * the whole job with no API key and no network. The model layer, when it is
 * on, produces the same shapes; the Reviewer audits both the same way. */

/* ── Planner ──────────────────────────────────────────────────────────────── */

export const COHORTS = ['FSWD-2026-Q3', 'DA-2026-Q3', 'CYB-2026-Q3'];

/** Read the scope out of the goal's words when there is no model to ask. */
export function readScope(goal: string): GoalPlan['scope'] {
  const g = goal.toLowerCase();
  const cohorts = COHORTS.filter((c) => {
    const code = c.split('-')[0].toLowerCase();
    if (g.includes(c.toLowerCase()) || new RegExp(`\\b${code}\\b`).test(g)) return true;
    if (code === 'fswd' && /full[- ]?stack|web dev/.test(g)) return true;
    if (code === 'da' && /data analytics|\bdata\b/.test(g)) return true;
    if (code === 'cyb' && /cyber|security/.test(g)) return true;
    return false;
  });
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const m = g.match(/\b(?:top|the|most at[- ]risk)\s+(\d+|one|two|three|four|five)\b/);
  const limit = m ? Math.max(1, Math.min(10, Number(m[1]) || words[m[1]] || 10)) : 10;
  const language: TutorLanguage = /isizulu|\bzulu\b/.test(g) ? 'zu' : /sesotho|\bsotho\b/.test(g) ? 'st' : 'en';
  return { cohorts: cohorts.length ? cohorts : [...COHORTS], limit, language };
}

export const STAGE_OWNER: Record<PlanStep['key'], PlanStep['owner']> = {
  scan: 'success', diagnose: 'success', act: 'learning', review: 'coo', deliver: 'coo', follow_up: 'success',
};

export function simGoalPlan(goal: string, scope = readScope(goal)): GoalPlan {
  const where = scope.cohorts.length === COHORTS.length ? 'every cohort' : scope.cohorts.join(' and ');
  const lang = scope.language === 'zu' ? ' Tutoring goes out in isiZulu alongside English.' : scope.language === 'st' ? ' Tutoring goes out in Sesotho alongside English.' : '';
  const step = (key: PlanStep['key'], text: string): PlanStep => ({ key, owner: STAGE_OWNER[key], text, status: 'todo' });
  return {
    goal,
    reading: `The outcome is learners back on track, not a report. I will scope it to ${where}, find out why each one is behind before anyone acts, and only call it done when every learner has something they can act on today.${lang}`,
    scope,
    successCriteria: 'Every learner who needs help has a reviewed, personal next step in their inbox, and the LMS shows it.',
    steps: [
      step('scan', `Pull engagement and marks for ${where} from the LMS and score every learner`),
      step('diagnose', 'Work out why each flagged learner is behind: a topic gap or disengagement'),
      step('act', 'Topic gaps get a catch-up quiz and tutoring; disengaged learners get a personal check-in'),
      step('review', 'The Reviewer checks every output against the LMS evidence and sends back anything wrong'),
      step('deliver', 'Send each learner their approved work and mark the case open in the LMS'),
      step('follow_up', 'Watch for results: a passed quiz flips the learner back to On Track'),
    ],
    viaAi: false,
  };
}

/* ── Student Success: diagnosis ───────────────────────────────────────────── */

/** The evidence decides the cause: a failed checkpoint is a topic gap; silence with passing marks is disengagement. */
export function simCase(student: StudentProfile, e: EngagementMetrics, risk: RiskAssessment): LearnerCase {
  const first = student.name.split(' ')[0];
  const topic = Boolean(risk.weakModule) && risk.signals.some((s) => /checkpoint scored/.test(s));
  return {
    learner: { id: student.id, name: student.name, email: student.email, cohort: student.cohort, programme: student.programme },
    riskScore: risk.score,
    signals: risk.signals,
    cause: topic ? 'topic_gap' : 'disengaged',
    why: topic
      ? `${first} failed the ${risk.weakModule?.code} checkpoint on ${risk.weakTopic || 'one topic'} and went quiet after it: the silence follows the mark, so re-teaching the topic comes first.`
      : `${first} passes every quiz but has not logged in for ${e.daysSinceLastLogin} days: the work is not the problem, so a quiz would not help and a person should reach out.`,
    action: topic ? 'remedial_quiz' : 'checkin',
    owner: topic ? 'learning' : 'success',
    weakModule: topic ? risk.weakModule : null,
    weakTopic: topic ? (risk.weakTopic || risk.weakModule?.title || null) : null,
  };
}

export function simCheckIn(
  c: LearnerCase,
  daysQuiet: number,
  ac: { academyName: string; senderName: string; senderTitle: string } = {
    academyName: 'Melsoft Academy',
    senderName: 'Bongani',
    senderTitle: 'Student Success',
  },
): CheckInMessage {
  const first = c.learner.name.split(' ')[0];
  return {
    learner: { id: c.learner.id, name: c.learner.name, email: c.learner.email },
    subject: `${first}, checking in from ${ac.academyName}`,
    body: [
      `Hi ${first},`,
      `I'm ${ac.senderName} from ${ac.senderTitle} at ${ac.academyName}. We noticed it has been ${daysQuiet} days since your last login in ${c.learner.cohort}, and wanted to check in personally rather than just sending automated reminders.`,
      `If life got busy or something got in the way — time, schedules, data, or a tricky concept — let me know and we will work out a flexible plan around it together. Your place in ${c.learner.cohort} is yours.`,
      `Warm regards,\n${ac.senderName}\n${ac.senderTitle} · ${ac.academyName}`,
    ].join('\n\n'),
    ask: 'Reply with one line on what got in the way, or suggest a quick 15-minute slot that works for you this week.',
  };
}

/* ── Student Success ──────────────────────────────────────────────────────── */

export function simPlan(student: StudentProfile, e: EngagementMetrics, risk: RiskAssessment): InterventionPlan {
  const first = student.name.split(' ')[0];
  const mod = risk.weakModule || { code: e.currentModule.code, title: e.currentModule.title };
  return {
    learner: { id: student.id, name: student.name, email: student.email, cohort: student.cohort, programme: student.programme },
    riskScore: risk.score,
    signals: risk.signals,
    weakModule: mod,
    weakTopic: risk.weakTopic || mod.title,
    topicKeywords: risk.topicKeywords,
    summary: `${first} was on pace until ${mod.code}. The checkpoint result and the silence since point at one topic, ${risk.weakTopic || mod.title}, not at motivation. A short, targeted win on that topic is the fastest way back.`,
    actions: [
      { when: 'Today', action: `Send a personal video lesson and a mastery test on ${risk.weakTopic || mod.title}, with a two-minute tutoring summary`, owner: 'Learning & Assessment' },
      { when: 'Today', action: `WhatsApp check-in from the cohort mentor: no pressure, one question about what got in the way`, owner: 'Student Success' },
      { when: 'Within 48 h', action: `Book a 20-minute 1:1 on ${mod.code} if the quiz scores under the 67% pass mark`, owner: 'Learning & Assessment' },
      { when: 'Day 7', action: 'Re-run the engagement scan; close the case at two consecutive logins and a passed checkpoint', owner: 'Student Success' },
    ],
  };
}

/* ── Learning & Assessment ────────────────────────────────────────────────── */

export { QUESTION_BANK, syllabusFor, bankFor, noticedLine, clampQuestions, clampPassMark } from './questionBank';

/** An off-topic question the demo slips into the first draft. */
export const OFF_TOPIC_QUESTION: Omit<QuizQuestion, 'id'> = Q(
  'Which CSS property aligns flex items along the main axis?',
  ['align-items', 'justify-content', 'flex-wrap', 'grid-template-columns'],
  1, 'justify-content distributes items along the main axis of a flex container.', 'CSS Flexbox',
);

export const LOCALIZED_BANK: Record<string, Record<'zu' | 'st', LocalizedTutoring>> = {
  'JS-07': {
    zu: {
      language: 'zu',
      label: 'isiZulu',
      summary: 'I-Promise ifana nesithembiso sedatha engakafiki manje. Iqala ilindile (pending), bese iphetha kanye kuphela: iyaphumelela (fulfilled) noma iyehluleka (rejected). Sebenzisa u-.then() uma iphumelela kanye no-.catch() uma kunephutha. U-async/await wenza lolu hlelo lube lula ukufundeka: u-await umisa umsebenzi we-async kuphela kuze kufike impendulo, kuthi u-try/catch ubambe amaphutha. U-Promise.all uhlanganisa ama-Promise amaningi kanyekanye.',
      keyPoints: [
        'Pending → fulfilled noma rejected: i-Promise ishintsha kanye kuphela.',
        'U-.then() ngamunye ubuyisela i-Promise entsha ukuze uchungechunge luqhubeke.',
        'U-await usebenza ngaphakathi kwe-async function kuphela; iphutha libanjwa ngo-try/catch.',
        'U-Promise.all ulinda zonke, futhi wehluleka ngokushesha uma eyodwa yehluleka.',
      ],
    },
    st: {
      language: 'st',
      label: 'Sesotho',
      summary: 'Promise ke tshepiso ya boleng bo e-so fihle hona jwale. E qala e emetse (pending), ebe e phethela hang feela: e atlehile (fulfilled) kapa e hlolehile (rejected). Sebedisa .then() ha e atlehile le .catch() ha ho na le phoso. async/await e nolofatsa mokgwa ona: await e emisa tshebetso ya async feela ho fihlela Promise e araba, mme try/catch e tshwara diphoso. Promise.all e tsamaisa di-Promise tse ngata ka nako e le nngwe.',
      keyPoints: [
        'Pending → fulfilled kapa rejected: Promise e fetoha hang feela.',
        '.then() ka nngwe e kgutlisa Promise e ntjha bakeng sa ketane ya diketso.',
        'await e sebetsa ka hara async function feela; diphoso di tshwarwa ka try/catch.',
        'Promise.all e emela tsohle mme e hloleha hang-hang ha e le nngwe e hloleha.',
      ],
    },
  },
  'SQL-04': {
    zu: {
      language: 'zu',
      label: 'isiZulu',
      summary: 'U-JOIN uhlanganisa imigqa yamatafula amabili ngokhiye ofanayo. U-INNER JOIN ugcina imigqa efana nhlangothi zombili kuphela. U-LEFT JOIN ugcina yonke imigqa yetafula langakwesobunxele bese egcwalisa nge-NULL lapho kungekho okufanayo — lokhu kukusiza uthole amakhasimende angenama-oda. U-GROUP BY uhlanganisa imigqa eminingi ibe iqembu elilodwa ukuze ubale nge-COUNT noma u-SUM, kuthi u-HAVING uhlunge amaqembu ngemva kokubala.',
      keyPoints: [
        'INNER JOIN: okufanayo kuphela. LEFT JOIN: konke okungakwesobunxele, bese kuba ngu-NULL lapho kungafani.',
        'Hlanganisa ngo-foreign key (ON); ukhiye ongalungile wandisa imigqa ngokungeyikho.',
        'U-WHERE uhlunga imigqa ngaphambi kwe-GROUP BY; u-HAVING uhlunga amaqembu ngemva kwayo.',
        'I-COUNT(ikholomu) ayibali ama-NULL; i-COUNT(*) ibala yonke imigqa.',
      ],
    },
    st: {
      language: 'st',
      label: 'Sesotho',
      summary: 'JOIN e kopanya mela ya ditafole tse pedi ho sebediswa senotlolo se tshwanang. INNER JOIN e boloka feela mela e tshwanang mahlakoreng ka bobedi. LEFT JOIN e boloka mela yohle ya tafole e ka ho le letshehadi ebe e tlatsa ka NULL moo ho se nang papiso — mokgwa ona o thusa ho fumana bareki ba senang di-oda. GROUP BY e kopanya mela hore o tle o bale ka COUNT kapa SUM, ha HAVING e sefa dihlopha ka mora palo.',
      keyPoints: [
        'INNER JOIN: tse tshwanang feela. LEFT JOIN: tsohle tsa le letshehadi le NULL moo ho sa tshwaneng.',
        'Kopanya ka foreign key (ON); ON e fosahetseng e atisa mela ho feta tekano.',
        'WHERE e sefa mela pele ho GROUP BY; HAVING e sefa dihlopha ka morao.',
        'COUNT(kholomo) ha e bale NULL; COUNT(*) e bala mela yohle.',
      ],
    },
  },
  'RE-03': {
    zu: {
      language: 'zu',
      label: 'isiZulu',
      summary: 'I-State yidatha elawulwa yikhomphonenti engashintsha ngokuhamba kwesikhathi. U-useState ukunika inani kanye nesilungisi (setter); uma usibiza, i-React ibuyekeza isikrini. Ungalokothi uguqule i-state ngokuqondile (njengo-.push): yenza ikhophi entsha ukuze i-React ibone ushintsho. U-useEffect usebenza ngemva kokuvela kwesikrini, futhi uhlu lwe-dependencies lunquma ukuthi ugijima nini.',
      keyPoints: [
        'Ukubiza i-setter kuqala ukuvuselela isikrini; ukushintsha uhlu ngokuqondile akwenzi lutho.',
        'Kopisha bese uyashintsha: setItems([...items, newItem]), hhayi items.push().',
        'I-dependency array ka-useEffect ibala yonke idatha efundwa yilowo msebenzi.',
        'Phakamisa i-state iye kumzali ofanayo uma ama-component amabili eyidinga.',
      ],
    },
    st: {
      language: 'st',
      label: 'Sesotho',
      summary: 'State ke data eo karolo ya React e e bolokang e ka fetohang ha nako e ntse e ya. useState e o fa boleng le setter; ha o bitsa setter, React e nchafatsa skrine. O se ke wa fetola state ka ho toba (jwaloka .push): etsa khopi e ntjha hore React e bone phetoho. useEffect e sebetsa ka mora ho taka skrine, mme lenane la dependencies le laola nako eo e mathang ka yona.',
      keyPoints: [
        'Ho bitsa setter ho tsosa re-render; ho fetola array ka ho toba ha ho etse letho.',
        'Kopitsa pele o fetola: setItems([...items, newItem]), eseng items.push().',
        'Lenane la dependencies ho useEffect le tshwanela ho kenyelletsa tsohle tse balwang.',
        'Phahamisa state ho e isa ho motswadi ya tshwanang bakeng sa dikarolo tse arolelanang.',
      ],
    },
  },
};

/** Real pages and a video search for each module's weak topics: the study pack. */
const yt = (q: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
export const RESOURCES: Record<string, { label: string; url: string; kind: 'read' | 'watch' }[]> = {
  'JS-07': [
    { label: 'Watch: JavaScript promises and async/await, explained', url: yt('javascript promises async await explained'), kind: 'watch' },
    { label: 'MDN: Using promises', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises', kind: 'read' },
    { label: 'MDN: async function', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function', kind: 'read' },
  ],
  'RE-03': [
    { label: 'Watch: React useState and useEffect, explained', url: yt('react useState useEffect explained'), kind: 'watch' },
    { label: 'React docs: State, a component\'s memory', url: 'https://react.dev/learn/state-a-components-memory', kind: 'read' },
    { label: 'React docs: Synchronizing with Effects', url: 'https://react.dev/learn/synchronizing-with-effects', kind: 'read' },
  ],
  'SQL-04': [
    { label: 'Watch: SQL joins, GROUP BY and HAVING, explained', url: yt('sql joins group by having explained'), kind: 'watch' },
    { label: 'W3Schools: SQL joins', url: 'https://www.w3schools.com/sql/sql_join.asp', kind: 'read' },
    { label: 'W3Schools: SQL HAVING', url: 'https://www.w3schools.com/sql/sql_having.asp', kind: 'read' },
  ],
  'CSS-04': [
    { label: 'Watch: Flexbox and Grid, explained', url: yt('css flexbox grid explained'), kind: 'watch' },
    { label: 'CSS-Tricks: A complete guide to Flexbox', url: 'https://css-tricks.com/snippets/css/a-guide-to-flexbox/', kind: 'read' },
    { label: 'MDN: Basic concepts of grid layout', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout/Basic_concepts_of_grid_layout', kind: 'read' },
  ],
  'PY-05': [
    { label: 'Watch: pandas groupby and merge, explained', url: yt('pandas groupby merge explained'), kind: 'watch' },
    { label: 'pandas docs: Group by', url: 'https://pandas.pydata.org/docs/user_guide/groupby.html', kind: 'read' },
    { label: 'pandas docs: Merge, join and concatenate', url: 'https://pandas.pydata.org/docs/user_guide/merging.html', kind: 'read' },
  ],
  'SEC-06': [
    { label: 'Watch: firewalls and TLS, explained', url: yt('firewall tls explained'), kind: 'watch' },
    { label: 'Cloudflare: What is TLS?', url: 'https://www.cloudflare.com/learning/ssl/transport-layer-security-tls/', kind: 'read' },
    { label: 'OWASP: Threat modeling cheat sheet', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html', kind: 'read' },
  ],
};

export interface PackOptions { questionCount?: number; passMark?: number; evidence?: LessonEvidence | null }

export function simQuiz(student: StudentProfile, plan: InterventionPlan, mod: ModuleSyllabus, quizId: string, tutorLanguage: TutorLanguage = 'en', opts: PackOptions = {}): RemedialQuiz {
  const bank = bankFor(mod, plan.weakTopic);
  const translations = LOCALIZED_BANK[mod.code];
  const n = Math.min(clampQuestions(opts.questionCount), bank.questions.length);
  const picked = bank.questions.slice(0, n).map((q, i) => ({ ...q, id: `q${i + 1}` }));
  return {
    quizId,
    learner: { id: student.id, name: student.name, email: student.email },
    module: { code: mod.code, title: mod.title },
    topic: plan.weakTopic,
    topicKeywords: mod.keywords,
    tutoringSummary: bank.summary,
    keyPoints: bank.keyPoints,
    localizedSummary: translations && (tutorLanguage === 'zu' || tutorLanguage === 'st') ? translations[tutorLanguage] : null,
    allTranslations: translations,
    questions: picked,
    resources: RESOURCES[mod.code] || [
      { label: `Watch: ${plan.weakTopic} explained`, url: yt(`${mod.title} ${plan.weakTopic} explained`), kind: 'watch' },
    ],
    passMark: clampPassMark(opts.passMark),
    status: 'pending',
    result: null,
    evidence: opts.evidence || null,
  };
}

export interface LessonOptions extends PackOptions { tutorName?: string; academyName?: string }

/** A lesson built from the question bank, for when the model is off. It still
 *  greets the learner by name and says what was noticed. */
export function simLesson(name: string, mod: ModuleSyllabus, topic: string, opts: LessonOptions = {}): Lesson {
  const bank = bankFor(mod, topic);
  const first = name.split(' ')[0];
  const pts = bank.keyPoints;
  const n = clampQuestions(opts.questionCount);
  const pass = clampPassMark(opts.passMark);
  const tutor = opts.tutorName ? `I'm ${opts.tutorName}, your tutor.` : '';
  const greeting = `Hey ${first}, how are you? I noticed ${noticedLine(opts.evidence, mod, topic)}, so I prepared this lesson just for you.`;
  const sentences = bank.summary.split(/(?<=\.)\s+/);
  const example = bank.questions.find((q) => /`/.test(q.prompt) || q.prompt.includes('\n'));
  const code = example
    ? (example.prompt.includes('\n') ? example.prompt.split('\n').slice(2).join('\n') : example.prompt.match(/`([^`]+)`/)?.[1] || '').slice(0, 320)
    : '';
  const q0 = bank.questions[0];
  const wrong = q0 ? q0.options.find((_, i) => i !== q0.answerIndex) : null;
  const right = q0 ? q0.options[q0.answerIndex] : pts[0];
  const ICON_STEPS = ['lightbulb', 'workflow', 'check', 'target', 'star'];
  // Visual scenes, with tiny labels: the narration does the explaining.
  const slides: LessonSlide[] = [
    { visual: 'greeting', heading: `Hey ${first}`, points: [], say: `${greeting} ${tutor} In the next few minutes we'll go through ${topic} step by step, and then you'll try ${n} questions on exactly this. You've got this.` },
    { visual: 'big', heading: "Today's one idea", points: [], scene: { value: clampWords(topic, 3), caption: 'The one thing we fix today' }, say: sentences.slice(0, 2).join(' ') },
    { visual: 'flow', heading: 'How it works', points: [], scene: { nodes: pts.slice(0, 3).map((p, k) => ({ label: clampWords(p, 3), icon: ICON_STEPS[k] })) }, say: `Let's take it step by step. First: ${pts[0]} Then: ${pts[1] || ''} And finally: ${pts[2] || ''}` },
    code
      ? { visual: 'code', heading: 'See it in code', points: [], code, scene: { highlight: [1], caption: clampWords(pts[3] || pts[0], 8) }, say: `Here's what it looks like in practice. Watch the highlighted line, that's where ${topic} happens. ${pts[3] || pts[0]}` }
      : { visual: 'analogy', heading: 'Think of it like this', points: [], scene: { left: { label: 'An online order', icon: 'package' }, right: { label: clampWords(topic, 3), icon: 'lightbulb' }, caption: clampWords(pts[3] || pts[0], 10) }, say: `Think of it like an online order. ${pts[3] || pts[0]} Picture where that shows up in work you've already done.` },
    { visual: 'compare', heading: 'Mistake vs fix', points: [], scene: { left: { label: clampWords(wrong || 'Guessing the rule', 6), icon: 'x' }, right: { label: clampWords(right, 6), icon: 'check' } }, say: `Here's the mistake most people make, and the fix. ${q0?.explanation || pts[0]}` },
    { visual: 'big', heading: 'Remember this', points: [], scene: { value: 'Remember', caption: clampWords(pts[4] || pts[pts.length - 1], 10) }, say: `One more thing worth remembering. ${pts[4] || pts[pts.length - 1]}` },
    { visual: 'recap', heading: 'Quick recap', points: [], scene: { nodes: pts.slice(0, 4).map((p) => ({ label: clampWords(p, 6), icon: 'check' })) }, say: `Quick recap. ${pts.slice(0, 3).join(' ')}` },
    { visual: 'cta', heading: 'Your turn', points: [], say: `That's the lesson, ${first}. Now try the ${n}-question test. Every question is on what we just covered. Score ${pass} percent or more and your record updates straight away. Good luck!` },
  ];
  return { title: `${mod.code} · ${topic}`, viaAi: false, slides, greeting, tutorName: opts.tutorName, academyName: opts.academyName, questionCount: n, passMark: pass };
}

/** An off-topic question the demo slips into the first draft: one that touches
 *  none of this module's keywords, so the Reviewer has something real to catch. */
export function injectQuizDefect(q: RemedialQuiz): RemedialQuiz {
  const kws = (q.topicKeywords || []).map((k) => k.toLowerCase());
  const candidates = [OFF_TOPIC_QUESTION, ...Object.entries(QUESTION_BANK).filter(([code]) => code !== q.module.code).flatMap(([, b]) => b.questions)];
  const offTopic = candidates.find((c) => !kws.some((k) => `${c.prompt} ${c.options.join(' ')} ${c.topicTag} ${c.explanation}`.toLowerCase().includes(k))) || OFF_TOPIC_QUESTION;
  const questions = q.questions.map((x, i) => (i === q.questions.length - 1 ? { ...offTopic, id: x.id } : x));
  return { ...q, questions };
}

/** Replace any question the audit flagged with the next unused on-topic one in the bank. */
export function fixQuiz(q: RemedialQuiz, badIds: string[]): RemedialQuiz {
  const mod = syllabusFor(q.module.code, q.module.title, q.topic);
  const bank = bankFor(mod, q.topic).questions;
  const used = new Set(q.questions.filter((x) => !badIds.includes(x.id)).map((x) => x.prompt));
  const spare = bank.filter((b) => !used.has(b.prompt));
  const replaced: QuizQuestion[] = [];
  for (const x of q.questions) {
    if (!badIds.includes(x.id)) { replaced.push(x); continue; }
    const next = spare.shift();
    if (next) replaced.push({ ...next, id: x.id });
  }
  // Out of spares: a shorter, fully on-topic test beats a padded one.
  const fixed = replaced.length >= 3 ? replaced : q.questions;
  return { ...q, questions: fixed.map((x, i) => ({ ...x, id: `q${i + 1}` })) };
}

/* ── COO ──────────────────────────────────────────────────────────────────── */

export function simCritique(kind: string, notes: string[], subject: string) {
  const lead = kind === 'remedial_quiz'
    ? `This quiz is meant to repair ${subject}. It cannot go to the learner as it stands.`
    : kind === 'checkin_message'
      ? `This message goes to a learner who is already pulling away. It has to read like a person, not a system.`
      : `Sent back for revision.`;
  return `${lead} ${notes.join(' ')} Fix these and resubmit; everything else holds.`;
}

export function simApproval(kind: string) {
  switch (kind) {
    case 'remedial_quiz': return 'Every question tests the weak topic, one correct answer each, explanations teach rather than tell. Approved for dispatch.';
    case 'catchup_plan': return 'Every case is backed by LMS evidence, the cause matches the marks, and each learner has an owner and an action. Approved.';
    case 'checkin_message': return 'Warm, personal, no risk labels, and one small ask the learner can answer today. Approved.';
    default: return 'Approved.';
  }
}
