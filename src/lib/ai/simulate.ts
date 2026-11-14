import type {
  CheckInMessage, GoalPlan, InterventionPlan, LearnerCase, LocalizedTutoring, PlanStep, QuizQuestion, RemedialQuiz, TutorLanguage,
} from '@/lib/types';
import type { EngagementMetrics, ModuleSyllabus, RiskAssessment, StudentProfile } from '@/lib/lms/lmsAdapter';

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

export function simCheckIn(c: LearnerCase, daysQuiet: number): CheckInMessage {
  const first = c.learner.name.split(' ')[0];
  return {
    learner: { id: c.learner.id, name: c.learner.name, email: c.learner.email },
    subject: `${first}, checking in`,
    body: `Hi ${first}, it's Bongani from Student Success. We haven't seen you online for ${daysQuiet} days, and your marks have been solid, so this isn't about the work. Life gets busy and that's okay. If something is getting in the way, time, money, a laptop or just energy, tell me and we'll find a way around it together. Your seat in ${c.learner.cohort} is yours.`,
    ask: 'Reply with one line on what got in the way, or book a 10-minute call this week.',
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
      { when: 'Today', action: `Send a 3-question remedial micro-quiz on ${risk.weakTopic || mod.title} with a two-minute tutoring summary`, owner: 'Learning & Assessment' },
      { when: 'Today', action: `WhatsApp check-in from the cohort mentor: no pressure, one question about what got in the way`, owner: 'Student Success' },
      { when: 'Within 48 h', action: `Book a 20-minute 1:1 on ${mod.code} if the quiz scores under the 67% pass mark`, owner: 'Learning & Assessment' },
      { when: 'Day 7', action: 'Re-run the engagement scan; close the case at two consecutive logins and a passed checkpoint', owner: 'Student Success' },
    ],
  };
}

/* ── Learning & Assessment ────────────────────────────────────────────────── */

const Q = (prompt: string, options: string[], answerIndex: number, explanation: string, topicTag: string): Omit<QuizQuestion, 'id'> => ({ prompt, options, answerIndex, explanation, topicTag });

