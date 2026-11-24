import { ImapFlow } from 'imapflow';
import type { DataRecord } from '@/lib/types';
import { listRecords, removeRecords } from '@/lib/data/records';
import { LEADS_SOURCE_ID } from '@/lib/data/sources';
import { markCleared } from '@/lib/data/cleared';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { imapSettings } from '@/lib/email/watch';
import { log as storeLog } from '@/lib/engine/store';
import { campaignDoc, libraryDoc, meta, metaDoc } from './store';

/* Starting fresh: Thuso keeps the leads it really reached, and the new ones.
 *
 * The first read of the leads sheet brought in every old row (imported
 * quietly). Many were never messaged; a campaign tried some and Gmail refused
 * (and back then a refused email still counted as received). Clearing takes
 * out the old rows Thuso never reached, so every number is about real people:
 *
 *   kept    anyone new since the sheet was connected (repair.ts marks the rows that were there before); anyone who got an email
 *           (Gmail's Sent folder, or Thuso's own delivery stamp), opened,
 *           clicked, took the quiz, replied, qualified or unsubscribed
 *   cleared the old rows with none of that
 *
 * A cleared lead does not come back from the sheet (or the dialer) unless they
 * enquire again (a new form submission). Counts that included them (saved
 * messages sent, each message's "sent") are corrected. */

const log: typeof storeLog = (actor, level, text, extra = {}) => storeLog(actor, level, text, { dept: 'admissions', ...extra });

const n = (v: string | undefined) => { const x = Number(v || 0); return Number.isFinite(x) ? x : 0; };

/** Why a lead stays ('' = they are cleared). Pure. */
export function keepReason(r: Pick<DataRecord, 'email' | 'fields'>, sent: Set<string> | null): string {
  const f = r.fields;
  if (f.preview === 'yes') return 'a test lead';
  if (f.imported_quietly !== 'yes') return 'new since the sheet was connected';
  if (f.qualified === 'yes') return 'qualified';
  if (f.opted_out === 'yes') return 'unsubscribed (remembered, so they are never emailed)';
  if (f.replied === 'yes') return 'replied';
  if (n(f.engagement_score) > 0 || n(f.nurture_opens) > 0 || n(f.nurture_clicks) > 0 || f.last_clicked || f.fit_done === 'yes' || f.fit_track) return 'opened or clicked';
  if (f.nurture_delivered_at) return 'got an email';
  if (sent && r.email && sent.has(r.email.toLowerCase())) return 'got an email (in Gmail\'s Sent folder)';
  if (/^(applied|enrolled|registered|student)$/i.test(f.status || '')) return 'applied';
  if (f.dialer_in === 'yes' || f.dialer_lead_id) return 'in the dialer';
  // Without Gmail to check: an email Thuso sent before it stamped deliveries (19 Nov, 17:15) may have arrived.
  if (!sent && n(f.nurture_count) > 0 && Date.parse(f.nurture_last_sent_at || '') < Date.parse('2026-11-19T15:15:00Z')) return 'may have got an email (Gmail not checked)';
  return '';
}

/** Who Gmail sent to since `since` (the Sent folder), or null when the mailbox cannot be read. */
export async function sentRecipients(since: Date, tenantId = currentTenantId()): Promise<Set<string> | null> {
  const cfg = imapSettings(tenantId);
  if (!cfg) return null;
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.port === 993, auth: { user: cfg.user, pass: cfg.pass }, logger: false, socketTimeout: 60_000, greetingTimeout: 15_000 });
  const out = new Set<string>();
  try {
    await client.connect();
    const boxes = await client.list();
    const sentBox = boxes.find((b) => b.specialUse === '\\Sent') || boxes.find((b) => /^(\[gmail\]\/)?sent( mail| items)?$/i.test(b.path));
    if (!sentBox) return null;
    const lock = await client.getMailboxLock(sentBox.path, { readOnly: true });
    try {
      const uids = await client.search({ since }, { uid: true });
      if (uids && uids.length) {
        for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
          for (const a of [...(msg.envelope?.to || []), ...(msg.envelope?.cc || []), ...(msg.envelope?.bcc || [])]) {
            if (a?.address) out.add(a.address.toLowerCase());
          }
        }
      }
    } finally {
      lock.release();
    }
    return out;
  } catch (e) {
    console.warn('[thuso] could not read the Sent folder:', (e as Error).message);
    return null;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export interface CleanupPlan {
  keep: number;
  clear: number;
  why: Record<string, number>;
  gmailChecked: boolean;
  sample: string[];
  /** Of the cleared: never messaged at all, and tried but never reached. */
  never: number;
  failed: number;
  /** How many leads are old rows (in the sheet before Thuso started), and the days leads came in. */
  old: number;
  days: [string, number][];
}

/** The days leads came in (South African dates), busiest first. */
function arrivals(): Pick<CleanupPlan, 'old' | 'days'> {
  const recs = listRecords(LEADS_SOURCE_ID).filter((r) => r.fields.preview !== 'yes');
  const by = new Map<string, number>();
  for (const r of recs) {
    const day = new Date(r.firstSeenAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'Africa/Johannesburg' });
    by.set(day, (by.get(day) || 0) + 1);
  }
  return { old: recs.filter((r) => r.fields.imported_quietly === 'yes').length, days: [...by].sort((a, b) => b[1] - a[1]).slice(0, 6) };
}

