import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* WhatsApp follow-ups against a fake ManyChat: who is due and who never is,
 * every field filled before anything is sent, sent once (even when ManyChat
 * does not answer), nobody added to ManyChat unless asked, and a problem with
 * the account stops everything instead of trying every lead. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-whatsapp-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SMTP_HOST', 'DISCORD_LEADS_WEBHOOK', 'WHATSAPP_API_URL']) delete process.env[k];
process.env.SENDING_PAUSED = 'false';

const NUDGE = 'content20261123100441_687598';
const VIDEO = 'content20261123100701_419471';
const DAY = 86_400_000;
// A programme on the default list, so it is not matched to another one.
const PROGRAMME = 'Data Analytics with Python & SQL';
// Wednesday 25 November 2026, 11:00 in South Africa.
const NOW = Date.parse('2026-11-25T09:00:00Z');
const iso = (t: number) => new Date(t).toISOString();

type Contact = { id: number; first_name: string; phone?: string; whatsapp_phone?: string; optin_whatsapp?: boolean; last_interaction?: string | null; tags?: { name: string }[]; sa?: string };
let contacts: Contact[] = [];
let flows = [{ ns: NUDGE, name: 'Thuso - Quiz nudge' }, { ns: VIDEO, name: 'Thuso - Programme video' }];
let failField: { status: number; message: string } | null = null;
let flowAnswer: 'ok' | 'timeout' | 'refused' = 'ok';
const set: { id: number; name: string; value: string }[] = [];
const sent: { id: number; ns: string }[] = [];
const created: Record<string, unknown>[] = [];
const realFetch = globalThis.fetch;

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  acc: typeof import('../src/lib/auth/accounts');
  rec: typeof import('../src/lib/data/records');
  src: typeof import('../src/lib/data/sources');
  wa: typeof import('../src/lib/nurture/whatsapp');
  store: typeof import('../src/lib/nurture/store');
  track: typeof import('../src/lib/nurture/track');
};
let m: M;
const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);

before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.host !== 'api.manychat.com') return realFetch(input, init);
    const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
    const bad = (status: number, message: string) => new Response(JSON.stringify({ status: 'error', message }), { status });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    switch (u.pathname) {
      case '/fb/page/getInfo': return ok({ id: 3078391, name: 'Larreth Jimu' });
      case '/fb/page/getFlows': return ok({ flows, folders: [] });
      case '/fb/page/getCustomFields': return ok([{ id: 7, name: 'SA Phone', type: 'text' }, ...['thuso_programme', 'thuso_quiz', 'thuso_video', 'thuso_call'].map((name, i) => ({ id: 20 + i, name, type: 'text' }))]);
      case '/fb/subscriber/findBySystemField': {
        const c = contacts.find((x) => x.phone && x.phone === u.searchParams.get('phone'));
        return c ? ok(c) : bad(400, 'Subscriber not found');
      }
      case '/fb/subscriber/findByCustomField': return ok(contacts.filter((x) => x.sa && x.sa === u.searchParams.get('field_value')));
      case '/fb/subscriber/createSubscriber': { created.push(body); return ok({ id: 900 + created.length, first_name: body.first_name }); }
      case '/fb/subscriber/setCustomFieldByName':
        if (failField) return bad(failField.status, failField.message);
        set.push({ id: body.subscriber_id, name: body.field_name, value: body.field_value });
        return ok(null);
      case '/fb/sending/sendFlow':
        if (flowAnswer === 'refused') return bad(400, 'Subscriber is not available');
        sent.push({ id: body.subscriber_id, ns: body.flow_ns });
        if (flowAnswer === 'timeout') throw new Error('The operation was aborted due to timeout');
        return ok(null);
      default: return bad(404, 'Not found');
    }
  }) as typeof fetch;
  m = {
    ctx: await import('../src/lib/auth/tenantContext'), acc: await import('../src/lib/auth/accounts'), rec: await import('../src/lib/data/records'),
    src: await import('../src/lib/data/sources'), wa: await import('../src/lib/nurture/whatsapp'), store: await import('../src/lib/nurture/store'), track: await import('../src/lib/nurture/track'),
  };
});

