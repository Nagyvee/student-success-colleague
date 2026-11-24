import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* The Admissions daily report in Discord: weekdays at 17:00 South African
 * time, covering everything since the previous report (Monday's covers the
 * weekend), never on Saturday or Sunday, once per day. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-report-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
process.env.DISCORD_LEADS_WEBHOOK = 'https://discord.com/api/webhooks/123/abc';

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  rep: typeof import('../src/lib/nurture/report');
  rec: typeof import('../src/lib/data/records');
  src: typeof import('../src/lib/data/sources');
};
let m: M;
const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);
const posts: { embeds: { title: string; fields: { name: string; value: string }[] }[] }[] = [];
const realFetch = globalThis.fetch;
// 17:00 in South Africa is 15:00 UTC.
const at = (iso: string) => Date.parse(iso);

before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://discord.com/api/webhooks/')) { posts.push(JSON.parse(String(init?.body || '{}'))); return new Response('{}', { status: 200 }); }
    return realFetch(input, init);
  }) as typeof fetch;
  m = {
    ctx: await import('../src/lib/auth/tenantContext'),
    rep: await import('../src/lib/nurture/report'),
    rec: await import('../src/lib/data/records'),
    src: await import('../src/lib/data/sources'),
  };
});

test('the report slot is the latest weekday 17:00 in South Africa', () => {
  // Thursday 19 November 2026.
  assert.equal(m.rep.lastReportSlot(at('2026-11-19T14:30:00Z')), at('2026-11-18T15:00:00Z'), 'before 17:00: yesterday');
  assert.equal(m.rep.lastReportSlot(at('2026-11-19T15:30:00Z')), at('2026-11-19T15:00:00Z'), 'after 17:00: today');
  assert.equal(m.rep.lastReportSlot(at('2026-11-21T16:00:00Z')), at('2026-11-20T15:00:00Z'), 'Saturday: Friday');
  assert.equal(m.rep.lastReportSlot(at('2026-11-23T08:00:00Z')), at('2026-11-20T15:00:00Z'), 'Monday morning: still Friday');
});

test('it posts once each weekday at 17:00, never at the weekend, and Monday covers the weekend', () => T(async () => {
  posts.length = 0;
  const { updateTenantIntegrations } = await import('../src/lib/auth/accounts');
  updateTenantIntegrations('default', { handoff: { reportOn: true } });
  assert.equal(await m.rep.maybeSendNurtureReport('default', at('2026-11-19T14:00:00Z')), false, 'the first check only starts the clock');
  assert.equal(await m.rep.maybeSendNurtureReport('default', at('2026-11-19T14:59:00Z')), false, 'not yet 17:00');
  assert.equal(await m.rep.maybeSendNurtureReport('default', at('2026-11-19T15:01:00Z')), true, 'Thursday 17:01');
  assert.equal(await m.rep.maybeSendNurtureReport('default', at('2026-11-19T18:00:00Z')), false, 'once a day');
  assert.equal(await m.rep.maybeSendNurtureReport('default', at('2026-11-20T15:00:30Z')), true, 'Friday');
  assert.equal(await m.rep.maybeSendNurtureReport('default', at('2026-11-21T15:05:00Z')), false, 'not on Saturday');
  assert.equal(await m.rep.maybeSendNurtureReport('default', at('2026-11-22T15:05:00Z')), false, 'not on Sunday');
  assert.equal(await m.rep.maybeSendNurtureReport('default', at('2026-11-23T15:02:00Z')), true, 'Monday');
  assert.equal(posts.length, 3);
  assert.match(posts[2].embeds[0].title, /Admissions report · Mon,? 23 Nov/);
  assert.match(String((posts[2].embeds[0] as unknown as { description: string }).description), /Fri,? 20 Nov.*17:00.*Mon,? 23 Nov.*17:02/, 'Monday covers Friday 17:00 to Monday');
}));

