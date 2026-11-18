import type { DataRecord, MessageChannel } from '@/lib/types';
import type { Audience, CtaTarget, NurtureMessage, NurtureResource, NurtureStage, TrackPayload } from './types';
import { AUDIENCES, NURTURE_STAGES } from './types';
import { bumpStat, libraryDoc, bankDoc, nid } from './store';
import { getResource, leadAudience, pickResources, bankKnowledge, SHAREABLE } from './bank';
import { leadProgramme, programmeList } from './programmes';
import { leadProfile } from './profile';
import { trackUrl } from './track';
import type { VoucherOffer } from './types';
import { dateText, expiresFor, getOffer, issueVoucher, offerLive, valueText, voucherVars } from './vouchers';
import { unsubscribeHeaders } from '@/lib/email/send';
import { auditAgentMessage } from '@/lib/engine/agentAudit';
import { complete, generateJSON, isStr, noEmoji, obj } from '@/lib/ai/llm';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import { emailShell, esc, formatHtmlParagraphs, sendMail, sendManyChat, sendWhatsApp, signatureBlock } from '@/lib/email/send';
import { appendConversation, getConversation, getRecord, setRecordField } from '@/lib/data/records';
import { isoDate } from '@/lib/data/conditions';
import { getState, log } from '@/lib/engine/store';

/* The message library: write once, send to many.
 *
 * A message is written once (by a person, or by AI from a one-line brief),
 * checked once by the same reviewer rules the agents use, approved once by a
 * person, and then sent to every lead it fits. Each lead's name and programme
 * are merged in, the resources that fit them are attached as cards, and every
 * link is tracked. Sending a saved message costs no AI at all. */

export const MERGE_FIELDS = ['first_name', 'programme', 'academy', 'sender', 'voucher_code', 'voucher_value', 'voucher_for', 'voucher_expires'] as const;

/* ── Reading and saving ───────────────────────────────────────────────────── */

export function listMessages(): NurtureMessage[] {
  return libraryDoc.get();
}

export function getMessage(id: string | undefined): NurtureMessage | null {
  if (!id) return null;
  return libraryDoc.get().find((m) => m.id === id) || null;
}

function put(m: NurtureMessage) {
  const list = libraryDoc.get();
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) list[i] = m; else list.unshift(m);
  libraryDoc.save();
}

/** {{field}} → value. Unknown fields stay visible so the check catches them. */
export function mergeText(t: string, vars: Record<string, string>): string {
  return t.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, k: string) => (k.toLowerCase() in vars ? vars[k.toLowerCase()] : whole));
}

export function leadVars(rec: Pick<DataRecord, 'name' | 'fields'>, senderName: string): Record<string, string> {
  const ac = getAcademyContext();
  const first = (rec.fields.first_name || rec.name || '').split(/\s+/)[0] || 'there';
  return { first_name: first, programme: leadProgramme(rec.fields) || 'tech', academy: ac.academyName, sender: senderName };
}

