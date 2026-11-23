import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* What Thuso's leads type on WhatsApp, against a fake ManyChat: answered once,
 * in the same chat, as Naledi or Zinhle; never another lead's chat; nobody is
 * left unanswered without the team hearing. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-wareplies-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SMTP_HOST', 'WHATSAPP_API_URL']) delete process.env[k];
process.env.SENDING_PAUSED = 'false';

const texts: { id: number; text: string }[] = [];
const tags: { id: number; tag: string }[] = [];
const discord: string[] = [];
const realFetch = globalThis.fetch;

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext'); acc: typeof import('../src/lib/auth/accounts'); rec: typeof import('../src/lib/data/records');
  src: typeof import('../src/lib/data/sources'); wr: typeof import('../src/lib/nurture/waReplies'); runs: typeof import('../src/lib/engine/agentRuns');
};
let m: M;
const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const L = () => m.src.LEADS_SOURCE_ID;
// Approval Mode and autopilot live on the workspace (the world state mirrors them).
const setMode = (p: { requireApproval?: boolean; autoRunMode?: boolean }) => m.acc.updateTenantIntegrations('default', p);
const until = async (ok: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await wait(25); };

before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.host === 'discord.com') { discord.push(JSON.parse(String(init?.body)).content || ''); return new Response('{}', { status: 200 }); }
    if (u.host !== 'api.manychat.com') return realFetch(input, init);
    if (u.pathname === '/fb/sending/sendContent') {
      const b = JSON.parse(String(init?.body));
      texts.push({ id: b.subscriber_id, text: b.data.content.messages[0].text });
    }
    if (u.pathname === '/fb/subscriber/addTagByName') { const b = JSON.parse(String(init?.body)); tags.push({ id: b.subscriber_id, tag: b.tag_name }); }
    return new Response(JSON.stringify({ status: 'success', data: {} }), { status: 200 });
  }) as typeof fetch;
  m = {
    ctx: await import('../src/lib/auth/tenantContext'), acc: await import('../src/lib/auth/accounts'), rec: await import('../src/lib/data/records'),
    src: await import('../src/lib/data/sources'), wr: await import('../src/lib/nurture/waReplies'), runs: await import('../src/lib/engine/agentRuns'),
  };
  await T(async () => {
    (await import('../src/lib/engine/departments')).ensureDepartmentModel();
    m.src.saveSource({ id: L(), name: 'Leads', kind: 'leads', url: '' });
    m.acc.updateTenantIntegrations('default', { liveOutreachEnabled: true, manychatApiKey: 'mc', requireApproval: false, handoff: { discordWebhook: 'https://discord.com/api/webhooks/1/abc' } });
    setMode({ requireApproval: false, autoRunMode: true });
  });
});

const add = (key: string, phone: string, fields: Record<string, string> = {}) => {
  m.rec.upsertRecord(L(), { key, name: 'Thandi Mokoena', email: '', phone, fields: { interest: 'Data Science' } });
  for (const [k, v] of Object.entries(fields)) m.rec.setRecordField(L(), key, k, v);
};
const say = (id: string, text: string, now = Date.now(), phone = '') => m.wr.receive({ id, phone, name: 'Thandi', text }, 'default', now);
const later = () => Date.now() + m.wr.QUIET_MS + 10_000;

test('ManyChat\'s contact data is read; anything without a contact is refused', () => {
  assert.deepEqual(m.wr.readIncoming({ id: '901', first_name: 'Thandi', last_name: 'M', whatsapp_phone: '+27821', last_input_text: ' Hi ' }), { id: '901', phone: '+27821', name: 'Thandi M', text: 'Hi' });
  assert.equal(m.wr.readIncoming({ text: 'hi' }), null);
  assert.equal(m.wr.readIncoming({ id: '../etc', text: 'hi' }), null);
});

