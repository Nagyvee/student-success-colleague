import type { LearnerCard } from '@/lib/types';
import type { AssessmentRecord, EngagementMetrics, ModuleSyllabus, StudentProfile } from './lmsAdapter';

/* The Demo Sandbox cohort.
 *
 * A realistic slice of the academy: three cohorts, ten learners. Three
 * are falling behind on one specific module each (a topic gap: they need
 * re-teaching), and one passes every quiz but has gone silent (disengaged:
 * they need a person, not a quiz). Dates are relative to now, so the data
 * never goes stale. */

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

export const MODULES: ModuleSyllabus[] = [
  { code: 'JS-07', title: 'Asynchronous JavaScript: Promises & async/await', programmeCode: 'FSWD',
    topics: ['Promise states and chaining', 'async/await and error handling', 'Promise.all and Promise.race', 'The event loop and microtasks'],
    keywords: ['promise', 'async', 'await', 'then', 'catch', 'finally', 'resolve', 'reject', 'event loop', 'microtask', 'settimeout', 'promise.all', 'promise.race', 'callback', 'asynchronous', 'fetch', 'pending', 'fulfilled', 'rejected', 'try/catch', 'try'] },
  { code: 'RE-03', title: 'React State & Hooks', programmeCode: 'FSWD',
    topics: ['useState and immutable updates', 'useEffect and the dependency array', 'Lifting state up', 'Derived state and re-renders'],
    keywords: ['usestate', 'useeffect', 'state', 'hook', 're-render', 'render', 'props', 'setstate', 'dependency array', 'immutable', 'component', 'usereducer', 'closure', 'setcount', 'effect'] },
  { code: 'SQL-04', title: 'SQL Joins & Aggregations', programmeCode: 'DA',
    topics: ['INNER vs LEFT JOIN', 'Join keys and NULL handling', 'GROUP BY and HAVING', 'Aggregates across joined tables'],
    keywords: ['join', 'inner join', 'left join', 'right join', 'full outer', 'group by', 'having', 'aggregate', 'count', 'sum', 'avg', 'null', 'foreign key', 'cross join', 'on ', 'rows'] },
  { code: 'CSS-04', title: 'CSS Layout: Flexbox & Grid', programmeCode: 'FSWD',
    topics: ['Flex container and items', 'justify-content and align-items', 'Grid template areas'],
    keywords: ['flex', 'flexbox', 'grid', 'justify-content', 'align-items', 'gap', 'layout'] },
  { code: 'PY-05', title: 'Python Data Wrangling with pandas', programmeCode: 'DA',
    topics: ['DataFrames', 'groupby', 'merge'], keywords: ['pandas', 'dataframe', 'groupby', 'merge'] },
  { code: 'SEC-06', title: 'Network Security Fundamentals', programmeCode: 'CYB',
    topics: ['Firewalls', 'TLS', 'Threat modelling'], keywords: ['firewall', 'tls', 'port', 'threat'] },
];

export const PROGRAMMES = {
  FSWD: { code: 'FSWD', name: 'Full-Stack Web Development', duration: '12 months', mode: 'Online, live evening classes + weekend labs', tuition: 42_000, registrationFee: 1_500, intakeMonths: [1, 4, 7, 10] },
  DA: { code: 'DA', name: 'Data Analytics with Python & SQL', duration: '9 months', mode: 'Online, live evening classes', tuition: 36_000, registrationFee: 1_500, intakeMonths: [2, 6, 10] },
  CYB: { code: 'CYB', name: 'Cybersecurity Essentials', duration: '9 months', mode: 'Online, live evening classes + virtual labs', tuition: 38_500, registrationFee: 1_500, intakeMonths: [3, 9] },
} as const;

export type ProgrammeCode = keyof typeof PROGRAMMES;

