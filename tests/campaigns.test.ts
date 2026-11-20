import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/* A campaign against a mail server that starts refusing (as Gmail does when
 * too much goes too fast): it pauses and carries on instead of failing
 * everyone, a lead it could not reach is not remembered as having the message,
 * and a campaign from before can be sent again to the ones it missed. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-campaigns-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEMO_RECIPIENT_EMAIL']) delete process.env[k];

// A tiny SMTP server: accepts `allow` messages, then answers RCPT with `refuse`.
let allow = 2;
let refuse = '421 4.7.0 Try again later, closing connection.';
let accepted = 0;
const connections: number[] = [];
const server = net.createServer((sock) => {
  connections.push(Date.now());
  let data = false;
  let buf = '';
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (data) {
        if (line === '.') { data = false; accepted++; sock.write('250 OK queued\r\n'); }
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
      else if (cmd === 'HELO') sock.write('250 fake\r\n');
      else if (cmd === 'AUTH') sock.write('235 2.7.0 Accepted\r\n');
      else if (cmd === 'MAIL') sock.write('250 OK\r\n');
      else if (cmd === 'RCPT') sock.write(accepted < allow ? '250 OK\r\n' : `${refuse}\r\n`);
      else if (cmd === 'DATA') { data = true; sock.write('354 go ahead\r\n'); }
      else if (cmd === 'RSET') sock.write('250 OK\r\n');
      else if (cmd === 'NOOP') sock.write('250 OK\r\n');
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 OK\r\n');
    }
  });
  sock.on('error', () => { /* closed */ });
});

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  rec: typeof import('../src/lib/data/records');
  src: typeof import('../src/lib/data/sources');
  lib: typeof import('../src/lib/nurture/library');
  camp: typeof import('../src/lib/nurture/campaigns');
  store: typeof import('../src/lib/nurture/store');
  send: typeof import('../src/lib/email/send');
};
let m: M;
const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'hello@academy.test', SMTP_PASS: 'secret', EMAIL_FROM: 'hello@academy.test', SENDING_PAUSED: 'false', SMTP_PER_MINUTE: '600', CAMPAIGN_PER_TICK: '10' });
  m = {
    ctx: await import('../src/lib/auth/tenantContext'),
    rec: await import('../src/lib/data/records'),
    src: await import('../src/lib/data/sources'),
    lib: await import('../src/lib/nurture/library'),
    camp: await import('../src/lib/nurture/campaigns'),
    store: await import('../src/lib/nurture/store'),
    send: await import('../src/lib/email/send'),
  };
  const { updateTenantIntegrations } = await import('../src/lib/auth/accounts');
  updateTenantIntegrations('default', { liveOutreachEnabled: true });
});
after(() => { server.close(); });

test('Gmail\'s "slow down" and daily-limit answers are told apart from real failures', () => {
  const { isThrottled, isDailyLimit } = m.send;
  assert.ok(isThrottled('421 4.7.0 Try again later, closing connection.'));
  assert.ok(isThrottled('454 4.7.0 Too many login attempts, please try again later.'));
  assert.ok(isThrottled('550 5.4.5 Daily user sending limit exceeded.'));
  assert.ok(isThrottled('421-4.7.28 Gmail has detected an unusual rate of unsolicited mail'));
  assert.ok(isDailyLimit('550 5.4.5 Daily user sending limit exceeded.'));
  assert.ok(!isDailyLimit('421 4.7.0 Try again later'));
  assert.ok(!isThrottled('550 5.1.1 The email account that you tried to reach does not exist.'));
});