test('the report counts only real new leads, qualified leads and replies; old sheet rows never count', () => T(() => {
  const now = Date.now();
  m.rec.upsertRecord(m.src.LEADS_SOURCE_ID, { key: 'a@example.com', name: 'Thandi Mokoena', email: 'a@example.com', phone: '+27820000001', fields: { platform: 'ig', engagement: 'hot', qualified: 'yes', qualified_at: new Date(now).toISOString(), qualified_reason: 'call', dialer_status: 'moved to New in the dialer', replied_at_ms: String(now) } });
  m.rec.upsertRecord(m.src.LEADS_SOURCE_ID, { key: 'b@example.com', name: 'Sizwe Ndlovu', email: 'b@example.com', phone: '+27820000002', fields: { platform: 'fb', engagement: 'warm', engagement_score: '4', nurture_count: '2' } });
  // An old sheet row imported quietly: not new, not in nurturing.
  m.rec.upsertRecord(m.src.LEADS_SOURCE_ID, { key: 'c@example.com', name: 'Old Sheet Row', email: 'c@example.com', phone: '+27820000003', fields: { platform: 'fb', imported_quietly: 'yes' } });
  const r = m.rep.buildNurtureReport(now - 3_600_000, now + 3_600_000, null);
  const f = (name: RegExp) => r.fields.find((x) => name.test(x.name))?.value || '';
  assert.match(f(/New leads/), /\*\*2\*\*/);
  assert.match(f(/New leads/), /Instagram ads: 1/);
  assert.match(f(/New leads/), /Facebook ads: 1/, 'the quietly imported sheet row is not new');
  assert.match(f(/Qualified/), /Thandi Mokoena\*\* asked us to call them · moved to New/);
  assert.match(f(/replied/), /Thandi Mokoena/);
  assert.match(f(/Right now/), /\*\*1\*\* being nurtured · \*\*1\*\* warming up/, 'only leads Thuso is working');
}));

test('the report waits for the switch: nothing is posted until "Post the daily report" is on', () => T(async () => {
  const { updateTenantIntegrations } = await import('../src/lib/auth/accounts');
  updateTenantIntegrations('default', { handoff: { reportOn: false } });
  posts.length = 0;
  assert.equal(await m.rep.maybeSendNurtureReport('default', at('2026-11-24T15:05:00Z')), false);
  assert.equal(posts.length, 0);
  const p = m.rep.previewNurtureReport('default');
  assert.match(p.report.title, /Admissions report/, 'the preview is there to read in the app');
  assert.equal(posts.length, 0, 'a preview posts nothing');
}));

test('someone who enquired earlier is not a new lead when the team gives them to Thuso: counted on their own, by where they came from', () => {
  const now = Date.now();
  const H = 3_600_000;
  const rec = (key: string, fields: Record<string, string>, firstSeenAt = now - H) => ({ key, sourceId: 'x', name: key, email: '', phone: '', fields, firstSeenAt, updatedAt: now });
  const ago = (h: number) => new Date(now - h * H).toISOString();
  const recs = [
    rec('today-ig', { platform: 'ig', agent_dialer_kind: 'sheet_row', agent_dialer_first_seen: ago(1) }),
    rec('today-site', { received_at: ago(1) }),
    rec('unknown', {}),
    // A lead from last month, moved to the nurturing stage today.
    rec('moved', { agent_dialer_kind: 'lead', agent_dialer_source: 'Meta ads', agent_dialer_first_seen: ago(700) }),
    // A row the form dates two weeks ago, on a tab connected today.
    rec('old-row', { platform: 'fb', created_time: ago(340), agent_dialer_first_seen: ago(1) }),
    // Given back to Thuso today.
    rec('back', { agent_dialer_kind: 'lead', agent_dialer_source: 'manual', back_for_nurturing_at: ago(2) }, now - 300 * H),
    rec('quiet', { imported_quietly: 'yes', platform: 'fb' }),
    rec('preview', { preview: 'yes' }),
    rec('before', { platform: 'ig' }, now - 50 * H),
  ];
  const { fresh, older } = m.rep.cameIn(recs, now - 24 * H, now);
  assert.deepEqual(fresh.map((r) => r.key), ['today-ig', 'today-site', 'unknown']);
  assert.deepEqual(older.map((r) => r.key), ['moved', 'old-row', 'back']);
});

test('the report says new and older leads apart, what it does not know, and never cuts a line in half', () => T(async () => {
  const now = Date.now();
  const L = m.src.LEADS_SOURCE_ID;
  m.rec.removeRecords((r) => r.sourceId === L);
  const add = (key: string, fields: Record<string, string>) => m.rec.upsertRecord(L, { key, name: fields.name || key, email: key, phone: '', fields });
  add('n1@example.com', { platform: 'ig' });
  add('n2@example.com', {});
  add('m1@example.com', { agent_dialer_kind: 'lead', agent_dialer_source: 'Meta ads', agent_dialer_first_seen: new Date(now - 60 * 86_400_000).toISOString(), agent_dialer_row_id: 'm1' });
  add('w1@example.com', { agent_dialer_row_id: 'w1', imported_quietly: 'yes' });
  for (let i = 0; i < 25; i++) add(`q${i}@example.com`, { name: `Nomathemba Constance Dlamini-Mthembu ${i}`, imported_quietly: 'yes', qualified: 'yes', qualified_at: new Date(now).toISOString(), qualified_reason: 'hot', dialer_status: i ? 'moved back to New in the dialer (was in Unqualified)' : 'moved back to New in the dialer (was in New Lead)', dialer_assigned_to: 'Thabile Mhlanga' });
  const r = m.rep.buildNurtureReport(now - 3_600_000, now + 3_600_000, null);
  const f = (name: RegExp) => r.fields.find((x) => name.test(x.name))?.value || '';
  assert.match(f(/New leads/), /^\*\*2\*\*\nInstagram ads: 1\nSource not recorded: 1$/);
  assert.match(f(/Older leads/), /^\*\*1\*\*\nMeta ads: 1$/);
  assert.match(f(/Right now/), /^\*\*1\*\* being nurtured · \*\*0\*\* warming up/);
  assert.match(f(/Right now/), /1 old row in the dialer, not messaged/);
  assert.doesNotMatch(f(/Right now/), /hot/);
  const q = f(/Qualified/);
  assert.ok(q.length <= 1024, `${q.length} characters`);
  assert.match(q, /\*\*Nomathemba Constance Dlamini-Mthembu 0\*\* reached 8 points · already in New Lead: given out again · Thabile/);
  assert.match(q, /back to New from Unqualified · Thabile/);
  const shown = q.split('\n').filter((l) => l.startsWith('•')).length;
  assert.match(q, new RegExp(`…and ${25 - shown} more$`));
  assert.ok(shown >= 8, `${shown} of 25 shown`);
  assert.match(r.description, /except Right now/);
  for (const x of r.fields) assert.ok(x.value.length <= 1024 && x.name.length <= 256, x.name);
}));

