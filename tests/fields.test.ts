import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* What Thuso writes on a lead survives the next read of the leads list.
 *
 * The bug this guards: the second time a field was written (a score going
 * from 1 to 4, a second email sent), only its plain copy changed; the next
 * read of the dialer put the first value back. Scores fell to 1, "already
 * sent" lists lost messages (so they went again), and the 24-hour spacing
 * read an old date. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-fields-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST']) delete process.env[k];

type M = { ctx: typeof import('../src/lib/auth/tenantContext'); rec: typeof import('../src/lib/data/records') };
let m: M;
const T = <R>(fn: () => R) => m.ctx.withTenant('default', fn);

before(async () => {
  m = {
    ctx: await import('../src/lib/auth/tenantContext'),
    rec: await import('../src/lib/data/records'),
  };
});

const row = (cols: Record<string, string>) => ({ key: 'ann@x.com', name: 'Ann Lee', email: 'ann@x.com', phone: '+27820000000', fields: cols });

test('a field written twice keeps its latest value through every re-read', () => T(() => {
  const { upsertRecord, setRecordField, getRecord } = m.rec;
  upsertRecord('src_t1', row({ full_name: 'Ann Lee', platform: 'fb' }));
  setRecordField('src_t1', 'ann@x.com', 'engagement_score', '1');
  setRecordField('src_t1', 'ann@x.com', 'nurture_sent', 'msg_a');
  setRecordField('src_t1', 'ann@x.com', 'engagement_score', '4');
  setRecordField('src_t1', 'ann@x.com', 'nurture_sent', 'msg_a|msg_b');

  // The same row read again (nothing changed in the sheet).
  const same = upsertRecord('src_t1', row({ full_name: 'Ann Lee', platform: 'fb' }));
  assert.deepEqual(same.changed, [], 'Thuso\'s own fields are not a change in the sheet');
  assert.equal(getRecord('src_t1', 'ann@x.com')!.fields.engagement_score, '4');
  assert.equal(getRecord('src_t1', 'ann@x.com')!.fields.nurture_sent, 'msg_a|msg_b');

  // The row changes in the sheet: Thuso's fields still keep their latest values.
  upsertRecord('src_t1', row({ full_name: 'Ann Lee', platform: 'ig' }));
  const f = getRecord('src_t1', 'ann@x.com')!.fields;
  assert.equal(f.engagement_score, '4');
  assert.equal(f.agent_engagement_score, '4');
  assert.equal(f.nurture_sent, 'msg_a|msg_b');
  assert.equal(f.platform, 'ig');
}));

test('a real sheet column is still the sheet\'s to change', () => T(() => {
  const { upsertRecord, setRecordField, getRecord } = m.rec;
  upsertRecord('src_t2', row({ full_name: 'Ann Lee', status: 'new' }));
  setRecordField('src_t2', 'ann@x.com', 'status', 'contacted');
  assert.equal(getRecord('src_t2', 'ann@x.com')!.fields.status, 'contacted');
  assert.equal(getRecord('src_t2', 'ann@x.com')!.fields.agent_status, undefined, 'a sheet column is written in place');
  upsertRecord('src_t2', row({ full_name: 'Ann Lee', status: 'applied' }));
  assert.equal(getRecord('src_t2', 'ann@x.com')!.fields.status, 'applied');
}));

test('a lead already damaged gets its newest value back on the next read', () => T(() => {
  const { upsertRecord, getRecord } = m.rec;
  // As the old code left it: the plain copy moved on, the agent_ copy stayed behind.
  upsertRecord('src_t3', { ...row({ full_name: 'Ann Lee' }), fields: { full_name: 'Ann Lee', agent_engagement_score: '1', engagement_score: '7', agent_nurture_count: '1', nurture_count: '3' } });
  upsertRecord('src_t3', row({ full_name: 'Ann Lee' }));
  const f = getRecord('src_t3', 'ann@x.com')!.fields;
  assert.equal(f.engagement_score, '7');
  assert.equal(f.agent_engagement_score, '7');
  assert.equal(f.nurture_count, '3');
}));

test('a lead\'s points add up, line by line; a score the bug pulled back is rebuilt from what they did', async () => {
  const { pointsOf } = await import('../src/lib/nurture/track');
  const { earnedScore } = await import('../src/lib/nurture/repair');
  const seen = 'open:msg_a:open|click:msg_a:call|quiz:msg_a:quiz|video:msg_b:video';
  const p = pointsOf({ nurture_seen: seen, engagement_score: '13' });
  assert.deepEqual(p.items.map((i) => [i.kind, i.points]), [['open', 1], ['click', 3], ['quiz', 5], ['video', 4]]);
  assert.equal(p.total, 13);
  assert.equal(p.other, 0);
  // As the bug left a lead: one open listed, score 1, but they had opened 2 emails, clicked and replied.
  const damaged = { nurture_seen: 'open:msg_a:open', engagement_score: '1', nurture_opens: '2', nurture_clicks: '1', last_clicked: 'Call me', replied: 'yes' };
  assert.equal(earnedScore(damaged), 1 + 1 + 3 + 6);
  // A lead whose score is right is left as it is.
  assert.equal(earnedScore({ nurture_seen: seen, engagement_score: '13', nurture_opens: '1', nurture_clicks: '1', fit_done: 'yes' }), 13);
});
