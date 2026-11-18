import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Moodle groups and gradebooks, against a fake Moodle (the same JSON shapes
 * the web service returns): students carry their group (intake), a course's
 * whole gradebook is read in one call, and the saved copy works without Moodle. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-gradebook-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'MOODLE_URL', 'MOODLE_TOKEN', 'MOODLE_COURSE_IDS']) delete process.env[k];

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  moodle: typeof import('../src/lib/lms/moodleAdapter');
  gb: typeof import('../src/lib/lms/gradebook');
  stu: typeof import('../src/lib/lms/students');
};
let m: M;
before(async () => {
  m = {
    ctx: await import('../src/lib/auth/tenantContext'),
    moodle: await import('../src/lib/lms/moodleAdapter'),
    gb: await import('../src/lib/lms/gradebook'),
    stu: await import('../src/lib/lms/students'),
  };
});
const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);

const student = (id: number, name: string, groups: { id: number; name: string }[] = []) => ({
  id, fullname: name, email: `${name.split(' ')[0].toLowerCase()}@student.example.com`, lastaccess: Math.floor(Date.now() / 1000) - 86400,
  roles: [{ shortname: 'student' }], ...(groups.length ? { groups } : {}),
});
const item = (id: number, name: string, mod: string, raw: number | null, max = 10, extra: Record<string, unknown> = {}) => ({
  id, itemname: name, itemtype: 'mod', itemmodule: mod, iteminstance: id, graderaw: raw, grademin: 0, grademax: max, gradepass: null,
  gradedategraded: raw == null ? null : Math.floor(Date.now() / 1000) - 3600, ...extra,
});

/** A fake Moodle: two courses, intake groups, one student in no group, and a staff account. */
function fakeMoodle() {
  const calls: string[] = [];
  const jan = { id: 7, name: 'Jan 2026' };
  const jun = { id: 8, name: 'June 2026' };
  const data: Record<string, (p: Record<string, string | number | boolean>) => unknown> = {
    core_course_get_courses: () => [{ id: 1, shortname: 'site' }, { id: 11, shortname: 'SDQCTO', fullname: 'Software Developer QCTO' }, { id: 14, shortname: 'CYB', fullname: 'Cyber Security Analyst' }],
    core_group_get_course_groups: (p) => (p.courseid === 11 ? [jan, jun, { id: 9, name: 'test' }] : [jan]),
    core_enrol_get_enrolled_users: (p) => (p.courseid === 11
      ? [student(101, 'Buhle Dimba', [jan]), student(102, 'Kwame Mathole', [jun]), student(103, 'Anathi Kheswa'), { id: 900, fullname: 'Staff Person', roles: [{ shortname: 'editingteacher' }] }]
      : [student(101, 'Buhle Dimba', [jan])]),
    gradereport_user_get_grade_items: (p) => {
      if (p.courseid === 11) {
        return { usergrades: [
          { userid: 101, gradeitems: [item(1, 'KM-01 Summative', 'quiz', 8, 10, { feedback: '<p>Good work</p>' }), item(2, 'Project', 'assign', 30, 100, { gradepass: 50 }), item(3, 'Attendance', 'attendance', null), { id: 99, itemtype: 'course', graderaw: 61, grademin: 0, grademax: 100 }] },
          { userid: 102, gradeitems: [item(1, 'KM-01 Summative', 'quiz', 4), item(2, 'Project', 'assign', 70, 100, { gradepass: 50 }), item(3, 'Attendance', 'attendance', null), { id: 99, itemtype: 'course', graderaw: 55, grademin: 0, grademax: 100 }] },
          { userid: 103, gradeitems: [item(1, 'KM-01 Summative', 'quiz', null), item(2, 'Project', 'assign', null, 100), item(3, 'Attendance', 'attendance', null), { id: 99, itemtype: 'course', graderaw: null, grademin: 0, grademax: 100 }] },
        ] };
      }
      return { usergrades: [{ userid: 101, gradeitems: [item(5, 'Network basics', 'quiz', 9)] }] };
    },
  };
  const ws = async (fn: string, p: Record<string, string | number | boolean> = {}) => {
    calls.push(`${fn}${p.userid ? ':user' : ''}`);
    if (!data[fn]) return [];
    return data[fn](p);
  };
  return { ws, calls };
}

function adapter() {
  const a = new m.moodle.MoodleLmsAdapter('https://moodle.example.com', 'token', [11, 14]);
  const f = fakeMoodle();
  (a as unknown as { ws: typeof f.ws }).ws = f.ws;
  return { a, calls: f.calls };
}

