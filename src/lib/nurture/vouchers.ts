import { randomBytes } from 'node:crypto';
import type { DataRecord } from '@/lib/types';
import type { Voucher, VoucherOffer } from './types';
import { offerDoc, voucherDoc, nid } from './store';
import { getRecord, setRecordField } from '@/lib/data/records';
import { log as storeLog } from '@/lib/engine/store';

/** Lead nurturing is Admissions' work: its activity shows on that floor. */
const log: typeof storeLog = (actor, level, text, extra = {}) => storeLog(actor, level, text, { dept: 'admissions', ...extra });

/* Vouchers: the team writes the offer once, code makes the codes.
 *
 * An offer is a template a person approves ("R500 off the registration fee,
 * valid 14 days, can be passed on to a friend"). When an agent decides a lead
 * should get one, a unique code is made here (never by the model), written on
 * the lead's record and in the ledger, and merged into the email. The team
 * marks a code as used when it is redeemed; a lead can pass a shareable code
 * to a friend, who then comes in as a lead of their own. */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

export function listOffers(): VoucherOffer[] {
  return offerDoc.get();
}

export function getOffer(id: string | undefined): VoucherOffer | null {
  if (!id) return null;
  return offerDoc.get().find((o) => o.id === id) || null;
}

export function listVouchers(): Voucher[] {
  return voucherDoc.get().filter((v) => !v.preview);
}

export function findVoucher(code: string): Voucher | null {
  const c = code.trim().toUpperCase();
  return voucherDoc.get().find((v) => v.code === c) || null;
}

/** "R 1,000 off" or "50% off". */
export function valueText(o: Pick<VoucherOffer, 'kind' | 'value'>): string {
  return o.kind === 'percent' ? `${Math.round(o.value)}% off` : `R ${Math.round(o.value).toLocaleString('en-ZA').replace(/[  ]/g, ' ')} off`;
}

export const dateText = (ms: number) => new Date(ms).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });

/** When a code given now stops working. */
export function expiresFor(o: VoucherOffer, now = Date.now()): number {
  if (o.expiry.kind === 'date') return o.expiry.date;
  const end = new Date(now + o.expiry.days * 86_400_000);
  end.setHours(23, 59, 0, 0);
  return end.getTime();
}

/** Can this offer be given out right now? */
export function offerLive(o: VoucherOffer, now = Date.now()): boolean {
  if (o.status !== 'active') return false;
  if (o.expiry.kind === 'date' && o.expiry.date <= now) return false;
  if (o.maxIssued && o.stats.issued >= o.maxIssued) return false;
  return true;
}