export function nextIntake(code: ProgrammeCode, from = new Date()) {
  const months = PROGRAMMES[code].intakeMonths;
  const y = from.getFullYear();
  const m = from.getMonth() + 1;
  for (const im of months) if (im > m) return new Date(y, im - 1, 1);
  return new Date(y + 1, months[0] - 1, 1);
}

interface Seed {
  profile: StudentProfile;
  engagement: Omit<EngagementMetrics, 'studentId'>;
  assessments: Omit<AssessmentRecord, 'id' | 'studentId'>[];
}

const S = (p: StudentProfile, e: Seed['engagement'], a: Seed['assessments']): Seed => ({ profile: p, engagement: e, assessments: a });

const stu = (id: string, name: string, cohort: string, programmeCode: ProgrammeCode, enrolledDays: number, phone: string): StudentProfile => ({
  id, name, phone,
  email: `${name.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, '.')}@student.example.org`,
  cohort, programmeCode, programme: PROGRAMMES[programmeCode].name, enrolledAt: ago(enrolledDays), status: 'on_track',
});

export const SEED: Seed[] = [
  S(stu('MA-2041', 'Naledi Khumalo', 'FSWD-2026-Q3', 'FSWD', 96, '+27 82 441 0192'),
    { loginStreakDays: 0, daysSinceLastLogin: 9, modulesCompleted: 6, modulesTotal: 14, completionPct: 48, currentModule: { code: 'JS-07', title: 'Asynchronous JavaScript: Promises & async/await', progressPct: 35 }, hoursThisWeek: 0.5, forumPosts: 1, lastActivityAt: ago(9) },
    [
      { moduleCode: 'JS-05', moduleTitle: 'Functions, Scope & Closures', title: 'JS-05 Module Quiz', scorePct: 78, passMark: 60, passed: true, takenAt: ago(31), weakTopics: [], kind: 'quiz' },
      { moduleCode: 'JS-06', moduleTitle: 'The DOM & Events', title: 'JS-06 Module Quiz', scorePct: 66, passMark: 60, passed: true, takenAt: ago(21), weakTopics: ['event delegation'], kind: 'quiz' },
      { moduleCode: 'JS-07', moduleTitle: 'Asynchronous JavaScript: Promises & async/await', title: 'JS-07 Checkpoint Quiz', scorePct: 42, passMark: 60, passed: false, takenAt: ago(10), weakTopics: ['Promise chaining', 'async/await error handling', 'Promise.all'], kind: 'quiz' },
    ]),
  S(stu('MA-1987', 'Thabo Mokoena', 'DA-2026-Q3', 'DA', 110, '+27 73 205 8841'),
    { loginStreakDays: 1, daysSinceLastLogin: 6, modulesCompleted: 5, modulesTotal: 11, completionPct: 55, currentModule: { code: 'SQL-04', title: 'SQL Joins & Aggregations', progressPct: 40 }, hoursThisWeek: 1.2, forumPosts: 0, lastActivityAt: ago(6) },
    [
      { moduleCode: 'SQL-03', moduleTitle: 'Filtering & Sorting', title: 'SQL-03 Module Quiz', scorePct: 71, passMark: 60, passed: true, takenAt: ago(28), weakTopics: [], kind: 'quiz' },
      { moduleCode: 'SQL-04', moduleTitle: 'SQL Joins & Aggregations', title: 'SQL-04 Checkpoint Quiz', scorePct: 38, passMark: 60, passed: false, takenAt: ago(7), weakTopics: ['LEFT JOIN vs INNER JOIN', 'GROUP BY with HAVING'], kind: 'quiz' },
    ]),
  S(stu('MA-2110', 'Ayanda Ndlovu', 'FSWD-2026-Q3', 'FSWD', 96, '+27 71 998 2204'),
    { loginStreakDays: 0, daysSinceLastLogin: 5, modulesCompleted: 8, modulesTotal: 14, completionPct: 61, currentModule: { code: 'RE-03', title: 'React State & Hooks', progressPct: 30 }, hoursThisWeek: 1.0, forumPosts: 2, lastActivityAt: ago(5) },
    [
      { moduleCode: 'RE-02', moduleTitle: 'Components & Props', title: 'RE-02 Module Quiz', scorePct: 74, passMark: 60, passed: true, takenAt: ago(18), weakTopics: [], kind: 'quiz' },
      { moduleCode: 'RE-03', moduleTitle: 'React State & Hooks', title: 'RE-03 Checkpoint Quiz', scorePct: 47, passMark: 60, passed: false, takenAt: ago(6), weakTopics: ['useEffect dependency array', 'immutable state updates'], kind: 'quiz' },
    ]),
  S(stu('MA-2058', 'Lerato Dube', 'FSWD-2026-Q3', 'FSWD', 96, '+27 84 110 7732'),
    { loginStreakDays: 11, daysSinceLastLogin: 0, modulesCompleted: 9, modulesTotal: 14, completionPct: 68, currentModule: { code: 'RE-03', title: 'React State & Hooks', progressPct: 70 }, hoursThisWeek: 7.5, forumPosts: 9, lastActivityAt: ago(0) },
    [{ moduleCode: 'RE-02', moduleTitle: 'Components & Props', title: 'RE-02 Module Quiz', scorePct: 88, passMark: 60, passed: true, takenAt: ago(17), weakTopics: [], kind: 'quiz' }]),
  S(stu('MA-1964', 'Sibusiso Nkosi', 'DA-2026-Q3', 'DA', 110, '+27 79 334 5510'),
    { loginStreakDays: 6, daysSinceLastLogin: 0, modulesCompleted: 7, modulesTotal: 11, completionPct: 70, currentModule: { code: 'PY-05', title: 'Python Data Wrangling with pandas', progressPct: 55 }, hoursThisWeek: 5.2, forumPosts: 4, lastActivityAt: ago(0) },
    [{ moduleCode: 'SQL-04', moduleTitle: 'SQL Joins & Aggregations', title: 'SQL-04 Checkpoint Quiz', scorePct: 81, passMark: 60, passed: true, takenAt: ago(9), weakTopics: [], kind: 'quiz' }]),
  S(stu('MA-2203', 'Precious Mahlangu', 'CYB-2026-Q3', 'CYB', 70, '+27 61 772 0048'),
    { loginStreakDays: 4, daysSinceLastLogin: 1, modulesCompleted: 5, modulesTotal: 10, completionPct: 52, currentModule: { code: 'SEC-06', title: 'Network Security Fundamentals', progressPct: 45 }, hoursThisWeek: 4.0, forumPosts: 3, lastActivityAt: ago(1) },
    [{ moduleCode: 'SEC-05', moduleTitle: 'Identity & Access', title: 'SEC-05 Module Quiz', scorePct: 76, passMark: 60, passed: true, takenAt: ago(12), weakTopics: [], kind: 'quiz' }]),
  // Passing every quiz, but silent for twelve days: a motivation problem, not a topic problem.
  S(stu('MA-2077', 'Kabelo Maseko', 'FSWD-2026-Q3', 'FSWD', 96, '+27 83 556 9013'),
    { loginStreakDays: 0, daysSinceLastLogin: 12, modulesCompleted: 7, modulesTotal: 14, completionPct: 54, currentModule: { code: 'JS-07', title: 'Asynchronous JavaScript: Promises & async/await', progressPct: 80 }, hoursThisWeek: 0, forumPosts: 1, lastActivityAt: ago(12) },
    [
      { moduleCode: 'JS-06', moduleTitle: 'The DOM & Events', title: 'JS-06 Module Quiz', scorePct: 72, passMark: 60, passed: true, takenAt: ago(26), weakTopics: [], kind: 'quiz' },
      { moduleCode: 'JS-07', moduleTitle: 'Asynchronous JavaScript: Promises & async/await', title: 'JS-07 Checkpoint Quiz', scorePct: 64, passMark: 60, passed: true, takenAt: ago(13), weakTopics: [], kind: 'quiz' },
    ]),
  S(stu('MA-1990', 'Zinhle Radebe', 'DA-2026-Q3', 'DA', 110, '+27 72 019 3345'),
    { loginStreakDays: 9, daysSinceLastLogin: 0, modulesCompleted: 8, modulesTotal: 11, completionPct: 77, currentModule: { code: 'PY-05', title: 'Python Data Wrangling with pandas', progressPct: 60 }, hoursThisWeek: 6.4, forumPosts: 7, lastActivityAt: ago(0) },
    [{ moduleCode: 'SQL-04', moduleTitle: 'SQL Joins & Aggregations', title: 'SQL-04 Checkpoint Quiz', scorePct: 90, passMark: 60, passed: true, takenAt: ago(11), weakTopics: [], kind: 'quiz' }]),
  S(stu('MA-2215', 'Tumelo Sithole', 'CYB-2026-Q3', 'CYB', 70, '+27 60 884 2271'),
    { loginStreakDays: 3, daysSinceLastLogin: 0, modulesCompleted: 6, modulesTotal: 10, completionPct: 60, currentModule: { code: 'SEC-06', title: 'Network Security Fundamentals', progressPct: 65 }, hoursThisWeek: 4.8, forumPosts: 2, lastActivityAt: ago(0) },
    [{ moduleCode: 'SEC-05', moduleTitle: 'Identity & Access', title: 'SEC-05 Module Quiz', scorePct: 69, passMark: 60, passed: true, takenAt: ago(13), weakTopics: [], kind: 'quiz' }]),
  S(stu('MA-2099', 'Amahle Zulu', 'FSWD-2026-Q3', 'FSWD', 96, '+27 76 402 1189'),
    { loginStreakDays: 14, daysSinceLastLogin: 0, modulesCompleted: 10, modulesTotal: 14, completionPct: 74, currentModule: { code: 'RE-03', title: 'React State & Hooks', progressPct: 85 }, hoursThisWeek: 8.0, forumPosts: 12, lastActivityAt: ago(0) },
    [{ moduleCode: 'RE-03', moduleTitle: 'React State & Hooks', title: 'RE-03 Checkpoint Quiz', scorePct: 92, passMark: 60, passed: true, takenAt: ago(3), weakTopics: [], kind: 'quiz' }]),
];

