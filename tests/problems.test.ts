import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* What is broken is said, and never hidden behind a "sent": the WhatsApp
 * account refusing, a channel switched off, ManyChat not answering; the red
 * boxes at the top of the daily report, the Discord alert when it is on, and
 * the reasons made safe for the whole team. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-problems-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SMTP_HOST', 'WHATSAPP_API_URL']) delete process.env[k];
process.env.SENDING_PAUSED = 'false';
process.env.DISCORD_LEADS_WEBHOOK = 'https://discord.com/api/webhooks/123/abc';

const H = 3_600_000;
const DAY = 24 * H;
// Wednesday 25 November 2026, 11:00 in South Africa.
const NOW = Date.parse('2026-11-25T09:00:00Z');
const iso = (t: number) => new Date(t).toISOString();

type Answer = { status: number; message: string } | null;
let account: Answer = null; // getInfo
let finds: Answer = null;
let sending: Answer = null;
const sent: number[] = [];
let sendTries = 0;
const posts: { content?: string; embeds: { title: string; description: string; color: number; fields?: { name: string; value: string }[] }[] }[] = [];
let discordUp = true;

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  acc: typeof import('../src/lib/auth/accounts');
  rec: typeof import('../src/lib/data/records');
  src: typeof import('../src/lib/data/sources');
  wa: typeof import('../src/lib/nurture/whatsapp');
  pr: typeof import('../src/lib/engine/problems');
  rep: typeof import('../src/lib/nurture/report');
  al: typeof import('../src/lib/nurture/alerts');
  mc: typeof import('../src/lib/messaging/manychat');
};
let m: M;
const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);

before(async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.host === 'discord.com') {
      if (!discordUp) return new Response('{}', { status: 500 });
      posts.push(JSON.parse(String(init?.body || '{}')));
      return new Response('{}', { status: 200 });
    }
    if (u.host !== 'api.manychat.com') return realFetch(input, init);
    const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
    const or = (a: Answer, data: unknown) => (a ? new Response(JSON.stringify({ status: 'error', message: a.message }), { status: a.status }) : ok(data));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    switch (u.pathname) {
      case '/fb/page/getInfo': return or(account, { id: 1, name: 'Melsoft' });
      case '/fb/page/getFlows': return ok({ flows: [{ ns: 'n', name: 'Nudge' }, { ns: 'v', name: 'Video' }] });
      case '/fb/page/getCustomFields': return or(account, ['thuso_programme', 'thuso_quiz', 'thuso_video', 'thuso_call'].map((name, i) => ({ id: i + 1, name, type: 'text' })));
      case '/fb/subscriber/findBySystemField': {
        const phone = u.searchParams.get('phone') || '';
        return or(finds, phone ? { id: Number(phone.slice(-4)), first_name: 'Thandi', phone } : []);
      }
      case '/fb/sending/sendFlow':
        sendTries++;
        if (!sending) sent.push(body.subscriber_id);
        return or(sending, null);
      default: return ok(null);
    }
  }) as typeof fetch;
  m = {
    ctx: await import('../src/lib/auth/tenantContext'), acc: await import('../src/lib/auth/accounts'), rec: await import('../src/lib/data/records'), src: await import('../src/lib/data/sources'),
    wa: await import('../src/lib/nurture/whatsapp'), pr: await import('../src/lib/engine/problems'), rep: await import('../src/lib/nurture/report'), al: await import('../src/lib/nurture/alerts'),
    mc: await import('../src/lib/messaging/manychat'),
  };
});

let n = 0;
const L = () => m.src.LEADS_SOURCE_ID;
function lead(name = 'Thandi Mokoena', fields: Record<string, string> = {}): string {
  const key = `lead${++n}@example.com`;
  m.rec.upsertRecord(L(), { key, name, email: key, phone: `+2782000${1000 + n}`, fields: {} });
  for (const [k, v] of Object.entries({ nurture_delivered_at: iso(NOW - 2 * DAY), ...fields })) m.rec.setRecordField(L(), key, k, v);
  m.rec.getRecord(L(), key)!.firstSeenAt = NOW - 4 * DAY;
  return key;
}
const f = (key: string) => m.rec.getRecord(L(), key)!.fields;
const report = (from = NOW - DAY, to = NOW + 2 * H) => m.rep.buildNurtureReport(from, to, null);
const box = (r: ReturnType<typeof report>, name: RegExp) => r.fields.find((x) => name.test(x.name))?.value || '';

