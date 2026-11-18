import type { DataRecord, StepCondition } from '@/lib/types';
import type { NurtureCampaign } from './types';
import { campaignDoc, nid } from './store';
import { fitsFunding, isLive, resolveMessage, resolveMessage as getMessage, sendLibraryMessage } from './library';
import { listRecords, getRecord } from '@/lib/data/records';
import { LEADS_SOURCE_ID, liveFields } from '@/lib/data/sources';
import { matchesAll } from '@/lib/data/conditions';
import { leadProgramme } from './programmes';
import { listCustomAgents, listOffices } from '@/lib/engine/offices';
import { getAcademyContext } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { log } from '@/lib/engine/store';

/* Campaigns: one saved message to a group of leads, now or at a set time.
 *
 * "Everyone interested in Data Science who has not applied", "all warm
 * leads", "the parents". The group is worked out when the campaign is made;
 * the pump then sends a few at a time (so a big list never floods the mail
 * server), skipping anyone who unsubscribed or already got that message.
 * No AI is involved: it is the saved, approved message, merged per lead. */

const PER_TICK = Math.max(1, Number(process.env.CAMPAIGN_PER_TICK || 6));
const DONE_STATUSES = /^(applied|enrolled|registered|student|won|closed|not interested|unsubscribed)$/i;

export function listCampaigns(): NurtureCampaign[] {
  return campaignDoc.get();
}

/** Who a campaign would reach right now, and why others are left out. */
export function segmentMembers(sourceId: string, segment: StepCondition[], messageId?: string): { members: DataRecord[]; skipped: { optedOut: number; alreadyHad: number; noContact: number; finished: number; notForThem: number } } {
  const skipped = { optedOut: 0, alreadyHad: 0, noContact: 0, finished: 0, notForThem: 0 };
  const msg = messageId ? resolveMessage(messageId) : null;
  const mentionsStatus = segment.some((c) => c.field === 'status');
  const members: DataRecord[] = [];
  for (const rec of listRecords(sourceId)) {
    const f: Record<string, string> = { ...liveFields(rec), lead_programme: leadProgramme(rec.fields) };
    if (f.preview === 'yes' || !matchesAll(segment, f)) continue;
    if (f.opted_out === 'yes') { skipped.optedOut++; continue; }
    if (!rec.email && !rec.phone) { skipped.noContact++; continue; }
    if (!mentionsStatus && DONE_STATUSES.test((f.status || '').trim())) { skipped.finished++; continue; }
    if (messageId && (f.nurture_sent || '').split('|').includes(messageId)) { skipped.alreadyHad++; continue; }
    if (msg && !fitsFunding(msg, f)) { skipped.notForThem++; continue; }
    members.push(rec);
  }
  return { members, skipped };
}

export function createCampaign(input: { name?: string; messageId: string; sourceId?: string; segment: StepCondition[]; sendAt?: number; by: string }): NurtureCampaign {
  const msg = getMessage(input.messageId);
  if (!msg) throw new Error('Choose a message from the library.');
  if (!isLive(msg)) throw new Error(msg.status !== 'approved' ? 'Approve the message first: a person approves what goes out.' : 'That offer has ended.');
  const sourceId = input.sourceId || LEADS_SOURCE_ID;
  const { members } = segmentMembers(sourceId, input.segment, msg.id);
  if (!members.length) throw new Error('Nobody in that group can get this message (already had it, unsubscribed, or no contact details).');
  const now = Date.now();
  const c: NurtureCampaign = {
    id: nid('cmp'),
    name: (input.name || msg.name).trim().slice(0, 80),
    messageId: msg.id,
    sourceId,
    segment: input.segment.slice(0, 6),
    sendAt: input.sendAt && input.sendAt > now ? input.sendAt : now,
    status: 'scheduled',
    total: members.length,
    sent: 0, skipped: 0, failed: 0,
    queue: members.map((r) => r.key),
    createdAt: now,
    createdBy: input.by,
    finishedAt: null,
  };
  campaignDoc.get().unshift(c);
  campaignDoc.set(campaignDoc.get().slice(0, 100));
  log('system', 'route', `Campaign "${c.name}" set for ${c.total} lead${c.total === 1 ? '' : 's'}${c.sendAt > now + 60_000 ? ` on ${new Date(c.sendAt).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ', sending now'}.`);
  return c;
}

export function cancelCampaign(id: string): boolean {
  const c = campaignDoc.get().find((x) => x.id === id);
  if (!c || c.status === 'done' || c.status === 'cancelled') return false;
  c.status = 'cancelled';
  c.finishedAt = Date.now();
  c.queue = [];
  campaignDoc.save();
  return true;
}

/** Who signs campaign messages: the Admissions lead nurturer, else the academy sender. */
export function campaignSender(): { name: string; office: string } {
  const a = listCustomAgents().find((x) => x.id === 'ag_naledi') || listCustomAgents().find((x) => x.officeId === 'dep_admissions');
  if (a) return { name: a.name, office: listOffices().find((o) => o.id === a.officeId)?.name || 'Admissions' };
  const ac = getAcademyContext();
  return { name: ac.senderName, office: 'Admissions' };
}

const g = globalThis as unknown as { __thusoCampaignBusy?: Set<string> };
const busy = (g.__thusoCampaignBusy ??= new Set());

/** Send the next few messages of every due campaign. Called by the always-on pump. */
export async function pumpCampaigns(tenantId = currentTenantId()): Promise<void> {
  if (busy.has(tenantId)) return;
  const due = campaignDoc.get(tenantId).filter((c) => (c.status === 'scheduled' && c.sendAt <= Date.now()) || c.status === 'sending');
  if (!due.length) return;
  busy.add(tenantId);
  try {
    for (const c of due) {
      if (c.status === 'scheduled') { c.status = 'sending'; log('system', 'email', `Campaign "${c.name}" started: ${c.total} lead${c.total === 1 ? '' : 's'}.`); }
      const msg = getMessage(c.messageId);
      if (!msg || !isLive(msg)) {
        c.status = 'cancelled'; c.finishedAt = Date.now(); c.skipped += c.queue.length; c.queue = [];
        log('system', 'info', `Campaign "${c.name}" stopped: its message is no longer approved or the offer ended.`);
        continue;
      }
      const sender = campaignSender();
      for (let i = 0; i < PER_TICK && c.queue.length; i++) {
        const key = c.queue.shift()!;
        const rec = getRecord(c.sourceId, key);
        if (!rec || rec.fields.opted_out === 'yes' || (rec.fields.nurture_sent || '').split('|').includes(msg.id)) { c.skipped++; continue; }
        const r = await sendLibraryMessage({ rec, msg, sender, taskId: c.id });
        if (r.skipped) c.skipped++;
        else if (r.ok) c.sent++;
        else c.failed++;
      }
      if (!c.queue.length) {
        c.status = 'done';
        c.finishedAt = Date.now();
        log('system', 'approve', `Campaign "${c.name}" finished: ${c.sent} sent, ${c.skipped} skipped${c.failed ? `, ${c.failed} failed` : ''}.`);
      }
    }
    campaignDoc.save(tenantId);
  } finally {
    busy.delete(tenantId);
  }
}
