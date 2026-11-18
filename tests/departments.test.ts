import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SyncedLearnerRow } from '../src/lib/types';

/* The three departments that go live first, end to end in simulation mode
 * (no AI key, no database, nothing really sent):
 *
 *   Student Success        Moodle rows become a students list; quiet students,
 *                          overdue work, student emails, finished courses and a
 *                          weekly at-risk report each have an agent.
 *   Learning & Assessment  failed quizzes, assessments due in 5 days, a weekly
 *                          academic report.
 *   Admissions             saved messages and vouchers wait for approval.
 *
 * And the rule for the test phase: in Approval Mode nothing reaches a student
 * or a lead until a person approves it. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-depts-'));
process.chdir(dir);
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DATABASE_URL', 'PGHOST', 'SMTP_HOST', 'DIALER_URL', 'MANAGER_EMAIL']) delete process.env[k];

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  dep: typeof import('../src/lib/engine/departments');
  runs: typeof import('../src/lib/engine/agentRuns');
  trig: typeof import('../src/lib/engine/agentTriggers');
  rec: typeof import('../src/lib/data/records');
  src: typeof import('../src/lib/data/sources');
  store: typeof import('../src/lib/engine/store');
  wfs: typeof import('../src/lib/engine/workflows');
  appr: typeof import('../src/lib/engine/approvals');
  acc: typeof import('../src/lib/auth/accounts');
  lib: typeof import('../src/lib/nurture/library');
  nstore: typeof import('../src/lib/nurture/store');
  vou: typeof import('../src/lib/nurture/vouchers');
  stu: typeof import('../src/lib/lms/students');
  lms: typeof import('../src/lib/lms/lmsAdapter');
};
let m: M;

const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);

before(async () => {
  m = {
    ctx: await import('../src/lib/auth/tenantContext'),
    dep: await import('../src/lib/engine/departments'),
    runs: await import('../src/lib/engine/agentRuns'),
    trig: await import('../src/lib/engine/agentTriggers'),
    rec: await import('../src/lib/data/records'),
    src: await import('../src/lib/data/sources'),
    store: await import('../src/lib/engine/store'),
    wfs: await import('../src/lib/engine/workflows'),
    appr: await import('../src/lib/engine/approvals'),
    acc: await import('../src/lib/auth/accounts'),
    lib: await import('../src/lib/nurture/library'),
    nstore: await import('../src/lib/nurture/store'),
    vou: await import('../src/lib/nurture/vouchers'),
    stu: await import('../src/lib/lms/students'),
    lms: await import('../src/lib/lms/lmsAdapter'),
  };
  await T(() => m.dep.ensureDepartmentModel());
});

async function settle(runId: string, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = m.runs.getAgentRun(runId);
    if (r && r.status !== 'running') return r;
    if (Date.now() > end) throw new Error(`run ${runId} still running: ${JSON.stringify(r?.logs.slice(-3))}`);
    await new Promise((res) => setTimeout(res, 25));
  }
}
async function until(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((res) => setTimeout(res, 20));
  }
}
const logs = (r: { logs: { detail: string }[] }) => JSON.stringify(r.logs.map((l) => l.detail));
const setMode = (p: { requireApproval?: boolean; autoRunMode?: boolean; managerEmail?: string }) => m.acc.updateTenantIntegrations('default', p);
const mailsTo = (email: string) => m.store.getState().inbox.filter((x) => x.to === email);
const pendingFor = (runId: string) => m.store.getState().pendingOutreach!.find((x) => x.runId === runId && x.status === 'pending');
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

/** A student as the Moodle sync hands it over. */
function student(over: Partial<SyncedLearnerRow> & { id: string; name: string; email: string }): SyncedLearnerRow {
  return {
    phone: '', cohort: 'FSWD 2026 A', programme: 'Full-Stack Web Development', module: 'JS-07', moduleTitle: 'Asynchronous JavaScript',
    checkpoint: 72, avgScore: 72, completionPct: 45, daysSinceLogin: 1, neverLoggedIn: false, missedAssignments: 0,
    courses: [{ id: 1, code: 'FSWD', name: 'Full-Stack Web Development', progressPct: 45, completedActivities: 9, totalActivities: 20 }],
    incompleteActivities: [], recentGrades: [], nextDue: null, riskScore: 20, riskBand: 'on_track', signals: [], weakTopic: null,
    status: 'on_track', lastEvent: null, source: 'moodle',
    ...over,
  };
}

