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

test('the report counts new leads by source, qualified leads and replies in its window', () => T(() => {
  const now = Date.now();
  m.rec.upsertRecord(m.src.LEADS_SOURCE_ID, { key: 'a@example.com', name: 'Thandi Mokoena', email: 'a@example.com', phone: '+27820000001', fields: { platform: 'ig', engagement: 'hot', qualified: 'yes', qualified_at: new Date(now).toISOString(), qualified_reason: 'call', dialer_status: 'moved to New in the dialer', replied_at_ms: String(now) } });
  m.rec.upsertRecord(m.src.LEADS_SOURCE_ID, { key: 'b@example.com', name: 'Sizwe Ndlovu', email: 'b@example.com', phone: '+27820000002', fields: { platform: 'fb', engagement: 'warm' } });
  const r = m.rep.buildNurtureReport(now - 3_600_000, now + 3_600_000, null);
  const f = (name: RegExp) => r.fields.find((x) => name.test(x.name))?.value || '';
  assert.match(f(/New leads/), /\*\*2\*\*/);
  assert.match(f(/New leads/), /Instagram ads: 1/);
  assert.match(f(/New leads/), /Facebook ads: 1/);
  assert.match(f(/Qualified/), /Thandi Mokoena\*\* asked us to call them · dialer: moved to New/);
  assert.match(f(/Replies/), /Thandi Mokoena/);
  assert.match(f(/Right now/), /1 lead in nurturing · \*\*0\*\* hot · 1 warming up/);
}));
