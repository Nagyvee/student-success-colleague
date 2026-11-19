import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* When the database (the SSH tunnel to the VPS) was unreachable, changes
 * reached only .data. On the next start the newer copy must win: local
 * changes are sent up, not overwritten by the database's older copy. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-sync-'));
process.chdir(dir);

let s: typeof import('../src/lib/db/syncState');
before(async () => { s = await import('../src/lib/db/syncState'); });

const H = 3_600_000;

test('one server writes everything: its local copy always loads on start (the database is the backup)', () => {
  const now = Date.now();
  delete process.env.THUSO_PREFER_DB;
  assert.equal(s.localWins(now - 5 * H, now - 5 * H + 300, now), true, 'even when the database row looks newer (an out-of-order save): never roll back');
  assert.equal(s.localWins(now - 24 * H, null, now), true);
  assert.equal(s.localWins(null, null, now), false, 'no local file (a new server): the database copy loads');
});

test('with THUSO_PREFER_DB: a store changed here after its last database save wins; one that did not loads the database copy', () => {
  process.env.THUSO_PREFER_DB = 'true';
  const now = Date.now();
  assert.equal(s.localWins(now, now - 5 * H, now - H), true, 'changed while the tunnel was down');
  assert.equal(s.localWins(now - 5 * H, now - 5 * H + 300, now), false, 'saved to both: the database copy (maybe newer from the VPS) loads');
  assert.equal(s.localWins(now - 5 * H, now - 5 * H, now - 9 * H), false, 'no local change since the last save');
  assert.equal(s.localWins(null, null, now), false, 'nothing local');
});

test('with THUSO_PREFER_DB, the first start: a document compares with its own database timestamp; with none, the local copy wins', () => {
  process.env.THUSO_PREFER_DB = 'true';
  const now = Date.now();
  assert.equal(s.localWins(now, null, now - 24 * H), true, 'local is newer: send it up');
  assert.equal(s.localWins(now - 24 * H, null, now), false, 'the database is newer: load it');
  assert.equal(s.localWins(now, null, null), true, 'no timestamp in the database (settings, agents, jobs): this machine was the only writer');
  assert.equal(s.localWins(now, null, now - 500), false, 'within a couple of seconds: same save, the database copy');
  delete process.env.THUSO_PREFER_DB;
});

test('database saves are remembered per workspace and survive a restart', () => {
  assert.equal(s.confirmedAt('doc:records', 'tnt_a'), null);
  s.markSynced('doc:records', 'tnt_a', 1000);
  s.markSynced('auth', 'tnt_b', 2000);
  assert.equal(s.confirmedAt('doc:records', 'tnt_a'), 1000);
  assert.equal(s.confirmedAt('auth', 'tnt_a'), null);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.data', 'db-sync.json'), 'utf8'));
  assert.deepEqual(saved, { tnt_a: { 'doc:records': 1000 }, tnt_b: { auth: 2000 } });
  fs.writeFileSync(path.join(dir, 'f.json'), '{}');
  assert.ok(Math.abs((s.fileTime(path.join(dir, 'f.json')) || 0) - Date.now()) < 5000);
  assert.equal(s.fileTime(path.join(dir, 'missing.json')), null);
});

test('copies reach the database one at a time and the newest lands last (no rollback on the next start)', async () => {
  const { serialWriter } = await import('../src/lib/db/serialWriter');
  let current = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const stored: number[] = [];
  const marks: number[] = [];
  // The first copy is slow (a big document on a busy connection): the race that rolled data back.
  const delays = [80, 5, 5, 5, 5, 5, 5];
  let call = 0;
  const push = serialWriter<number>(async (v) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, delays[call++] ?? 5));
    stored.push(v);
    inFlight--;
    return true;
  }, (at) => marks.push(at));
  const saves: Promise<void>[] = [];
  for (let i = 1; i <= 5; i++) { current = i; saves.push(push(() => current)); await new Promise((r) => setTimeout(r, 2)); }
  await Promise.all(saves);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(maxInFlight, 1, 'never two copies on their way at once');
  assert.equal(stored[stored.length - 1], 5, 'the database ends with the newest value');
  assert.ok(stored.length <= 3, `saves in between are folded into one (${stored.join(', ')})`);
  assert.ok(marks.length >= 1);
});
