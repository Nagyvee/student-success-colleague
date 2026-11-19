import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Lists made of several tabs (Meta ads, TikTok, WhatsApp leads; tracker years),
 * against a fake Google Sheets: one record per person, a new tab is a quiet
 * baseline, and the tracker's own words (Fully Paid!, Behind, Dropped out,
 * an instalment "Due" next to an outstanding balance) are read correctly. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-sheets-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  src: typeof import('../src/lib/data/sources');
  rec: typeof import('../src/lib/data/records');
};
let m: M;
const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);

const SHEET = 'https://docs.google.com/spreadsheets/d/FAKEID/edit';
const tab = (gid: number) => `${SHEET}#gid=${gid}`;
const csv: Record<string, string> = {};
const realFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input);
    const gid = /gid=(\d+)/.exec(u)?.[1] || '0';
    if (!(gid in csv)) return realFetch(input);
    return new Response(csv[gid], { status: 200, headers: { 'Content-Type': 'text/csv' } });
  }) as typeof fetch;
  m = {
    ctx: await import('../src/lib/auth/tenantContext'),
    src: await import('../src/lib/data/sources'),
    rec: await import('../src/lib/data/records'),
  };
});

test('three lead tabs make one list: one record per person, later tabs fill in, the first read messages nobody', () => T(async () => {
  csv['1'] = 'id,created_time,campaign_name,which_programme_are_you_interested_in?,how_will_you_finance_the_program,first_name,surname,email_address,phone_number,lead_status\n'
    + 'l1,2026-11-05,Nov intake,cybersecurity_analyst,i_will_fund_my_self,Thandi,Mokoena,Thandi@Example.com,0821234567,CREATED\n'
    + 'l2,2026-11-06,Nov intake,data_science,i_require_a_student_loan,Sizwe,Ndlovu,sizwe@example.com,0831234567,CREATED\n';
  csv['2'] = 'Timestamp,Platform,Username,Full Name,Phone,Email,Programme,Payment Plan\n'
    + '2026-07-04,TikTok,@ayanda,Ayanda Zulu,0841234567,ayanda@example.com,Cybersecurity 101,TBD - Advisor to discuss\n'
    + '2026-07-05,TikTok,@noemail,No Email,0851234567,,Software Development,I will fund myself\n';
  csv['3'] = 'Timestamp,Name,Phone,Email,Programme ID,Programme,Track,Payment Plan\n'
    + '2026-06-23,Thandi M,0821234567,thandi@example.com,cyb,Cybersecurity Analyst,accredited,Upfront\n';
  // As configured for Melsoft: Meta's lead_status (always CREATED) is not our status.
  m.src.saveSource({
    id: 'src_leads', name: 'Leads from ads & forms', kind: 'leads', url: tab(1),
    mapping: { first_name: 'first_name', last_name: 'surname', email: 'email_address', phone: 'phone_number', interest: 'which_programme_are_you_interested_in?', source: 'campaign_name' },
    tabs: [{ url: tab(2), label: 'openclaw-social-leads' }, { url: tab(3), label: 'WhatsApp Leads' }],
  });
  const events = await m.src.readSource(m.src.getSource('src_leads')!);
  assert.deepEqual(events, [], 'the first read is a baseline');
  const all = m.rec.listRecords('src_leads');
  assert.equal(all.length, 4, 'Thandi is on two tabs but is one record');
  const thandi = m.rec.getRecord('src_leads', 'thandi@example.com')!;
  assert.equal(thandi.name, 'Thandi M');
  assert.equal(thandi.phone, '+27821234567');
  assert.equal(thandi.fields.interest, 'cybersecurity_analyst', 'from the Meta tab');
  assert.equal(thandi.fields.payment_plan, 'Upfront', 'from the WhatsApp tab');
  assert.equal(thandi.fields.status, undefined, 'lead_status is not mapped to status');
  assert.equal(m.rec.getRecord('src_leads', 'ayanda@example.com')!.fields.programme, 'Cybersecurity 101');
  assert.ok(all.some((r) => r.name === 'No Email' && r.phone === '+27851234567'), 'a lead with only a phone is kept');
  assert.deepEqual(m.src.getSource('src_leads')!.baselined, [tab(1), tab(2), tab(3)]);

  // An agent marks Thandi contacted; the next read keeps it (status is not a sheet column).
  m.rec.setRecordField('src_leads', 'thandi@example.com', 'status', 'contacted');
  // A new lead on one tab is new; Thandi is not.
  csv['3'] += '2026-11-18,Lebo K,0861234567,lebo@example.com,ds,Data Science,bootcamp,6 installments\n';
  const next = await m.src.readSource(m.src.getSource('src_leads')!);
  assert.deepEqual(next.map((e) => [e.kind, e.record.email]), [['added', 'lebo@example.com']]);
  assert.equal(m.rec.getRecord('src_leads', 'thandi@example.com')!.fields.status, 'contacted');

  // A tab added later is imported quietly (its 2 people are not "new leads").
  csv['4'] = 'Timestamp,Name,Phone,Email,Programme\n2026-01-01,Old One,0871234567,old1@example.com,Data Science\n2026-01-02,Old Two,0881234567,old2@example.com,Data Science\n';
  const s = m.src.getSource('src_leads')!;
  m.src.saveSource({ ...s, tabs: [...(s.tabs || []), { url: tab(4), label: 'Applications' }] });
  assert.deepEqual(await m.src.readSource(m.src.getSource('src_leads')!), []);
  assert.ok(m.rec.getRecord('src_leads', 'old1@example.com'));
}));

