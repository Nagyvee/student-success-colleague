import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Leads read from the dialer (the people it holds for Thuso), against a fake
 * dialer API: one record per person with every column of their sheet row,
 * someone the team takes over in the dialer stops being nurtured, and
 * qualifying a lead releases it in the dialer (it becomes a new lead there). */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-dialer-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SENDING_PAUSED', 'DISCORD_LEADS_WEBHOOK']) delete process.env[k];
process.env.DIALER_URL = 'https://dialer.example.test';
process.env.DIALER_API_KEY = 'zad_test';

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  src: typeof import('../src/lib/data/sources');
  rec: typeof import('../src/lib/data/records');
  q: typeof import('../src/lib/nurture/qualify');
};
let m: M;
const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);

const queue: Record<string, unknown>[] = [];
const released: { id: string; body: Record<string, unknown> }[] = [];
const discordPosts: Record<string, unknown>[] = [];
// The dialer's hand-over API (off until a test turns it on: the earlier tests use the older calls).
let handoffApi = false;
const handoffs: Record<string, unknown>[] = [];
const pipeline: Record<string, unknown>[] = [];
const realFetch = globalThis.fetch;

const row = (id: string, cells: Record<string, string>, extra: Record<string, string> = {}) => ({
  id, source: 'Meta ads', tab: 'Meta B2C v4', name: extra.name || cells.full_name || '', phone: extra.phone || '', email: extra.email || cells.email || '', cells,
});

