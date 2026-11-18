import { clearOfficeActivity } from './store';
import { clearAgentRuns } from './agentRuns';
import { removeRecords } from '@/lib/data/records';
import { emptyStats, metaDoc, voucherDoc } from '@/lib/nurture/store';

/* "Clear samples and test data": everything made while testing goes, so a
 * demo starts clean and one fresh sample can be made for it.
 *   - the office: inbox, outputs, approvals, plans, activity, counters,
 *   - agent runs (nothing has gone to anyone while sending was paused),
 *   - preview leads, their vouchers, and scenes made for them,
 *   - the nurturing counters (sends, opens, clicks and views from samples).
 * Settings, real leads and students, the message library, the videos, the
 * quiz, the knowledge and the agents stay as they are. */

export interface ClearedSummary { inbox: number; outputs: number; approvals: number; plans: number; activity: number; runs: number; previewLeads: number; vouchers: number }

export function clearSamplesAndTests(): ClearedSummary {
  const office = clearOfficeActivity();
  const runs = clearAgentRuns();
  const previewLeads = removeRecords((r) => r.fields.preview === 'yes' || r.key.startsWith('preview:'));
  const vouchers = voucherDoc.get().filter((v) => v.preview).length;
  voucherDoc.set(voucherDoc.get().filter((v) => !v.preview));
  const m = metaDoc.get();
  m.personal = {};
  m.stats = emptyStats();
  for (const v of m.videos) v.views = 0;
  metaDoc.save();
  return { ...office, runs, previewLeads, vouchers };
}
