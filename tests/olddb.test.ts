import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* The server's database was out of reach for days and answers again: nothing
 * old in it may replace what this server has. (A fake Postgres.) */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-olddb-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SMTP_HOST', 'THUSO_PREFER_DB']) delete process.env[k];
Object.assign(process.env, { PGHOST: '127.0.0.1', PGPORT: '2106', PGDATABASE: 'x', PGUSER: 'x', PGPASSWORD: 'x' });

const OLD = new Date('2026-11-10T10:00:00Z');
const user = (id: string, hash: string) => ({ id, tenant_id: 'default', email: `${id}@x.org`, name: id, password_hash: hash, role: 'admin', created_at: OLD });
const writes: string[] = [];
const sentUp: unknown[][] = [];

fs.mkdirSync('.data', { recursive: true });
fs.writeFileSync('.data/auth.json', JSON.stringify({
  tenants: [{ id: 'default', name: 'Melsoft Academy', slug: 'melsoft-academy', webhookSecret: 'whsec_now', integrations: { lmsProvider: 'webhook', liveOutreachEnabled: true }, createdAt: 1 }],
  users: [{ id: 'u1', tenantId: 'default', email: 'u1@x.org', name: 'u1', passwordHash: 'NEW', role: 'owner', createdAt: 1 }],
}));
fs.writeFileSync('.data/world.json', JSON.stringify({ deliverables: [], inbox: [], learners: [], metrics: { dispatched: 3 }, tasks: [], feed: [], pendingOutreach: [] }));

test('a database that missed days never brings back old accounts, approvals, counts or students', async () => {
  const pg = (await import('pg')).default;
  pg.Pool.prototype.query = (async (sql: string, params: unknown[] = []) => {
    if (/^\s*SELECT/i.test(sql)) {
      if (/FROM tenants/i.test(sql)) return { rows: [{ id: 'default', name: 'Old name', slug: 'old', webhook_secret: 'whsec_old', integrations: { lmsProvider: 'sandbox' }, created_at: OLD }, { id: 'tnt_gone', name: 'Deleted', slug: 'gone', webhook_secret: 'w', integrations: { liveOutreachEnabled: true }, created_at: OLD }] };
      if (/FROM users/i.test(sql)) return { rows: [user('u1', 'OLD'), user('removed', 'OLD')] };
      if (/tenant_snapshots/i.test(sql)) return { rows: [{ metrics: { dispatched: 900 }, tasks: [], feed: [], pending_outreach: [{ id: 'appr_old', status: 'pending', createdAt: OLD.getTime() }] }] };
      return { rows: [] };
    }
    writes.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40));
    if (/INSERT INTO users/i.test(sql)) sentUp.push(params);
    return { rows: [] };
  }) as never;

  const ctx = await import('../src/lib/auth/tenantContext');
  const acc = await import('../src/lib/auth/accounts');
  const store = await import('../src/lib/engine/store');
  await ctx.withTenant('default', async () => {
    store.getState();
    await acc.hydrateAuthFromDb();
    await store.hydrateStoreFromDb();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(acc.listTenantIds(), ['default']);
    assert.equal(acc.getTenant('default').name, 'Melsoft Academy');
    assert.equal(acc.getTenantIntegrations('default').liveOutreachEnabled, true);
    const state = store.getState();
    assert.equal(state.metrics.dispatched, 3);
    assert.deepEqual(state.pendingOutreach, []);
  });
  const users = (globalThis as unknown as { __thusoAuth: { users: { id: string; passwordHash: string }[] } }).__thusoAuth.users;
  assert.deepEqual(users.map((u) => [u.id, u.passwordHash]), [['u1', 'NEW']]);
  // The database gets this server's copy.
  assert.ok(sentUp.some((p) => p.includes('NEW')), 'the current password is sent up');
  assert.ok(writes.some((w) => /INSERT INTO tenant_snapshots/i.test(w)));
});

test('the older student list in the database is not used; a newer one is', async () => {
  const ctx = await import('../src/lib/auth/tenantContext');
  const book = await import('../src/lib/lms/gradebook');
  const sync = await import('../src/lib/engine/moodleSync');
  const pg = (await import('pg')).default;
  let dbAt = OLD.getTime();
  pg.Pool.prototype.query = (async (sql: string) => {
    if (/FROM learners/i.test(sql)) return { rows: [{ id: 'old', name: 'Old student', email: 'old@x.org', cohort: '', programme: '' }] };
    if (/SELECT moodle_sync_meta/i.test(sql)) return { rows: [{ moodle_sync_meta: { lastSyncedAt: dbAt } }] };
    return { rows: [] };
  }) as never;
  await ctx.withTenant('default', async () => {
    book.saveRoster([{ id: 'now', name: 'Current student' } as never], 'default');
    const a = await sync.getCachedLearnersSnapshot('default');
    assert.deepEqual(a.learners.map((r) => r.id), ['now']);
    dbAt = Date.now() + 1000;
    const b = await sync.getCachedLearnersSnapshot('default');
    assert.deepEqual(b.learners.map((r) => r.id), ['old'], 'a database as new as the roster is used');
  });
});