test('Admissions, Student Success and Learning & Assessment are staffed; Finance sends reminders; B2B is paused', () => T(() => {
  const floors = m.dep.buildingModel();
  const names = (dept: string) => floors.find((f) => f.department.id === dept)!.agents.map((a) => a.agent.name).sort();
  assert.deepEqual(names('dep_admissions'), ['Ayanda', 'Naledi', 'Thabo', 'Zinhle']);
  assert.deepEqual(names('dep_success'), ['Bongani', 'Karabo', 'Mpho', 'Nomsa', 'Zodwa']);
  assert.deepEqual(names('dep_learning'), ['Lindiwe', 'Thandi', 'Tumi']);
  assert.deepEqual(names('dep_finance'), ['Kagiso', 'Musa', 'Refilwe']);

  const live = new Set(m.trig.agentWorkflows().map((w) => w.id));
  for (const id of ['wf_sipho', 'wf_lerato']) assert.equal(live.has(id), false, `${id} is paused`);
  for (const id of ['wf_naledi', 'wf_zinhle', 'wf_thabo', 'wf_ayanda', 'wf_bongani', 'wf_nomsa', 'wf_zodwa', 'wf_mpho', 'wf_karabo', 'wf_lindiwe', 'wf_tumi', 'wf_thandi', 'wf_kagiso', 'wf_refilwe']) {
    assert.ok(live.has(id), `${id} is on`);
  }

  // Student Success and Learning read Moodle's students list.
  const moodle = m.src.getSource('src_moodle')!;
  assert.equal(moodle.kind, 'students');
  const t = (id: string) => m.wfs.getWorkflow(id)!.agentTrigger!;
  assert.deepEqual([t('wf_zodwa').kind, t('wf_zodwa').sourceId], ['reply.received', 'src_moodle']);
  assert.deepEqual([t('wf_mpho').kind, t('wf_mpho').sourceId, t('wf_mpho').field], ['record.changed', 'src_moodle', 'course_completed']);
  assert.deepEqual([t('wf_tumi').kind, t('wf_tumi').sourceId], ['record.match', 'src_moodle']);
  assert.deepEqual([t('wf_nomsa').kind, t('wf_nomsa').lmsEvent], ['lms.event', 'assignment.missed']);
  assert.equal(m.src.deleteSource('src_moodle'), false, 'the Moodle list cannot be removed');
}));