let n = 0;
const L = () => m.src.LEADS_SOURCE_ID;
/** A lead who has had an email and is four days old. */
function lead(fields: Record<string, string> = {}, phone = `+2782000${String(1000 + ++n)}`): { key: string; phone: string } {
  const key = `lead${n}@example.com`;
  m.rec.upsertRecord(L(), { key, name: 'Thandi Mokoena', email: key, phone, fields: { interest: PROGRAMME } });
  for (const [k, v] of Object.entries({ nurture_delivered_at: iso(NOW - 2 * DAY), ...fields })) m.rec.setRecordField(L(), key, k, v);
  m.rec.getRecord(L(), key)!.firstSeenAt = NOW - 4 * DAY;
  return { key, phone };
}
const f = (key: string) => m.rec.getRecord(L(), key)!.fields;

beforeEach(() => T(() => {
  for (const r of m.rec.listRecords(L())) m.rec.removeRecords((x) => x.key === r.key);
  contacts = []; set.length = 0; sent.length = 0; created.length = 0; failField = null; flowAnswer = 'ok';
  flows = [{ ns: NUDGE, name: 'Thuso - Quiz nudge' }, { ns: VIDEO, name: 'Thuso - Programme video' }];
  m.acc.updateTenantIntegrations('default', { liveOutreachEnabled: true, manychatApiKey: 'mc_key', whatsappFollowups: { on: true, nudgeFlow: NUDGE, videoFlow: VIDEO, perDay: 20, addContacts: false } });
}));
/** A fresh start for the pump's own memory (day count, pause). */
const unpause = async () => { await m.wa.checkWhatsApp('default'); };

test('who is due, and who never is', () => {
  const at = (fields: Record<string, string>, over: { phone?: string; age?: number; video?: boolean } = {}) =>
    m.wa.whatsappDue({ phone: over.phone ?? '+27821234567', firstSeenAt: NOW - (over.age ?? 4) * DAY, fields: { nurture_delivered_at: iso(NOW - 2 * DAY), ...fields } }, NOW, over.video ?? true);
  assert.equal(at({}).kind, 'nudge', 'three days on, an email delivered, nothing opened');
  assert.equal(at({ nurture_clicks: '1', last_engaged_at: iso(NOW - DAY) }).kind, 'video');
  assert.equal(at({ fit_done: 'yes', last_engaged_at: iso(NOW - DAY) }).kind, 'video');
  for (const [why, r] of Object.entries({
    'two days old': at({}, { age: 2 }), 'too old': at({}, { age: 40 }), 'opened an email': at({ nurture_opens: '1', engagement_score: '1' }),
    'no email reached them': at({ nurture_delivered_at: '' }), 'emailed today': at({ nurture_delivered_at: iso(NOW - 3_600_000) }),
    unsubscribed: at({ opted_out: 'yes' }), 'sent STOP': at({ whatsapp_stopped: 'yes' }), qualified: at({ qualified: 'yes' }), applied: at({ status: 'applied' }),
    'with sales': at({ dialer_left: 'yes' }), replied: at({ replied: 'yes' }), 'old sheet row': at({ imported_quietly: 'yes' }), 'test lead': at({ preview: 'yes' }),
    'no phone': at({}, { phone: '0821' }), 'WhatsApp this week': at({ whatsapp_last_at: iso(NOW - 3 * DAY) }), 'had the nudge': at({ whatsapp_nudge_at: iso(NOW - 9 * DAY) }),
    'watched the video': at({ nurture_clicks: '1', last_engaged_at: iso(NOW - DAY), nurture_seen: 'video:msg_a:video' }),
    'no video for their programme': at({ nurture_clicks: '1', last_engaged_at: iso(NOW - DAY) }, { video: false }),
    'clicked an hour ago': at({ nurture_clicks: '1', last_engaged_at: iso(NOW - 3_600_000) }),
  })) assert.equal(r.kind, null, why);
});

test('daytime only: weekdays 9 to 6, Saturday 9 to 1, never Sunday (South African time)', () => {
  const h = (s: string) => m.wa.whatsappHours(Date.parse(s));
  assert.ok(h('2026-11-25T07:00:00Z'), 'Wednesday 09:00');
  assert.ok(!h('2026-11-25T06:59:00Z'), 'Wednesday 08:59');
  assert.ok(!h('2026-11-25T16:00:00Z'), 'Wednesday 18:00');
  assert.ok(h('2026-11-28T10:59:00Z'), 'Saturday 12:59');
  assert.ok(!h('2026-11-28T11:00:00Z'), 'Saturday 13:00');
  assert.ok(!h('2026-11-29T09:00:00Z'), 'Sunday');
});