export function sandboxLearnerCards(): LearnerCard[] {
  return SEED.map(({ profile, engagement, assessments }) => {
    const latest = assessments[assessments.length - 1];
    const risk = roughRisk(engagement.daysSinceLastLogin, engagement.completionPct, latest?.scorePct ?? 70, engagement.loginStreakDays);
    return {
      id: profile.id, name: profile.name, email: profile.email, cohort: profile.cohort, programme: profile.programme,
      status: risk >= 60 ? 'at_risk' : 'on_track',
      riskScore: risk,
      weakTopic: latest && !latest.passed ? `${latest.moduleCode} · ${latest.weakTopics[0] || latest.moduleTitle}` : null,
      lastLoginDays: engagement.daysSinceLastLogin,
      completion: engagement.completionPct,
      quizAvg: Math.round(assessments.reduce((n, a) => n + a.scorePct, 0) / Math.max(1, assessments.length)),
      lastEvent: null,
    };
  });
}

/** The same formula the adapter uses, kept here so the seed can label itself. */
export function roughRisk(daysSinceLogin: number, completionPct: number, latestScore: number, streak: number) {
  const a = Math.min(35, daysSinceLogin * 5);
  const b = Math.min(25, (100 - completionPct) * 0.25);
  const c = Math.min(30, Math.max(0, 60 - latestScore) * 1.2);
  const d = streak === 0 ? 10 : 0;
  return Math.min(100, Math.round(a + b + c + d));
}