export const QUESTION_BANK: Record<string, { summary: string; keyPoints: string[]; questions: Omit<QuizQuestion, 'id'>[] }> = {
  'JS-07': {
    summary: 'A Promise is a placeholder for a value that is not ready yet. It starts pending and settles once, as either fulfilled (with a value) or rejected (with a reason). .then() runs when it fulfils, .catch() when it rejects, and each returns a new Promise, which is what makes chaining work. async/await is the same machinery in a friendlier shape: await pauses the async function until the Promise settles, and a rejected Promise becomes a thrown error you catch with try/catch. Promise.all runs several Promises together and rejects as soon as any one of them rejects.',
    keyPoints: [
      'Pending → fulfilled or rejected. A Promise settles once and never changes again.',
      'Every .then() returns a new Promise, so the chain passes values down.',
      'await only works inside an async function; a rejected Promise throws at the await.',
      'Promise.all waits for all and fails fast; Promise.allSettled never fails.',
      'await in a loop runs one at a time; Promise.all runs them together.',
    ],
    questions: [
      Q('What does `await` do inside an async function?',
        ['Blocks the whole browser until the Promise settles', 'Pauses that function until the Promise settles, then gives back the fulfilled value', 'Converts the Promise into a callback', 'Runs the Promise a second time'],
        1, 'await pauses only the async function it is in. The rest of the program keeps running, and when the Promise fulfils the function resumes with the value.', 'async/await'),
      Q('A fetch inside an async function rejects. Which pattern catches the error?',
        ['if (response.error) { ... }', 'response.catch(err => ...) after the await', 'try { await fetch(url) } catch (err) { ... }', 'await.catch(err => ...)'],
        2, 'With await, a rejected Promise becomes a thrown error. try/catch around the await is the way to handle it.', 'error handling'),
      Q('What does `Promise.all([a, b, c])` return?',
        ['The first Promise to settle', 'A single Promise that fulfils with an array of all three values, or rejects as soon as any one rejects', 'An array of three settled values immediately', 'Nothing; it only runs them'],
        1, 'Promise.all combines them into one Promise. It fulfils with the array of results in order, and it rejects fast if any input rejects.', 'Promise.all'),
      Q('In `getUser().then(u => u.id).then(id => console.log(id))`, what does the second .then() receive?',
        ['The original user object', 'undefined', 'The value returned by the first .then(), the id', 'A new Promise it must await'],
        2, 'Each .then() returns a new Promise that fulfils with whatever the callback returned, so the id flows into the next step of the chain.', 'Promise chaining'),
      Q('Which log order does this produce?\n\nconsole.log("A");\nsetTimeout(() => console.log("B"), 0);\nPromise.resolve().then(() => console.log("C"));\nconsole.log("D");',
        ['A, B, C, D', 'A, D, C, B', 'A, D, B, C', 'A, C, D, B'],
        1, 'Synchronous code runs first (A, D). Then the microtask queue drains (C) before the timer callback on the macrotask queue (B).', 'event loop'),
    ],
  },
  'SQL-04': {
    summary: 'A JOIN combines rows from two tables on a matching key. INNER JOIN keeps only the rows that match on both sides. LEFT JOIN keeps every row from the left table and fills the right side with NULL where nothing matches, which is how you find "customers with no orders". GROUP BY folds many rows into one per group so you can COUNT, SUM or AVG them, and HAVING filters those groups after the aggregation (WHERE filters rows before it).',
    keyPoints: [
      'INNER JOIN: matches only. LEFT JOIN: everything on the left, NULLs where no match.',
      'Join on the foreign key; a wrong ON clause multiplies rows.',
      'WHERE filters rows before grouping; HAVING filters groups after.',
      'COUNT(column) ignores NULLs; COUNT(*) counts rows.',
    ],
    questions: [
      Q('Which query lists every customer, including those who have never placed an order?',
        ['SELECT ... FROM customers INNER JOIN orders ON ...', 'SELECT ... FROM customers LEFT JOIN orders ON customers.id = orders.customer_id', 'SELECT ... FROM orders LEFT JOIN customers ON ...', 'SELECT ... FROM customers CROSS JOIN orders'],
        1, 'LEFT JOIN keeps every row from the left table (customers) and fills order columns with NULL where there is no match.', 'LEFT JOIN'),
      Q('After `GROUP BY customer_id`, which clause keeps only customers with more than 5 orders?',
        ['WHERE COUNT(*) > 5', 'HAVING COUNT(*) > 5', 'ORDER BY COUNT(*) > 5', 'LIMIT 5'],
        1, 'HAVING filters groups after aggregation. WHERE runs before grouping, so it cannot see COUNT(*).', 'HAVING'),
      Q('customers has 100 rows, orders has 250 rows and every order belongs to a customer. How many rows does `customers INNER JOIN orders` return?',
        ['100', '250', '350', '25,000'],
        1, 'Each order matches exactly one customer, so the inner join returns one row per order: 250.', 'INNER JOIN'),
      Q('In a LEFT JOIN from customers to orders, what is `orders.total` for a customer with no orders?',
        ['0', 'An empty string', 'NULL', 'The row is dropped'],
        2, 'Unmatched right-side columns are NULL in a LEFT JOIN. The customer row is kept.', 'NULL handling'),
    ],
  },
  'RE-03': {
    summary: 'State is the data a component owns and that can change over time. useState gives you the value and a setter; calling the setter re-renders the component with the new value. Never mutate state directly: create a new object or array so React sees the change. useEffect runs side effects after render, and its dependency array decides when: [] once on mount, [x] whenever x changes, and no array after every render.',
    keyPoints: [
      'Calling the setter schedules a re-render; mutating state does not.',
      'Copy, then change: setItems([...items, newItem]), not items.push().',
      'useEffect dependencies list every value the effect reads.',
      'Share state by lifting it to the closest common parent.',
    ],
    questions: [
      Q('Why does `items.push(newItem); setItems(items);` fail to show the new item?',
        ['push is asynchronous', 'The array reference did not change, so React skips the re-render', 'setItems only accepts strings', 'useState cannot hold arrays'],
        1, 'React compares the new state to the old by reference. The same array object means "nothing changed". Create a new array: setItems([...items, newItem]).', 'immutable updates'),
      Q('What does `useEffect(() => { fetchData(); }, [])` do?',
        ['Runs fetchData on every render', 'Runs fetchData once, after the first render', 'Never runs fetchData', 'Runs fetchData before the component mounts'],
        1, 'An empty dependency array means the effect has no dependencies, so it runs once after the component mounts.', 'useEffect'),
      Q('Two sibling components need the same piece of state. Where should it live?',
        ['In whichever sibling renders first', 'In a global variable outside React', 'In their closest common parent, passed down as props', 'Duplicated in both and kept in sync manually'],
        2, 'Lift the state up to the closest common parent and pass the value and setter down as props.', 'lifting state'),
      Q('What happens when you call `setCount(count + 1)` three times in one click handler?',
        ['count increases by 3', 'count increases by 1, because each call read the same stale count', 'React throws an error', 'The component unmounts'],
        1, 'All three calls read the same count from this render. Use the updater form, setCount(c => c + 1), to build on the latest value.', 'useState'),
    ],
  },
};

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
  ],
  'PY-05': [
    { label: 'Watch: pandas groupby and merge, explained', url: yt('pandas groupby merge explained'), kind: 'watch' },
    { label: 'pandas docs: Group by', url: 'https://pandas.pydata.org/docs/user_guide/groupby.html', kind: 'read' },
  ],
  'SEC-06': [
    { label: 'Watch: firewalls and TLS, explained', url: yt('firewall tls explained'), kind: 'watch' },
  ],
};