test('a due lead gets the nudge once, with all four fields filled first', () => T(async () => {
  await unpause();
  const a = lead();
  contacts = [{ id: 11, first_name: 'Thandi', phone: a.phone }];
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 1);
  assert.deepEqual(sent, [{ id: 11, ns: NUDGE }]);
  assert.deepEqual(set.map((x) => x.name), ['thuso_programme', 'thuso_quiz', 'thuso_video', 'thuso_call']);
  assert.equal(set[0].value, PROGRAMME);
  // The link ending is this lead's own signed link (no address in it).
  const quiz = m.track.readTrack(set[1].value)!;
  assert.deepEqual([quiz.k, quiz.x, quiz.m], [a.key, 'quiz', 'wa_nudge']);
  assert.equal(m.track.readTrack(set[3].value)!.x, 'call');
  assert.ok(f(a.key).whatsapp_nudge_at && f(a.key).whatsapp_last_at);
  assert.equal(await m.wa.pumpWhatsApp('default', NOW + 600_000), 0, 'never twice');
  assert.equal(sent.length, 1);
}));

test('switched off, outside hours, or sending paused: nothing goes', () => T(async () => {
  await unpause();
  const a = lead();
  contacts = [{ id: 11, first_name: 'Thandi', phone: a.phone }];
  assert.equal(await m.wa.pumpWhatsApp('default', Date.parse('2026-11-29T09:00:00Z')), 0, 'Sunday');
  process.env.SENDING_PAUSED = 'true';
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 0);
  process.env.SENDING_PAUSED = 'false';
  m.acc.updateTenantIntegrations('default', { whatsappFollowups: { on: false } });
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 0);
  assert.equal(sent.length, 0);
  assert.equal(m.acc.getTenantIntegrations('default').whatsappFollowups?.nudgeFlow, NUDGE, 'switching off keeps the IDs');
}));

test('STOP, not opted in, or already chatting: left alone; someone not in ManyChat is not added unless asked', () => T(async () => {
  await unpause();
  const stop = lead(); const out = lead(); const chat = lead(); const recent = lead(); const nobody = lead(); const noname = lead();
  contacts = [
    { id: 1, first_name: 'A', phone: stop.phone, tags: [{ name: 'thuso_whatsapp_stop' }] },
    { id: 2, first_name: 'B', phone: out.phone, optin_whatsapp: false },
    { id: 3, first_name: 'C', phone: chat.phone, tags: [{ name: 'WA - replied' }] },
    { id: 4, first_name: 'D', phone: recent.phone, last_interaction: iso(Date.now() - DAY) },
    { id: 6, first_name: '', phone: noname.phone },
  ];
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 0);
  assert.equal(sent.length, 0);
  assert.equal(created.length, 0);
  assert.equal(f(stop.key).whatsapp_stopped, 'yes');
  assert.equal(f(nobody.key).whatsapp_nudge_at, undefined);
  // Asked to add them: as a WhatsApp contact, never as agreeing to SMS.
  m.acc.updateTenantIntegrations('default', { whatsappFollowups: { addContacts: true } });
  m.rec.setRecordField(L(), nobody.key, 'whatsapp_retry_at', '');
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 1);
  assert.deepEqual(created, [{ first_name: 'Thandi', last_name: 'Mokoena', whatsapp_phone: nobody.phone, phone: nobody.phone, has_opt_in_sms: false, has_opt_in_email: false }]);
}));

test('a contact ManyChat made from a WhatsApp chat is found by "SA Phone"; a different number is never used', () => T(async () => {
  await unpause();
  const a = lead();
  contacts = [{ id: 21, first_name: 'Thandi', whatsapp_phone: a.phone, sa: a.phone.replace(/^\+27/, '0') }];
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 1);
  const b = lead();
  contacts = [{ id: 22, first_name: 'Someone', whatsapp_phone: '+27839999999', sa: b.phone }];
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 0, 'the field says one number, their WhatsApp is another');
  assert.deepEqual(sent.map((x) => x.id), [21]);
}));

test('no answer from ManyChat: it may have gone, so it is never sent again', () => T(async () => {
  await unpause();
  const a = lead();
  contacts = [{ id: 31, first_name: 'Thandi', phone: a.phone }];
  flowAnswer = 'timeout';
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 1);
  flowAnswer = 'ok';
  assert.equal(await m.wa.pumpWhatsApp('default', NOW + 600_000), 0);
  assert.equal(sent.length, 1);
  assert.match(f(a.key).whatsapp_result, /unknown/);
}));

