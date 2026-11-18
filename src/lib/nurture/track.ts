import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DataRecord } from '@/lib/types';
import type { Engagement, TrackPayload } from './types';
import { derivedKey } from '@/lib/auth/accounts';
import { getRecord, setRecordField } from '@/lib/data/records';
import { getSource } from '@/lib/data/sources';
import { log as storeLog } from '@/lib/engine/store';

/** Lead nurturing is Admissions' work: its activity shows on that floor. */
const log: typeof storeLog = (actor, level, text, extra = {}) => storeLog(actor, level, text, { dept: 'admissions', ...extra });
import { bankDoc, bumpStat, libraryDoc } from './store';

/* Tracked links and what a lead's clicks mean.
 *
 * Every link in a nurture message carries a small signed token (who, which
 * message, where to) so a click can be counted without storing a row per
 * link. Opens (a 1-pixel image) count a little, clicks more, the career-fit
 * quiz and the video most. The score decides how warm a lead is, and a lead
 * turning hot starts the agents that give them personal attention. */

const TARGETS = new Set(['enrol', 'call', 'apply', 'quiz', 'video', 'resource', 'reply', 'url', 'open', 'unsub', 'res']);

export function signTrack(p: TrackPayload): string {
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  const sig = createHmac('sha256', derivedKey('track')).update(body).digest().subarray(0, 12).toString('base64url');
  return `${body}.${sig}`;
}