test('a reply is never counted as a click; a test or a sample is never counted as an email', () => T(async () => {
  const L = m.src.LEADS_SOURCE_ID;
  const { noteEngagement } = await import('../src/lib/nurture/track');
  const { meta } = await import('../src/lib/nurture/store');
  m.rec.upsertRecord(L, { key: 'r@example.com', name: 'Reply Person', email: 'r@example.com', phone: '', fields: {} });
  const before = meta().stats.clicks;
  await noteEngagement({ t: 'default', s: L, k: 'r@example.com', m: 'reply_1', x: 'reply' }, 'reply');
  assert.equal(meta().stats.clicks, before);
  await noteEngagement({ t: 'default', s: L, k: 'r@example.com', m: 'msg_1', x: 'apply' }, 'click', 'the application');
  assert.equal(meta().stats.clicks, before + 1);
  const { isNurtureEmail } = await import('../src/lib/email/send');
  const mail = (subject: string, dept = 'dep_admissions') => isNurtureEmail({ subject, dept });
  assert.ok(mail('Your course starts in January'));
  assert.ok(mail('[Testimonials] What our students say'));
  assert.ok(!mail('[Test] Your course starts in January'));
  assert.ok(!mail('[Sample 1/6 · Welcome] Hello'));
  assert.ok(!mail('Your fees', 'dep_finance'));
}));

test('what the dialer says about where a lead came from is kept without counting as a change', () => T(() => {
  const L = m.src.LEADS_SOURCE_ID;
  const put = (fields: Record<string, string>) => m.rec.upsertRecord(L, { key: 'k@example.com', name: 'Kagiso', email: 'k@example.com', phone: '', fields });
  put({ city: 'Durban' });
  assert.deepEqual(put({ city: 'Durban', agent_dialer_kind: 'lead', agent_dialer_first_seen: '2026-10-01T08:00:00Z' }).changed, [], 'no agent starts because of it');
  let f = m.rec.getRecord(L, 'k@example.com')!.fields;
  assert.equal(f.agent_dialer_kind, 'lead');
  assert.equal(f.dialer_first_seen, '2026-10-01T08:00:00Z');
  assert.deepEqual(put({ city: 'Durban', agent_dialer_kind: 'sheet_row', agent_dialer_first_seen: '2026-10-01T08:00:00Z' }).changed, []);
  f = m.rec.getRecord(L, 'k@example.com')!.fields;
  assert.deepEqual([f.agent_dialer_kind, f.dialer_kind], ['sheet_row', 'sheet_row'], 'both copies follow');
  assert.deepEqual(put({ city: 'Cape Town', agent_dialer_kind: 'sheet_row' }).changed, ['city'], 'a real column still counts');
  // A status Thuso wrote, changed by a form that sends it all back: a change.
  m.rec.setRecordField(L, 'k@example.com', 'status', 'new');
  const all = m.rec.getRecord(L, 'k@example.com')!.fields;
  assert.ok(put({ ...all, status: 'applied' }).changed.includes('status'));
}));

test('the preview also says who came in during the last report, as counted now', () => T(async () => {
  await m.rep.maybeSendNurtureReport('default', at('2026-11-25T15:05:00Z'));
  const p = m.rep.previewNurtureReport('default', at('2026-11-25T16:00:00Z'));
  assert.ok(p.last);
  assert.match(p.last!.description, /Tue,? 24 Nov.*Wed,? 25 Nov/);
  assert.match(p.last!.fields[0].name, /New leads/);
}));
