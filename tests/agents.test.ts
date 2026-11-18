import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* End to end, in simulation mode (no AI key, no database, no live outreach):
 * the departments are created, the finance agent chases an overdue account,
 * waits, stops when it is paid, Approval Mode pauses a message until it is
 * approved, and a lead from ads is nurtured until they reply. */

// Everything writes under a throwaway folder, never the real .data/.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-agents-'));
process.chdir(dir);
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DATABASE_URL', 'PGHOST', 'SMTP_HOST', 'DIALER_URL']) delete process.env[k];

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  dep: typeof import('../src/lib/engine/departments');
  runs: typeof import('../src/lib/engine/agentRuns');
  trig: typeof import('../src/lib/engine/agentTriggers');
  rec: typeof import('../src/lib/data/records');
  store: typeof import('../src/lib/engine/store');
  wfs: typeof import('../src/lib/engine/workflows');
  appr: typeof import('../src/lib/engine/approvals');
  acc: typeof import('../src/lib/auth/accounts');
  lib: typeof import('../src/lib/nurture/library');
  track: typeof import('../src/lib/nurture/track');
  nstore: typeof import('../src/lib/nurture/store');
};
let m: M;

before(async () => {
  m = {
    ctx: await import('../src/lib/auth/tenantContext'),
    dep: await import('../src/lib/engine/departments'),
    runs: await import('../src/lib/engine/agentRuns'),
    trig: await import('../src/lib/engine/agentTriggers'),
    rec: await import('../src/lib/data/records'),
    store: await import('../src/lib/engine/store'),
    wfs: await import('../src/lib/engine/workflows'),
    appr: await import('../src/lib/engine/approvals'),
    acc: await import('../src/lib/auth/accounts'),
    lib: await import('../src/lib/nurture/library'),
    track: await import('../src/lib/nurture/track'),
    nstore: await import('../src/lib/nurture/store'),
  };
});

const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);

