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
const realFetch = globalThis.fetch;

const row = (id: string, cells: Record<string, string>, extra: Record<string, string> = {}) => ({
  id, source: 'Meta ads', tab: 'Meta B2C v4', name: extra.name || cells.full_name || '', phone: extra.phone || '', email: extra.email || cells.email || '', cells,
});

before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.host !== 'dialer.example.test') return realFetch(input, init);
    if (u.pathname === '/api/v1/nurture') {
      return new Response(JSON.stringify({ ok: true, rows: queue, total: queue.length, page: 1, per: 500 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const rel = /^\/api\/v1\/nurture\/([^/]+)\/release$/.exec(u.pathname);
    if (rel && init?.method === 'POST') {
      released.push({ id: decodeURIComponent(rel[1]), body: JSON.parse(String(init.body || '{}')) });
      return new Response(JSON.stringify({ ok: true, outcome: 'created', lead: { id: 'lead-1', status: 'new' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  m.src.saveSource({ id: m.src.LEADS_SOURCE_ID, name: 'Leads from ads & forms', kind: 'leads', provider: 'dialer', url: '' });
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

test('qualifying a lead the dialer holds releases it there, with the brief', () => T(async () => {
  const { updateTenantIntegrations } = await import('../src/lib/auth/accounts');
  updateTenantIntegrations('default', { liveOutreachEnabled: true, handoff: { dialerOn: true } });
  process.env.SENDING_PAUSED = 'false';
  const r = await m.q.qualifyLead(m.src.LEADS_SOURCE_ID, 'thandi@example.com', { reason: 'call', bestTime: 'This afternoon' });
  process.env.SENDING_PAUSED = 'true';
  assert.ok(r?.qualified);
  assert.equal(released.length, 1);
  assert.equal(released[0].id, 'r1');
  assert.match(String(released[0].body.notes), /Thandi Mokoena asked us to call them/);
  assert.match(String(released[0].body.notes), /Source: Instagram ads/);
  assert.equal(r?.dialer, 'moved to New in the dialer');
}));