test('a campaign pauses when the mail server pushes back, keeps who it missed, and finishes later; one connection for all', () => T(async () => {
  for (let i = 1; i <= 5; i++) {
    m.rec.upsertRecord(m.src.LEADS_SOURCE_ID, { key: `lead${i}@example.com`, name: `Lead ${i}`, email: `lead${i}@example.com`, phone: '', fields: { programme: 'Cybersecurity' } });
  }
  const x = m.lib.saveMessage({ name: 'Gentle check-in', stage: 'reengage', subject: 'Hi {{first_name}}, is now the right time?', body: 'Hi {{first_name}},\n\nOur live classes and real projects help people like you start a tech career, with support from our team all the way through the programme. Reply with any question about applying and we will help.', cta: { target: 'reply', label: 'Just reply' } });
  const msg = m.lib.approveMessage(x.id, 'test').message!;
  const c = m.camp.createCampaign({ messageId: msg.id, segment: [], by: 'Test' });
  assert.equal(c.total, 5);

  allow = 2; accepted = 0;
  await m.camp.pumpCampaigns('default');
  let now = m.store.campaignDoc.get().find((y) => y.id === c.id)!;
  assert.equal(now.sent, 2);
  assert.equal(now.failed, 0, 'a "try again later" is not a failure');
  assert.equal(now.queue.length, 3, 'the lead it was refused on waits at the front');
  assert.ok(now.pausedUntil && now.pausedUntil > Date.now(), 'paused');
  assert.match(now.lastError || '', /421/);
  const third = m.rec.getRecord(m.src.LEADS_SOURCE_ID, now.queue[0])!;
  assert.ok(!(third.fields.nurture_sent || '').includes(msg.id), 'not remembered as received');
  assert.equal(Number(third.fields.nurture_count || 0), 0);

  // Still paused: nothing goes.
  await m.camp.pumpCampaigns('default');
  assert.equal(m.store.campaignDoc.get().find((y) => y.id === c.id)!.sent, 2);

  // Later: the server takes one more, then refuses the last two addresses for good.
  now.pausedUntil = Date.now() - 1;
  allow = 1; accepted = 0; refuse = '550 5.1.1 The email account does not exist.';
  await m.camp.pumpCampaigns('default');
  now = m.store.campaignDoc.get().find((y) => y.id === c.id)!;
  assert.equal(now.status, 'done');
  assert.equal(now.sent, 3);
  assert.equal(now.failed, 2);
  assert.equal((now.failedKeys || []).length, 2);
  assert.match(now.lastError || '', /does not exist/);
  assert.ok(connections.length <= 3, `one reused connection per run, not one per email (${connections.length})`);

  // Send again to the two it missed (the address is fine now).
  refuse = '421 4.7.0 Try again later'; allow = 1000; accepted = 0;
  assert.equal(m.camp.retryCampaign(c.id), 2);
  await m.camp.pumpCampaigns('default');
  now = m.store.campaignDoc.get().find((y) => y.id === c.id)!;
  assert.equal(now.status, 'done');
  assert.equal(now.sent, 5);
  assert.equal(now.failed, 0);
}));

test('a campaign from before (no list of who it missed): the leads with the message but no email delivered since are sent again', () => T(async () => {
  const msg = m.lib.listMessages().find((x) => x.name === 'Gentle check-in')!;
  const started = Date.now() - 20 * 3600_000;
  const add = (key: string, fields: Record<string, string>) => {
    m.rec.upsertRecord(m.src.LEADS_SOURCE_ID, { key, name: key.split('@')[0], email: key, phone: '', fields: { programme: 'Cybersecurity' } });
    for (const [k, v] of Object.entries(fields)) m.rec.setRecordField(m.src.LEADS_SOURCE_ID, key, k, v);
  };
  add('missed@example.com', { nurture_sent: msg.id, nurture_count: '1' });
  add('reached@example.com', { nurture_sent: msg.id, nurture_count: '1', nurture_delivered_at: new Date(started + 60_000).toISOString() });
  add('stopped@example.com', { nurture_sent: msg.id, nurture_count: '1', opted_out: 'yes' });
  const old = { id: 'cmp_old', name: 'Gentle check-in', messageId: msg.id, sourceId: m.src.LEADS_SOURCE_ID, segment: [], sendAt: started, status: 'done' as const,
    total: 3, sent: 1, skipped: 0, failed: 2, queue: [], createdAt: started, createdBy: 'Nigel', finishedAt: started + 600_000 };
  m.store.campaignDoc.get().push(old);
  assert.equal(m.camp.retryCampaign('cmp_old'), 1, 'only the one never reached (not the unsubscribed, not the one delivered)');
  const missed = m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'missed@example.com')!.fields;
  assert.ok(!(missed.nurture_sent || '').includes(msg.id), 'their record no longer says they have it');
  assert.equal(missed.nurture_count, '0');
  allow = 1000; accepted = 0;
  await m.camp.pumpCampaigns('default');
  const now = m.store.campaignDoc.get().find((y) => y.id === 'cmp_old')!;
  assert.equal(now.status, 'done');
  assert.equal(now.sent, 2);
  assert.ok((m.rec.getRecord(m.src.LEADS_SOURCE_ID, 'missed@example.com')!.fields.nurture_sent || '').includes(msg.id));
}));