const split = (clear: DataRecord[]) => {
  const failed = clear.filter((r) => n(r.fields.nurture_count) > 0).length;
  return { never: clear.length - failed, failed };
};

function plan(sent: Set<string> | null): { keep: DataRecord[]; clear: DataRecord[]; why: Record<string, number> } {
  const keep: DataRecord[] = [];
  const clear: DataRecord[] = [];
  const why: Record<string, number> = {};
  for (const r of listRecords(LEADS_SOURCE_ID)) {
    const reason = keepReason(r, sent);
    if (reason === 'a test lead') continue;
    if (reason) { keep.push(r); why[reason] = (why[reason] || 0) + 1; } else clear.push(r);
  }
  return { keep, clear, why };
}

// Thuso went live on 18 Nov 2026: Gmail's Sent folder is read from then on.
const SINCE = new Date('2026-11-17T22:00:00Z');

/** Who would stay and who would go. Nothing changes. */
export async function previewCleanup(tenantId = currentTenantId()): Promise<CleanupPlan> {
  const sent = await sentRecipients(SINCE, tenantId);
  const p = plan(sent);
  return { keep: p.keep.length, clear: p.clear.length, why: p.why, gmailChecked: Boolean(sent), sample: p.clear.slice(0, 8).map((r) => r.name), ...split(p.clear), ...arrivals() };
}

/** Clears the old rows Thuso never reached. Returns how many went and how many stayed. */
export async function runCleanup(tenantId = currentTenantId()): Promise<CleanupPlan> {
  const sent = await sentRecipients(SINCE, tenantId);
  const p = plan(sent);
  if (!p.clear.length) return { keep: p.keep.length, clear: 0, why: p.why, gmailChecked: Boolean(sent), sample: [], never: 0, failed: 0, ...arrivals() };

  // Counts that included sends which never arrived: saved messages sent, and each message's "sent".
  let sends = 0;
  const perMessage = new Map<string, number>();
  for (const r of p.clear) {
    sends += n(r.fields.nurture_count);
    for (const id of (r.fields.nurture_sent || '').split('|').filter(Boolean)) perMessage.set(id, (perMessage.get(id) || 0) + 1);
  }
  const m = meta(tenantId);
  m.stats.librarySends = Math.max(0, (m.stats.librarySends || 0) - sends);
  metaDoc.save(tenantId);
  const lib = libraryDoc.get(tenantId);
  for (const msg of lib) {
    const less = perMessage.get(msg.id);
    if (less) msg.stats.sent = Math.max(0, msg.stats.sent - less);
  }
  libraryDoc.save(tenantId);

  // Remembered, so the sheet does not bring them back (unless they enquire again).
  markCleared(LEADS_SOURCE_ID, p.clear, tenantId);
  const keys = new Set(p.clear.map((r) => r.key));
  removeRecords((r) => r.sourceId === LEADS_SOURCE_ID && keys.has(r.key));

  // Old campaigns: nobody left to send again to.
  for (const c of campaignDoc.get(tenantId)) if (c.failed > 0 && !c.failedKeys) c.failedKeys = [];
  campaignDoc.save(tenantId);

  log('system', 'system', `Leads cleaned up: ${p.clear.length} old sheet rows Thuso never reached were cleared; ${p.keep.length} leads stay (${Object.entries(p.why).map(([k, v]) => `${v} ${k}`).join(', ')}).`);
  return { keep: p.keep.length, clear: p.clear.length, why: p.why, gmailChecked: Boolean(sent), sample: p.clear.slice(0, 8).map((r) => r.name), ...split(p.clear), ...arrivals() };
}