export function readTrack(token: string): TrackPayload | null {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', derivedKey('track')).update(body).digest().subarray(0, 12);
  let got: Buffer;
  try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TrackPayload;
    if (!p || typeof p.t !== 'string' || typeof p.s !== 'string' || typeof p.k !== 'string' || typeof p.m !== 'string' || !TARGETS.has(p.x)) return null;
    if (p.u !== undefined && (typeof p.u !== 'string' || !/^https?:\/\//i.test(p.u))) return null;
    return p;
  } catch {
    return null;
  }
}

/** The public link for a payload: /go/<token> (click), ?o=1 (open pixel), ?u=1 (unsubscribe). */
export function trackUrl(baseUrl: string, p: TrackPayload, mode?: 'o' | 'u'): string {
  return `${baseUrl.replace(/\/$/, '')}/go/${signTrack(p)}${mode ? `?${mode}=1` : ''}`;
}

/** Link checkers and mail scanners open links too; they are not people. */
export function isBot(userAgent: string | null | undefined): boolean {
  const ua = (userAgent || '').toLowerCase();
  if (!ua) return true;
  return /bot|crawl|spider|preview|scanner|safelinks|proofpoint|mimecast|barracuda|slurp|facebookexternalhit|whatsapp|curl|wget|python-requests|headless/.test(ua);
}

/* ── Engagement ───────────────────────────────────────────────────────────── */

export type EngagementKind = 'open' | 'click' | 'quiz' | 'video' | 'reply' | 'unsub';

/** What each kind of action is worth. Counted once per message (or resource). */
export const SCORE: Record<Exclude<EngagementKind, 'unsub'>, number> = { open: 1, click: 3, video: 4, quiz: 5, reply: 6 };

export function engagementFor(score: number): Engagement {
  if (score >= 8) return 'hot';
  if (score >= 3) return 'warm';
  return 'cold';
}

const num = (v: string | undefined) => {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
};

/** The pure part: given the record's fields and an action, the field updates. */
export function scoreUpdate(fields: Record<string, string>, kind: Exclude<EngagementKind, 'unsub'>, uniqueKey: string, now = new Date()): { updates: Record<string, string>; counted: boolean } {
  const seen = (fields.nurture_seen || '').split('|').filter(Boolean);
  const counted = !seen.includes(uniqueKey);
  const updates: Record<string, string> = {};
  if (kind === 'open') updates.nurture_opens = String(num(fields.nurture_opens) + (counted ? 1 : 0));
  if (kind === 'click') updates.nurture_clicks = String(num(fields.nurture_clicks) + 1);
  if (counted) {
    const score = num(fields.engagement_score) + SCORE[kind];
    updates.engagement_score = String(score);
    updates.engagement = engagementFor(score);
    updates.nurture_seen = [...seen, uniqueKey].slice(-80).join('|');
  }
  if (kind !== 'open') updates.last_engaged_at = now.toISOString();
  return { updates, counted };
}

/** A lead did something with a message. Updates the record, the stats, and
 *  starts the agents waiting for "a lead turned warm / hot". */
export async function noteEngagement(p: TrackPayload, kind: EngagementKind, detail = ''): Promise<DataRecord | null> {
  const rec = getRecord(p.s, p.k);
  if (!rec) return null;
  const first = rec.name.split(/\s+/)[0] || rec.name;

  if (kind === 'unsub') {
    if (rec.fields.opted_out === 'yes') return rec;
    setRecordField(p.s, p.k, 'opted_out', 'yes');
    setRecordField(p.s, p.k, 'opted_out_at', new Date().toISOString());
    bumpStat('optOuts');
    log('system', 'info', `${rec.name} asked not to get marketing messages. Nurturing for them stops now.`);
    const { stopRunsFor } = await import('@/lib/engine/agentRuns');
    stopRunsFor(rec.email, rec.key, 'They unsubscribed from marketing messages.');
    return rec;
  }

  // A team member previewing the quiz or video: their preview lead changes, nothing else does.
  if (rec.fields.preview === 'yes') {
    const { updates } = scoreUpdate(rec.fields, kind, `${kind}:${p.m}:${p.r || p.x}`);
    for (const [k, v] of Object.entries(updates)) setRecordField(p.s, p.k, k, v);
    return getRecord(p.s, p.k);
  }

  const target = kind === 'open' ? 'open' : (p.r || p.x);
  const { updates, counted } = scoreUpdate(rec.fields, kind, `${kind}:${p.m}:${target}`);
  const before = rec.fields.engagement || 'cold';
  for (const [k, v] of Object.entries(updates)) setRecordField(p.s, p.k, k, v);
  if (kind === 'click' && detail) setRecordField(p.s, p.k, 'last_clicked', detail.slice(0, 120));

  // The message and resource counters (unique per lead).
  if (counted && p.m.startsWith('msg_')) {
    const msg = libraryDoc.get().find((m) => m.id === p.m);
    if (msg) {
      if (kind === 'open') msg.stats.opened++;
      if (kind === 'click') msg.stats.clicked++;
      libraryDoc.save();
    }
  }
  if (counted && kind === 'click' && p.r) {
    const res = bankDoc.get().find((r) => r.id === p.r);
    if (res) { res.stats.clicks++; bankDoc.save(); }
  }
  if (counted) bumpStat(kind === 'open' ? 'opens' : kind === 'click' ? 'clicks' : kind === 'quiz' ? 'quizzes' : kind === 'video' ? 'videoViews' : 'clicks');

  const after = updates.engagement || before;
  if (kind !== 'open') {
    const what = kind === 'quiz' ? 'took the career-fit quiz' : kind === 'video' ? 'watched their programme video' : kind === 'reply' ? 'replied' : `opened ${detail ? `"${detail}"` : 'a link'}`;
    log('system', 'lms', `${rec.name} ${what}.${after !== before ? ` ${first} is now a ${after} lead.` : ''}`);
  }

  // 8 points and up: a qualified lead (the team hears on Discord, the dialer gets them with a brief).
  if (after === 'hot' && before !== 'hot') {
    const { qualifyLead } = await import('./qualify');
    await qualifyLead(p.s, p.k, { reason: 'hot', detail: detail || undefined }).catch((e) => console.warn('[thuso] qualify failed:', (e as Error).message));
  }

  // Agents react to a lead warming up (record.changed on "engagement").
  const fresh = getRecord(p.s, p.k);
  if (fresh) {
    const changed = Object.keys(updates).filter((k) => k !== 'nurture_seen');
    const { noteFacts } = await import('@/lib/engine/agentRuns');
    if (fresh.email) noteFacts(fresh.email, { engagement: after, engagement_score: fresh.fields.engagement_score || '0' });
    if (after !== before) {
      const source = getSource(p.s);
      const { dispatchRecordEvents } = await import('@/lib/engine/agentTriggers');
      if (source) await dispatchRecordEvents([{ source, record: fresh, kind: 'changed', changed: changed.includes('engagement') ? changed : [...changed, 'engagement'] }]);
    }
  }
  return fresh;
}