async function settle(runId: string, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = m.runs.getAgentRun(runId);
    if (r && r.status !== 'running') return r;
    if (Date.now() > end) throw new Error(`run ${runId} still running: ${JSON.stringify(r?.logs.slice(-3))}`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

// Approval Mode and autopilot live on the workspace (the world state mirrors them).
const setMode = (p: { requireApproval?: boolean; autoRunMode?: boolean }) => m.acc.updateTenantIntegrations('default', p);

const mailsTo = (email: string) => m.store.getState().inbox.filter((x) => x.to === email);

function trackerRow(email: string, fields: Record<string, string>) {
  return m.rec.upsertRecord('src_tracker', { key: email, name: fields.name, email, phone: '+27825551234', fields: { email, ...fields } }).record;
}

test('the building gets five department floors with agents and jobs', () => T(() => {
  assert.equal(m.dep.ensureDepartmentModel(), true);
  assert.equal(m.dep.ensureDepartmentModel(), false, 'runs once');
  const floors = m.dep.buildingModel();
  assert.deepEqual(floors.slice(0, 5).map((f) => f.department.name), ['Admissions', 'B2B Sales', 'Student Success', 'Learning & Assessment', 'Finance & Operations']);
  for (const f of floors.slice(0, 5)) {
    assert.ok(f.agents.length >= 2, `${f.department.name} has agents`);
    for (const a of f.agents) assert.ok(a.workflow?.steps?.length, `${a.agent.name} has a job`);
  }
  const lindiwe = floors[3].agents.find((a) => a.agent.name === 'Lindiwe')!;
  assert.equal(lindiwe.workflow!.steps![0].kind, 'ai_lesson');
  assert.equal(lindiwe.workflow!.steps![0].questionCount, 10);
}));

test('finance chases an overdue account, waits, and stops when it is paid', () => T(async () => {
  setMode({ requireApproval: false });
  const email = 'nigel@example.com';
  const rec = trackerRow(email, { name: 'Nigel Dube', first_name: 'Nigel', total_fee: '42000', amount_paid: '40500', amount_due: '1500', due_date: '2026-01-10' });
  const wf = m.wfs.getWorkflow('wf_refilwe')!;
  const { run } = await m.runs.startAgentRun({ workflow: wf, record: m.trig.toRunRecord(rec), trigger: 'test', force: true });
  assert.ok(run);
  let r = await settle(run.id);
  assert.equal(r.status, 'waiting', JSON.stringify(r.logs.map((l) => l.detail)));
  assert.equal(mailsTo(email).length, 1, 'the first reminder; the follow-ups wait their 3 days');
  assert.match(mailsTo(email)[0].text, /1.?500/);
  assert.ok(r.resumeAt! > Date.now() + 70 * 3_600_000, 'waits about 3 days');

  // A cooldown keeps the scheduler from starting a second chase for the same person.
  const again = await m.runs.startAgentRun({ workflow: wf, record: m.trig.toRunRecord(rec), trigger: 'test' });
  assert.equal(again.run, null);

  // The tracker now says paid: the loop ends and the agent thanks them.
  trackerRow(email, { name: 'Nigel Dube', first_name: 'Nigel', total_fee: '42000', amount_paid: '42000', amount_due: '0', due_date: '2026-01-10' });
  assert.equal(m.runs.resumeNow(run.id), true);
  r = await settle(run.id);
  assert.equal(r.status, 'completed', JSON.stringify(r.logs.map((l) => l.detail)));
  assert.equal(mailsTo(email).length, 2, 'no follow-up once paid, just the thank-you');
  assert.ok(r.logs.some((l) => /No more follow-ups needed/.test(l.detail)));
}));

test('Approval Mode holds a message until a person approves it', () => T(async () => {
  setMode({ requireApproval: true });
  const email = 'ama@example.com';
  const rec = trackerRow(email, { name: 'Ama Khumalo', first_name: 'Ama', amount_due: '3000', due_date: '2099-01-01' });
  const { run } = await m.runs.startAgentRun({ workflow: m.wfs.getWorkflow('wf_kagiso')!, record: m.trig.toRunRecord(rec), trigger: 'test', force: true });
  let r = await settle(run!.id);
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(mailsTo(email).length, 0, 'nothing sent yet');
  const item = m.store.getState().pendingOutreach!.find((x) => x.runId === run!.id && x.status === 'pending')!;
  assert.equal(item.kind, 'agent_message');
  await m.appr.approveOutreachById(item.id);
  r = await settle(run!.id);
  assert.equal(r.status, 'completed');
  assert.equal(mailsTo(email).length, 1);
}));

test('a lead from ads gets saved messages (no AI), warms up, and a hot lead gets personal attention', () => T(async () => {
  setMode({ requireApproval: false, autoRunMode: true });
  // The library starts with drafts: a person approves each once.
  const drafts = m.lib.listMessages();
  assert.ok(drafts.length >= 6, 'starter library');
  assert.ok(drafts.every((x) => x.status === 'draft'), 'nothing goes out unapproved');
  for (const x of drafts) assert.equal(m.lib.approveMessage(x.id, 'test').error, undefined, `${x.name}: ${x.check.notes.join(' ')}`);

  const got = await m.trig.receiveLead({ field_data: [{ name: 'full_name', values: ['Thandi Mokoena'] }, { name: 'email', values: ['Thandi@Example.com'] }, { name: 'phone_number', values: ['082 123 4567'] }, { name: 'which_course_are_you_interested_in', values: ['Data Analytics'] }], campaign: 'Nov intake - Facebook' });
  assert.equal(got.created, true);
  assert.equal(got.record.email, 'thandi@example.com');
  assert.equal(got.record.phone, '+27821234567');
  assert.equal(got.record.fields.interest, 'Data Analytics');
  assert.ok(got.started >= 1, 'Naledi started');
  const run = m.runs.listAgentRuns({ workflowId: 'wf_naledi' })[0];
  const r = await settle(run.id);
  assert.equal(r.status, 'waiting', JSON.stringify(r.logs.map((l) => l.detail)));
  assert.equal(m.rec.getRecord('src_leads', got.record.key)!.fields.status, 'contacted');
  const welcome = mailsTo('thandi@example.com');
  assert.equal(welcome.length, 1);
  assert.match(welcome[0].subject, /Thandi/, 'merged with her name');
  assert.match(welcome[0].html, /\/go\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, 'links are tracked');
  assert.match(welcome[0].html, /Stop these emails/, 'she can unsubscribe');
  assert.equal(m.nstore.meta().stats.librarySends, 1);
  assert.equal(m.nstore.meta().stats.aiSends, 0, 'no AI for a saved message');

  // She replies (+6, warm), then clicks the quiz link (+3, hot): Zinhle gives her personal attention.
  await m.trig.dispatchReply('thandi@example.com', 'Hi, can I study part time while working?', 'Thandi');
  assert.equal(m.rec.getRecord('src_leads', got.record.key)!.fields.engagement, 'warm');
  await m.track.noteEngagement({ t: 'default', s: 'src_leads', k: got.record.key, m: welcome[0].taskId || 'x', x: 'quiz' }, 'click', 'the career-fit quiz');
  assert.equal(m.rec.getRecord('src_leads', got.record.key)!.fields.engagement, 'hot');
  const z = m.runs.listAgentRuns({ workflowId: 'wf_zinhle' })[0];
  assert.ok(z, 'Zinhle picked up the hot lead');
  const zr = await settle(z.id);
  assert.ok(zr.logs.some((l) => /Personal note/.test(l.title) && l.status === 'ok'), JSON.stringify(zr.logs.map((l) => l.detail)));
  // AI wrote for her only because she engaged: Thabo answered her question, Zinhle wrote to her as a hot lead.
  assert.equal(m.nstore.meta().stats.aiSends, 2);
  assert.equal(m.nstore.meta().stats.librarySends, 1);
}));

test('an unsubscribe stops every journey for that lead', () => T(async () => {
  setMode({ requireApproval: false, autoRunMode: true });
  const got = await m.trig.receiveLead({ name: 'Sipho Dlamini', email: 'sipho.d@example.com', course: 'Software Development' });
  const run = m.runs.listAgentRuns({ workflowId: 'wf_naledi' }).find((r) => r.record.key === got.record.key)!;
  assert.equal((await settle(run.id)).status, 'waiting');
  await m.track.noteEngagement({ t: 'default', s: 'src_leads', k: got.record.key, m: 'msg_x', x: 'unsub' }, 'unsub');
  assert.equal(m.rec.getRecord('src_leads', got.record.key)!.fields.opted_out, 'yes');
  assert.equal(m.runs.getAgentRun(run.id)!.status, 'stopped');
}));

test('a login does not trigger a "gone quiet" check-in, a long silence does', () => T(async () => {
  setMode({ requireApproval: false, autoRunMode: true });
  const fresh = await m.trig.dispatchLmsEvent('login.gap', { id: 'L1', name: 'Kabelo Nkosi', email: 'kabelo@example.com', fields: { id: 'L1', days_since_login: '0' } }, 'test');
  assert.equal(fresh, 0);
  const quiet = await m.trig.dispatchLmsEvent('login.gap', { id: 'L1', name: 'Kabelo Nkosi', email: 'kabelo@example.com', fields: { id: 'L1', days_since_login: '12' } }, 'test');
  assert.equal(quiet, 1, 'Bongani picks it up');
  const run = m.runs.listAgentRuns({ workflowId: 'wf_bongani' })[0];
  const r = await settle(run.id);
  assert.equal(r.status, 'waiting');
  // He logs in again: the loop sees days_since_login 0 at its next check and stops.
  await m.trig.dispatchLmsEvent('login.gap', { id: 'L1', name: 'Kabelo Nkosi', email: 'kabelo@example.com', fields: { id: 'L1', days_since_login: '0' } }, 'test');
  m.runs.resumeNow(run.id);
  const done = await settle(run.id);
  assert.ok(done.logs.some((l) => /No more follow-ups needed/.test(l.detail)), JSON.stringify(done.logs.map((l) => l.detail)));
}));

test('marking a lead "applied" ends the nurture journey and starts enrolment help', () => T(async () => {
  setMode({ requireApproval: false, autoRunMode: true });
  const got = await m.trig.receiveLead({ name: 'Lwazi Zulu', email: 'lwazi@example.com', course: 'Cybersecurity' });
  const nurture = m.runs.listAgentRuns({ workflowId: 'wf_naledi' }).find((r) => r.record.key === got.record.key)!;
  assert.equal((await settle(nurture.id)).status, 'waiting');
  const edit = await m.trig.editRecord('src_leads', got.record.key, 'status', 'applied');
  assert.equal(edit.started, 1, 'Ayanda starts');
  m.runs.resumeNow(nurture.id);
  const r = await settle(nurture.id);
  assert.equal(r.status, 'completed');
  assert.ok(r.logs.some((l) => /already applied, so the nurturing ends here/.test(l.detail)), JSON.stringify(r.logs.map((l) => l.detail)));
  // A repeat webhook for the same lead keeps the status someone set.
  const again = await m.trig.receiveLead({ name: 'Lwazi Zulu', email: 'lwazi@example.com', course: 'Cybersecurity' });
  assert.equal(again.created, false);
  assert.equal(again.record.fields.status, 'applied');
}));

test('a hot-lead agent takes the lead over, gives a voucher (code made by the system), and a friend can claim it', () => T(async () => {
  setMode({ requireApproval: false, autoRunMode: true });
  const v = await import('../src/lib/nurture/vouchers');
  const thanks = v.listOffers().find((o) => o.name === 'Thank-you voucher')!;
  assert.ok(thanks, 'starter offers exist');
  assert.equal(thanks.status, 'draft', 'nothing is given away until a person makes it active');
  v.setOfferStatus(thanks.id, 'active', 'test');

  const got = await m.trig.receiveLead({ name: 'Ayesha Khan', email: 'ayesha@example.com', course: 'Data Science' });
  const naledi = m.runs.listAgentRuns({ workflowId: 'wf_naledi' }).find((r) => r.record.key === got.record.key)!;
  assert.equal((await settle(naledi.id)).status, 'waiting');

  // A one-off job: take her over, give her the voucher.
  const wf = m.wfs.createWorkflow({ name: 'Test close', officeId: 'dep_admissions', agentId: 'ag_zinhle', domain: 'admissions', description: '', trigger: 'manual', instructions: '', version: 2, departmentId: 'dep_admissions', agentTrigger: { kind: 'manual' }, steps: [{ id: 't1', kind: 'take_over', title: 'Take over' }, { id: 't2', kind: 'send_voucher', title: 'Voucher' }] });
  const started = await m.runs.startAgentRun({ workflow: wf, record: m.trig.toRunRecord(got.record), trigger: 'test', force: true });
  const r = await settle(started.run!.id);
  assert.equal(m.runs.getAgentRun(naledi.id)!.status, 'stopped', 'Naledi stops: one person talks to her');
  assert.ok(r.logs.some((l) => /takes Ayesha over: 1 other agent/.test(l.detail)), JSON.stringify(r.logs.map((l) => l.detail)));
  const rec = m.rec.getRecord('src_leads', got.record.key)!;
  assert.match(rec.fields.voucher_code, /^MEL-AYES-[A-Z2-9]{4}$/);
  const mail = mailsTo('ayesha@example.com').find((x) => /voucher/i.test(x.subject))!;
  assert.ok(mail, 'the voucher email went out');
  assert.ok(mail.html.includes(rec.fields.voucher_code) && /Pass it on/.test(mail.html));
  assert.equal(v.getOffer(thanks.id)!.stats.issued, 1);

  // Giving it again reuses the same code.
  assert.equal(v.issueVoucher(thanks, rec).code, rec.fields.voucher_code);

  // A friend claims it and becomes a lead with the code.
  const claim = await v.claimShared(rec.fields.voucher_code, { name: 'Sizwe Ndlovu', email: 'sizwe@example.com', phone: '', interest: 'Cybersecurity' });
  assert.equal(claim.ok, true);
  const friend = m.rec.getRecord('src_leads', 'sizwe@example.com')!;
  assert.equal(friend.fields.voucher_code, rec.fields.voucher_code);
  assert.match(friend.fields.source, /Referral from Ayesha Khan/);

  // Used at enrolment, once.
  assert.equal(v.redeemVoucher(rec.fields.voucher_code, 'test').error, undefined);
  assert.match(v.redeemVoucher(rec.fields.voucher_code, 'test').error || '', /Already used/);
}));

test('every job has unique step ids (a repeat would send a run to the wrong step)', () => T(() => {
  m.dep.ensureDepartmentModel();
  for (const w of m.wfs.listWorkflows().filter((x) => x.version === 2)) {
    const ids: string[] = [];
    const walk = (list: NonNullable<typeof w.steps>) => { for (const x of list) { ids.push(x.id); walk(x.yes || []); walk(x.no || []); walk(x.steps || []); } };
    walk(w.steps || []);
    assert.equal(new Set(ids).size, ids.length, `${w.name} repeats a step id`);
  }
}));
