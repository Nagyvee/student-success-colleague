import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* The B2B Outbound page's API: what a signed-in person, and what only an owner
 * or admin, may do; nothing is searched or sent without being switched on. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-outboundapi-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SMTP_HOST', 'DISCORD_LEADS_WEBHOOK']) delete process.env[k];

type M = { api: typeof import('../src/app/api/outbound/route'); stop: typeof import('../src/app/b2b/[token]/route'); acc: typeof import('../src/lib/auth/accounts'); st: typeof import('../src/lib/outbound/store'); out: typeof import('../src/lib/outbound/outreach'); ctx: typeof import('../src/lib/auth/tenantContext') };
let m: M;
const cookie = (role: 'owner' | 'advisor') => `${m.acc.SESSION_COOKIE}=${m.acc.signSessionToken({ userId: 'u', tenantId: 'default', email: 'x@example.org', name: 'Nigel', role })}`;
const post = async (body: Record<string, unknown>, role: 'owner' | 'advisor' = 'owner') => { const r = (await m.api.POST(new Request('http://x/api/outbound', { method: 'POST', headers: { cookie: cookie(role), 'content-type': 'application/json' }, body: JSON.stringify(body) }))) as Response; return { status: r.status, ...((await r.json()) as { ok?: boolean; error?: string; detail?: string; id?: string }) }; };
const get = async (q = '', role: 'owner' | 'advisor' = 'owner') => (await m.api.GET(new Request(`http://x/api/outbound${q}`, { headers: { cookie: cookie(role) } }))) as Response;
const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);

before(async () => {
  m = { api: await import('../src/app/api/outbound/route'), stop: await import('../src/app/b2b/[token]/route'), acc: await import('../src/lib/auth/accounts'), st: await import('../src/lib/outbound/store'), out: await import('../src/lib/outbound/outreach'), ctx: await import('../src/lib/auth/tenantContext') };
});

test('signed out sees nothing; everything starts off', async () => {
  assert.equal(((await m.api.GET(new Request('http://x/api/outbound'))) as Response).status, 401);
  const j = await (await get()).json();
  assert.equal(j.settings.researchOn, false);
  assert.equal(j.settings.sendingOn, false);
  assert.equal(j.settings.budgetUsd, 50);
  assert.deepEqual(j.settings.magnets.map((x: { name: string }) => x.name), ['The free report', 'The toolkit', 'The 12H calculator']);
  assert.equal(j.missingForResearch.length, 2);
});

test('the switches stay off until what they need is there', async () => {
  let r = await post({ action: 'saveSettings', settings: { researchOn: true } });
  assert.match(r.error!, /Daily research stays off: tell Thuso what we sell/);
  r = await post({ action: 'saveSettings', settings: { services: 'Learnerships', ideal: 'Growing', sendingOn: true } });
  assert.match(r.error!, /sending stays off\. Still missing: the outreach mailbox/);
  const s = (await (await get()).json()).settings;
  assert.deepEqual([s.researchOn, s.sendingOn, s.services], [false, false, 'Learnerships']);
  assert.equal((await post({ action: 'saveSettings', settings: { researchOn: true } }, 'advisor')).status, 403);
  assert.equal((await post({ action: 'findNow', n: 3 })).error, 'The AI is not connected on this server.');
});

test('the list: import, add, choose, undo, edit, stages, export', async () => {
  assert.match((await post({ action: 'importIdeals', text: 'Company,Website\nShoprite,shoprite.co.za\nAcme,acme.co.za' })).detail!, /2 added, 2 in all\. They are marked "learn from it only"/);
  assert.match((await post({ action: 'add', name: 'Shoprite', website: 'shoprite.co.za' })).error!, /learn from it only/);
  const { id } = await post({ action: 'add', name: '=Cmd Co', website: 'cmd.co.za' }, 'advisor');
  assert.ok(id);
  assert.match((await post({ action: 'add', name: 'Cmd Co', website: 'www.cmd.co.za' })).error!, /already here/);
  assert.equal((await post({ action: 'stage', id, stage: 'contacted' })).error, 'It moves to Contacted when the first email goes.');
  assert.match((await post({ action: 'decide', id, yes: true }, 'advisor')).detail!, /1 approved/);
  assert.match((await post({ action: 'undo', id })).detail!, /back on the list/);
  await post({ action: 'decide', ids: [id], yes: true });
  assert.equal((await post({ action: 'edit', id, contact: { email: 'not an address' } })).error, 'That is not an email address.');
  assert.equal((await post({ action: 'edit', id, contact: { name: 'Ann', email: 'ann@cmd.co.za' }, notes: 'Met at an expo', callAt: '2026-12-01T10:00' })).ok, true);
  await T(() => m.out.draftNext());
  const c = (await (await get(`?company=${id}`)).json()).company;
  assert.equal(c.thread.length, 1);
  assert.match(c.thread[0].full, /Reply "no" or use .*\/b2b\//);
  // Checked, but nothing goes while sending is off; an advisor may not send.
  assert.equal((await post({ action: 'sendOk', id }, 'advisor')).status, 403);
  await post({ action: 'saveDraft', id, message: c.thread[0].id, subject: 'A report for Cmd', text: 'Hi Ann,\n\nWe met at the expo in October and you said you take on juniors every year.\n\nWe made a free report on training juniors. May I send it?' });
  assert.match((await post({ action: 'sendOk', id })).detail!, /once sending can start: Sending is switched off/);
  assert.equal((await post({ action: 'sendNow', id, message: c.thread[0].id })).error, 'Sending is switched off.');
  assert.equal((await post({ action: 'holdDraft', id, message: c.thread[0].id })).ok, true);
  const csv = await (await get('?export=csv')).text();
  assert.match(csv, /'=Cmd Co/);
  assert.match(csv, /ann@cmd\.co\.za/);
  // Stopped by the link: opening it changes nothing, the button does, and it cannot be moved back.
  const token = T(() => m.out.stopUrl(m.st.getCompany(id!)!)) as unknown as string;
  const params = { params: Promise.resolve({ token: String(await token).split('/b2b/')[1] }) };
  await m.stop.GET(new Request('http://x'), params);
  assert.equal(await T(() => m.st.getCompany(id!)!.consent), 'none');
  assert.equal((await m.stop.POST(new Request('http://x', { method: 'POST' }), params)).status, 200);
  assert.equal(await T(() => m.st.getCompany(id!)!.consent), 'no');
  assert.match((await post({ action: 'stage', id, stage: 'talking' })).error!, /asked us not to write/);
  assert.equal((await m.stop.GET(new Request('http://x'), { params: Promise.resolve({ token: 'bad' }) })).status, 404);
});
