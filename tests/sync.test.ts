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

test('a store changed here after its last database save wins; one that did not loads the database copy', () => {
  const now = Date.now();
  assert.equal(s.localWins(now, now - 5 * H, now - H), true, 'changed while the tunnel was down');
  assert.equal(s.localWins(now - 5 * H, now - 5 * H + 300, now), false, 'saved to both: the database copy (maybe newer from the VPS) loads');
  assert.equal(s.localWins(now - 5 * H, now - 5 * H, now - 9 * H), false, 'no local change since the last save');
  assert.equal(s.localWins(null, null, now), false, 'nothing local');
});

test('the first start with this check: a document compares with its own database timestamp; with none, the local copy wins', () => {
  const now = Date.now();
  assert.equal(s.localWins(now, null, now - 24 * H), true, 'local is newer: send it up');
  assert.equal(s.localWins(now - 24 * H, null, now), false, 'the database is newer: load it');
  assert.equal(s.localWins(now, null, null), true, 'no timestamp in the database (settings, agents, jobs): this machine was the only writer');
  assert.equal(s.localWins(now, null, now - 500), false, 'within a couple of seconds: same save, the database copy');
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