before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.host === 'discord.com') {
      discordPosts.push(JSON.parse(String(init?.body || '{}')));
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.host !== 'dialer.example.test') return realFetch(input, init);
    if (u.pathname === '/api/v1/nurture') {
      return new Response(JSON.stringify({ ok: true, rows: queue, total: queue.length, page: 1, per: 500 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (handoffApi && u.pathname === '/api/v1/handoff' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      handoffs.push(body);
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
      // In New with Larreth, who takes no Thuso leads: given to Thabile.
      if (body.name === 'Vuyo Memani') return json({ ok: true, outcome: 'reassigned', lead_id: '22222222-2222-4222-8222-222222222222', stage: 'New Lead', was_owner: 'Larreth Jimu', assigned_to: { id: 'ag-1', name: 'Thabile Mhlanga', discord_id: '123456789012345678' } });
      // Being worked by Siphumezo already: nothing changes.
      if (body.name === 'Kept Lead') return json({ ok: true, outcome: 'kept', lead_id: '33333333-3333-4333-8333-333333333333', stage: 'Contacted on WhatsApp', assigned_to: { id: 'ag-2', name: 'Siphumezo Vuke', discord_id: '223456789012345678' } });
      return new Response(JSON.stringify({ ok: true, outcome: 'reset', lead_id: '11111111-1111-4111-8111-111111111111', stage: 'New Lead', was: 'Voicemail',
        assigned_to: { id: 'ag-2', name: 'Siphumezo Vuke', discord_id: '223456789012345678' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (handoffApi && u.pathname === '/api/v1/handoff/status' && init?.method === 'POST') {
      const ids = (JSON.parse(String(init.body || '{}')).ids || []) as string[];
      return new Response(JSON.stringify({ ok: true, leads: pipeline.filter((p) => ids.includes(String(p.id))) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const rel = /^\/api\/v1\/nurture\/([^/]+)\/release$/.exec(u.pathname);
    if (rel && init?.method === 'POST') {
      released.push({ id: decodeURIComponent(rel[1]), body: JSON.parse(String(init.body || '{}')) });
      return new Response(JSON.stringify({ ok: true, outcome: 'created', lead: { id: 'lead-1', status: 'new' }, assigned_to: { id: 'ag-1', name: 'Thabile Mhlanga', discord_id: '123456789012345678' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  m = {
    ctx: await import('../src/lib/auth/tenantContext'),
    src: await import('../src/lib/data/sources'),
    rec: await import('../src/lib/data/records'),
    q: await import('../src/lib/nurture/qualify'),
  };
});

test('leads read from the dialer: everyone it holds for Thuso, with their columns; taken over there, nurturing stops', () => T(async () => {
  queue.push(
    row('r1', { full_name: 'Thandi Mokoena', email: 'Thandi@Example.com', phone_number: '0821234567', platform: 'ig', how_will_you_finance_the_program: 'i_will_fund_my_self', which_programme_are_you_interested_in: 'data_science' }, { phone: '+27821234567' }),
    row('r2', { full_name: 'Sizwe Ndlovu', email: 'sizwe@example.com', phone_number: '0831234567', platform: 'fb' }, { phone: '+27831234567' }),
  );
  // Before: the old sheet list, where Thuso was already nurturing one person.
  m.src.saveSource({ id: m.src.LEADS_SOURCE_ID, name: 'Leads from ads & forms', kind: 'leads', url: '' });
  m.rec.upsertRecord(m.src.LEADS_SOURCE_ID, { key: 'kept@example.com', name: 'Being Nurtured', email: 'kept@example.com', phone: '+27820000009', fields: { nurture_count: '1' } });
  m.rec.upsertRecord(m.src.LEADS_SOURCE_ID, { key: 'old@example.com', name: 'Old Sheet Row', email: 'old@example.com', phone: '+27820000008', fields: { imported_quietly: 'yes' } });
  m.src.saveSource({ id: m.src.LEADS_SOURCE_ID, name: 'Leads from ads & forms', kind: 'leads', provider: 'dialer', url: '' });
  assert.ok(m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'kept@example.com'), 'someone Thuso is nurturing stays (their journey carries on)');
  assert.equal(m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'old@example.com'), null, 'an old sheet row Thuso never contacted goes');
  const events = await m.src.readSource(m.src.getSource(m.src.LEADS_SOURCE_ID)!);
  assert.deepEqual(events.map((e) => [e.kind, e.record.email]), [['added', 'thandi@example.com'], ['added', 'sizwe@example.com']], 'everyone the dialer holds is new to nurture (no quiet baseline)');
  const thandi = m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'thandi@example.com')!;
  assert.equal(thandi.name, 'Thandi Mokoena');
  assert.equal(thandi.phone, '+27821234567');
  assert.equal(thandi.fields.dialer_row_id, 'r1');
  assert.equal(thandi.fields.how_will_you_finance_the_program, 'i_will_fund_my_self', 'every column of the sheet row is there');
  assert.equal(m.q.leadChannel(thandi.fields), 'Instagram ads');

  // The team took Sizwe over in the dialer: he is no longer in the queue.
  queue.splice(1, 1);
  const again = await m.src.readSource(m.src.getSource(m.src.LEADS_SOURCE_ID)!);
  assert.deepEqual(again, [], 'nothing new');
  const sizwe = m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'sizwe@example.com')!;
  assert.equal(sizwe.fields.dialer_left, 'yes');
  assert.equal(sizwe.fields.status, 'with sales');
  assert.equal(m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'thandi@example.com')!.fields.dialer_left, undefined);
}));

test('switching to the dialer emails nobody old: rows it held for days come in quietly, cleared ones stay out, the team\'s moves start', () => T(async () => {
  const L = m.src.LEADS_SOURCE_ID;
  const { markCleared } = await import('../src/lib/data/cleared');
  const before = queue.slice();
  const switched = m.src.getSource(L)!.since!;
  assert.ok(Date.now() - switched < 60_000, 'the switch is remembered');
  const at = (days: number) => new Date(switched - days * 86_400_000).toISOString();
  markCleared(L, [{ key: 'cleared@example.com', fields: { id: 'l:555' } }, { key: 'moved@example.com', fields: { id: 'l:556' } }]);
  queue.push(
    { ...row('o1', { full_name: 'Old Row', email: 'oldrow@example.com', id: 'l:1' }), kind: 'sheet_row', first_seen_at: at(6) },
    { ...row('n1', { full_name: 'New Row', email: 'newrow@example.com', id: 'l:2' }), kind: 'sheet_row', first_seen_at: at(0.1) },
    { ...row('c1', { full_name: 'Cleared Row', email: 'cleared@example.com', id: 'l:555' }), kind: 'sheet_row', first_seen_at: at(6) },
    { id: 'lead-9', kind: 'lead', source: 'Meta ads', tab: 'Nurturing (Thuso) DNC', name: 'Moved Person', phone: '+27835550000', email: 'moved@example.com', cells: null, values: { name: 'Moved Person' }, first_seen_at: at(40) },
  );
  const events = await m.src.readSource(m.src.getSource(L)!);
  assert.deepEqual(events.map((e) => e.record.email).sort(), ['moved@example.com', 'newrow@example.com']);
  assert.equal(m.rec.getRecord(L, 'oldrow@example.com')!.fields.imported_quietly, 'yes');
  assert.equal(m.rec.getRecord(L, 'cleared@example.com'), null, 'cleared from the sheet, the same row in the dialer stays out');
  queue.splice(0, queue.length, ...before);
  m.rec.removeRecords((r) => /^(oldrow|newrow|moved)@/.test(r.key));
}));

test('qualifying a lead the dialer holds releases it there, with the brief; whoever has it is tagged in Discord', () => T(async () => {
  const { updateTenantIntegrations } = await import('../src/lib/auth/accounts');
  updateTenantIntegrations('default', { liveOutreachEnabled: true, handoff: { dialerOn: true, discordWebhook: 'https://discord.com/api/webhooks/1/abc' } });
  process.env.SENDING_PAUSED = 'false';
  const r = await m.q.qualifyLead(m.src.LEADS_SOURCE_ID, 'thandi@example.com', { reason: 'call', bestTime: 'This afternoon' });
  process.env.SENDING_PAUSED = 'true';
  assert.ok(r?.qualified);
  assert.equal(released.length, 1);
  assert.equal(released[0].id, 'r1');
  assert.match(String(released[0].body.notes), /Thandi Mokoena asked us to call them/);
  assert.match(String(released[0].body.notes), /Source: Instagram ads/);
  assert.equal(r?.dialer, 'moved to New in the dialer');
  // The dialer gave Thandi to Thabile: the card tags her (a ping only for her) and says so.
  assert.equal(m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'thandi@example.com')!.fields.dialer_assigned_to, 'Thabile Mhlanga');
  const card = discordPosts.at(-1) as { content: string; allowed_mentions: { users?: string[]; parse: string[] }; embeds: { description: string }[] };
  assert.match(card.content, /<@123456789012345678>, this one is yours/);
  assert.deepEqual(card.allowed_mentions, { parse: [], users: ['123456789012345678'] });
  assert.match(card.embeds[0].description, /assigned to Thabile Mhlanga\. Thabile, call now/);
}));

test('a Discord ID pings; a username is only shown', () => {
  assert.equal(m.q.discordUserId('<@!123456789012345678>'), '123456789012345678');
  assert.equal(m.q.discordUserId('thabile.m'), null);
});

test('someone the team moves back to a nurturing stage in the dialer starts again with Thuso', () => T(async () => {
  // Sizwe left (the team took him over); now a consultant moved his lead to "Nurturing (Thuso)".
  // A lead (not a sheet row) comes with its fields instead of sheet columns.
  queue.push({ id: 'lead-77', kind: 'lead', source: 'Facebook ads', tab: 'Nurturing (Thuso) DNC', name: 'Sizwe Ndlovu', phone: '+27831234567', email: 'sizwe@example.com', cells: null,
    values: { name: 'Sizwe Ndlovu', phone: '+27831234567', email: 'sizwe@example.com', interest: 'Cybersecurity', notes: 'Wants to start in February' } });
  // And someone new, moved there straight from the pipeline.
  queue.push({ id: 'lead-78', kind: 'lead', source: 'Website', tab: 'Nurturing (Thuso) DNC', name: 'Lerato Dube', phone: '+27841234567', email: 'lerato@example.com', cells: null,
    values: { name: 'Lerato Dube', phone: '+27841234567', email: 'lerato@example.com', interest: 'Data Science' } });
  const events = await m.src.readSource(m.src.getSource(m.src.LEADS_SOURCE_ID)!);
  assert.deepEqual(events.map((e) => [e.kind, e.record.email]).sort(), [['added', 'lerato@example.com'], ['added', 'sizwe@example.com']]);
  const sizwe = m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'sizwe@example.com')!;
  assert.equal(sizwe.fields.dialer_left, '');
  assert.equal(sizwe.fields.status, 'new');
  assert.equal(sizwe.fields.dialer_row_id, 'lead-77');
  const lerato = m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'lerato@example.com')!;
  assert.equal(lerato.name, 'Lerato Dube');
  assert.equal(lerato.fields.interest, 'Data Science');
  // Read again: nothing new, nobody restarted twice.
  assert.deepEqual(await m.src.readSource(m.src.getSource(m.src.LEADS_SOURCE_ID)!), []);
  // Thandi was qualified a moment ago and is still listed (a read can overlap her release): she stays qualified.
  assert.equal(m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'thandi@example.com')!.fields.qualified, 'yes');
  // Hours later she is listed again: the team moved her back to nurturing, so Thuso starts again.
  m.rec.setRecordField(m.src.LEADS_SOURCE_ID, 'thandi@example.com', 'qualified_at', new Date(Date.now() - 2 * 3600_000).toISOString());
  const back = await m.src.readSource(m.src.getSource(m.src.LEADS_SOURCE_ID)!);
  assert.deepEqual(back.map((e) => [e.kind, e.record.email]), [['added', 'thandi@example.com']]);
  const thandi = m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'thandi@example.com')!.fields;
  assert.equal(thandi.qualified, '');
  assert.equal(thandi.engagement_score, '0');
  assert.equal(thandi.dialer_assigned_to, '');
}));

test('every qualified lead ends up in the dialer: one qualified before the hand-over goes back to New there, and the team hears who has it', () => T(async () => {
  const { catchUpQualified } = await import('../src/lib/nurture/pipeline');
  handoffApi = true;
  // Like Rhass: qualified yesterday, already a lead in the dialer (with someone, in voicemail); only the brief was added.
  m.rec.upsertRecord(m.src.LEADS_SOURCE_ID, { key: 'rhass@example.com', name: 'Rhass Bagani', email: 'rhass@example.com', phone: '+27721884622', fields: { platform: 'ig' } });
  for (const [k, v] of Object.entries({ qualified: 'yes', qualified_reason: 'ready', qualified_at: '2026-11-19T14:03:00.000Z', dialer_status: 'already in the dialer: brief added', lead_brief_sales: 'Thuso qualified: Rhass Bagani replied that they want to sign up. Call immediately.' })) {
    m.rec.setRecordField(m.src.LEADS_SOURCE_ID, 'rhass@example.com', k, v);
  }
  process.env.SENDING_PAUSED = 'false';
  const before = discordPosts.length;
  const done = await catchUpQualified('default');
  process.env.SENDING_PAUSED = 'true';
  assert.deepEqual(done.map((d) => d.name), ['Rhass Bagani'], 'only the lead not handed over yet');
  const sent = handoffs.at(-1)!;
  assert.equal(sent.phone, '+27721884622');
  assert.equal(sent.qualified_at, '2026-11-19T14:03:00.000Z', 'the dialer only keeps an owner given the lead after this');
  assert.match(String(sent.notes), /^Thuso qualified: Rhass Bagani replied/);
  const f = m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'rhass@example.com')!.fields;
  assert.equal(f.dialer_status, 'moved back to New in the dialer (was in Voicemail)');
  assert.equal(f.dialer_assigned_to, 'Siphumezo Vuke');
  assert.equal(f.dialer_in, 'yes');
  assert.equal(f.dialer_lead_id, '11111111-1111-4111-8111-111111111111');
  // One Discord message for the team, pinging whoever has each lead.
  assert.equal(discordPosts.length, before + 1);
  const post = discordPosts.at(-1) as { content: string; allowed_mentions: { users: string[] } };
  assert.match(post.content, /Qualified leads: who has them now/);
  assert.match(post.content, /Rhass Bagani\*\* → <@223456789012345678>/);
  assert.deepEqual(post.allowed_mentions.users, ['223456789012345678']);
  // Next time: nothing to do.
  process.env.SENDING_PAUSED = 'false';
  assert.deepEqual(await catchUpQualified('default'), []);
  process.env.SENDING_PAUSED = 'true';
}));

test('applied and enrolled come back from the dialer; never backwards', () => T(async () => {
  const { readPipeline } = await import('../src/lib/nurture/pipeline');
  handoffApi = true;
  pipeline.push({ id: '11111111-1111-4111-8111-111111111111', stage: 'Registration page', status: 'applied', assigned_to: { id: 'ag-2', name: 'Siphumezo Vuke' } });
  assert.equal(await readPipeline('default'), 1);
  let f = m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'rhass@example.com')!.fields;
  assert.equal(f.status, 'applied');
  assert.ok(f.applied_at);
  assert.equal(f.dialer_stage, 'Registration page');
  // Moved back a stage in the dialer: still applied here.
  pipeline[0] = { ...pipeline[0], stage: 'Documents requested', status: 'with_sales' };
  assert.equal(await readPipeline('default'), 0);
  f = m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'rhass@example.com')!.fields;
  assert.equal(f.status, 'applied');
  assert.equal(f.dialer_stage, 'Documents requested');
  // Won: enrolled.
  pipeline[0] = { ...pipeline[0], stage: 'Enrolled', status: 'enrolled' };
  assert.equal(await readPipeline('default'), 1);
  assert.equal(m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'rhass@example.com')!.fields.status, 'enrolled');
}));

test('a qualified lead given to someone who takes no Thuso leads goes to someone who does; the team hears only about changes', () => T(async () => {
  const { catchUpQualified } = await import('../src/lib/nurture/pipeline');
  handoffApi = true;
  const add = (key: string, name: string, fields: Record<string, string>) => {
    m.rec.upsertRecord(m.src.LEADS_SOURCE_ID, { key, name, email: key, phone: '+27620790261', fields: { platform: 'fb' } });
    for (const [k, v] of Object.entries(fields)) m.rec.setRecordField(m.src.LEADS_SOURCE_ID, key, k, v);
  };
  // Handed over before the rule (marker "yes"): Vuyo went to Larreth; the other is with Siphumezo already.
  add('vuyo@example.com', 'Vuyo Memani', { qualified: 'yes', qualified_reason: 'hot', qualified_at: new Date().toISOString(), dialer_handed_over: 'yes', dialer_assigned_to: 'Larreth Jimu', dialer_status: 'moved to New in the dialer' });
  add('kept@example.org', 'Kept Lead', { qualified: 'yes', qualified_reason: 'call', qualified_at: new Date().toISOString(), dialer_handed_over: 'yes', dialer_assigned_to: 'Siphumezo Vuke', dialer_status: 'moved to New in the dialer' });
  process.env.SENDING_PAUSED = 'false';
  const before = discordPosts.length;
  const done = await catchUpQualified('default');
  process.env.SENDING_PAUSED = 'true';
  assert.deepEqual(done.map((d) => [d.name, d.changed]).sort(), [['Kept Lead', false], ['Vuyo Memani', true]]);
  const vuyo = m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'vuyo@example.com')!.fields;
  assert.equal(vuyo.dialer_assigned_to, 'Thabile Mhlanga');
  assert.equal(vuyo.dialer_status, 'moved to Thabile Mhlanga in the dialer (New Lead)');
  assert.equal(vuyo.dialer_handed_over, '2');
  // One message, about Vuyo only.
  assert.equal(discordPosts.length, before + 1);
  const post = discordPosts.at(-1) as { content: string; allowed_mentions: { users: string[] } };
  assert.match(post.content, /Vuyo Memani\*\* → <@123456789012345678> \(was Larreth Jimu\) · New Lead/);
  assert.doesNotMatch(post.content, /Kept Lead/);
  assert.deepEqual(post.allowed_mentions.users, ['123456789012345678']);
}));