export function simQuiz(student: StudentProfile, plan: InterventionPlan, mod: ModuleSyllabus, quizId: string, tutorLanguage: TutorLanguage = 'en'): RemedialQuiz {
  const bank = QUESTION_BANK[mod.code] || QUESTION_BANK['JS-07'];
  const translations = LOCALIZED_BANK[mod.code] || LOCALIZED_BANK['JS-07'];
  const picked = bank.questions.slice(0, 3).map((q, i) => ({ ...q, id: `q${i + 1}` }));
  return {
    quizId,
    learner: { id: student.id, name: student.name, email: student.email },
    module: { code: mod.code, title: mod.title },
    topic: plan.weakTopic,
    topicKeywords: mod.keywords,
    tutoringSummary: bank.summary,
    keyPoints: bank.keyPoints,
    localizedSummary: tutorLanguage === 'zu' || tutorLanguage === 'st' ? translations[tutorLanguage] : null,
    allTranslations: translations,
    questions: picked,
    resources: RESOURCES[mod.code] || [],
    passMark: 67,
    status: 'pending',
    result: null,
  };
}

/** A lesson built from the question bank, for when the model is off. */
export function simLesson(name: string, mod: ModuleSyllabus, topic: string): import('@/lib/types').Lesson {
  const bank = QUESTION_BANK[mod.code] || QUESTION_BANK['JS-07'];
  const first = name.split(' ')[0];
  const pts = bank.keyPoints;
  return {
    title: `${mod.code} · ${topic}`,
    viaAi: false,
    slides: [
      { heading: `Hi ${first}: let's fix ${topic}`, points: [`${mod.code} · ${mod.title}`, 'About 3 minutes', 'Then 3 quick questions'], say: `Hi ${first}. Your last checkpoint showed that ${topic} is the one thing holding you back in ${mod.code}. In the next three minutes we will go through it step by step, and then you will try three short questions. You have got this.` },
      { heading: 'The big idea', points: [bank.summary.split('. ')[0] + '.'], say: bank.summary.split('. ').slice(0, 2).join('. ') + '.' },
      ...pts.slice(0, 4).map((p, i) => ({ heading: `Key point ${i + 1}`, points: [p], say: `Key point ${i + 1}. ${p} Take a second to picture what that means in code you have written.` })),
      { heading: 'Putting it together', points: pts.slice(0, 3), say: `Let's put it together. ${pts.slice(0, 3).join(' ')}` },
      { heading: 'Your turn', points: ['3 questions on exactly this topic', 'Pass mark 67%', 'Your record updates the moment you submit'], say: `That's the lesson. Now try the three questions. They are on exactly what we just covered. Pass two of the three and your record updates straight away. Good luck, ${first}.` },
    ],
  };
}

export function injectQuizDefect(q: RemedialQuiz): RemedialQuiz {
  const questions = q.questions.map((x, i) => (i === q.questions.length - 1 ? { ...OFF_TOPIC_QUESTION, id: x.id } : x));
  return { ...q, questions };
}

/** Replace any question the audit flagged with the next on-topic one in the bank. */
export function fixQuiz(q: RemedialQuiz, badIds: string[]): RemedialQuiz {
  const bank = (QUESTION_BANK[q.module.code] || QUESTION_BANK['JS-07']).questions;
  const used = new Set(q.questions.map((x) => x.prompt));
  const spare = bank.filter((b) => !used.has(b.prompt));
  const questions = q.questions.map((x) => {
    if (!badIds.includes(x.id)) return x;
    const next = spare.shift() || bank[0];
    return { ...next, id: x.id };
  });
  return { ...q, questions };
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