beforeEach(() => T(async () => {
  m.rec.removeRecords(() => true);
  account = null; finds = null; sending = null; sent.length = 0; sendTries = 0; posts.length = 0; discordUp = true;
  m.acc.updateTenantIntegrations('default', { liveOutreachEnabled: true, manychatApiKey: 'mc_key', whatsappFollowups: { on: true, nudgeFlow: 'n', videoFlow: 'v', perDay: 20 }, handoff: { reportOn: true, alertsOn: false } });
  await m.wa.checkWhatsApp('default');
  for (const k of Object.keys(m.pr.KINDS) as (keyof typeof m.pr.KINDS)[]) m.pr.dropProblem(k);
}));

test('ManyChat refusing the account: no lead is tried or put off, and the report says it in red', () => T(async () => {
  const a = lead('Thandi Mokoena'); const b = lead('Sizwe Ndlovu');
  // Before, every lead looked like "not in ManyChat" and was put off for a week, with nothing said.
  account = { status: 403, message: 'Your subscription payment failed' };
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 0);
  assert.equal(sendTries, 0);
  for (const k of [a, b]) assert.ok(!f(k).whatsapp_retry_at && !f(k).whatsapp_nudge_at);
  const r = report();
  assert.match(r.title, /^🚨/);
  assert.deepEqual(r.critical, ['WhatsApp follow-ups are not going out']);
  const c = box(r, /CRITICAL: WhatsApp follow-ups/);
  assert.match(c, /Since \*\*.*11:00\*\*/);
  assert.match(c, /Why: Your subscription payment failed\./);
  assert.match(c, /2 leads are waiting for one/);
  assert.match(c, /What to do: In ManyChat, check the subscription and billing/);
  assert.equal(r.fields[0].tone, 'bad', 'it comes first');
  assert.match(box(report(NOW - DAY, NOW + H / 2), /WhatsApp follow-ups$/), /\*\*0\*\* taken by ManyChat\nPaused until .*12:00/);
}));

test('a channel that is switched off is the account, not the lead; it works again and the report says from when to when', () => T(async () => {
  const a = lead('Thandi Mokoena'); lead('Sizwe Ndlovu');
  sending = { status: 400, message: 'Channel is disabled' };
  assert.equal(await m.wa.pumpWhatsApp('default', NOW), 0);
  assert.equal(sendTries, 1, 'stopped at the first');
  assert.ok(!f(a).whatsapp_retry_at, 'the lead is not put off for it');
  let r = report();
  assert.match(box(r, /CRITICAL/), /Why: Channel is disabled\.\nCould not be sent to: Thandi Mokoena\./);
  assert.match(box(r, /WhatsApp follow-ups$/), /\*\*1\*\* failed/);
  // The same lead again: perhaps it is them, so someone else is next.
  assert.equal(await m.wa.pumpWhatsApp('default', NOW + 70 * 60_000), 0);
  assert.ok(f(a).whatsapp_retry_at);
  sending = null;
  assert.equal(await m.wa.pumpWhatsApp('default', NOW + 3 * H), 1);
  r = report(NOW - DAY, NOW + 4 * H);
  assert.equal(r.critical, undefined);
  assert.match(r.title, /^📊/);
  assert.match(box(r, /Worth a look/), /WhatsApp follow-ups stopped from .*11:00 to .*14:00\. Working again\. \(Channel is disabled\)/);
}));

test('ManyChat not answering is not "sent": three in a row stops it, and they are shown as not confirmed', () => T(async () => {
  for (let i = 0; i < 6; i++) lead(`Person ${i}`);
  sending = { status: 502, message: 'Bad gateway' };
  await m.wa.pumpWhatsApp('default', NOW);
  assert.equal(sendTries, 3, 'it does not use up everyone\'s only message');
  const r = report();
  assert.match(box(r, /CRITICAL/), /did not confirm the last 3: Bad gateway/);
  assert.match(box(r, /WhatsApp follow-ups$/), /\*\*0\*\* taken by ManyChat\n\*\*3\*\* not confirmed/);
  assert.equal(await m.wa.pumpWhatsApp('default', NOW + 600_000), 0, 'paused');
}));

test('one blip is not an alarm; one lead refused is worth a look, not critical', () => T(async () => {
  lead('Thandi Mokoena'); lead('Sizwe Ndlovu');
  account = { status: 503, message: 'Service unavailable' };
  await m.wa.pumpWhatsApp('default', NOW);
  assert.equal(report().critical, undefined, 'it may pass');
  account = null;
  sending = { status: 400, message: 'Subscriber is not available' };
  await m.wa.pumpWhatsApp('default', NOW + 70 * 60_000);
  const r = report();
  assert.equal(r.critical, undefined);
  assert.match(box(r, /Worth a look/), /WhatsApp could not be sent to Thandi Mokoena, Sizwe Ndlovu: Subscriber is not available\./);
}));