/** The reviewer's rules, run on the message as a sample lead would get it. */
export function checkMessage(m: Pick<NurtureMessage, 'subject' | 'body' | 'channel' | 'cta' | 'programme' | 'expiresAt' | 'waBody'>): { pass: boolean; notes: string[] } {
  const notes: string[] = [];
  const sample = { first_name: 'Thandi', programme: m.programme || programmeList()[0] || 'Software Development', academy: getAcademyContext().academyName, sender: 'Naledi', voucher_code: 'MEL-THAN-7K3Q', voucher_value: 'R 500 off', voucher_for: 'the registration fee', voucher_expires: '30 November' };
  if (!/\{\{\s*first_name\s*\}\}/i.test(m.body)) notes.push('Use {{first_name}} in the message so every lead is greeted by name.');
  const unknown = [...`${m.subject} ${m.body} ${m.waBody || ''}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((x) => x[1].toLowerCase()).filter((k) => !(MERGE_FIELDS as readonly string[]).includes(k));
  if (unknown.length) notes.push(`Unknown merge field${unknown.length > 1 ? 's' : ''}: ${[...new Set(unknown)].map((k) => `{{${k}}}`).join(', ')}. Use ${MERGE_FIELDS.map((k) => `{{${k}}}`).join(', ')}.`);
  if (/https?:\/\//i.test(m.body)) notes.push('Put links in the button or as resource cards, not in the text, so clicks are tracked.');
  if (/(\b\d{1,3}\s?(%|percent\b)|\bhalf price\b|\bdiscount|\bfree registration\b|\bspecial offer\b|\bpromo(tion)?\b)/i.test(`${m.subject} ${m.body}`) && !m.expiresAt) notes.push('This looks like an offer: give it an end date so it is never sent after it ends.');
  const merged = mergeText(m.body, sample);
  const withAsk = m.cta.target === 'reply' ? merged : `${merged}\n\n${m.cta.label}`;
  const verdict = auditAgentMessage({ body: withAsk, subject: mergeText(m.subject, sample), firstName: sample.first_name, channel: m.channel === 'whatsapp' ? 'whatsapp' : 'email', department: 'admissions', fields: {} });
  notes.push(...verdict.notes
    .filter((n) => !/placeholder/i.test(n) || unknown.length === 0)
    // The button is the next step when there is one.
    .filter((n) => !(m.cta.target !== 'reply' && /no clear next step/i.test(n))));
  return { pass: notes.length === 0, notes };
}

const cleanCta = (x: unknown): NurtureMessage['cta'] => {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const targets: CtaTarget[] = ['apply', 'quiz', 'video', 'resource', 'reply', 'url'];
  const target = targets.includes(o.target as CtaTarget) ? (o.target as CtaTarget) : 'reply';
  const label = (typeof o.label === 'string' && o.label.trim() ? o.label.trim() : DEFAULT_CTA[target]).slice(0, 60);
  const out: NurtureMessage['cta'] = { target, label };
  if (target === 'resource' && typeof o.resourceId === 'string') out.resourceId = o.resourceId;
  if (target === 'url' && typeof o.url === 'string' && /^https?:\/\//i.test(o.url.trim())) out.url = o.url.trim().slice(0, 500);
  return out;
};

export const DEFAULT_CTA: Record<CtaTarget, string> = {
  apply: 'Start my application',
  quiz: 'Find my tech fit (2 min)',
  video: 'Watch my video',
  resource: 'Open it',
  reply: 'Just reply to this email',
  url: 'Have a look',
};

/** Save (create or edit). Any edit sends an approved message back to draft: a person approves what is sent. */
export function saveMessage(input: Partial<NurtureMessage> & { name: string; subject: string; body: string }, origin: NurtureMessage['origin'] = 'person'): NurtureMessage {
  if (input.funding) input.funding = input.funding.filter((x) => ['self', 'family', 'loan', 'employer', 'undecided'].includes(x));
  const prev = input.id ? getMessage(input.id) : null;
  const now = Date.now();
  const stage = NURTURE_STAGES.includes(input.stage as NurtureStage) ? (input.stage as NurtureStage) : prev?.stage || 'learn';
  const audience = AUDIENCES.includes(input.audience as Audience) ? (input.audience as Audience) : prev?.audience || 'everyone';
  const channel: MessageChannel = input.channel === 'whatsapp' || input.channel === 'email_whatsapp' ? input.channel : input.channel === 'email' ? 'email' : prev?.channel || 'email';
  const resourceIds = (Array.isArray(input.resourceIds) ? input.resourceIds : prev?.resourceIds || []).filter((id) => getResource(id)).slice(0, 3);
  const base = {
    subject: input.subject.trim().slice(0, 160),
    body: input.body.replace(/\r\n/g, '\n').trim().slice(0, 3000),
    waBody: typeof input.waBody === 'string' ? input.waBody.trim().slice(0, 900) : prev?.waBody,
    channel,
    cta: cleanCta(input.cta ?? prev?.cta),
    programme: typeof input.programme === 'string' ? input.programme.trim().slice(0, 80) : prev?.programme || '',
    funding: Array.isArray(input.funding) ? input.funding : prev?.funding,
    repeatable: typeof input.repeatable === 'boolean' ? input.repeatable : prev?.repeatable,
    voucherOfferId: typeof input.voucherOfferId === 'string' ? (input.voucherOfferId || undefined) : prev?.voucherOfferId,
    expiresAt: input.expiresAt === null ? null : typeof input.expiresAt === 'number' && input.expiresAt > 0 ? input.expiresAt : prev?.expiresAt ?? null,
  };
  const contentChanged = !prev || prev.subject !== base.subject || prev.body !== base.body || (prev.waBody || '') !== (base.waBody || '') || JSON.stringify(prev.cta) !== JSON.stringify(base.cta) || prev.channel !== base.channel || (typeof input.voucherOfferId === 'string' && (input.voucherOfferId || undefined) !== prev.voucherOfferId);
  const m: NurtureMessage = {
    id: prev?.id || nid('msg'),
    name: input.name.trim().slice(0, 80) || prev?.name || 'Message',
    stage, audience, resourceIds,
    ...base,
    status: input.status === 'archived' ? 'archived' : prev && !contentChanged ? prev.status : 'draft',
    origin: prev?.origin || origin,
    check: checkMessage(base),
    approvedBy: prev && !contentChanged ? prev.approvedBy : undefined,
    approvedAt: prev && !contentChanged ? prev.approvedAt : undefined,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    stats: prev?.stats || { sent: 0, opened: 0, clicked: 0 },
  };
  put(m);
  return m;
}

export function approveMessage(id: string, by: string): { message: NurtureMessage | null; error?: string } {
  const m = getMessage(id);
  if (!m) return { message: null, error: 'No such message.' };
  const check = checkMessage(m);
  if (!check.pass) {
    put({ ...m, check });
    return { message: m, error: `Fix this first: ${check.notes[0]}` };
  }
  const next: NurtureMessage = { ...m, check, status: 'approved', approvedBy: by, approvedAt: Date.now(), updatedAt: Date.now() };
  put(next);
  return { message: next };
}

export function setMessageStatus(id: string, status: NurtureMessage['status']): NurtureMessage | null {
  const m = getMessage(id);
  if (!m) return null;
  const next = { ...m, status, updatedAt: Date.now() };
  put(next);
  return next;
}

export function deleteMessage(id: string): boolean {
  const before = libraryDoc.get().length;
  libraryDoc.set(libraryDoc.get().filter((m) => m.id !== id));
  return libraryDoc.get().length < before;
}

/* ── Choosing one for a lead (rules, no AI) ───────────────────────────────── */

export const isLive = (m: NurtureMessage, now = Date.now()) => m.status === 'approved' && (!m.expiresAt || m.expiresAt > now);

/** The best approved message of a stage this lead has not had yet. */
/** Is this message for this lead's way of paying? (Black Friday and the Early Bird are not for student loans.) */
export function fitsFunding(m: Pick<NurtureMessage, 'funding'>, fields: Record<string, string>): boolean {
  if (!m.funding?.length) return true;
  const theirs = fields.funding || leadProfile(fields).funding || '';
  return !theirs || m.funding.includes(theirs as NonNullable<NurtureMessage['funding']>[number]);
}

export function pickMessage(fields: Record<string, string>, stage: NurtureStage): NurtureMessage | null {
  const had = new Set((fields.nurture_sent || '').split('|').filter(Boolean));
  const programme = leadProgramme(fields).toLowerCase();
  const audience = leadAudience(fields);
  const ranked = libraryDoc.get()
    .filter((m) => isLive(m) && m.stage === stage && !m.repeatable && !had.has(m.id))
    .filter((m) => !m.programme || m.programme.toLowerCase() === programme)
    .filter((m) => m.audience === 'everyone' || m.audience === audience)
    .filter((m) => fitsFunding(m, fields))
    .map((m) => ({ m, score: (m.programme ? 3 : 0) + (m.audience !== 'everyone' ? 2 : 0) + (m.funding?.length && fields.funding && m.funding.includes(fields.funding as never) ? 3 : 0) + (m.stats.sent >= 10 ? Math.min(2, (m.stats.clicked / m.stats.sent) * 8) : 0) }))
    .sort((a, b) => b.score - a.score || a.m.createdAt - b.m.createdAt);
  return ranked[0]?.m || null;
}

/* ── Rendering ────────────────────────────────────────────────────────────── */

export interface Rendered { subject: string; html: string; text: string; whatsapp: string; resources: NurtureResource[]; ctaHref: string | null; unsub: string }

function card(href: string, r: NurtureResource): string {
  const label = r.kind === 'video' ? 'Watch the video' : r.kind === 'pdf' ? 'Read the guide' : 'Have a look';
  const thumb = r.kind === 'video' && r.thumb
    ? `<tr><td><a href="${href}" style="display:block;text-decoration:none"><img src="${r.thumb}" width="556" alt="${esc(r.title)}" style="display:block;width:100%;max-width:556px;height:auto;border-radius:12px 12px 0 0;border:0" /></a></td></tr>`
    : '';
  const badge = r.kind === 'pdf' ? 'Guide · PDF' : r.kind === 'video' ? 'Video' : 'Read';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0;border:1px solid #e4e9f2;border-radius:12px;border-collapse:separate;overflow:hidden">
${thumb}<tr><td style="padding:14px 16px;background:#f9fbff;border-radius:${thumb ? '0 0 12px 12px' : '12px'}">
<span style="display:inline-block;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#5e0743">${badge}</span>
<a href="${href}" style="display:block;margin:4px 0 4px;font-size:16px;font-weight:800;color:#0a1733;text-decoration:none">${esc(r.title)}</a>
${r.hook ? `<span style="display:block;font-size:14px;line-height:1.55;color:#4a556e">${esc(r.hook)}</span>` : ''}
<a href="${href}" style="display:inline-block;margin-top:8px;font-size:13px;font-weight:800;color:#ff7300;text-decoration:none">${label} &rarr;</a>
</td></tr></table>`;
}

function videoInvite(href: string, first: string, programme: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 8px;border-collapse:separate">
<tr><td bgcolor="#0a1733" style="border-radius:16px;background:#0a1733;background-image:linear-gradient(135deg,#0a1733 0%,#0a1733 55%,#5e0743 100%)">
<a href="${href}" style="display:block;text-decoration:none;color:#ffffff;padding:30px 22px 24px;text-align:center;font-family:Inter,Segoe UI,Arial,sans-serif">
<span style="display:block;font-size:30px;font-weight:900;line-height:1.15;margin:0 0 8px;color:#ffffff">Hey ${esc(first)}</span>
<span style="display:block;font-size:15px;line-height:1.55;color:#dbe4ff;margin:0 0 18px">A short video made for you about <b style="color:#ffffff">${esc(programme)}</b></span>
<span style="display:inline-block;width:64px;height:64px;line-height:64px;border-radius:50%;background:#ff7300;color:#ffffff;font-size:26px;text-align:center">&#9654;</span>
<span style="display:block;font-size:13px;color:#c7d2fe;margin-top:12px">Tap to watch &middot; sound on</span>
</a></td></tr></table>
<p style="font-size:12px;color:#62687a;margin:0 0 10px;text-align:center">Video not opening? <a href="${href}" style="color:#0a1733;font-weight:700">Open it here</a>.</p>`;
}

/** The message as one lead gets it: merged, with tracked button, cards, unsubscribe and open pixel. */
export function renderForLead(msg: NurtureMessage, rec: Pick<DataRecord, 'key' | 'sourceId' | 'name' | 'fields'>, sender: { name: string; office: string }, opts: { personalLine?: string; tenantId?: string; voucher?: { code: string; expiresAt: number; offer: VoucherOffer } } = {}): Rendered {
  const tid = opts.tenantId || currentTenantId();
  const base = getState().caps.baseUrl;
  const ac = getAcademyContext(tid);
  const vars = { ...leadVars(rec, sender.name), ...(opts.voucher ? voucherVars(opts.voucher, opts.voucher.offer) : {}) };
  const p = (x: TrackPayload['x'], extra: Partial<TrackPayload> = {}): TrackPayload => ({ t: tid, s: rec.sourceId, k: rec.key, m: msg.id, x, ...extra });

  const subject = mergeText(msg.subject, vars);
  let body = mergeText(msg.body, vars).replace(/\n+(?:warm regards|kind regards|best regards|regards|cheers)[,\s]*[\s\S]*$/i, '').trim();
  if (opts.personalLine) {
    // One personal sentence after the greeting line.
    const [hello, ...rest] = body.split(/\n\s*\n/);
    body = /^(hi|hello|hey|dear)\b/i.test(hello) ? [hello, opts.personalLine, ...rest].join('\n\n') : [opts.personalLine, body].join('\n\n');
  }

  // Resources: the ones chosen for the message, else the best fit for this lead.
  const chosen = msg.resourceIds.map((id) => getResource(id)).filter((r): r is NurtureResource => Boolean(r && r.enabled && SHAREABLE.includes(r.kind)));
  const fresh = msg.repeatable ? freshResource(rec.fields) : null;
  const resources = chosen.length ? chosen : msg.repeatable ? [] : msg.stage === 'offer' || msg.stage === 'decide' || msg.voucherOfferId ? [] : pickResources(rec.fields, msg.stage, 1);

  const t = msg.cta.target;
  const applyUrl = (getTenantIntegrations(tid).applyUrl || '').trim();
  const ctaRes = t === 'resource' ? getResource(msg.cta.resourceId) || fresh : null;
  const ctaHref = t === 'reply' || (t === 'url' && !msg.cta.url) || (t === 'resource' && !ctaRes)
    ? null
    : trackUrl(base, p(t, t === 'resource' ? { r: ctaRes!.id } : t === 'url' ? { u: msg.cta.url } : {}));
  const cards = [...resources.filter((r) => r.id !== ctaRes?.id), ...(fresh && fresh.id === ctaRes?.id ? [fresh] : [])].map((r) => card(trackUrl(base, p('res', { r: r.id })), r)).join('');
  const voucher = opts.voucher ? voucherCard(opts.voucher, `${base.replace(/\/$/, '')}/v/${opts.voucher.code}`) : '';
  const video = t === 'video' && ctaHref ? videoInvite(ctaHref, vars.first_name, vars.programme) : '';
  const unsub = trackUrl(base, p('unsub'), 'u');
  const pixel = trackUrl(base, p('open'), 'o');

  const askLine = t === 'reply' ? `<p style="font-size:14px;line-height:1.68;margin:18px 0 0;color:#0a1733;background:#f4f7fc;border-radius:10px;padding:15px 18px;border:1px solid #e2e8f4"><b>Next step:</b> ${esc(msg.cta.label)}</p>` : '';
  const html = emailShell(
    subject,
    `${formatHtmlParagraphs(body)}${voucher}${video}${cards}${askLine}${signatureBlock(sender.name, sender.office, ac.academyName)}`,
    // The video card is the button for a video message; everything else gets the orange button.
    ctaHref && t !== 'video' ? { href: ctaHref, label: msg.cta.label } : null,
    { agentName: sender.name, officeName: sender.office },
    { footer: `Not for you right now? <a href="${unsub}" style="color:#6f7890">Stop these emails</a>.`, pixel, preheader: preheaderOf(body) },
  );
  const text = [
    body,
    opts.voucher ? `Your voucher: ${opts.voucher.code} (${valueText(opts.voucher.offer)} ${opts.voucher.offer.appliesTo}, valid until ${dateText(opts.voucher.expiresAt)})` : '',
    ctaHref ? `${msg.cta.label}: ${ctaHref}` : msg.cta.target === 'reply' ? msg.cta.label : '',
    ...[...resources, ...(fresh ? [fresh] : [])].map((r) => `${r.title}: ${trackUrl(base, p('res', { r: r.id }))}`),
    `Warm regards,\n${sender.name}\n${sender.office} · ${ac.academyName}`,
    `Stop these emails: ${unsub}`,
  ].filter(Boolean).join('\n\n');

  const waSource = msg.waBody ? mergeText(msg.waBody, vars) : body.split(/\n\s*\n/).slice(0, 3).join('\n\n');
  const whatsapp = `${waSource}${opts.voucher ? `\n\nYour voucher: ${opts.voucher.code}` : ''}${ctaHref ? `\n\n${msg.cta.label}: ${ctaHref}` : ''}\n\n${sender.name}, ${ac.academyName}`.slice(0, 1200);

  return { subject, html, text, whatsapp, resources: fresh ? [...resources, fresh] : resources, ctaHref, unsub };
}

/** A guide or video that fits them and they have not had yet (for "something useful" messages). */
export function freshResource(fields: Record<string, string>): NurtureResource | null {
  const had = new Set((fields.nurture_res || '').split('|').filter(Boolean));
  return pickResources(fields, 'any', 4).find((r) => !had.has(r.id)) || null;
}

/** The first sentence after the greeting: what the inbox shows next to the subject. */
function preheaderOf(body: string): string {
  const paras = body.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const after = paras.find((x, i) => i > 0 || !/^(hi|hello|hey|dear)\b/i.test(x)) || '';
  return after.replace(/\s+/g, ' ').slice(0, 140);
}

function voucherCard(v: { code: string; expiresAt: number; offer: VoucherOffer }, shareHref: string): string {
  const o = v.offer;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 10px;border-collapse:separate">
<tr><td style="border:2px dashed #ff7300;border-radius:14px;padding:22px 18px;text-align:center;background:#fff8f2;font-family:Inter,Segoe UI,Arial,sans-serif">
<span style="display:block;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#5e0743">A voucher in your name</span>
<span style="display:block;font-size:30px;font-weight:900;line-height:1.2;color:#0a1733;margin:8px 0 4px">${esc(valueText(o))}</span>
<span style="display:block;font-size:14px;color:#4a556e">${esc(o.appliesTo)} &middot; valid until ${esc(dateText(v.expiresAt))}</span>
<span style="display:inline-block;margin-top:14px;padding:11px 18px;border-radius:10px;background:#0a1733;color:#ffffff;font:800 18px/1 Consolas,Menlo,monospace;letter-spacing:.14em">${esc(v.code)}</span>
<span style="display:block;font-size:12.5px;color:#62687a;margin-top:12px">Give this code when you apply.${o.shareable ? ` Know someone thinking about tech? <a href="${shareHref}" style="color:#0a1733;font-weight:700">Pass it on</a>.` : ''}</span>
</td></tr></table>`;
}

/** The email that carries a voucher, from the offer the team approved. */
export function offerMessage(o: VoucherOffer): NurtureMessage {
  const now = Date.now();
  return {
    id: `vou_${o.id}`, name: o.name, stage: 'offer', audience: 'everyone', programme: '', channel: 'email',
    subject: o.subject, body: o.body, cta: { target: 'apply', label: 'Use it when I apply' }, resourceIds: [],
    status: o.status === 'active' ? 'approved' : 'draft', expiresAt: o.expiry.kind === 'date' ? o.expiry.date : null, origin: 'person',
    check: { pass: true, notes: [] }, createdAt: o.createdAt, updatedAt: now, stats: { sent: 0, opened: 0, clicked: 0 }, voucherOfferId: o.id,
  };
}

/** A message by id, including a voucher offer's email ("vou_<offer id>"). */
export function resolveMessage(id: string | undefined): NurtureMessage | null {
  if (!id) return null;
  if (id.startsWith('vou_')) {
    const o = getOffer(id.slice(4));
    return o ? offerMessage(o) : null;
  }
  return getMessage(id);
}

/** Keep in touch, forever, without repeating: the next best thing they have not had.
 *  A live offer first, then any approved message they have not had (not the welcome),
 *  then a "something useful" message with a guide or video they have not seen. */
export function pickOngoing(fields: Record<string, string>): NurtureMessage | null {
  const had = new Set((fields.nurture_sent || '').split('|').filter(Boolean));
  const programme = leadProgramme(fields).toLowerCase();
  const audience = leadAudience(fields);
  const fits = (m: NurtureMessage) => isLive(m) && (!m.programme || m.programme.toLowerCase() === programme) && (m.audience === 'everyone' || m.audience === audience) && fitsFunding(m, fields);
  const list = libraryDoc.get().filter(fits);
  const order: NurtureStage[] = ['offer', 'learn', 'trust', 'decide', 'reengage'];
  for (const stage of order) {
    const m = list.filter((x) => x.stage === stage && !x.repeatable && !had.has(x.id)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (m) return m;
  }
  if (freshResource(fields)) return list.find((x) => x.repeatable) || null;
  return null;
}

/* ── Sending ──────────────────────────────────────────────────────────────── */

export interface SendResult { ok: boolean; skipped?: boolean; detail: string; mailId?: string }

/** Send a saved message to one lead. No AI unless a personal line was asked for. */
export async function sendLibraryMessage(input: {
  rec: DataRecord;
  msg: NurtureMessage;
  sender: { name: string; office: string };
  channel?: MessageChannel;
  personalLine?: string;
  taskId?: string;
  /** A test send to a person on the team: ignores approval and opt-out. */
  test?: { to: string };
}): Promise<SendResult> {
  const { rec, msg } = input;
  if (!input.test) {
    if (rec.fields.opted_out === 'yes') return { ok: false, skipped: true, detail: `${rec.name} asked not to get marketing messages.` };
    if (msg.status !== 'approved') return { ok: false, skipped: true, detail: `"${msg.name}" is not approved yet.` };
    if (msg.expiresAt && msg.expiresAt <= Date.now()) return { ok: false, skipped: true, detail: `"${msg.name}" ended on ${isoDate(new Date(msg.expiresAt))}.` };
    if (!fitsFunding(msg, rec.fields)) return { ok: false, skipped: true, detail: `"${msg.name}" is not for ${rec.name.split(/\s+/)[0]}: ${leadProfile(rec.fields).funding_said || 'their way of paying'}.` };
  }
  // A message that gives a voucher: a live offer, and a code made for this lead.
  let voucher: { code: string; expiresAt: number; offer: VoucherOffer } | undefined;
  if (msg.voucherOfferId) {
    const offer = getOffer(msg.voucherOfferId);
    if (!offer || (!input.test && !offerLive(offer))) return { ok: false, skipped: true, detail: `The voucher for "${msg.name}" is not active.` };
    const v = input.test ? { code: 'TEST-CODE', expiresAt: expiresFor(offer) } : issueVoucher(offer, rec, { preview: rec.fields.preview === 'yes' });
    voucher = { code: v.code, expiresAt: v.expiresAt, offer };
  }
  if (msg.repeatable && !input.test && !freshResource(rec.fields)) return { ok: false, skipped: true, detail: `${rec.name.split(/\s+/)[0]} has had every guide and video that fits them.` };
  const channel = input.channel || msg.channel;
  const r = renderForLead(msg, rec, input.sender, { personalLine: input.personalLine, voucher });
  const out: string[] = [];
  let delivered = 0;
  let mailId: string | undefined;

  const email = input.test?.to || rec.email;
  if (channel !== 'whatsapp' && email) {
    const m = await sendMail({ to: email, toName: rec.name, subject: input.test ? `[Test] ${r.subject}` : r.subject, html: r.html, text: r.text, link: r.ctaHref, taskId: input.taskId || `nurture_${msg.id}`, deliverableId: null, fromName: input.sender.name, headers: unsubscribeHeaders(r.unsub) });
    mailId = m.id;
    out.push(m.error ? `email failed (${m.error})` : m.delivery === 'smtp' ? 'email sent' : 'email kept in the Inbox (sending paused)');
    if (!m.error) delivered++;
  }
  if (!input.test && (channel === 'whatsapp' || channel === 'email_whatsapp') && rec.phone) {
    const tid = currentTenantId();
    const ti = getTenantIntegrations(tid);
    const w = ti.whatsappUrl || (tid === DEFAULT_TENANT_ID && process.env.WHATSAPP_API_URL)
      ? await sendWhatsApp({ toPhone: rec.phone, learnerName: rec.name, text: r.whatsapp })
      : ti.manychatApiKey
        ? await sendManyChat({ email: rec.email, phone: rec.phone, learnerName: rec.name, text: r.whatsapp })
        : { ok: false, detail: 'WhatsApp is not connected (Channels & API)' };
    out.push(`WhatsApp: ${w.detail}`);
    if (w.ok) delivered++;
  }
  if (!out.length) return { ok: false, detail: 'No email or phone number for this lead.' };
  if (input.test) return { ok: delivered > 0, detail: out.join('; '), mailId };

  // Remember what they got, so nobody receives the same thing twice.
  const sent = [...(rec.fields.nurture_sent || '').split('|').filter(Boolean), msg.id].slice(-50).join('|');
  const res = [...(rec.fields.nurture_res || '').split('|').filter(Boolean), ...r.resources.map((x) => x.id)].slice(-50).join('|');
  setRecordField(rec.sourceId, rec.key, 'nurture_sent', sent);
  setRecordField(rec.sourceId, rec.key, 'nurture_res', res);
  setRecordField(rec.sourceId, rec.key, 'nurture_last_sent_at', new Date().toISOString());
  setRecordField(rec.sourceId, rec.key, 'nurture_count', String(Number(rec.fields.nurture_count || 0) + 1));
  setRecordField(rec.sourceId, rec.key, 'last_contacted', isoDate(new Date()));
  setRecordField(rec.sourceId, rec.key, 'last_contacted_by', input.sender.name);
  appendConversation(rec.sourceId, rec.key, 'us', `${r.subject}. ${r.text.split(/\n\s*\n/).slice(1, 3).join(' ')}`.slice(0, 400), input.sender.name);
  const live = getMessage(msg.id);
  if (live) { live.stats.sent++; libraryDoc.save(); }
  for (const x of r.resources) { const b = bankDoc.get().find((y) => y.id === x.id); if (b) b.stats.sent++; }
  if (r.resources.length) bankDoc.save();
  bumpStat('librarySends');
  return { ok: delivered > 0, detail: `"${r.subject}": ${out.join('; ')}`, mailId };
}

/** One short personal sentence from what a lead wrote on the form. The only per-lead AI in a saved message, and optional. */
export async function writePersonalLine(rec: DataRecord): Promise<string | null> {
  const said = [rec.fields.message, rec.fields.notes, rec.fields.question, rec.fields.why].filter(Boolean).join(' ').slice(0, 500);
  if (!said.trim()) return null;
  const text = await complete({
    system: 'You write one warm, specific sentence (max 25 words) that shows we read what a prospective student wrote. No greeting, no sign-off, no promises, no facts we were not given. Plain text only.',
    prompt: `They wrote: "${said}". Their interest: ${rec.fields.interest || 'not given'}.`,
    maxTokens: 4000,
    timeoutMs: 12000,
    json: false,
  });
  const line = text?.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim();
  if (!line || line.length > 220 || /\{\{|\[/.test(line)) return null;
  if (rec.fields.preview !== 'yes') bumpStat('aiLines');
  return line;
}

/* ── Writing with AI (once per message, not per lead) ─────────────────────── */

const WRITER_RULES = (academy: string) => `You write reusable nurture messages for ${academy}, a tech academy, sent to many prospective students with their details merged in.
Merge fields you may use: {{first_name}} (always, in the greeting), {{programme}} (the programme they are interested in), {{academy}}. Use no other fields and no square brackets.
Voice: warm, clear, practical South African English; confident and hopeful, never pushy, never preachy. No pressure tactics (no "last chance", "act now", "only X spots").
Facts: only what is in the brief and in what you know below. Never invent fees, discounts, dates, salaries, statistics, links, promises, or claims about other students and results.
Shape: start "Hi {{first_name}}," on its own line; 70 to 140 words; short paragraphs separated by \\n\\n; no links in the text (the button and cards carry them); no sign-off (it is added).`;

interface Draft { name: string; subject: string; body: string; waBody: string; ctaLabel: string; resourceIds: string[] }

function validDraft(x: unknown, resIds: Set<string>): Draft | null {
  const o = obj(x);
  if (!o || !isStr(o.subject) || !isStr(o.body)) return null;
  return {
    name: isStr(o.name) ? o.name.trim().slice(0, 80) : String(o.subject).slice(0, 60),
    subject: noEmoji(o.subject).slice(0, 140),
    body: noEmoji(o.body.replace(/\r\n/g, '\n')),
    waBody: isStr(o.waBody) ? noEmoji(o.waBody).slice(0, 700) : '',
    ctaLabel: isStr(o.ctaLabel) ? noEmoji(o.ctaLabel).slice(0, 50) : '',
    resourceIds: Array.isArray(o.resourceIds) ? o.resourceIds.filter((r): r is string => typeof r === 'string' && resIds.has(r)).slice(0, 2) : [],
  };
}

function writerContext() {
  const ti = getTenantIntegrations(currentTenantId());
  const known = [ti.academyFocus ? `Programmes: ${ti.academyFocus}` : '', ti.agentKnowledge || '', bankKnowledge(2500)].filter(Boolean).join('\n');
  const shareable = bankDoc.get().filter((r) => r.enabled && SHAREABLE.includes(r.kind)).slice(0, 20);
  return { known, shareable, applyUrl: (ti.applyUrl || '').trim() };
}

/** One message from a one-line brief ("50% off registration until 30 November"). Saved as a draft. */
export async function writeLibraryMessage(input: { brief: string; stage: NurtureStage; audience: Audience; programme?: string; channel?: MessageChannel; cta?: CtaTarget; expiresAt?: number | null }): Promise<NurtureMessage> {
  const ac = getAcademyContext();
  const { known, shareable, applyUrl } = writerContext();
  const cta: CtaTarget = input.cta || (input.stage === 'decide' || input.stage === 'offer' ? (applyUrl ? 'apply' : 'reply') : input.stage === 'welcome' ? 'quiz' : 'reply');
  const ids = new Set(shareable.map((r) => r.id));
  const draft = await generateJSON<Draft>({
    system: `${WRITER_RULES(ac.academyName)}\nReply with one JSON object only.`,
    prompt: `Brief from the team: ${input.brief.trim().slice(0, 600)}
Journey stage: ${input.stage}. Audience: ${input.audience}${input.programme ? `. Only for leads interested in ${input.programme}` : ''}.
The button under the message: ${DEFAULT_CTA[cta]} (${cta}).${input.expiresAt ? ` The offer ends ${new Date(input.expiresAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' })}: say so plainly.` : ''}
${known ? `What you know about ${ac.academyName}:\n${known}\n` : ''}${shareable.length ? `Resources that can be attached as cards (pick 0 to 2 that truly fit):\n${shareable.map((r) => `- ${r.id}: ${r.title} (${r.kind}, ${r.audience.join('/')}) ${r.summary}`).join('\n')}\n` : ''}
JSON: {"name": "internal name, 2 to 5 words", "subject": "subject line, may use {{first_name}}", "body": "the email", "waBody": "a WhatsApp version, 30 to 60 words, starts 'Hi {{first_name}}'", "ctaLabel": "button text, 2 to 5 words", "resourceIds": []}`,
    maxTokens: 8000,
    timeoutMs: 35000,
    validate: (x) => validDraft(x, ids),
  });
  if (!draft) throw new Error('AI could not write that right now. Try again, or write it yourself.');
  bumpStat('aiBuilds');
  return saveMessage({
    name: draft.name, subject: draft.subject, body: draft.body, waBody: draft.waBody,
    stage: input.stage, audience: input.audience, programme: input.programme || '', channel: input.channel || 'email',
    cta: { target: cta, label: draft.ctaLabel || DEFAULT_CTA[cta] }, resourceIds: draft.resourceIds, expiresAt: input.expiresAt ?? null,
  }, 'ai');
}

type PlanItem = { stage: NurtureStage; audience: Audience; cta: CtaTarget; brief: string };

/** The messages a nurture journey needs, one per stage it sends. */
function starterPlan(canApply: boolean): PlanItem[] {
  return [
    { stage: 'welcome', audience: 'everyone', cta: 'quiz', brief: 'First hello within minutes of them asking about us: thank them, say who we are in one line, and invite them to a 2-minute career-fit quiz that shows which programme suits them.' },
    { stage: 'learn', audience: 'everyone', cta: 'video', brief: 'Tell them you made them a short personal video about {{programme}}: what they would learn and build, and where it can take them.' },
    { stage: 'trust', audience: 'parents', cta: 'reply', brief: 'For parents helping a child choose: what the programme gives their child, how classes and support work, and that they can reply with any question.' },
    { stage: 'trust', audience: 'everyone', cta: 'reply', brief: 'How it really works: live classes, real projects, support all the way. Invite them to reply with what is holding them back.' },
    { stage: 'decide', audience: 'everyone', cta: canApply ? 'apply' : 'reply', brief: canApply ? 'They have been looking for a while: make applying feel easy and quick, and say a person helps if they get stuck.' : 'They have been looking for a while: invite them to reply to start their application, and say a person helps them through it.' },
    { stage: 'reengage', audience: 'everyone', cta: 'quiz', brief: 'A gentle check-in a few weeks later: no pressure, ask if tech is still on their mind, and offer the career-fit quiz as an easy restart.' },
  ];
}

/** A new workspace's library: the hand-written starters as drafts (no AI), ready to approve or rewrite. */
/** "Something useful": goes again and again, each time with a guide or video they have not seen. */
export function seedUsefulMessage(): NurtureMessage | null {
  if (libraryDoc.get().some((m) => m.repeatable)) return null;
  return saveMessage({
    name: 'Something useful (repeats)', stage: 'learn', audience: 'everyone', programme: '', channel: 'email', repeatable: true,
    subject: '{{first_name}}, I thought of you when I saw this',
    body: 'Hi {{first_name}},\n\nI came across this and thought it might help while you think about {{programme}}.\n\nHave a look when you have a few minutes, and reply if it raises any questions. I am always happy to help.',
    waBody: 'Hi {{first_name}}, I came across this and thought it might help while you think about {{programme}}. Have a look when you have a moment.',
    cta: { target: 'resource', label: 'Have a look' }, resourceIds: [],
  }, 'starter');
}

export function seedStarterLibrary(): NurtureMessage[] {
  const canApply = Boolean((getTenantIntegrations(currentTenantId()).applyUrl || '').trim());
  const drafts = starterTemplates(getAcademyContext().academyName, canApply);
  return starterPlan(canApply).map((p, i) => saveMessage({
    name: drafts[i].name, subject: drafts[i].subject, body: drafts[i].body, waBody: drafts[i].waBody,
    stage: p.stage, audience: p.audience, programme: '', channel: 'email',
    cta: { target: p.cta, label: drafts[i].ctaLabel || DEFAULT_CTA[p.cta] }, resourceIds: [],
  }, 'starter'));
}

/** The starter library: the messages a nurture journey needs, written in one AI call (or from templates). Drafts until approved. */
export async function writeStarterSet(): Promise<NurtureMessage[]> {
  const ac = getAcademyContext();
  const { known, shareable, applyUrl } = writerContext();
  const plan = starterPlan(Boolean(applyUrl));
  const ids = new Set(shareable.map((r) => r.id));
  const res = await generateJSON<Draft[]>({
    system: `${WRITER_RULES(ac.academyName)}\nReply with one JSON object only.`,
    prompt: `Write ${plan.length} different messages for the nurture journey, one per brief, each with its own subject and angle.
${plan.map((p, i) => `${i + 1}. Stage ${p.stage}, audience ${p.audience}, button "${DEFAULT_CTA[p.cta]}": ${p.brief}`).join('\n')}
${known ? `\nWhat you know about ${ac.academyName}:\n${known}\n` : ''}${shareable.length ? `\nResources that can be attached as cards (0 to 2 per message, only where they truly fit):\n${shareable.map((r) => `- ${r.id}: ${r.title} (${r.kind}, ${r.audience.join('/')}) ${r.summary}`).join('\n')}\n` : ''}
JSON: {"messages": [{"name": "...", "subject": "...", "body": "...", "waBody": "30 to 60 words", "ctaLabel": "...", "resourceIds": []}, ... ${plan.length} in order]}`,
    maxTokens: 16000,
    timeoutMs: 60000,
    validate: (x) => {
      const o = obj(x);
      const arr = o && Array.isArray(o.messages) ? o.messages : null;
      if (!arr || arr.length < plan.length) return null;
      const out = arr.slice(0, plan.length).map((m) => validDraft(m, ids));
      return out.every(Boolean) ? (out as Draft[]) : null;
    },
  });
  if (res) bumpStat('aiBuilds');
  const drafts = res || starterTemplates(ac.academyName, Boolean(applyUrl));
  return plan.map((p, i) => saveMessage({
    name: drafts[i].name, subject: drafts[i].subject, body: drafts[i].body, waBody: drafts[i].waBody,
    stage: p.stage, audience: p.audience, programme: '', channel: 'email',
    cta: { target: p.cta, label: drafts[i].ctaLabel || DEFAULT_CTA[p.cta] }, resourceIds: drafts[i].resourceIds,
  }, res ? 'ai' : 'starter'));
}

/** Hand-written starters, used when the model is off. They pass the reviewer's rules. */
export function starterTemplates(academy: string, canApply: boolean): Draft[] {
  return [
    {
      name: 'Welcome + fit quiz', subject: 'Welcome, {{first_name}}: which tech path fits you?',
      body: `Hi {{first_name}},\n\nThank you for reaching out to ${academy}. I'm glad you're thinking about a future in tech.\n\nEveryone asks the same first question: which programme is right for me? So we made a short quiz that matches what you enjoy to a path, whether that is building software, working with data or protecting systems. It takes about two minutes and there are no wrong answers.\n\nTry it below, and reply anytime with a question.`,
      waBody: 'Hi {{first_name}}, thanks for reaching out to us! Not sure which tech path fits you? Our 2-minute quiz matches what you enjoy to a programme. No wrong answers.',
      ctaLabel: 'Find my tech fit', resourceIds: [],
    },
    {
      name: 'Personal programme video', subject: '{{first_name}}, I made you a short video',
      body: `Hi {{first_name}},\n\nYou showed interest in {{programme}}, so I put together a short video just for you.\n\nIt shows what you would actually learn, the kind of projects you would build, and where it can lead. It's a few minutes long and it will answer most of the questions people ask us.\n\nWatch it when you have a moment, and reply with anything you'd like to know.`,
      waBody: 'Hi {{first_name}}, I made you a short video about {{programme}}: what you would learn, build and where it leads. Have a look when you have a moment.',
      ctaLabel: 'Watch my video', resourceIds: [],
    },
    {
      name: 'For parents', subject: 'Helping your child choose a tech career',
      body: `Hi {{first_name}},\n\nMany of the people who contact us are parents helping a son or daughter decide what comes next, and it's a big decision.\n\nOur programmes are practical: students learn live with experienced practitioners, build real projects for their portfolio, and have a student success team checking in with them all the way through.\n\nIf you have any question about how it works, fees or the next intake, just reply and a consultant will answer you personally.`,
      waBody: 'Hi {{first_name}}, helping your child choose a tech career? Our programmes are practical, live and supported all the way. Reply with any question and a consultant will answer personally.',
      ctaLabel: 'Just reply to this email', resourceIds: [],
    },
    {
      name: 'How it really works', subject: 'What studying with us actually looks like',
      body: `Hi {{first_name}},\n\nA quick look behind the scenes at ${academy}.\n\nClasses are live, so you can ask questions as you go. You learn by building real projects, not just watching videos. And you are never on your own: our student success team checks in, and help is a message away.\n\nWhat is the one thing holding you back right now: time, fees, or not being sure tech is for you? Reply and tell me, and I'll help you think it through.`,
      waBody: 'Hi {{first_name}}, with us classes are live, you build real projects, and support is a message away. What is holding you back right now? Reply and I will help you think it through.',
      ctaLabel: 'Just reply to this email', resourceIds: [],
    },
    {
      name: canApply ? 'Ready to apply' : 'Start your application', subject: '{{first_name}}, ready when you are',
      body: `Hi {{first_name}},\n\nYou have been looking at {{programme}} for a while, and that's a good sign: the people who take their time usually make great students.\n\n${canApply ? 'Applying takes a few minutes, and if anything is unclear along the way, reply to this email and a consultant will help you finish it.' : 'Reply to this email and a consultant will help you start your application and answer anything that is still unclear.'}\n\nWhenever you are ready, we're here.`,
      waBody: canApply ? 'Hi {{first_name}}, applying takes a few minutes, and a consultant helps if you get stuck. Ready when you are.' : 'Hi {{first_name}}, reply here and a consultant will help you start your application.',
      ctaLabel: canApply ? 'Start my application' : 'Just reply to this email', resourceIds: [],
    },
    {
      name: 'Gentle check-in', subject: 'Still thinking about tech, {{first_name}}?',
      body: `Hi {{first_name}},\n\nIt has been a little while, so I wanted to check in without any pressure.\n\nIf tech is still on your mind, a good way to restart is our two-minute career-fit quiz: it shows which path suits you best, and you can take it from there.\n\nAnd if now is not the right time, that is completely fine. Reply anytime and we'll pick up where we left off.`,
      waBody: 'Hi {{first_name}}, just checking in, no pressure. If tech is still on your mind, our 2-minute fit quiz is an easy restart.',
      ctaLabel: 'Take the 2-minute quiz', resourceIds: [],
    },
  ];
}

/** For a message an agent wrote to a lead: one resource that fits them, tracked, plus unsubscribe and the open pixel. */
export function leadEmailExtras(rec: DataRecord, runId: string, opts: { video?: boolean } = {}): { cardsHtml: string; footer: string; pixel: string; resourceIds: string[]; unsub: string } {
  const tid = currentTenantId();
  const base = getState().caps.baseUrl;
  const p = (x: TrackPayload['x'], extra: Partial<TrackPayload> = {}): TrackPayload => ({ t: tid, s: rec.sourceId, k: rec.key, m: `run_${runId.slice(-10)}`, x, ...extra });
  // Their personal video takes the place of a resource card.
  const picks = opts.video ? [] : pickResources(rec.fields, 'any', 1);
  const first = (rec.fields.first_name || rec.name).split(/\s+/)[0];
  const video = opts.video ? videoInvite(trackUrl(base, p('video')), first, leadProgramme(rec.fields) || 'your next step') : '';
  return {
    cardsHtml: video + picks.map((r) => card(trackUrl(base, p('res', { r: r.id })), r)).join(''),
    footer: `Not for you right now? <a href="${trackUrl(base, p('unsub'), 'u')}" style="color:#6f7890">Stop these emails</a>.`,
    pixel: trackUrl(base, p('open'), 'o'),
    resourceIds: picks.map((r) => r.id),
    unsub: trackUrl(base, p('unsub'), 'u'),
  };
}

/** For the Nurture page: the message rendered for a real or sample lead. */
export function previewMessage(msg: NurtureMessage, leadKey?: string, sourceId?: string): Rendered {
  const rec = leadKey && sourceId ? getRecord(sourceId, leadKey) : null;
  const sample = rec || { key: 'sample', sourceId: sourceId || 'src_leads', name: 'Thandi Mokoena', fields: { first_name: 'Thandi', interest: msg.programme || programmeList()[0] || '' } };
  const offer = msg.voucherOfferId ? getOffer(msg.voucherOfferId) : null;
  return renderForLead(msg, sample, { name: 'Naledi', office: 'Admissions' }, offer ? { voucher: { code: 'MEL-THAN-7K3Q', expiresAt: expiresFor(offer), offer } } : {});
}

/** Offers the agents may use when selling: approved, not ended, said exactly as written. */
export function liveOffersText(): string {
  const now = Date.now();
  const offers = libraryDoc.get().filter((m) => m.stage === 'offer' && isLive(m, now));
  if (!offers.length) return '';
  const generic = { first_name: 'there', programme: 'the programme', academy: getAcademyContext().academyName, sender: '' };
  return `Current offers (use only these, exactly as written, and say when they end):\n${offers.map((m) => `- ${mergeText(m.subject, generic)}: ${mergeText(m.body, generic).replace(/^Hi there,\s*/i, '').replace(/\s+/g, ' ').slice(0, 320)}${m.expiresAt ? ` (ends ${new Date(m.expiresAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' })})` : ''}`).join('\n')}`;
}

/** The conversation so far, for an agent about to reply. */
export function conversationText(rec: Pick<DataRecord, 'fields' | 'name'> | null): string {
  const turns = getConversation(rec);
  if (!turns.length) return '';
  const first = (rec?.fields.first_name || rec?.name || 'They').split(/\s+/)[0];
  return `The conversation so far (oldest first):\n${turns.map((t) => `${t.w === 'them' ? first : t.by || 'Us'} (${new Date(t.ts).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}): ${t.t}`).join('\n')}`;
}

/** Mark a lead as having been sent something by an agent (journey logs). */
export function logLibrarySend(name: string, msg: NurtureMessage, detail: string) {
  log('system', 'email', `[Admissions] ${msg.name} → ${name}: ${detail}`);
}