test('students carry their Moodle group (intake); staff and the "test" group are left out', () => T(async () => {
  const { a } = adapter();
  const list = await a.listStudents();
  assert.equal(list.length, 3, 'three students, the teacher is not one');
  const by = (n: string) => list.find((s) => s.name === n)!;
  assert.deepEqual(by('Buhle Dimba').groups, ['Jan 2026']);
  assert.deepEqual(by('Kwame Mathole').groups, ['June 2026']);
  assert.deepEqual(by('Anathi Kheswa').groups, [], 'in no group');
  const books = await a.getGradebooks();
  assert.deepEqual(books.find((b) => b.courseId === 11)!.groups, ['Jan 2026', 'June 2026']);
}));

test('a course gradebook is read in one call for every student, with feedback, pass marks and the course total', () => T(async () => {
  const { a, calls } = adapter();
  await a.listStudents();
  for (const s of await a.listStudents()) await a.getAssessments(s.id);
  const books = await a.getGradebooks();
  assert.equal(calls.filter((c) => c === 'gradereport_user_get_grade_items').length, 2, 'one call per course, not per student');
  assert.equal(calls.filter((c) => c === 'gradereport_user_get_grade_items:user').length, 0);

  const c = books.find((b) => b.courseId === 11)!;
  assert.deepEqual(c.items.map((i) => [i.name, i.kind, i.max, i.pass]), [['KM-01 Summative', 'quiz', 10, null], ['Project', 'assign', 100, 50], ['Attendance', 'attendance', 10, null]], 'every item, graded or not; the course total is not a column');
  const buhle = c.students.find((s) => s.name === 'Buhle Dimba')!;
  assert.deepEqual(buhle.cells['1'], { ...buhle.cells['1'], g: 8, pct: 80, f: 'Good work' });
  assert.equal(buhle.cells['2'].pct, 30);
  assert.equal(buhle.cells['3'], undefined, 'not graded');
  assert.equal(buhle.total, 61);
  assert.deepEqual(buhle.groups, ['Jan 2026']);
  const anathi = c.students.find((s) => s.name === 'Anathi Kheswa')!;
  assert.deepEqual([anathi.groups, Object.keys(anathi.cells).length, anathi.total], [[], 0, null]);

  // The assessments the agents use come from the same gradebook.
  const kwame = (await a.listStudents()).find((s) => s.name === 'Kwame Mathole')!;
  const grades = await a.getAssessments(kwame.id);
  assert.deepEqual(grades.map((g) => [g.title, g.scorePct, g.passed]), [['KM-01 Summative', 40, false], ['Project', 70, true]]);
}));

test('saved gradebooks: per student, per group as CSV, and kept when a course cannot be read', () => T(async () => {
  const { a } = adapter();
  await a.listStudents();
  const books = await a.getGradebooks();
  m.gb.saveGradebooks(books);
  const buhle = books[0].students.find((s) => s.name === 'Buhle Dimba')!;
  const mine = m.gb.studentGradebook(buhle.id);
  assert.deepEqual(mine.map((c) => c.code).sort(), ['CYB', 'SDQCTO'], 'both of his courses');
  assert.equal(mine.find((c) => c.code === 'SDQCTO')!.items.filter((i) => i.cell).length, 2);

  const sd = m.gb.listGradebooks().courses.find((c) => c.courseId === 11)!;
  const csv = m.gb.gradebookCsv(sd, 'June 2026').split('\n');
  assert.equal(csv.length, 2, 'header and Kwame');
  assert.match(csv[0], /^Student,Email,Group,KM-01 Summative \(\/10\),Project \(\/100\),Attendance \(\/10\),Course total %$/);
  assert.match(csv[1], /^Kwame Mathole,kwame@student\.example\.com,June 2026,4,70,,55$/);
  assert.equal(m.gb.gradebookCsv(sd, '__none__').split('\n').length, 2, 'students in no group');
  assert.deepEqual(m.gb.itemAverages(sd), { 1: 60, 2: 50, 3: null });

  // Next sync reads only one course: the other keeps its saved copy.
  m.gb.saveGradebooks([books.find((b) => b.courseId === 14)!]);
  assert.deepEqual(m.gb.listGradebooks().courses.map((c) => c.courseId).sort(), [11, 14]);
}));

test('the saved roster keeps groups and grades; the students list carries the group', () => T(() => {
  const row = {
    id: 'MDL-101', name: 'Buhle Dimba', email: 'buhle@student.example.com', phone: '', cohort: 'SDQCTO · Jan 2026', checkpoint: 80,
    daysSinceLogin: 1, status: 'on_track', lastEvent: null, groups: ['Jan 2026'],
    recentGrades: [{ id: 'g', title: 'KM-01', courseName: 'SDQCTO', scorePct: 80, passMark: 60, passed: true, feedback: null, missedQuestions: 0, takenAt: '' }],
  };
  m.gb.saveRoster([row]);
  const saved = m.gb.savedRoster();
  assert.deepEqual(saved.rows[0].groups, ['Jan 2026']);
  assert.equal(saved.rows[0].recentGrades?.length, 1);
  assert.equal(m.stu.studentFields(row).group, 'Jan 2026');
}));