test('the fees tracker: the instalment "Due" is what is owed now, never the whole balance; its status words are understood', () => T(async () => {
  const headers = ['Full Name', 'Email', 'Phone', 'Total', 'Up to Date', 'Outstanding Balance', 'Due', 'Due date', 'Status', 'Blocked Status'];
  const mapping = { name: 'Full Name', email: 'Email', phone: 'Phone', total_fee: 'Total', amount_paid: 'Up to Date', amount_due: 'Due', due_date: 'Due date', payment_status: 'Status' } as const;
  const source = { id: 'src_tracker', name: 'Student tracker', kind: 'finance' as const, url: 'x', mapping, enabled: true, createdAt: 0 };
  const now = new Date(2026, 10, 18);
  const row = (vals: string[]) => m.src.liveFields(m.src.rowToRecord(source, headers, vals, 0), now);

  const onPlan = row(['Ama K', 'ama@example.com', '0821112222', 'R82,875.06', 'R45,000.00', 'R37,875.06', 'R4,604.17', '20-Nov-2026', 'Up-to Date', '']);
  assert.deepEqual([onPlan.payment_state, onPlan.amount_due, onPlan.due_date], ['due', '4604.17', '2026-11-20'], 'the instalment, due in 2 days');

  const nothingDue = row(['Bo L', 'bo@example.com', '', 'R74,999.00', 'R30,000.00', 'R44,999.00', '', '', 'Up-to Date', '']);
  assert.notEqual(nothingDue.payment_state, 'due', 'an outstanding balance with no instalment due is not "due"');
  assert.ok(!nothingDue.amount_due, 'nothing due now');

  const behind = row(['Cy M', 'cy@example.com', '', 'R74,999.00', 'R20,000.00', 'R54,999.00', 'R3,333.34', '9-Nov-2026', 'Behind', 'BLOCKED']);
  assert.deepEqual([behind.payment_state, behind.days_overdue], ['overdue', '9']);
  const behindNoDate = row(['Ed N', 'ed@example.com', '', 'R74,999.00', 'R20,000.00', 'R54,999.00', 'R1,000.00', '', 'Behind', '']);
  assert.equal(behindNoDate.payment_state, 'overdue', 'Behind with an amount owed, even with no date on the sheet');
  assert.equal(row(['Di P', 'di@example.com', '', 'R30,000.00', 'R30,000.00', 'R0.00', '', '', 'Fully Paid!', '']).payment_state, 'paid');
  for (const word of ['Dropped out', 'Paused', 'Bad Debt']) {
    assert.equal(row(['Ex S', 'ex@example.com', '', 'R74,999.00', 'R10,000.00', 'R64,999.00', 'R5,500.00', '1-Nov-2026', word, '']).payment_state, 'inactive', `${word}: never reminded`);
  }
}));
