import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Starting fresh: the old sheet rows Thuso never reached are cleared; anyone
 * it reached, anyone who engaged or unsubscribed, and every new lead stays.
 * The counts that included the cleared are corrected, and a cleared lead only
 * comes back by enquiring again. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-cleanup-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'IMAP_HOST', 'IMAP_USER', 'IMAP_PASS']) delete process.env[k];

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  rec: typeof import('../src/lib/data/records');
  src: typeof import('../src/lib/data/sources');
  clean: typeof import('../src/lib/nurture/cleanup');
  cleared: typeof import('../src/lib/data/cleared');
  store: typeof import('../src/lib/nurture/store');
  lib: typeof import('../src/lib/nurture/library');
};
let m: M;
const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);

before(async () => {
  m = {
    ctx: await import('../src/lib/auth/tenantContext'),
    rec: await import('../src/lib/data/records'),
    src: await import('../src/lib/data/sources'),
    clean: await import('../src/lib/nurture/cleanup'),
    cleared: await import('../src/lib/data/cleared'),
    store: await import('../src/lib/nurture/store'),
    lib: await import('../src/lib/nurture/library'),
  };
});

test('who stays and who is cleared', () => {
  const { keepReason } = m.clean;
  const old = (f: Record<string, string>) => ({ email: 'a@x.com', fields: { imported_quietly: 'yes', ...f } });
  assert.equal(keepReason(old({}), null), '', 'an old row never messaged');
  assert.equal(keepReason(old({ nurture_count: '1', nurture_sent: 'msg_a', nurture_last_sent_at: '2026-11-20T07:00:00Z' }), null), '', 'an old row whose only email failed (Gmail refused)');
  assert.equal(keepReason(old({ nurture_count: '1', nurture_last_sent_at: '2026-11-20T07:00:00Z' }), new Set(['a@x.com'])), 'got an email (in Gmail\'s Sent folder)');
  assert.equal(keepReason(old({ nurture_delivered_at: '2026-11-20T07:00:00Z' }), null), 'got an email');
  assert.equal(keepReason(old({ nurture_opens: '1' }), null), 'opened or clicked');
  assert.match(keepReason(old({ opted_out: 'yes' }), null), /^unsubscribed/);
  assert.equal(keepReason(old({ qualified: 'yes' }), null), 'qualified');
  assert.equal(keepReason({ email: 'n@x.com', fields: {} }, null), 'new since the sheet was connected');
  // Gmail not readable: an email sent before Thuso stamped deliveries may have arrived, so they stay.
  assert.match(keepReason(old({ nurture_count: '1', nurture_last_sent_at: '2026-11-19T09:00:00Z' }), null), /may have got an email/);
});

test('clearing: the old rows go, the counts are corrected, and they only come back by enquiring again', () => T(async () => {
  const L = m.src.LEADS_SOURCE_ID;
  const add = (key: string, fields: Record<string, string>) => m.rec.upsertRecord(L, { key, name: key.split('@')[0], email: key, phone: '', fields: { id: `l:${key}`, ...fields } });
  const msg = m.lib.saveMessage({ name: 'Gentle check-in', stage: 'reengage', subject: 'Hi {{first_name}}', body: 'Hi {{first_name}},\n\nOur live classes and real projects help people like you start a tech career, with support from our team all the way through the programme. Reply with any question about applying and we will help.', cta: { target: 'reply', label: 'Just reply' } });
  m.store.libraryDoc.get().find((x) => x.id === msg.id)!.stats.sent = 3;
  add('never@x.com', { imported_quietly: 'yes' });
  add('failed@x.com', { imported_quietly: 'yes', nurture_count: '1', nurture_sent: msg.id, nurture_last_sent_at: '2026-11-20T07:00:00Z' });
  add('failed2@x.com', { imported_quietly: 'yes', nurture_count: '2', nurture_sent: msg.id, nurture_last_sent_at: '2026-11-20T07:00:00Z' });
  add('reached@x.com', { imported_quietly: 'yes', nurture_count: '1', nurture_sent: msg.id, nurture_delivered_at: '2026-11-20T07:00:00Z' });
  add('stopped@x.com', { imported_quietly: 'yes', opted_out: 'yes' });
  add('new@x.com', {});
  add('test@x.com', { preview: 'yes', imported_quietly: 'yes' });
  m.store.meta().stats.librarySends = 10;

  const preview = await m.clean.previewCleanup();
  assert.equal(preview.clear, 3);
  assert.equal(preview.keep, 3, 'the test lead is neither');
  assert.equal(preview.gmailChecked, false);
  assert.ok(m.rec.getRecord(L, 'never@x.com'), 'a preview changes nothing');

  const done = await m.clean.runCleanup();
  assert.equal(done.clear, 3);
  for (const k of ['never@x.com', 'failed@x.com', 'failed2@x.com']) assert.equal(m.rec.getRecord(L, k), null, k);
  for (const k of ['reached@x.com', 'stopped@x.com', 'new@x.com', 'test@x.com']) assert.ok(m.rec.getRecord(L, k), k);
  assert.equal(m.store.meta().stats.librarySends, 7, 'the 3 sends that never arrived come off "saved messages sent"');
  assert.equal(m.store.libraryDoc.get().find((x) => x.id === msg.id)!.stats.sent, 1, 'and off the message\'s own "sent"');

  // The sheet is read again: the same old row stays out; a new form submission comes back.
  assert.equal(m.cleared.isCleared(L, { key: 'never@x.com', fields: { id: 'l:never@x.com' } }), true);
  assert.equal(m.cleared.isCleared(L, { key: 'failed@x.com', fields: { id: 'l:failed@x.com:new-form' } }), false, 'enquired again: welcome back');
  assert.equal(m.cleared.isCleared(L, { key: 'failed@x.com', fields: { id: 'l:failed@x.com' } }), false, 'and no longer remembered as cleared');
  assert.equal((await m.clean.runCleanup()).clear, 0, 'nothing left to clear');
}));
