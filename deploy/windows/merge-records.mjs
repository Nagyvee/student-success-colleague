// Repairs lead activity lost to the restart rollbacks (fixed in 6856aa1): for every lead that
// exists now, takes the most advanced state found in the backups (score, engagement, emails
// sent and opened, clicks, quiz, video, qualification, dialer status, replies). Leads that are
// no longer in the list are not brought back.
//
//   node merge-records.mjs <.data folder> <extracted backup folder> [more backup folders...]
//
// Run by recover-leads.ps1 with Thuso stopped. Pure merge logic: mergeLead (tested).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LISTS = new Set(['nurture_seen', 'nurture_sent', 'nurture_res']);
const COUNTS = new Set(['engagement_score', 'nurture_opens', 'nurture_clicks', 'nurture_count']);
const HEAT = { cold: 0, warm: 1, hot: 2 };
const STATUS_RANK = (s) => {
  const v = String(s || '').toLowerCase();
  if (/^(enrolled|registered|student|applied)$/.test(v)) return 5;
  if (v === 'qualified') return 4;
  if (/^ready to/.test(v)) return 3;
  if (v === 'with sales') return 2;
  if (v === 'contacted') return 1;
  return 0;
};
const isTime = (k) => /(_at|_at_ms)$/.test(k);
const timeOf = (v) => { const n = Number(v); if (Number.isFinite(n) && n > 1e11) return n; const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };
const plain = (k) => k.replace(/^agent_/, '');

/** One field, the most advanced of two values. */
function better(key, now, old) {
  if (old === undefined || old === null || old === '') return now;
  if (now === undefined || now === null || now === '') return old;
  const k = plain(key);
  if (COUNTS.has(k)) return String(Math.max(Number(now) || 0, Number(old) || 0));
  if (LISTS.has(k)) return [...new Set([...String(now).split('|'), ...String(old).split('|')].filter(Boolean))].slice(-80).join('|');
  if (k === 'engagement') return (HEAT[old] ?? -1) > (HEAT[now] ?? -1) ? old : now;
  if (k === 'status') return STATUS_RANK(old) > STATUS_RANK(now) ? old : now;
  if (k === 'conversation') {
    const n = (v) => { try { return JSON.parse(v).length || 0; } catch { return 0; } };
    return n(old) > n(now) ? old : now;
  }
  if (isTime(k)) return timeOf(old) > timeOf(now) ? old : now;
  return now;
}

/** A lead record now, with what an older copy knew merged in. Returns the merged fields and the names of fields that changed. */
export function mergeLead(nowFields, oldFields) {
  const out = { ...nowFields };
  const changed = [];
  for (const [k, v] of Object.entries(oldFields || {})) {
    // Only what agents and tracking wrote (agent_ fields and their plain names); sheet columns stay as now.
    const agentish = k.startsWith('agent_') || `agent_${k}` in (oldFields || {}) || `agent_${k}` in out;
    if (!agentish) continue;
    const merged = better(k, out[k], v);
    if (merged !== out[k]) { out[k] = merged; changed.push(k); }
  }
  return { fields: out, changed: changed.filter((k) => !k.startsWith('agent_')) };
}

function main() {
  const [dataDir, ...backups] = process.argv.slice(2);
  if (!dataDir || !backups.length) { console.error('Usage: node merge-records.mjs <.data folder> <backup folder> [...]'); process.exit(2); }
  const tenantsDir = path.join(dataDir, 'tenants');
  const tenants = fs.existsSync(tenantsDir) ? fs.readdirSync(tenantsDir) : [];
  for (const tid of tenants) {
    const file = path.join(tenantsDir, tid, 'records.json');
    if (!fs.existsSync(file)) continue;
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    const leads = current.src_leads || {};
    const touched = new Map();
    for (const b of backups) {
      const old = path.join(b, 'tenants', tid, 'records.json');
      if (!fs.existsSync(old)) continue;
      const oldLeads = (JSON.parse(fs.readFileSync(old, 'utf8')).src_leads) || {};
      for (const [key, rec] of Object.entries(leads)) {
        const was = oldLeads[key];
        if (!was) continue;
        const { fields, changed } = mergeLead(rec.fields || {}, was.fields || {});
        if (changed.length) { rec.fields = fields; touched.set(key, [...new Set([...(touched.get(key) || []), ...changed])]); }
      }
    }
    if (touched.size) {
      fs.writeFileSync(file, JSON.stringify(current), 'utf8');
      console.log(`${tid}: repaired ${touched.size} lead${touched.size === 1 ? '' : 's'}:`);
      for (const [key, fields] of touched) {
        const f = leads[key].fields;
        console.log(`  ${leads[key].name}: score ${f.engagement_score || 0}, ${f.engagement || 'cold'}${f.qualified === 'yes' ? ', qualified' : ''} (${fields.slice(0, 6).join(', ')}${fields.length > 6 ? ', ...' : ''})`);
      }
    } else {
      console.log(`${tid}: nothing to repair.`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