test('refused for one lead: not marked as sent, tried again later; three in a row pauses for a day', () => T(async () => {
  await unpause();
  const leads = [lead(), lead(), lead(), lead()];
  contacts = leads.map((x, i) => ({ id: 40 + i, first_name: 'Thandi', phone: x.phone }));
  flowAnswer = 'refused';
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 0);
  assert.equal(f(leads[0].key).whatsapp_nudge_at, '');
  assert.ok(f(leads[0].key).whatsapp_retry_at);
  assert.equal(f(leads[3].key).whatsapp_result, undefined, 'the fourth was not tried');
  assert.ok(m.wa.previewWhatsApp('default', NOW).pausedUntil > NOW + 23 * 3_600_000);
}));

test('a missing field or a bad key stops everything before anything is sent, and marks no lead', () => T(async () => {
  await unpause();
  const a = lead(); const b = lead();
  contacts = [{ id: 51, first_name: 'Thandi', phone: a.phone }, { id: 52, first_name: 'Thandi', phone: b.phone }];
  failField = { status: 400, message: 'Custom field not found' };
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 0);
  assert.equal(sent.length, 0);
  for (const x of [a, b]) assert.ok(!f(x.key).whatsapp_nudge_at && !f(x.key).whatsapp_retry_at);
  failField = null;
  assert.equal(await m.wa.pumpWhatsApp('default', NOW + 600_000), 0, 'paused for an hour');
  // Put right and checked: it carries on.
  assert.equal((await m.wa.checkWhatsApp('default')).ok, true);
  assert.equal(await m.wa.pumpWhatsApp('default', NOW + 600_000), 2);
}));

test('the day\'s limit holds; people who clicked go first', () => T(async () => {
  await unpause();
  m.acc.updateTenantIntegrations('default', { whatsappFollowups: { perDay: 2 } });
  m.store.meta().videos = [{ id: 'v1', programme: PROGRAMME, title: PROGRAMME, slides: [], tutorName: 'Naledi', viaAi: false, createdAt: 0, views: 0 }];
  const a = lead(); const b = lead(); const c = lead({ nurture_clicks: '1', last_engaged_at: iso(NOW - DAY) });
  contacts = [a, b, c].map((x, i) => ({ id: 60 + i, first_name: 'Thandi', phone: x.phone }));
  const day = NOW + DAY; // a new day for the count
  for (const x of [a, b, c]) m.rec.setRecordField(L(), x.key, 'nurture_delivered_at', iso(NOW - 2 * DAY));
  assert.equal(await m.wa.pumpWhatsApp('default', day), 2);
  assert.deepEqual(sent.map((x) => x.ns), [VIDEO, NUDGE]);
  assert.equal(await m.wa.pumpWhatsApp('default', day + 600_000), 0);
}));

test('the check says which account, and what is missing', () => T(async () => {
  const good = await m.wa.checkWhatsApp('default');
  assert.equal(good.ok, true);
  assert.match(good.detail, /Larreth Jimu \(3078391\) has both automations/);
  flows = [];
  const other = await m.wa.checkWhatsApp('default');
  assert.equal(other.ok, false);
  assert.match(other.detail, /no automation content20261123100441_687598/);
}));

test('a test goes to one number with links for a hidden test lead, even while switched off', () => T(async () => {
  m.acc.updateTenantIntegrations('default', { whatsappFollowups: { on: false } });
  m.rec.upsertRecord(L(), { key: 'preview:u1', name: 'Nigel', email: '', phone: '', fields: { preview: 'yes', interest: PROGRAMME } });
  contacts = [{ id: 71, first_name: 'Nigel', phone: '+27820000071' }];
  const p = { sourceId: L(), key: 'preview:u1' };
  assert.equal((await m.wa.testWhatsApp('video', '+27820000071', p, 'default')).ok, true);
  assert.deepEqual(sent, [{ id: 71, ns: VIDEO }]);
  assert.equal(m.track.readTrack(set[2].value)!.k, 'preview:u1');
  assert.equal((await m.wa.testWhatsApp('nudge', '0820000071', p, 'default')).ok, false, 'needs the country code');
  const real = lead();
  assert.equal((await m.wa.testWhatsApp('nudge', '+27820000071', { sourceId: L(), key: real.key }, 'default')).ok, false, 'never a real lead\'s links');
}));

test('an email waits a day after a WhatsApp', async () => {
  const { nextEmailAllowedAt } = await import('../src/lib/engine/agentRuns');
  assert.equal(nextEmailAllowedAt({ whatsapp_last_at: iso(NOW - 3_600_000) }, 'new row', NOW, 24), NOW + 23 * 3_600_000);
});
