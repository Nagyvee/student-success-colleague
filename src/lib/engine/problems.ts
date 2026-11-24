import { tenantDoc } from './tenantDoc';
import { currentTenantId } from '@/lib/auth/tenantContext';

/* What is broken right now, and what was.
 *
 * Whatever sends or reads (WhatsApp, email, the mailbox, the dialer, the AI)
 * says when it failed and when it worked. A problem is open from its first
 * failure until it works again. One that may pass by itself (a timeout) only
 * counts once it has lasted; one that cannot (a refused key, an unpaid plan)
 * counts at once. The daily report, the Lead Nurturing page and the Discord
 * alerts read it from here, so a thing that stopped is never just a low
 * number. */

export type ProblemKey = 'whatsapp' | 'whatsapp_connect' | 'whatsapp_answer' | 'email' | 'mailbox' | 'leads' | 'leads_tabs' | 'ai' | 'voice';

interface Kind { what: string; was: string; fix: string; critical: boolean; graceMs: number }
const MIN = 60_000;

/** What each one is called, what to do about it, and how long it may last before it counts. Most important first. */
export const KINDS: Record<ProblemKey, Kind> = {
  whatsapp: { what: 'WhatsApp follow-ups are not going out', was: 'WhatsApp follow-ups stopped', fix: 'In ManyChat, check the subscription and billing, and Settings → WhatsApp. Then press "Check ManyChat" in Thuso (Channels & API).', critical: true, graceMs: 30 * MIN },
  whatsapp_answer: { what: 'WhatsApp answers are not reaching leads who wrote', was: 'WhatsApp answers did not reach leads', fix: 'Answer them in ManyChat, and check its subscription and Settings → WhatsApp.', critical: true, graceMs: 30 * MIN },
  whatsapp_connect: { what: 'Thuso cannot use the ManyChat account', was: 'Thuso could not use ManyChat', fix: 'In ManyChat, check the subscription and billing, and that the API key is still the one in Thuso.', critical: true, graceMs: 45 * MIN },
  email: { what: 'Emails are not going out', was: 'Emails stopped', fix: 'Check the sending mailbox: its password, its daily limit, and that the server can reach it.', critical: true, graceMs: 20 * MIN },
  leads: { what: 'New leads are not coming in', was: 'New leads stopped coming in', fix: 'Check that the dialer works and that its API key in Thuso is still right.', critical: true, graceMs: 15 * MIN },
  mailbox: { what: 'Replies to our emails are not being read', was: 'Replies were not read', fix: 'Check the mailbox sign-in and that IMAP is on. Until then, answer replies by hand.', critical: true, graceMs: 20 * MIN },
  ai: { what: 'The AI is not writing', was: 'The AI stopped writing', fix: 'Check the AI account: its credit and its API key. Saved messages still go; personal ones use simple wording.', critical: true, graceMs: 30 * MIN },
  leads_tabs: { what: 'The other lead tabs (TikTok, WhatsApp) cannot be read', was: 'The other lead tabs could not be read', fix: 'Check that the sheet is still shared.', critical: false, graceMs: 15 * MIN },
  voice: { what: 'New videos have no recorded voice', was: 'New videos had no recorded voice', fix: 'Check the voice account: its credit and its key.', critical: false, graceMs: 30 * MIN },
};
const ORDER = Object.keys(KINDS) as ProblemKey[];

export interface Problem {
  key: ProblemKey; critical: boolean;
  /** The last reason given, safe to show the team. */
  why: string;
  firstAt: number; lastAt: number; times: number;
  /** It cannot pass by itself: it counts at once. */
  sure: boolean;
  /** Who was affected. */
  people: string[];
  fixedAt?: number;
  /** When the team was told (Discord), and told it works again. */
  toldAt?: number; toldFixedAt?: number;
}

interface Doc { open: Partial<Record<ProblemKey, Problem>>; past: Problem[]; told: Partial<Record<ProblemKey, number>> }
const doc = tenantDoc<Doc>('problems', () => ({ open: {}, past: [], told: {} }));

const STALE_MS = 3 * 86_400_000;