/** MEL-THAN-7K3Q: the prefix, four letters of their name, four random characters. */
export function makeCode(prefix: string, name: string): string {
  const p = (prefix || 'MEL').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'MEL';
  const n = (name || 'X').toUpperCase().normalize('NFKD').replace(/[^A-Z]/g, '').slice(0, 4).padEnd(4, 'X');
  const taken = new Set(voucherDoc.get().map((v) => v.code));
  for (;;) {
    const r = [...randomBytes(4)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    const code = `${p}-${n}-${r}`;
    if (!taken.has(code)) return code;
  }
}

/** Give a lead a code for an offer (the same one again if they already have it). */
export function issueVoucher(o: VoucherOffer, rec: Pick<DataRecord, 'key' | 'sourceId' | 'name' | 'fields'>, opts: { preview?: boolean } = {}): Voucher {
  const now = Date.now();
  const existing = voucherDoc.get().find((v) => v.offerId === o.id && v.leadKey === rec.key && v.sourceId === rec.sourceId && v.status === 'issued' && v.expiresAt > now);
  const v: Voucher = existing || {
    code: makeCode(o.prefix, (rec.fields.first_name || rec.name).split(/\s+/)[0]),
    offerId: o.id, sourceId: rec.sourceId, leadKey: rec.key, leadName: rec.name,
    issuedAt: now, expiresAt: expiresFor(o, now), status: 'issued', referred: [],
    ...(opts.preview ? { preview: true } : {}),
  };
  if (!existing) {
    voucherDoc.get().unshift(v);
    voucherDoc.save();
    if (!opts.preview) {
      o.stats.issued++;
      offerDoc.save();
      log('system', 'approve', `Voucher ${v.code} (${valueText(o)} ${o.appliesTo}) given to ${rec.name}, valid until ${dateText(v.expiresAt)}.`);
    }
  }
  // On the record, so agents and messages can mention it.
  setRecordField(rec.sourceId, rec.key, 'voucher_code', v.code);
  setRecordField(rec.sourceId, rec.key, 'voucher_value', `${valueText(o)} ${o.appliesTo}`);
  setRecordField(rec.sourceId, rec.key, 'voucher_expires', dateText(v.expiresAt));
  return v;
}

/** Merge fields for a voucher email. */
export function voucherVars(v: Pick<Voucher, 'code' | 'expiresAt'>, o: VoucherOffer): Record<string, string> {
  return { voucher_code: v.code, voucher_value: valueText(o), voucher_for: o.appliesTo, voucher_expires: dateText(v.expiresAt) };
}

/** The offer an agent should give this lead: live, not one they already hold, personal (days) before a promotion (date). */
export function bestOfferFor(rec: Pick<DataRecord, 'key' | 'sourceId'>, preferId?: string): VoucherOffer | null {
  const now = Date.now();
  const held = new Set(voucherDoc.get().filter((v) => v.leadKey === rec.key && v.sourceId === rec.sourceId).map((v) => v.offerId));
  if (preferId) {
    const o = getOffer(preferId);
    return o && offerLive(o, now) && !held.has(o.id) ? o : null;
  }
  return offerDoc.get()
    .filter((o) => offerLive(o, now) && !held.has(o.id))
    .sort((a, b) => Number(a.expiry.kind === 'date') - Number(b.expiry.kind === 'date') || b.createdAt - a.createdAt)[0] || null;
}

/** For the agents: what can be offered, in words (they never make up a code or an amount). */
export function offersText(): string {
  const live = offerDoc.get().filter((o) => offerLive(o));
  if (!live.length) return '';
  return `Vouchers the academy gives (a colleague's system issues the code; never invent one):\n${live.map((o) => `- ${o.name}: ${valueText(o)} ${o.appliesTo}, ${o.expiry.kind === 'date' ? `until ${dateText(o.expiry.date)}` : `valid ${o.expiry.days} days from when it is given`}${o.shareable ? ', can be passed on to a friend' : ''}`).join('\n')}`;
}

/* ── The team ─────────────────────────────────────────────────────────────── */

export function saveOffer(input: Partial<VoucherOffer> & { name: string }): VoucherOffer {
  const prev = input.id ? getOffer(input.id) : null;
  const now = Date.now();
  const kind = input.kind === 'percent' ? 'percent' : input.kind === 'amount' ? 'amount' : prev?.kind || 'amount';
  const value = Math.max(1, Math.min(kind === 'percent' ? 100 : 1_000_000, Number(input.value ?? prev?.value ?? 500) || 500));
  const expiry = input.expiry && input.expiry.kind === 'date' && Number(input.expiry.date) > 0
    ? { kind: 'date' as const, date: Number(input.expiry.date) }
    : input.expiry && input.expiry.kind === 'days'
      ? { kind: 'days' as const, days: Math.max(1, Math.min(365, Math.round(Number(input.expiry.days) || 14))) }
      : prev?.expiry || { kind: 'days' as const, days: 14 };
  const changedTerms = !prev || prev.kind !== kind || prev.value !== value || JSON.stringify(prev.expiry) !== JSON.stringify(expiry) || (input.body !== undefined && input.body !== prev.body) || (input.subject !== undefined && input.subject !== prev.subject);
  const o: VoucherOffer = {
    id: prev?.id || nid('vof'),
    name: input.name.trim().slice(0, 60) || prev?.name || 'Voucher',
    kind, value, expiry,
    appliesTo: (input.appliesTo ?? prev?.appliesTo ?? 'the registration fee').trim().slice(0, 80) || 'the registration fee',
    shareable: input.shareable ?? prev?.shareable ?? true,
    prefix: (input.prefix ?? prev?.prefix ?? 'MEL').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'MEL',
    subject: (input.subject ?? prev?.subject ?? DEFAULT_SUBJECT).trim().slice(0, 160),
    body: (input.body ?? prev?.body ?? DEFAULT_BODY).replace(/\r\n/g, '\n').trim().slice(0, 3000),
    // New terms go back to draft: a person approves what is given away.
    status: input.status === 'paused' ? 'paused' : prev && !changedTerms ? prev.status : 'draft',
    maxIssued: input.maxIssued === null ? null : Number(input.maxIssued) > 0 ? Math.round(Number(input.maxIssued)) : prev?.maxIssued ?? null,
    approvedBy: prev && !changedTerms ? prev.approvedBy : undefined,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    stats: prev?.stats || { issued: 0, redeemed: 0, shared: 0 },
  };
  const list = offerDoc.get();
  const i = list.findIndex((x) => x.id === o.id);
  if (i >= 0) list[i] = o; else list.unshift(o);
  offerDoc.save();
  return o;
}

export function setOfferStatus(id: string, status: VoucherOffer['status'], by: string): VoucherOffer | null {
  const o = getOffer(id);
  if (!o) return null;
  o.status = status;
  if (status === 'active') o.approvedBy = by;
  o.updatedAt = Date.now();
  offerDoc.save();
  return o;
}

export function deleteOffer(id: string): boolean {
  const before = offerDoc.get().length;
  offerDoc.set(offerDoc.get().filter((o) => o.id !== id));
  return offerDoc.get().length < before;
}

/** The team marks a code as used (at enrolment). */
export function redeemVoucher(code: string, by: string): { voucher: Voucher | null; error?: string } {
  const v = findVoucher(code);
  if (!v) return { voucher: null, error: 'No voucher with that code.' };
  if (v.status === 'redeemed') return { voucher: v, error: `Already used on ${dateText(v.redeemedAt || 0)}.` };
  if (v.status === 'cancelled') return { voucher: v, error: 'That voucher was cancelled.' };
  v.status = 'redeemed';
  v.redeemedAt = Date.now();
  v.redeemedBy = by;
  voucherDoc.save();
  const o = getOffer(v.offerId);
  if (o) { o.stats.redeemed++; offerDoc.save(); }
  if (getRecord(v.sourceId, v.leadKey)) setRecordField(v.sourceId, v.leadKey, 'voucher_redeemed', 'yes');
  log('system', 'approve', `Voucher ${v.code} used (${v.leadName}).`);
  return { voucher: v };
}

export function cancelVoucher(code: string): boolean {
  const v = findVoucher(code);
  if (!v || v.status !== 'issued') return false;
  v.status = 'cancelled';
  voucherDoc.save();
  return true;
}

/** A friend opened a shared voucher and left their details: they become a lead, with the code. */
export async function claimShared(code: string, friend: { name: string; email: string; phone: string; interest?: string }): Promise<{ ok: boolean; error?: string; first?: string; sample?: boolean }> {
  const v = findVoucher(code);
  const o = v ? getOffer(v.offerId) : null;
  if (!v || !o) return { ok: false, error: 'That voucher does not exist.' };
  if (!o.shareable) return { ok: false, error: 'This voucher cannot be passed on.' };
  if (v.status !== 'issued' || v.expiresAt < Date.now()) return { ok: false, error: 'This voucher has been used or has expired.' };
  if (!friend.name.trim() || (!/@/.test(friend.email) && friend.phone.replace(/\D/g, '').length < 9)) return { ok: false, error: 'Leave your name and an email or phone number.' };
  // A team member's sample voucher: show what would happen, create nobody.
  if (v.preview) return { ok: true, first: friend.name.trim().split(/\s+/)[0], sample: true };
  const { receiveLead } = await import('@/lib/engine/agentTriggers');
  const r = await receiveLead({
    full_name: friend.name.trim().slice(0, 80), email: friend.email.trim().slice(0, 120), phone_number: friend.phone.trim().slice(0, 30),
    interest: (friend.interest || '').slice(0, 80), source: `Referral from ${v.leadName}`, voucher_code: v.code, referred_by: v.leadName,
  });
  // The friend's record carries the voucher too, so the agents can mention it.
  setRecordField(r.record.sourceId, r.record.key, 'voucher_value', `${valueText(o)} ${o.appliesTo}`);
  setRecordField(r.record.sourceId, r.record.key, 'voucher_expires', dateText(v.expiresAt));
  if (!v.referred.includes(r.record.key)) {
    v.referred.push(r.record.key);
    voucherDoc.save();
    o.stats.shared++;
    offerDoc.save();
  }
  log('system', 'lms', `${r.record.name} claimed ${v.leadName}'s voucher ${v.code} and is now a lead.`);
  return { ok: true, first: r.record.name.split(/\s+/)[0] };
}

/* ── Starters ─────────────────────────────────────────────────────────────── */

const DEFAULT_SUBJECT = '{{first_name}}, a voucher for you: {{voucher_value}} {{voucher_for}}';
const DEFAULT_BODY = `Hi {{first_name}},

Thank you for taking the time to look at what studying with us could mean for you. We'd like to make starting a little easier, so here is a voucher in your name: {{voucher_value}} {{voucher_for}}.

Use your code when you apply. It is valid until {{voucher_expires}}, and if someone close to you is thinking about tech too, you can pass it on to them.`;

/** Two drafts to start from (nothing is given away until a person makes them active). */
export function seedStarterOffers(now = new Date()): VoucherOffer[] {
  if (offerDoc.get().length) return [];
  const year = now.getMonth() === 11 && now.getDate() > 1 ? now.getFullYear() + 1 : now.getFullYear();
  const bfEnd = new Date(year, 10, 30, 23, 59).getTime();
  return [
    saveOffer({ name: 'Thank-you voucher', kind: 'amount', value: 500, appliesTo: 'the registration fee', expiry: { kind: 'days', days: 14 }, shareable: true, prefix: 'MEL' }),
    saveOffer({
      name: 'Black Friday', kind: 'amount', value: 1000, appliesTo: 'the registration fee', expiry: { kind: 'date', date: bfEnd }, shareable: true, prefix: 'BF',
      subject: 'Black Friday, {{first_name}}: {{voucher_value}} {{voucher_for}}',
      body: `Hi {{first_name}},\n\nFor Black Friday we are giving everyone who has been thinking about studying with us {{voucher_value}} {{voucher_for}}, and this one is in your name.\n\nUse your code when you apply. It is valid until {{voucher_expires}}. If a friend or family member is thinking about tech too, you can pass it on to them.`,
    }),
  ];
}