test('three quick messages get one answer, on WhatsApp, from Naledi; a repeated delivery is not a new message', () => T(async () => {
  add('a@x', '+27820000001', { manychat_id: '1001' });
  const t = Date.now();
  say('1001', 'Hi', t); say('1001', 'How long is the course?', t + 2000); say('1001', 'How long is the course?', t + 2500);
  assert.equal(await m.wr.pumpWaReplies('default', t + 5000), 0, 'still typing');
  assert.equal(await m.wr.pumpWaReplies('default', later()), 1);
  await until(() => texts.length > 0);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].id, 1001);
  const run = m.runs.listAgentRuns({ limit: 50 }).find((r) => r.record.key === 'a@x')!;
  assert.equal(run.agentName, 'Naledi');
  assert.equal(run.vars.last_reply, 'Hi\nHow long is the course?');
  const f = m.rec.getRecord(L(), 'a@x')!.fields;
  assert.equal(f.replied, 'yes');
  assert.ok(Number(f.engagement_score) >= 6, 'a reply counts');
  assert.equal(await m.wr.pumpWaReplies('default', later()), 0, 'answered once');
}));

test('Zinhle answers once she has worked with them', () => T(async () => {
  add('z@x', '+27820000002', { manychat_id: '1002' });
  const { listWorkflows } = await import('../src/lib/engine/workflows');
  const { listCustomAgents } = await import('../src/lib/engine/offices');
  const zin = listCustomAgents().find((a) => a.id === 'ag_zinhle')!;
  const wf = listWorkflows().find((w) => w.id === zin.workflowId)!;
  const rec = m.rec.getRecord(L(), 'z@x')!;
  await m.runs.startAgentRun({ workflow: wf, record: { key: rec.key, sourceId: L(), name: rec.name, email: '', phone: rec.phone }, trigger: 'test', force: true });
  say('1002', 'Tell me about the payment plan');
  await m.wr.pumpWaReplies('default', later());
  const reply = m.runs.listAgentRuns({ limit: 50 }).find((r) => r.record.key === 'z@x' && /WhatsApp reply/.test(r.trigger))!;
  assert.equal(reply.agentName, 'Zinhle');
}));

test('found by the only lead with that number; two leads with it, or none: nobody guesses, the team hears', () => T(async () => {
  add('p@x', '+27820000003');
  assert.equal(m.wr.leadFor('1003', '27820000003')?.key, 'p@x');
  add('p2@x', '0820000003');
  assert.equal(m.wr.leadFor('1003', '+27820000003'), null);
  const before = discord.length; const sentBefore = texts.length;
  say('1003', 'Is anyone there?', Date.now(), '+27820000003');
  await m.wr.pumpWaReplies('default', later());
  assert.equal(discord.length, before + 1);
  assert.match(discord.at(-1)!, /could not match them to one lead.*Is anyone there\?/s);
  assert.equal(texts.length, sentBefore);
}));

test('autopilot off, or unsubscribed: no agent answers, the team hears what they said', () => T(async () => {
  add('u@x', '+27820000004', { manychat_id: '1004', opted_out: 'yes' });
  const before = discord.length;
  say('1004', 'Actually, when do you start?');
  await m.wr.pumpWaReplies('default', later());
  assert.match(discord.at(-1)!, /Thandi Mokoena wrote, and no agent may answer/);
  setMode({ autoRunMode: false });
  add('o@x', '+27820000005', { manychat_id: '1005' });
  say('1005', 'Hello?');
  await m.wr.pumpWaReplies('default', later());
  setMode({ autoRunMode: true });
  assert.equal(discord.length, before + 2);
}));

test('an answer still waiting: their next message is kept, not lost, and the team hears after half an hour', () => T(async () => {
  add('w@x', '+27820000006', { manychat_id: '1006' });
  setMode({ requireApproval: true });
  say('1006', 'What does it cost?');
  assert.equal(await m.wr.pumpWaReplies('default', later()), 1);
  await until(() => m.runs.listAgentRuns({ limit: 50 }).some((r) => r.record.key === 'w@x' && r.status === 'awaiting_approval'));
  const before = discord.length; const t = Date.now();
  say('1006', 'Still there?', t);
  assert.equal(await m.wr.pumpWaReplies('default', later()), 0);
  assert.equal(discord.length, before);
  assert.equal(await m.wr.pumpWaReplies('default', t + 31 * 60_000), 0);
  assert.match(discord.at(-1)!, /wrote again while an earlier answer is not finished/);
  setMode({ requireApproval: false });
}));