test('the account is watched even when nobody is due, and switched off is not broken', () => T(async () => {
  account = { status: 401, message: 'Wrong token' };
  await m.wa.watchWhatsApp('default', NOW);
  assert.deepEqual(report().critical, ['Thuso cannot use the ManyChat account']);
  m.acc.updateTenantIntegrations('default', { whatsappFollowups: { on: false } });
  await m.wa.watchWhatsApp('default', NOW);
  assert.equal(report().critical, undefined);
}));

test('paused before this was kept: it is still said', () => T(async () => {
  lead();
  account = { status: 403, message: 'Plan expired' };
  await m.wa.pumpWhatsApp('default', NOW);
  m.pr.dropProblem('whatsapp');
  await m.wa.pumpWhatsApp('default', NOW + 600_000);
  assert.match(box(report(), /CRITICAL/), /Plan expired/);
}));

test('nobody tapping any of the last 20 WhatsApps is worth a look: ManyChat never says one did not arrive', () => T(() => {
  for (let i = 0; i < 20; i++) lead(`P${i}`, { whatsapp_nudge_at: iso(NOW - 3 * DAY) });
  assert.match(box(report(), /Worth a look/), /Nobody tapped or answered any of the last 20 WhatsApps/);
  lead('Alive', { whatsapp_nudge_at: iso(NOW - 3 * DAY), nurture_seen: 'click:wa_nudge:quiz' });
  assert.doesNotMatch(box(report(), /Worth a look/), /Nobody tapped/);
}));

test('a qualified lead the dialer did not take is critical, with their number', () => T(() => {
  lead('Lerato Dube', { qualified: 'yes', qualified_at: iso(NOW - H), qualified_reason: 'call', dialer_status: 'failed: HTTP 500' });
  lead('Put Right', { qualified: 'yes', qualified_at: iso(NOW - H), qualified_reason: 'call', dialer_status: 'moved to New in the dialer', dialer_in: 'yes' });
  const r = report();
  assert.deepEqual(r.critical, ['1 qualified lead not in the dialer']);
  assert.match(box(r, /CRITICAL/), /Lerato Dube \(\+27\d+\)\.\nWhy: HTTP 500\./);
  assert.doesNotMatch(box(r, /CRITICAL/), /Put Right/);
}));

test('the team is told at once only when that is switched on: once when it breaks, once when it works', () => T(async () => {
  lead('Thandi Mokoena');
  account = { status: 403, message: 'Plan expired' };
  await m.wa.pumpWhatsApp('default', NOW);
  assert.equal(await m.al.alertProblems('default', NOW), 0, 'off until switched on');
  m.acc.updateTenantIntegrations('default', { handoff: { alertsOn: true } });
  discordUp = false;
  assert.equal(await m.al.alertProblems('default', NOW), 0, 'Discord down: tried again');
  discordUp = true;
  assert.equal(await m.al.alertProblems('default', NOW + 60_000), 1);
  assert.equal(await m.al.alertProblems('default', NOW + 120_000), 0, 'once');
  assert.match(posts[0].embeds[0].title, /🚨 Critical: WhatsApp follow-ups are not going out/);
  assert.match(posts[0].embeds[0].description, /Why: Plan expired\.\n1 lead is waiting for one\./);
  account = null;
  assert.equal(await m.wa.pumpWhatsApp('default', NOW + 2 * H), 1);
  assert.equal(await m.al.alertProblems('default', NOW + 2 * H), 1);
  assert.match(posts[1].embeds[0].title, /✅ Working again: WhatsApp follow-ups stopped/);
  assert.equal(await m.al.alertProblems('default', NOW + 2 * H + 60_000), 0);
  assert.equal(posts.length, 2);
}));

test('one broken account is one alarm, not two', () => T(async () => {
  lead('Thandi Mokoena');
  m.acc.updateTenantIntegrations('default', { handoff: { alertsOn: true } });
  account = { status: 403, message: 'Plan expired' };
  const later = NOW + 20 * DAY + 5 * H; // clear of the earlier alerts
  await m.wa.watchWhatsApp('default', later);
  assert.equal(await m.al.alertProblems('default', later), 1);
  m.pr.noteProblem('whatsapp', { why: 'Plan expired', sure: true }, 'default', later + 600_000);
  assert.equal(await m.al.alertProblems('default', later + 660_000), 0);
  m.pr.noteFine('whatsapp', 'default', later + H);
  m.pr.noteFine('whatsapp_connect', 'default', later + H);
  assert.equal(await m.al.alertProblems('default', later + H), 1);
  assert.deepEqual(m.pr.fixedProblems(later, later + 2 * H).map((x) => x.key), ['whatsapp']);
}));