test('Moodle rows become student records: the first sync is a baseline, finished and withdrawn students are recognised', () => T(() => {
  const busy = student({
    id: 'M1', name: 'Palesa Mokoena', email: 'Palesa@Student.example.com', missedAssignments: 1, daysSinceLogin: 3,
    incompleteActivities: [{ name: 'Overdue assignment: Build a REST API', type: 'assign', course: 'FSWD' }, { name: 'Week 4: Promises quiz', type: 'quiz', course: 'FSWD' }],
    recentGrades: [
      { id: 'g1', title: 'Promises quiz', courseName: 'FSWD', scorePct: 48, passMark: 60, passed: false, feedback: null, missedQuestions: 3, takenAt: '2026-11-10T10:00:00Z' },
      { id: 'g0', title: 'Arrays quiz', courseName: 'FSWD', scorePct: 80, passMark: 60, passed: true, feedback: null, missedQuestions: 0, takenAt: '2026-11-01T10:00:00Z' },
    ],
    nextDue: { name: 'Async project', course: 'FSWD', dueAt: inDays(20) },
  });
  const f = m.stu.studentFields(busy);
  assert.equal(f.status, 'active');
  assert.equal(f.course_completed, 'no');
  assert.equal(f.overdue_work, 'Build a REST API');
  assert.equal(f.open_activities, 'Week 4: Promises quiz');
  assert.equal(f.last_assessment, 'Promises quiz (FSWD)');
  assert.equal(f.last_passed, 'no');
  assert.match(f.failed_assessment, /48%, pass mark 60%/);
  assert.equal(f.next_assessment_name, 'Async project');
  assert.match(f.next_assessment_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(f.days_since_login, '3');

  assert.equal(m.stu.lifecycleOf(student({ id: 'x', name: 'x', email: 'x@x.co', completionPct: 100 })), 'completed');
  assert.equal(m.stu.lifecycleOf(student({ id: 'x', name: 'x', email: 'x@x.co', courses: [{ id: 1, code: 'A', name: 'A', progressPct: 100, completedActivities: 5, totalActivities: 5 }], completionPct: 90 })), 'completed');
  assert.equal(m.stu.lifecycleOf(student({ id: 'x', name: 'x', email: 'x@x.co', status: 'Withdrawn' })), 'inactive');

  const done = student({ id: 'M9', name: 'Kabelo Dlamini', email: 'kabelo@student.example.com', completionPct: 100 });
  assert.deepEqual(m.stu.mirrorStudents([busy, done]), [], 'the first sync starts nobody');
  const rec = m.rec.getRecord('src_moodle', 'palesa@student.example.com')!;
  assert.equal(rec.name, 'Palesa Mokoena');
  assert.equal(rec.fields.missed_assignments, '1');
  assert.equal(m.rec.getRecord('src_moodle', 'kabelo@student.example.com')!.fields.status, 'completed');

  // The next sync reports what changed.
  const ev = m.stu.mirrorStudents([{ ...busy, missedAssignments: 2 }]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'changed');
  assert.ok(ev[0].changed.includes('missed_assignments'));
}));

test('overdue work in Moodle: Nomsa writes, a person approves, and the follow-ups end when the work is in', () => T(async () => {
  setMode({ requireApproval: true, autoRunMode: true });
  const email = 'sizwe@student.example.com';
  const row = student({
    id: 'M2', name: 'Sizwe Ndlovu', email, missedAssignments: 2,
    incompleteActivities: [{ name: 'Overdue assignment: Build a REST API', type: 'assign', course: 'FSWD' }, { name: 'Overdue assignment: SQL joins worksheet', type: 'assign', course: 'FSWD' }],
  });
  m.stu.mirrorStudents([row]);
  assert.equal(await m.stu.routeStudentEvent(row, 'assignment.missed', '2 overdue assignments'), 1);
  const run = m.runs.listAgentRuns({ workflowId: 'wf_nomsa' }).find((r) => r.record.email === email)!;
  assert.equal(run.record.sourceId, 'src_moodle', 'works from the Moodle record');
  let r = await settle(run.id);
  assert.equal(r.status, 'awaiting_approval', logs(r));
  assert.equal(mailsTo(email).length, 0, 'nothing reaches the student before approval');

  await m.appr.approveOutreachById(pendingFor(run.id)!.id);
  r = await settle(run.id);
  assert.equal(r.status, 'waiting', logs(r));
  assert.equal(mailsTo(email).length, 1);

  // Three days later the next sync shows the work is in: no more nudges, a thank-you (approved first).
  const handedIn = { ...row, missedAssignments: 0, incompleteActivities: [] };
  m.stu.mirrorStudents([handedIn]);
  await m.stu.refreshRunFacts([handedIn]);
  m.runs.resumeNow(run.id);
  r = await settle(run.id);
  assert.ok(r.logs.some((l) => /No more follow-ups needed/.test(l.detail)), logs(r));
  assert.equal(r.status, 'awaiting_approval', 'the thank-you waits for approval too');
  await m.appr.approveOutreachById(pendingFor(run.id)!.id);
  r = await settle(run.id);
  assert.equal(r.status, 'completed', logs(r));
  assert.equal(mailsTo(email).length, 2);
  assert.ok(r.logs.some((l) => /Well done for catching up/.test(l.title)));
}));

test('finished and withdrawn students are never contacted', () => T(async () => {
  setMode({ requireApproval: false, autoRunMode: true });
  const done = student({ id: 'M5', name: 'Naledi Khoza', email: 'nkhoza@student.example.com', completionPct: 100, daysSinceLogin: 30 });
  const gone = student({ id: 'M6', name: 'Lwazi Mthembu', email: 'lwazi@student.example.com', status: 'withdrawn', daysSinceLogin: 30 });
  assert.equal(await m.stu.routeStudentEvent(done, 'login.gap', '30 days'), 0);
  assert.equal(await m.stu.routeStudentEvent(gone, 'login.gap', '30 days'), 0);
  assert.equal(m.runs.listAgentRuns({ workflowId: 'wf_bongani' }).filter((r) => [done.email, gone.email].includes(r.record.email)).length, 0);
  // An event nobody listens for is left to the older tutoring flow.
  assert.equal(await m.stu.routeStudentEvent(done, 'payment.overdue', 'x'), -1);
}));

test('a student who goes quiet gets a check-in from Bongani with their Moodle facts', () => T(async () => {
  setMode({ requireApproval: false, autoRunMode: true });
  const row = student({ id: 'M7', name: 'Ayanda Zulu', email: 'azulu@student.example.com', daysSinceLogin: 9 });
  m.stu.mirrorStudents([row]);
  assert.equal(await m.stu.routeStudentEvent(row, 'login.gap', '9 days since last activity'), 1);
  const run = m.runs.listAgentRuns({ workflowId: 'wf_bongani' }).find((r) => r.record.email === row.email)!;
  const r = await settle(run.id);
  assert.equal(r.status, 'waiting', logs(r));
  assert.equal(mailsTo(row.email).length, 1);
}));

test('a course finished in Moodle starts placement with Mpho', () => T(async () => {
  setMode({ requireApproval: false, autoRunMode: true });
  const row = student({ id: 'M4', name: 'Thabang Molefe', email: 'thabang@student.example.com', completionPct: 92 });
  m.stu.mirrorStudents([row]);
  const finished = { ...row, completionPct: 100, courses: [{ id: 1, code: 'FSWD', name: 'Full-Stack Web Development', progressPct: 100, completedActivities: 20, totalActivities: 20 }] };
  const events = m.stu.mirrorStudents([finished]);
  assert.ok(events[0].changed.includes('course_completed'));
  assert.equal(await m.trig.dispatchRecordEvents(events), 1);
  const run = m.runs.listAgentRuns({ workflowId: 'wf_mpho' }).find((r) => r.record.email === row.email)!;
  const r = await settle(run.id);
  assert.equal(r.status, 'waiting', logs(r));
  assert.match(mailsTo(row.email)[0].subject, /\S/);
}));

test('a student\'s email is answered by Student Support (not by Admissions)', () => T(async () => {
  setMode({ requireApproval: false, autoRunMode: true });
  const email = 'palesa@student.example.com';
  const before = mailsTo(email).length;
  const started = await m.trig.dispatchReply(email, 'Hi, when is my next assignment due? I am a bit behind.', 'Palesa');
  assert.equal(started, 1);
  assert.equal(m.runs.listAgentRuns({ workflowId: 'wf_thabo' }).filter((r) => r.record.email === email).length, 0, 'Admissions does not answer students');
  const run = m.runs.listAgentRuns({ workflowId: 'wf_zodwa' }).find((r) => r.record.email === email)!;
  const r = await settle(run.id);
  assert.equal(r.status, 'completed', logs(r));
  assert.equal(mailsTo(email).length, before + 1);
  assert.ok(m.rec.getRecord('src_moodle', email)!.fields.last_support_request, 'noted on the student');
}));

test('Tumi sends revision plans only to students with an assessment in the next 5 days', () => T(async () => {
  setMode({ requireApproval: false, autoRunMode: true });
  const soon = student({ id: 'M10', name: 'Zanele Nkosi', email: 'zanele@student.example.com', nextDue: { name: 'Async project', course: 'FSWD', dueAt: inDays(3) } });
  const later = student({ id: 'M11', name: 'Musa Khumalo', email: 'mkhumalo@student.example.com', nextDue: { name: 'Final exam', course: 'FSWD', dueAt: inDays(12) } });
  m.stu.mirrorStudents([soon, later]);
  const res = await m.trig.scanMatches(m.wfs.getWorkflow('wf_tumi')!, 'test');
  assert.equal(res.matched, 1);
  assert.equal(res.started, 1);
  const run = m.runs.listAgentRuns({ workflowId: 'wf_tumi' })[0];
  assert.equal(run.record.email, soon.email);
  assert.equal((await settle(run.id)).status, 'completed');
  assert.equal(mailsTo(later.email).length, 0);
}));

test('weekly reports read Moodle: Karabo and Thandi brief the team', () => T(async () => {
  setMode({ requireApproval: true, autoRunMode: true, managerEmail: 'team@academy.example.com' });
  const summary = m.stu.studentsSummary();
  assert.match(summary, /Students from Moodle: \d+ in total/);
  assert.match(summary, /Overdue work: [1-9]/);
  assert.match(summary, /Assessments due in the next 7 days: 1: Zanele Nkosi/);
  for (const id of ['wf_karabo', 'wf_thandi']) {
    const wf = m.wfs.getWorkflow(id)!;
    const { run } = await m.runs.startAgentRun({ workflow: wf, record: { key: '__report__', sourceId: 'src_moodle', name: 'Team report', email: '', phone: '' }, trigger: 'test', force: true });
    const r = await settle(run!.id);
    assert.equal(r.status, 'completed', logs(r));
    assert.ok(r.logs.some((l) => /Briefed team@academy\.example\.com/.test(l.detail)), logs(r));
  }
  assert.equal(mailsTo('team@academy.example.com').length, 2, 'reports to the team are not held: they are internal');
}));

test('a failed quiz goes to Lindiwe, who has the tutoring team build a personal lesson', () => T(async () => {
  setMode({ requireApproval: true, autoRunMode: true });
  const [s] = await m.lms.getLmsAdapter('sandbox').listStudents();
  const started = await m.trig.dispatchLmsEvent('quiz.failed', { id: s.id, name: s.name, email: s.email, fields: { id: s.id, last_score: '45' } }, 'test');
  assert.equal(started, 1);
  const run = m.runs.listAgentRuns({ workflowId: 'wf_lindiwe' }).find((r) => r.record.email === s.email)!;
  const r = await settle(run.id);
  assert.equal(r.status, 'waiting', logs(r));
  assert.ok(r.logs.some((l) => /Handed to the tutoring team: a personal video lesson and a 10-question test/.test(l.detail)), logs(r));
}));

test('Approval Mode: saved messages wait for a person; a rejected one is skipped and the journey carries on', () => T(async () => {
  setMode({ requireApproval: true, autoRunMode: true });
  for (const x of m.lib.listMessages()) if (x.status === 'draft') m.lib.approveMessage(x.id, 'test');
  const email = 'ayabonga@example.com';
  const got = await m.trig.receiveLead({ name: 'Ayabonga Sithole', email, course: 'Data Analytics' });
  const run = m.runs.listAgentRuns({ workflowId: 'wf_naledi' }).find((r) => r.record.key === got.record.key)!;
  let r = await settle(run.id);
  assert.equal(r.status, 'awaiting_approval', logs(r));
  assert.equal(mailsTo(email).length, 0, 'nothing reaches the lead before approval');
  const item = pendingFor(run.id)!;
  const held = m.store.getState().deliverables.find((d) => d.id === item.deliverableId)!.content as { html: string; library: { messageId: string } };
  assert.match(held.html, /Ayabonga/, 'the approver sees the email as it will land');
  assert.doesNotMatch(held.html, /\/go\//, 'previewing it does not count as the lead opening or clicking');
  assert.ok(held.library.messageId);

  // Rejected: skipped, and the journey goes on (marked contacted, then waits).
  m.appr.rejectOutreachById(item.id);
  await until(() => m.runs.getAgentRun(run.id)!.status !== 'awaiting_approval');
  r = await settle(run.id);
  assert.equal(r.status, 'waiting', logs(r));
  assert.equal(mailsTo(email).length, 0);
  assert.equal(m.rec.getRecord('src_leads', got.record.key)!.fields.nurture_sent || '', '');

  // The next message waits too; approved, it goes from the library and is booked.
  m.runs.resumeNow(run.id);
  r = await settle(run.id);
  assert.equal(r.status, 'awaiting_approval', logs(r));
  const next = pendingFor(run.id)!;
  const msgId = (m.store.getState().deliverables.find((d) => d.id === next.deliverableId)!.content as { library: { messageId: string } }).library.messageId;
  await m.appr.approveOutreachById(next.id);
  r = await settle(run.id);
  assert.equal(r.status, 'waiting', logs(r));
  assert.equal(mailsTo(email).length, 1);
  assert.match(mailsTo(email)[0].html, /\/go\//, 'the real email is tracked');
  assert.ok(m.rec.getRecord('src_leads', got.record.key)!.fields.nurture_sent.includes(msgId));
}));

test('Approval Mode: a voucher\'s code is made only when a person approves it', () => T(async () => {
  setMode({ requireApproval: true, autoRunMode: true });
  const thanks = m.vou.listOffers().find((o) => o.name === 'Thank-you voucher')!;
  m.vou.setOfferStatus(thanks.id, 'active', 'test');
  const got = await m.trig.receiveLead({ name: 'Refiloe Mahlangu', email: 'refiloe@example.com', course: 'Cybersecurity' });
  const wf = m.wfs.createWorkflow({ name: 'Voucher only', officeId: 'dep_admissions', agentId: 'ag_zinhle', domain: 'admissions', description: '', trigger: 'manual', instructions: '', version: 2, departmentId: 'dep_admissions', agentTrigger: { kind: 'manual' }, steps: [{ id: 'v1', kind: 'send_voucher', title: 'Voucher' }] });
  const { run } = await m.runs.startAgentRun({ workflow: wf, record: m.trig.toRunRecord(got.record), trigger: 'test', force: true });
  let r = await settle(run!.id);
  assert.equal(r.status, 'awaiting_approval', logs(r));
  assert.equal(m.rec.getRecord('src_leads', got.record.key)!.fields.voucher_code || '', '', 'no code exists yet');
  const issued = m.vou.getOffer(thanks.id)!.stats.issued;
  await m.appr.approveOutreachById(pendingFor(run!.id)!.id);
  r = await settle(run!.id);
  assert.equal(r.status, 'completed', logs(r));
  const code = m.rec.getRecord('src_leads', got.record.key)!.fields.voucher_code;
  assert.match(code, /^MEL-REFI-[A-Z2-9]{4}$/);
  assert.equal(m.vou.getOffer(thanks.id)!.stats.issued, issued + 1);
  assert.ok(mailsTo('refiloe@example.com').some((x) => x.html.includes(code)));
}));

test('a held email (a test result) is sent exactly as it is when approved', () => T(async () => {
  setMode({ requireApproval: true });
  const id = m.appr.holdMail({ to: 'pule@student.example.com', toName: 'Pule Moyo', subject: 'Well done, Pule: JS-07 cleared', html: '<p>Well done</p>', text: 'Well done', taskId: 't_res', learnerId: 'L9', label: 'Learning & Assessment · test result' });
  const item = m.store.getState().pendingOutreach!.find((x) => x.deliverableId === id && x.status === 'pending')!;
  assert.ok(item);
  assert.equal(mailsTo('pule@student.example.com').length, 0);
  await m.appr.approveOutreachById(item.id);
  const sent = mailsTo('pule@student.example.com');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Well done, Pule: JS-07 cleared');
}));

test('a workspace set up before this gets the new setup once (edited jobs are left alone)', () => T(() => {
  // As an older workspace looked: Zodwa followed up missed classes, B2B ran, no Nomsa yet.
  m.wfs.updateWorkflow('wf_zodwa', {
    agentTrigger: { kind: 'lms.event', lmsEvent: 'attendance.missed', cooldownHours: 120 },
    steps: [{ id: 'o1', kind: 'ai_message', title: 'Recap and catch-up offer' }, { id: 'o2', kind: 'wait', title: 'Give them 2 days', hours: 48 }, { id: 'o3', kind: 'condition', title: 'Did they respond?' }],
  });
  m.wfs.updateWorkflow('wf_sipho', { enabled: true });
  m.wfs.updateWorkflow('wf_tumi', { steps: [{ id: 'e1', kind: 'ai_message', title: 'My own revision note' }] });
  delete m.nstore.meta().seeded.focus;
  m.dep.ensureDepartmentModel();
  assert.equal(m.wfs.getWorkflow('wf_zodwa')!.agentTrigger!.kind, 'reply.received');
  assert.equal(m.wfs.getWorkflow('wf_sipho')!.enabled, false);
  assert.equal(m.wfs.getWorkflow('wf_tumi')!.steps![0].title, 'My own revision note', 'an edited job is not replaced');
  // Once only.
  m.wfs.updateWorkflow('wf_sipho', { enabled: true });
  m.dep.ensureDepartmentModel();
  assert.equal(m.wfs.getWorkflow('wf_sipho')!.enabled, true, 'a person turned it back on: it stays on');
}));

test('each kind of escalation goes to its own person; anything not routed goes to the manager', () => T(async () => {
  const esc = await import('../src/lib/escalation');
  assert.equal(esc.cleanAddresses(' A@x.co ; not-an-email, b@x.co '), 'a@x.co, b@x.co');
  assert.equal(esc.escalationTo({ stepEmail: '', type: 'finance', routes: { finance: 'fin@x.co' }, manager: 'boss@x.co' }), 'fin@x.co');
  assert.equal(esc.escalationTo({ stepEmail: '', type: 'support', routes: { finance: 'fin@x.co' }, manager: 'boss@x.co' }), 'boss@x.co');
  assert.equal(esc.escalationTo({ stepEmail: 'own@x.co', type: 'finance', routes: { finance: 'fin@x.co' }, manager: 'boss@x.co' }), 'own@x.co', 'a step that names an address wins');
  const kind = (r: Partial<{ key: string; departmentId: string; workflowId: string; workflowName: string }>) => esc.escalationType({ record: { key: r.key || 'a@b.co' }, departmentId: r.departmentId || '', workflowId: r.workflowId || '', workflowName: r.workflowName || '' } as never);
  assert.equal(kind({ key: '__report__', departmentId: 'dep_success' }), 'reports');
  assert.equal(kind({ departmentId: 'dep_success', workflowId: 'wf_mpho' }), 'placement');
  assert.equal(kind({ departmentId: 'dep_success' }), 'support');
  assert.equal(kind({ departmentId: 'dep_admissions' }), 'admissions');
  assert.equal(kind({ departmentId: 'dep_learning' }), 'academic');
  assert.equal(kind({ departmentId: 'dep_finance' }), 'finance');

  // Saved on the workspace (invalid addresses dropped), and used by the agents.
  m.acc.updateTenantIntegrations('default', { managerEmail: 'boss@academy.example.com', escalations: { reports: 'Reports@Academy.example.com, nope', support: 'success@academy.example.com' } as never });
  assert.deepEqual(m.acc.getTenantIntegrations('default').escalations, { reports: 'reports@academy.example.com', support: 'success@academy.example.com' });
  const { run } = await m.runs.startAgentRun({ workflow: m.wfs.getWorkflow('wf_karabo')!, record: { key: '__report__', sourceId: 'src_moodle', name: 'Team report', email: '', phone: '' }, trigger: 'test', force: true });
  const r = await settle(run!.id);
  assert.ok(r.logs.some((l) => /Briefed reports@academy\.example\.com/.test(l.detail)), logs(r));
  assert.equal(mailsTo('boss@academy.example.com').length, 0, 'the manager does not get what is routed elsewhere');
}));