test('stop, in words: no agent, no score, one confirmation, and an answer waiting for approval never goes', () => T(async () => {
  const { optOutWords } = await import('../src/lib/nurture/waTags');
  for (const s of ['STOP', 'Stop please.', 'opt out', 'OPT-OUT', 'Please don\u2019t message me again', 'stop sending me messages']) assert.equal(optOutWords(s), 'whatsapp', s);
  for (const s of ['Unsubscribe me', 'remove me from your list', 'Do not contact me', 'stop contacting me']) assert.equal(optOutWords(s), 'all', s);
  for (const s of ['When do classes stop?', 'I want to stop working nights and study', 'Can I cancel later?', 'Hi', '', 'Please remove the fee', 'how do I opt out of the payment plan']) assert.equal(optOutWords(s), null, s);

  add('s@x', '+27820000021', { manychat_id: '1021' });
  setMode({ requireApproval: true });
  say('1021', 'What does it cost?');
  await m.wr.pumpWaReplies('default', later());
  const run = () => m.runs.listAgentRuns({ limit: 100 }).find((r) => r.record.key === 's@x')!;
  await until(() => run()?.status === 'awaiting_approval');
  const before = texts.length; const score = m.rec.getRecord(L(), 's@x')!.fields.engagement_score;
  say('1021', 'Opt out please');
  assert.equal(await m.wr.pumpWaReplies('default', later()), 0);
  assert.equal(run().status, 'stopped');
  assert.deepEqual(texts.slice(before).map((x) => x.id), [1021]);
  assert.match(texts.at(-1)!.text, /will not get WhatsApp follow-ups/);
  assert.deepEqual(tags.at(-1), { id: 1021, tag: 'thuso_whatsapp_stop' });
  const f = m.rec.getRecord(L(), 's@x')!.fields;
  assert.equal(f.whatsapp_stopped, 'yes');
  assert.notEqual(f.opted_out, 'yes');
  assert.equal(f.engagement_score, score, 'asking us to stop is not interest');
  setMode({ requireApproval: false });

  add('r@x', '+27820000022', { manychat_id: '1022' });
  say('1022', 'Remove me from your list');
  await m.wr.pumpWaReplies('default', later());
  assert.equal(m.rec.getRecord(L(), 'r@x')!.fields.opted_out, 'yes');
}));

test('the answer goes only within WhatsApp\'s 24 hours, and not at all while sending is paused', () => T(async () => {
  const before = texts.length;
  const now = Date.now();
  assert.equal((await m.wr.answerWhatsApp('1001', now - 25 * 3_600_000, 'Hi')).ok, false);
  process.env.SENDING_PAUSED = 'true';
  assert.match((await m.wr.answerWhatsApp('1001', now, 'Hi')).detail, /kept in the app/);
  process.env.SENDING_PAUSED = 'false';
  assert.equal(texts.length, before);
  assert.equal((await m.wr.answerWhatsApp('1001', now, 'Hi')).ok, true);
  assert.equal(texts.length, before + 1);
}));

test('a reply without an email only touches that lead\'s own runs', () => T(() => {
  add('n1@x', '+27820000011'); add('n2@x', '+27820000012');
  const set: string[] = [];
  m.runs.noteReply('', 'hello', (k) => { set.push(k); }, 'n1@x');
  assert.ok(set.includes('replied'));
  for (const r of m.runs.listAgentRuns({ limit: 100 })) if (r.record.key !== 'n1@x' && !/reply/i.test(r.trigger)) assert.notEqual(r.vars.last_reply, 'hello');
}));