test('the posted report is red, says it in the notification, and always fits Discord', () => T(async () => {
  for (const k of ['whatsapp', 'email', 'leads', 'mailbox', 'ai', 'whatsapp_answer'] as const) {
    m.pr.noteProblem(k, { why: 'x'.repeat(20) + ' a very long reason that goes on '.repeat(12), sure: true, person: 'Nomathemba Constance Dlamini-Mthembu' }, 'default', NOW);
  }
  for (let i = 0; i < 25; i++) lead(`Nomathemba Constance Dlamini-Mthembu ${i}`, { qualified: 'yes', qualified_at: iso(NOW), qualified_reason: 'hot', dialer_in: 'yes', dialer_status: 'moved back to New in the dialer (was in Unqualified)', dialer_assigned_to: 'Thabile' });
  const r = report();
  assert.equal(r.critical!.length, 6);
  const fields = m.rep.fitCard(r);
  const size = r.title.length + r.description.length + fields.reduce((t, x) => t + x.name.length + x.value.length, 0);
  assert.ok(size <= 6000, `${size} characters`);
  assert.equal(fields.filter((x) => /CRITICAL/.test(x.name)).length, 6, 'never the critical ones');
  for (const x of fields) { assert.ok(x.value.length > 0 && x.value.length <= 1024, x.name); assert.ok(!('tone' in x)); }
  await m.rep.maybeSendNurtureReport('default', Date.parse('2026-11-25T14:00:00Z'));
  assert.equal(await m.rep.maybeSendNurtureReport('default', Date.parse('2026-11-25T15:01:00Z')), true);
  assert.equal(posts.at(-1)!.embeds[0].color, 0xd92d20);
  assert.match(String(posts.at(-1)!.content), /^🚨 \*\*Critical:\*\* WhatsApp follow-ups are not going out; /);
}));

test('reasons are safe for the whole team to read', () => {
  const s = m.pr.safeReason;
  assert.equal(s('Incorrect API key provided: sk-proj-abcdefgh12345678. See https://platform.example.com/keys'), 'Incorrect API key provided: (key) See (link)');
  assert.equal(s('535 5.7.8 Username and Password not accepted for admin@melsoft.example'), '535 5.7.8 Username and Password not accepted for (address)');
  assert.doesNotMatch(s('Bearer 3078391:0123456789abcdef0123456789abcdef'), /0123456789abcdef/);
  assert.equal(s('Channel is disabled'), 'Channel is disabled');
  assert.equal(s('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low."}}'), 'Your credit balance is too low.');
});

test('whose fault it is: the account, or the one lead', async () => {
  const a = m.mc.accountTrouble;
  for (const x of ['Channel is disabled', 'Your subscription has expired', 'Payment past due', 'Not enough balance in the wallet', 'Please upgrade to Pro', 'WhatsApp was turned off', 'Template is paused']) assert.ok(a(x), x);
  for (const x of ['Subscriber not found', 'Subscriber is not available', 'Contact is not opted in', 'Validation error', 'Message is outside the 24 hour window', '']) assert.ok(!a(x), x);
  const { mailboxRefuses } = await import('../src/lib/email/send');
  for (const x of ['EAUTH: Invalid login: 535-5.7.8 Username and Password not accepted', 'EENVELOPE: 550-5.4.5 Daily user sending limit exceeded']) assert.ok(mailboxRefuses(x), x);
  for (const x of ['EENVELOPE: 550 5.1.1 The email account that you tried to reach does not exist', 'EENVELOPE: 552 mailbox full', 'EENVELOPE: 552-5.2.2 The recipient is over quota', 'EENVELOPE: 550 5.2.1 account suspended']) assert.ok(!mailboxRefuses(x), x);
});

test('a short failure is forgotten when it works; a lasting one is kept; days later it is a new one', () => T(() => {
  const p = m.pr;
  p.noteProblem('mailbox', { why: 'timeout' }, 'default', NOW);
  assert.equal(p.openProblems('default', NOW).length, 0);
  p.noteFine('mailbox', 'default', NOW + 60_000);
  p.noteProblem('mailbox', { why: 'timeout' }, 'default', NOW + H);
  p.noteProblem('mailbox', { why: 'timeout' }, 'default', NOW + 2 * H);
  assert.equal(p.openProblems('default', NOW + 2 * H)[0].firstAt, NOW + H);
  p.noteFine('mailbox', 'default', NOW + 3 * H);
  assert.equal(p.fixedProblems(NOW - H, NOW + 4 * H).filter((x) => x.key === 'mailbox').length, 1, 'only the lasting one');
  p.noteProblem('email', { why: 'refused', sure: true }, 'default', NOW);
  assert.equal(p.openProblems('default', NOW + 4 * DAY).length, 0, 'nothing tried for days');
  p.noteProblem('email', { why: 'refused', sure: true }, 'default', NOW + 4 * DAY);
  assert.equal(p.openProblems('default', NOW + 4 * DAY)[0].firstAt, NOW + 4 * DAY);
}));
