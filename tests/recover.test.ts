import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* Repairing lead activity lost to the restart rollbacks: each lead keeps
 * the most advanced state found in the backups; sheet columns and leads no
 * longer in the list are left alone. */

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'windows', 'merge-records.mjs');

test('a lead rolled back from hot and qualified gets its activity back; nothing goes backwards', async () => {
  const { mergeLead } = await import(pathToFileURL(script).href);
  const now = {
    email: 'louw@example.com', how_will_you_finance_the_program: 'i_will_fund_my_self',
    agent_engagement_score: '1', engagement_score: '1', agent_engagement: 'cold', engagement: 'cold',
    agent_nurture_seen: 'open:msg_a:open', nurture_seen: 'open:msg_a:open', agent_status: 'contacted', status: 'contacted',
    agent_nurture_opens: '1', nurture_opens: '1',
  };
  const backup = {
    email: 'louw@example.com', how_will_you_finance_the_program: 'something old',
    agent_engagement_score: '8', engagement_score: '8', agent_engagement: 'hot', engagement: 'hot',
    agent_nurture_seen: 'open:msg_a:open|click:msg_a:quiz|quiz:msg_a:quiz|video:msg_a:video', nurture_seen: 'open:msg_a:open|click:msg_a:quiz|quiz:msg_a:quiz|video:msg_a:video',
    agent_qualified: 'yes', qualified: 'yes', agent_qualified_at: '2026-11-19T16:24:00.000Z', qualified_at: '2026-11-19T16:24:00.000Z',
    agent_status: 'qualified', status: 'qualified', agent_fit_track: 'The Builder', fit_track: 'The Builder',
    agent_nurture_opens: '1', nurture_opens: '1',
  };
  const { fields, changed } = mergeLead(now, backup);
  assert.equal(fields.engagement_score, '8');
  assert.equal(fields.engagement, 'hot');
  assert.equal(fields.qualified, 'yes');
  assert.equal(fields.status, 'qualified');
  assert.equal(fields.fit_track, 'The Builder');
  assert.match(fields.nurture_seen, /video:msg_a:video/);
  assert.equal(fields.how_will_you_finance_the_program, 'i_will_fund_my_self', 'sheet columns stay as they are now');
  assert.ok(changed.includes('engagement_score') && changed.includes('qualified'));
  // A newer state is never replaced by an older one.
  const again = mergeLead(fields, { agent_engagement_score: '3', engagement_score: '3', agent_engagement: 'warm', engagement: 'warm' });
  assert.equal(again.fields.engagement_score, '8');
  assert.equal(again.fields.engagement, 'hot');
  assert.deepEqual(again.changed, []);
});

test('the repair reads backup folders and only touches leads that exist now', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-recover-'));
  const data = path.join(root, '.data');
  const bk = path.join(root, 'b0');
  const write = (dir: string, recs: unknown) => { fs.mkdirSync(path.join(dir, 'tenants', 'tnt_x'), { recursive: true }); fs.writeFileSync(path.join(dir, 'tenants', 'tnt_x', 'records.json'), JSON.stringify(recs)); };
  write(data, { src_leads: { 'a@x.com': { key: 'a@x.com', name: 'Ann', fields: { agent_engagement_score: '1', engagement_score: '1' } } } });
  write(bk, { src_leads: {
    'a@x.com': { key: 'a@x.com', name: 'Ann', fields: { agent_engagement_score: '9', engagement_score: '9', agent_engagement: 'hot', engagement: 'hot' } },
    'gone@x.com': { key: 'gone@x.com', name: 'Old Row', fields: { agent_engagement_score: '5', engagement_score: '5' } },
  } });
  const out = execFileSync(process.execPath, [script, data, bk], { encoding: 'utf8' });
  assert.match(out, /repaired 1 lead/);
  const after = JSON.parse(fs.readFileSync(path.join(data, 'tenants', 'tnt_x', 'records.json'), 'utf8'));
  assert.equal(after.src_leads['a@x.com'].fields.engagement_score, '9');
  assert.equal(after.src_leads['gone@x.com'], undefined, 'a lead no longer in the list is not brought back');
});