/** A reason the whole team may read: no keys, tokens, links or addresses in it, and short. */
export function safeReason(why: string): string {
  // An API's answer in JSON: its message is what a person can read.
  const said = /"message"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(String(why || ''))?.[1];
  return String(said || why || '')
    .replace(/https?:\/\/\S+/gi, '(link)')
    .replace(/[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+/g, '(address)')
    .replace(/\b(?:sk|pk|zad)[-_][\w*.-]{6,}|\bbearer\s+\S+/gi, '(key)')
    .replace(/[A-Za-z0-9_-]{28,}/g, '(…)')
    .replace(/\s+/g, ' ').trim().slice(0, 220);
}

const counts = (p: Problem) => p.sure || p.lastAt - p.firstAt >= KINDS[p.key].graceMs;

/** Something failed. `sure`: it will not pass by itself. */
export function noteProblem(key: ProblemKey, o: { why: string; sure?: boolean; person?: string; critical?: boolean }, tenantId = currentTenantId(), now = Date.now()): void {
  const d = doc.get(tenantId);
  const old = d.open[key];
  // The last failure was days ago, and nothing was tried since: a new problem, not the same one.
  const prev = old && now - old.lastAt < STALE_MS ? old : undefined;
  const critical = o.critical ?? KINDS[key].critical;
  const p: Problem = prev || { key, critical, why: '', firstAt: now, lastAt: now, times: 0, sure: false, people: [] };
  p.critical = p.critical || critical;
  p.why = safeReason(o.why) || p.why || 'no reason was given';
  p.lastAt = now;
  p.times++;
  p.sure = p.sure || Boolean(o.sure);
  const who = (o.person || '').trim().slice(0, 60);
  if (who && !p.people.includes(who)) p.people = [...p.people, who].slice(-20);
  d.open[key] = p;
  doc.save(tenantId);
}

/** It works: the problem, if there was one, is over. */
export function noteFine(key: ProblemKey, tenantId = currentTenantId(), now = Date.now()): void {
  const d = doc.get(tenantId);
  const p = d.open[key];
  if (!p) return;
  delete d.open[key];
  if (counts(p)) d.past = [...d.past, { ...p, fixedAt: now }].slice(-40);
  doc.save(tenantId);
}

/** It was switched off: neither broken nor put right. */
export function dropProblem(key: ProblemKey, tenantId = currentTenantId()): void {
  const d = doc.get(tenantId);
  if (!d.open[key]) return;
  delete d.open[key];
  doc.save(tenantId);
}

/** Is it failing now (counted yet or not)? */
export const isFailing = (key: ProblemKey, tenantId = currentTenantId()): boolean => Boolean(doc.get(tenantId).open[key]);

/** What is broken now, the most important first. */
export function openProblems(tenantId = currentTenantId(), now = Date.now()): Problem[] {
  const d = doc.get(tenantId);
  const list = ORDER.map((k) => d.open[k]).filter((p): p is Problem => Boolean(p && counts(p) && now - p.lastAt < STALE_MS));
  // Nothing goes out because the account cannot be used: said once.
  return list.some((p) => p.key === 'whatsapp') ? list.filter((p) => p.key !== 'whatsapp_connect') : list;
}

/** What broke and works again, in a window. */
export function fixedProblems(from: number, to: number, tenantId = currentTenantId()): Problem[] {
  const list = doc.get(tenantId).past.filter((p) => (p.fixedAt || 0) > from && (p.fixedAt || 0) <= to);
  return list.some((p) => p.key === 'whatsapp') ? list.filter((p) => p.key !== 'whatsapp_connect') : list;
}

const AGAIN_MS = 2 * 3_600_000;

/** What the team has not been told yet: critical problems that broke, and ones they were told about that work again.
 *  One that comes and goes is told at most every two hours. */
export function untold(tenantId = currentTenantId(), now = Date.now()): { broke: Problem[]; fixed: Problem[] } {
  const d = doc.get(tenantId);
  return {
    broke: openProblems(tenantId, now).filter((p) => p.critical && !p.toldAt && now - (d.told[p.key] || 0) >= AGAIN_MS
      // Told already that the account cannot be used: the same thing.
      && !(p.key === 'whatsapp' && d.open.whatsapp_connect?.toldAt)),
    fixed: d.past.filter((p) => p.toldAt && !p.toldFixedAt && now - (p.fixedAt || 0) < 86_400_000),
  };
}

/** The team was told about it. */
export function markTold(p: Problem, tenantId = currentTenantId(), now = Date.now()): void {
  const d = doc.get(tenantId);
  if (p.fixedAt) p.toldFixedAt = now;
  else { p.toldAt = now; d.told[p.key] = now; }
  doc.save(tenantId);
}
