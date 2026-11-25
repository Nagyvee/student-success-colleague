import { createHmac, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import { derivedKey, getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { mailboxRefuses } from '@/lib/email/send';
import { liveAllowed } from '@/lib/email/pause';
import { publicUrl } from '@/lib/engine/store';
import { safeReason } from '@/lib/engine/problems';
import { noEmoji } from '@/lib/ai/llm';
import { HAIKU, SONNET, ask, jsonOf } from './ask';
import { postHandover, postNote } from './discord';
import type { Company, Magnet, Message, Qualified } from './types';
import { outOfDate } from './clock';
import { blockedReason, companies, countedTo, isWeekday, log, missingForSending, nid, runState, saveCompany, saveRun, sastDay, sastHour, setStage, settings, told } from './store';

/* The conversation.
 *
 * The law (POPIA, section 69) lets us approach someone who is not a customer
 * once, to ask. So there is one first email, with one useful thing to offer
 * and one question: may we send it? No answer means no more emails. A yes (or
 * their own question) opens the conversation: what they asked for, answers, a
 * question that qualifies them, the toolkit, the calculator, a call. "No" or
 * "stop" ends it for good, and every email says who we are and how to stop.
 *
 * The AI writes words, never links or promises: what we give away and the
 * booking link are added here from the settings. A person checks every email
 * before it goes unless that is switched off. */

const DAY = 86_400_000;
const paragraphs = (t: string) => t.replace(/\r/g, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const firstName = (c: Company) => (/^[\p{L}'-]{2,}/u.exec(c.contact.name.replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, ''))?.[0] || '');
const hello = (c: Company) => (firstName(c) ? `Hi ${firstName(c)},` : `Hello ${c.name} team,`);

/* ── Stopping ─────────────────────────────────────────────────────────────── */

const sign = (body: string) => createHmac('sha256', derivedKey('b2b-stop')).update(body).digest('base64url').slice(0, 24);

export function stopUrl(c: Company, tenantId = currentTenantId()): string {
  const body = Buffer.from(`${tenantId}|${c.id}`).toString('base64url');
  return `${publicUrl(tenantId).replace(/\/$/, '')}/b2b/${body}.${sign(body)}`;
}

export function readStop(token: string): { tenantId: string; id: string } | null {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || body.length > 300) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const [tenantId, id] = Buffer.from(body, 'base64url').toString('utf8').split('|');
  return tenantId && id ? { tenantId, id } : null;
}

/** They do not want to hear from us: never again, whatever else happens. */
export function stopFor(c: Company, why: string): Company {
  c.thread = c.thread.filter((m) => m.status !== 'draft' && m.status !== 'ready');
  log('system', 'info', `${c.name} ${why}. Thuso never writes to them again.`);
  return setStage(c, 'lost', { consent: 'no', lostReason: why.charAt(0).toUpperCase() + why.slice(1) });
}

/* ── May we write to them? ────────────────────────────────────────────────── */

/** Why this message may not go, or ''. Checked when it is written and again when it goes. */
export function mayNotWrite(c: Company, kind: Message['kind'], tenantId = currentTenantId()): string {
  if (c.consent === 'no') return 'they asked us not to write';
  if (!c.contact.email) return 'no email address yet';
  const stop = blockedReason(c, tenantId, c.id);
  if (stop && !stop.startsWith('already here')) return stop;
  if (kind === 'first') {
    if (c.consent !== 'none' || c.thread.some((m) => m.who === 'us' && m.status === 'sent')) return 'they were asked once already';
    const asked = companies(tenantId).find((x) => x.id !== c.id && x.contactedAt && (x.contact.email === c.contact.email || (c.domain && x.domain === c.domain)));
    if (asked) return `someone at ${asked.name} was asked already`;
    return '';
  }
  if (kind === 'reply') return c.thread.some((m) => m.who === 'them') ? '' : 'they have not written to us';
  return c.consent === 'yes' ? '' : 'they have not said yes';
}

/* ── Writing ──────────────────────────────────────────────────────────────── */

/** The words an email may not have ("92% only with reported": not without the other), or nothing. */
export function neverSaid(text: string, never: string): string[] {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  const has = (w: string) => { const x = w.trim().toLowerCase().replace(/\s+/g, ' '); return Boolean(x) && new RegExp(`(^|[^a-z0-9])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(t); };
  return never.split(/\n+/).map((x) => x.trim()).filter(Boolean).flatMap((rule) => {
    const only = /^(.+?)\s+only with\s+(.+)$/i.exec(rule);
    if (only) return has(only[1]) && !has(only[2]) ? [`"${only[1]}" without "${only[2]}"`] : [];
    return has(rule) ? [`"${rule}"`] : [];
  });
}

/** What is wrong with a draft, or nothing. */
export function draftProblems(subject: string, text: string, kind: Message['kind']): string[] {
  const words = text.split(/\s+/).filter(Boolean).length;
  const not = neverSaid(`${subject}\n${text}`, settings().never);
  return [
    !subject.trim() ? 'no subject' : subject.length > 90 ? 'the subject is too long' : '',
    words < 15 ? 'too short' : words > (kind === 'first' ? 170 : 260) ? 'too long' : '',
    /\[[^\]]{2,40}\]|\{\{|<[a-z]+ ?[^>]*>/i.test(text) ? 'a blank left to fill in' : '',
    kind === 'first' && /https?:\/\/|www\./i.test(text) ? 'a link (the first email has none, so it is not taken for spam)' : '',
    /guarantee|risk[- ]free|act now|limited time|100%(?! (black|online|female|youth))/i.test(text) ? 'a promise or pressure' : '',
    not.length ? `something we never say: ${not.slice(0, 3).join(', ')}` : '',
  ].filter(Boolean);
}

/** Phrases that sound like a machine or a brochure. The AI gets another try; a person may write what they like. */
const STIFF = /\b(which means|structured (route|pathway|path|learnerships?|pipelines?)|caught (our|my|your) eye|exactly what we|(the )?same stretch|close (that|the|this) gaps?|value (is|can get|gets) lost|leverag\w+|unlock\w*|landscape|delve|seamless(ly)?|empower\w*|cutting[- ]edge|robust|holistic|synerg\w+|talent pipelines?|resonat\w+|hope this (email )?finds you|in today's|fast[- ]paced|game[- ]chang\w+)\b/gi;
export const stiffWords = (t: string): string[] => [...new Set((t.match(STIFF) || []).map((x) => x.toLowerCase()))].slice(0, 3);

/** More than two or three things in one sentence reads as a brochure. */
export const longList = (t: string): boolean => t.split(/(?<=[.!?])\s+|\n+/).some((x) => (x.match(/[,;]/g) || []).length >= 4);

/** The AI's words, cleaned: no links (ours are added), no emoji, no sign-off of its own. */
export function cleanText(t: string): string {
  return noEmoji(String(t || '')).replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '').replace(/\n+(kind|warm|best)? ?regards[\s\S]*$/i, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
}

const offerOf = (c: Company): Magnet | null => { const s = told(); const open = s.magnets.filter((m) => m.on && m.when === 'open'); return open.find((m) => m.id === c.magnetId) || open[0] || null; };
const writerModel = () => (settings().writer === 'sonnet' ? SONNET : HAIKU);

const newMessage = (o: Pick<Message, 'kind' | 'subject' | 'text'> & Partial<Message>): Message => ({ id: nid('m'), who: 'us', at: Date.now(), status: 'draft', ...o });

function voice(c: Company): string {
  const s = told();
  return `You write emails for ${s.fromName || 'the team'}${s.fromTitle ? `, ${s.fromTitle}` : ''} at ${getAcademyContext().academyName}, a South African academy that trains companies' people. Plain, warm, specific, like a busy person writing to another. South African English. No buzzwords, no flattery, no pressure, no emoji, no links, no prices, no promises about results or money, and nothing about us that is not below. Never say how you found them beyond the public page. ${s.about ? `About us: ${s.about}` : ''}\nWhat we sell: ${s.services}${s.rules ? `\nHow we speak (always followed): ${s.rules}` : ''}${s.never.trim() ? `\nNever write these words (where it says "only with", never the first without the second): ${s.never.split(/\n+/).map((x) => x.trim()).filter(Boolean).join('; ')}` : ''}${c.contact.role ? `\nYou write to: ${[c.contact.name, c.contact.role].filter(Boolean).join(', ')}` : '\nYou write to a general address: assume whoever looks after people and training.'}\nThe company: ${c.name}. ${c.what}`;
}

/** The one first email: something true about them, something useful for them, one question. */
export async function writeFirst(c: Company): Promise<Message> {
  const offer = offerOf(c);
  const name = offer?.name || 'a short guide';
  let subject = '', text = '';
  let wrong: string[] = [];
  // A second try says what was wrong with the first.
  for (let i = 0; i < 2; i++) {
    try {
      const a = await ask({
        model: writerModel(), maxTokens: 3000, system: voice(c),
        prompt: `Write the only email we may send before they answer. We may ask once: may we send them "${name}"${offer?.about ? ` (${offer.about})` : ''}?\n\nTrue things about them (use one, the most telling):\n${c.facts.map((f) => `- ${f.text}`).join('\n')}\nWhy they might train people: ${c.fit.join('; ')}\nWhat we might offer later (do not pitch it now): ${c.service}\n\nStart with "${hello(c)}", then three short paragraphs, 55 to 95 words in all:\n1. The one thing you read about them, plainly ("I saw that ..."). One sentence. Never explain their own business to them, or what it means.\n2. Who we are and what we train people in, in a few words, one way it may touch their work, said as a possibility, and one or two concrete things in ${name} that someone in their job could use, taken only from what is in brackets above.\n3. One short question: shall I send it?\nWrite as one person ("I" for yourself, "we" for the academy), in short everyday sentences you would say aloud. Concrete things, no abstract ones. Name at most two things from ${name}, never a list. Never say or hint that we do the kind of training they already run, unless What we sell says so. Do not ask for a call. Do not sign it.\n\nThe tone, from an email to another company (copy how it sounds, never what it says):\n"I saw that you opened a second warehouse in May and are hiring ten junior planners.\n\nI'm with ${getAcademyContext().academyName}. We train people in data and software. If you are training the new planners, our free guide may help: it has a checklist for choosing who to take on.\n\nShall I send it to you?"${wrong.length ? `\nYour last try had: ${wrong.join('; ')}. Write it without that.` : ''}\nJSON only: {"subject": "under 60 characters, specific to them, no capitals for effect", "text": "paragraphs separated by \\n\\n"}`,
      });
      const j = jsonOf<{ subject?: string; text?: string }>(a);
      subject = String(j?.subject || '').replace(/\s+/g, ' ').trim().slice(0, 90);
      text = cleanText(j?.text || '');
      const stiff = stiffWords(text);
      wrong = [...draftProblems(subject, text, 'first'), ...(stiff.length ? [`stiff words (${stiff.join(', ')})`] : []), ...(longList(text) ? ['a long list in one sentence (name one or two things)'] : [])];
      if (!wrong.length) break;
    } catch (e) {
      log('system', 'error', `The first email to ${c.name} could not be written by the AI: ${safeReason((e as Error).message)}`);
      break;
    }
  }
  if (!text || draftProblems(subject, text, 'first').length) {
    // A plain one a person can work from.
    subject = `${name} for ${c.name}`.slice(0, 88);
    text = `${hello(c)}\n\n${c.facts[0] ? `I read that ${c.facts[0].text.replace(/\.$/, '').replace(/^[A-Z](?=[a-z])/, (x) => x.toLowerCase())}.` : `I came across ${c.name}.`} We train teams in ${c.service || 'practical technology skills'}, and it made me think of you.\n\nWe have put together ${name.replace(/^The /, 'the ')}${offer?.about ? `: ${offer.about.replace(/\.$/, '')}` : ''}. May I send it to you?`;
  }
  return newMessage({ kind: 'first', subject, text });
}

/* ── What goes out ────────────────────────────────────────────────────────── */

/** The whole email: the words, what we give, who we are, how to stop. */
export function compose(c: Company, m: Message, tenantId = currentTenantId()): { subject: string; text: string; html: string; stop: string } {
  const s = settings(tenantId);
  const academy = getAcademyContext(tenantId).academyName;
  const given = s.magnets.filter((x) => m.magnets?.includes(x.id) && x.link);
  const links = [...given.map((x) => ({ label: x.name, url: x.link })), ...(m.magnets?.includes('booking') && s.bookingLink ? [{ label: 'Choose a time for a call', url: s.bookingLink }] : [])];
  const stop = stopUrl(c, tenantId);
  const who = [s.fromName, s.fromTitle, academy].filter(Boolean);
  const why = m.kind === 'first' ? `We found ${c.name} on its public website. This is the only email we will send unless you answer.` : 'You are getting this because you answered our email.';
  const text = [m.text.trim(), ...links.map((l) => `${l.label}: ${l.url}`), `Kind regards,\n${who.join('\n')}`, `--\n${[academy, s.address].filter(Boolean).join(', ')}\n${why} Not for you? Reply "no" or use ${stop} and we will not write again.`].join('\n\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#ffffff"><div style="max-width:600px;margin:0 auto;padding:22px 18px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1b253b">${paragraphs(m.text).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br/>')}</p>`).join('')}${links.map((l) => `<p style="margin:0 0 14px"><a href="${esc(l.url)}" style="color:#0a1733;font-weight:bold">${esc(l.label)}</a></p>`).join('')}<p style="margin:18px 0 0">Kind regards,<br/><b>${esc(who[0] || academy)}</b>${who.slice(1).map((x) => `<br/><span style="color:#5b6478;font-size:13px">${esc(x)}</span>`).join('')}</p><p style="margin:26px 0 0;font-size:11.5px;line-height:1.5;color:#8a93a6">${esc([academy, s.address].filter(Boolean).join(', '))}<br/>${esc(why)} Not for you? Reply &quot;no&quot; or <a href="${esc(stop)}" style="color:#8a93a6">tell us here</a> and we will not write again.</p></div></body></html>`;
  return { subject: m.subject, text, html, stop };
}

/** Replaced by the tests. */
export const mailer = { make: (o: nodemailer.TransportOptions | Record<string, unknown>) => nodemailer.createTransport(o as nodemailer.TransportOptions) };

/** Weekdays, 08:30 to 16:30 (South African time). */
export const officeHours = (now = Date.now()) => isWeekday(now) && sastHour(now) >= 8.5 && sastHour(now) < 16.5;

/** Why nothing may be sent now, or ''. */
export function sendingBlocked(tenantId = currentTenantId()): string {
  const s = settings(tenantId);
  if (!s.sendingOn) return 'Sending is switched off.';
  if (!liveAllowed(getTenantIntegrations(tenantId).liveOutreachEnabled)) return 'Live Outreach is off, or sending is paused on this server.';
  if (!/^https:\/\//.test(publicUrl(tenantId))) return 'The public address of this server is not set (the stop link needs it).';
  const missing = missingForSending(s);
  return missing.length ? `Still missing: ${missing.join(', ')}.` : '';
}

/** Why this very message may not go: the person, or its words (the list, or the time left before a date, may have changed since it was checked). */
export function notFit(c: Company, m: Message, tenantId = currentTenantId(), now = Date.now()): string {
  const not = neverSaid(`${m.subject}\n${m.text}`, settings(tenantId).never);
  return mayNotWrite(c, m.kind, tenantId) || (not.length ? `it says ${not[0]}` : '') || outOfDate(m.text, countedTo(tenantId), m.at, now);
}

/** Sends one message now. Everything is checked again here. */
export async function sendMessage(c: Company, m: Message, tenantId = currentTenantId(), now = Date.now()): Promise<{ ok: boolean; detail: string }> {
  const blocked = sendingBlocked(tenantId) || notFit(c, m, tenantId, now);
  if (blocked) return { ok: false, detail: blocked };
  const s = settings(tenantId);
  const e = compose(c, m, tenantId);
  const before = c.thread.filter((x) => x.messageId);
  const lastIn = [...before].reverse().find((x) => x.who === 'them');
  const run = runState(tenantId);
  try {
    const t = mailer.make({ host: s.smtpHost, port: s.smtpPort, secure: s.smtpPort === 465, auth: { user: s.smtpUser, pass: /gmail|google/i.test(s.smtpHost) ? s.smtpPass.replace(/\s+/g, '') : s.smtpPass }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 });
    const info = await t.sendMail({
      from: `"${s.fromName.replace(/["\\<>]/g, '')}" <${s.smtpUser}>`, to: c.contact.email, subject: m.kind === 'first' || !lastIn ? e.subject : /^re:/i.test(lastIn.subject) ? lastIn.subject : `Re: ${lastIn.subject || e.subject}`,
      text: e.text, html: e.html,
      ...(lastIn?.messageId ? { inReplyTo: lastIn.messageId, references: before.map((x) => x.messageId!).slice(-10) } : {}),
      headers: { 'List-Unsubscribe': `<${e.stop}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    Object.assign(m, { status: 'sent', at: now, messageId: (info as { messageId?: string })?.messageId || undefined, error: undefined });
    run.lastSendAt = now;
    c.lastAt = now;
    if (m.kind === 'first') {
      if (run.sentDay !== sastDay(now)) { run.sentDay = sastDay(now); run.sentToday = 0; }
      run.sentToday++;
      setStage(c, 'contacted', { contactedAt: now, consent: 'asked' });
    } else {
      if (m.kind === 'nurture') c.nurtured++;
      saveCompany(c);
    }
    saveRun(tenantId);
    log('system', 'email', `B2B: "${m.subject}" sent to ${c.name}.`);
    return { ok: true, detail: `Sent to ${c.name}.` };
  } catch (err) {
    const why = safeReason((err as Error).message);
    if (mailboxRefuses((err as Error).message) || /ETIMEDOUT|ECONN|ESOCKET|EDNS|Greeting/i.test((err as Error).message)) {
      // The mailbox, not the company: nothing more is tried for an hour.
      run.pausedUntil = now + 3_600_000;
      run.lastError = `The outreach mailbox could not send: ${why}`;
      run.lastErrorAt = now;
      saveRun(tenantId);
    } else {
      Object.assign(m, { status: 'failed', error: why });
      saveCompany(c);
    }
    log('system', 'error', `B2B: the email to ${c.name} was not sent: ${why}`);
    return { ok: false, detail: why };
  }
}

const busy = new Set<string>();

/** What is due goes, one at a time: answers first, then first emails spread over the day. Called by the pump. */
export async function pumpSend(tenantId = currentTenantId(), now = Date.now()): Promise<number> {
  const run = runState(tenantId);
  if (busy.has(tenantId) || sendingBlocked(tenantId) || !officeHours(now) || (run.pausedUntil || 0) > now) return 0;
  busy.add(tenantId);
  try {
    const s = settings(tenantId);
    const due = companies(tenantId).flatMap((c) => c.thread.filter((m) => m.who === 'us' && m.status === 'ready').map((m) => ({ c, m })));
    // One that may not go waits for a person, and never holds up the next one.
    const held = due.find((x) => notFit(x.c, x.m, tenantId, now));
    if (held) { held.m.status = 'draft'; held.m.error = `Not sent: ${notFit(held.c, held.m, tenantId, now)}.`; saveCompany(held.c); return 0; }
    const answer = due.filter((x) => x.m.kind !== 'first').sort((a, b) => a.m.at - b.m.at)[0];
    if (answer) return (await sendMessage(answer.c, answer.m, tenantId, now)).ok ? 1 : 0;
    const today = run.sentDay === sastDay(now) ? run.sentToday : 0;
    // Never a burst: 7 to 18 minutes between first emails, not the same each time.
    const gap = (7 + (Math.floor(run.lastSendAt / 60_000) % 12)) * 60_000;
    if (today >= s.sendPerDay || now - run.lastSendAt < gap) return 0;
    const first = due.filter((x) => x.m.kind === 'first').sort((a, b) => b.c.score - a.c.score)[0];
    if (!first) return 0;
    return (await sendMessage(first.c, first.m, tenantId, now)).ok ? 1 : 0;
  } finally {
    busy.delete(tenantId);
  }
}

/* ── Yes or no from the team ──────────────────────────────────────────────── */

/** Approved: the first email is written next (and waits for a check, unless that is off). */
export function approve(c: Company, by: string): Company {
  return c.stage === 'found' ? setStage(c, 'approved', { decidedAt: Date.now(), decidedBy: by }) : c;
}

/** Writes the first email when there is an address and none is written yet. */
export async function draftFirst(c: Company, again = false): Promise<Company> {
  if (c.stage !== 'approved' || mayNotWrite(c, 'first')) return c;
  if (c.thread.some((m) => m.kind === 'first' && m.status !== 'failed') && !again) return c;
  const m = await writeFirst(c);
  // It may have been rejected, or stopped, while the email was being written.
  if (c.stage !== 'approved' || mayNotWrite(c, 'first')) return c;
  if (!settings().checkFirst && !draftProblems(m.subject, m.text, 'first').length) m.status = 'ready';
  c.thread = [...c.thread.filter((x) => x.kind !== 'first' || x.status === 'failed'), m];
  return saveCompany(c);
}

const drafting = new Set<string>();

/** The next approved company without a first email gets one. Called by the pump, one at a time. */
export async function draftNext(tenantId = currentTenantId()): Promise<Company | null> {
  if (drafting.has(tenantId)) return null;
  const next = companies(tenantId).find((c) => c.stage === 'approved' && !c.thread.some((m) => m.kind === 'first' && m.status !== 'failed') && !mayNotWrite(c, 'first', tenantId));
  if (!next) return null;
  drafting.add(tenantId);
  try { return await draftFirst(next); } finally { drafting.delete(tenantId); }
}

export function reject(c: Company, reason: string, by: string): Company {
  c.thread = c.thread.filter((m) => m.status === 'sent' || m.status === 'in');
  return setStage(c, 'rejected', { rejectReason: reason, decidedAt: Date.now(), decidedBy: by });
}

/* ── What they answer ─────────────────────────────────────────────────────── */

const SAYS_STOP = /^\s*(no|stop|unsubscribe|remove( me| us)?|no,? thank(s| you)|not interested|please (stop|remove)|do not (contact|email)( us| me)?( again)?)\b([\s.!,]*(thank(s| you)|not interested|please|from (your|the) (mailing )?list|me|us|again|kind regards))*[\s.!]*$/i;
/** A short, clear no: no AI needed, and no answer given. */
export const clearNo = (t: string) => SAYS_STOP.test(t.split('\n').map((x) => x.trim()).filter(Boolean)[0] || '') && t.split(/\s+/).length < 25;

const INTENTS = ['yes', 'no', 'question', 'call', 'later', 'wrong_person', 'other'] as const;
type Intent = (typeof INTENTS)[number];
const word = (v: unknown, max = 160) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Ready for a call: they asked for one, or we know what they need and for how many or when. */
export const isQualified = (said: Qualified, intent?: string) => intent === 'call' || Boolean(said.need && (said.people || said.timing));

/** They wrote back. */
export async function handleReply(c: Company, r: { text: string; subject?: string; from?: string; messageId?: string; at?: number }, tenantId = currentTenantId()): Promise<Intent> {
  const at = r.at || Date.now();
  if (r.messageId && c.thread.some((m) => m.messageId === r.messageId)) return 'other';
  c.thread = [...c.thread.filter((m) => !(m.kind === 'nurture' && (m.status === 'draft' || m.status === 'ready'))), { id: nid('m'), who: 'them', kind: 'in', subject: word(r.subject, 160), text: r.text.slice(0, 4000), at, status: 'in', messageId: r.messageId, by: r.from }];
  c.lastAt = at;
  saveCompany(c);
  if (clearNo(r.text)) { stopFor(c, 'said no'); return 'no'; }
  const s = told(tenantId);
  const open = offerOf(c);
  const gifts = s.magnets.filter((x) => x.on && x.link);
  let j: Record<string, unknown> | null = null;
  try {
    const a = await ask({
      model: writerModel(), maxTokens: 4000, system: voice(c),
      prompt: `They answered us. Our conversation, oldest first:\n${c.thread.filter((m) => m.status === 'sent' || m.status === 'in').slice(-8).map((m) => `${m.who === 'us' ? 'US' : 'THEM'}: ${m.text.slice(0, 1200)}`).join('\n---\n')}\n\nWhat we know: ${JSON.stringify(c.said)}\nFree things we can send (by id): ${gifts.map((x) => `${x.id} = ${x.name}${x.about ? ` (${x.about})` : ''}`).join('; ') || 'none'}. ${open ? `We offered ${open.id}.` : ''}\n\nDecide what they mean, and write our answer. Give what they asked for, answer only what we know (otherwise say ${s.callsWith || 'a colleague'} will answer on a call), and ask one natural question that tells us what they need, for how many people, or by when: never a list of questions. Offer a call only when they want one, or when we know what they need. The links are added for you: list the ids in "magnets", and "booking" when a call is offered.\nJSON only: {"intent": "yes (interested or please send it) | no | question | call (wants to talk) | later | wrong_person | other (automatic reply, unclear)", "said": {"need": "", "people": "", "budget": "", "timing": "", "decider": ""}, "summary": "one line for the sales team", "magnets": ["ids"], "reply": "our answer, under 130 words, starting with a greeting, paragraphs separated by \\n\\n, no sign-off; '' when no answer is needed"}`,
    });
    j = jsonOf<Record<string, unknown>>(a);
  } catch (e) {
    log('system', 'error', `B2B: ${c.name}'s answer could not be read by the AI: ${safeReason((e as Error).message)}`);
  }
  if (!j || !INTENTS.includes(j.intent as Intent)) {
    c.summary = 'They answered. Read it and reply.';
    setStage(c, c.stage === 'contacted' ? 'talking' : c.stage);
    await postNote(`💬 **${c.name}** answered, and it needs a person to read it.`, tenantId);
    return 'other';
  }
  const intent = j.intent as Intent;
  if (intent === 'no') { c.summary = word(j.summary); stopFor(c, 'said no'); return 'no'; }
  const said = (j.said || {}) as Record<string, unknown>;
  for (const k of ['need', 'people', 'budget', 'timing', 'decider'] as const) { const v = word(said[k]); if (v && !/^(unknown|n\/?a|none|not (said|known|given))$/i.test(v)) c.said[k] = v; }
  c.summary = word(j.summary, 240) || c.summary;
  if (intent === 'yes' || intent === 'call' || intent === 'later') c.consent = 'yes';
  const qualified = isQualified(c.said, intent);
  const text = cleanText(String(j.reply || ''));
  if (text && intent !== 'other') {
    const ids = (Array.isArray(j.magnets) ? j.magnets : []).map(String).filter((id) => id === 'booking' || gifts.some((x) => x.id === id));
    // A yes always gets what was offered; someone ready always gets the booking link.
    if (intent === 'yes' && open?.link && !c.thread.some((m) => m.magnets?.includes(open.id))) ids.push(open.id);
    if (qualified) ids.push('booking');
    c.thread.push(newMessage({ kind: 'reply', subject: `Re: ${r.subject || c.thread.find((m) => m.kind === 'first')?.subject || c.name}`.replace(/^Re: re:/i, 'Re:'), text, magnets: [...new Set(ids)], status: s.checkReplies || draftProblems('x', text, 'reply').length ? 'draft' : 'ready' }));
  }
  const ahead = ['qualified', 'call_booked', 'won'].includes(c.stage);
  const news = qualified && !c.toldAt;
  setStage(c, ahead ? c.stage : qualified ? 'qualified' : 'talking', qualified && !c.qualifiedAt ? { qualifiedAt: at } : {});
  if (news && (await postHandover(c, tenantId))) { c.toldAt = Date.now(); saveCompany(c); }
  log('system', 'lms', `B2B: ${c.name} answered (${intent.replace('_', ' ')})${qualified ? ': ready for a call' : ''}.`);
  return intent;
}

/** The address does not exist: they were not reached, so they were not asked. */
export function bounced(c: Company): Company {
  for (const m of c.thread) if (m.kind === 'first' && m.status === 'sent') Object.assign(m, { status: 'failed', error: `The address ${c.contact.email} does not work.` });
  const bad = c.contact.email;
  c.contact = { ...c.contact, email: '', source: '' };
  c.notes = [c.notes, `${bad} does not work (the email came back).`].filter(Boolean).join('\n');
  return setStage(c, 'approved', { consent: 'none', contactedAt: undefined });
}

/* ── Keeping warm (only someone who said yes) ─────────────────────────────── */

const QUIET = 7 * DAY;
export const MAX_NURTURE = 3;
const NO_ANSWER = 21 * DAY;

/** Closes the ones that never answered, and writes the next useful thing to those who said yes and went quiet. */
export async function keepWarm(tenantId = currentTenantId(), now = Date.now()): Promise<number> {
  let n = 0;
  for (const c of companies(tenantId)) {
    if (c.stage === 'contacted' && c.consent === 'asked' && (c.contactedAt || now) < now - NO_ANSWER) { setStage(c, 'lost', { lostReason: 'No answer' }); continue; }
    if ((c.stage !== 'talking' && c.stage !== 'qualified') || c.consent !== 'yes' || c.nurtured >= MAX_NURTURE || (c.lastAt || now) > now - QUIET) continue;
    if (c.thread.some((m) => m.status === 'draft' || m.status === 'ready') || c.thread.filter((m) => m.status === 'sent' || m.status === 'in').at(-1)?.who !== 'us') continue;
    if (mayNotWrite(c, 'nurture', tenantId)) continue;
    const m = await writeNurture(c, tenantId);
    if (!m) continue;
    if (!settings(tenantId).checkReplies && !draftProblems('x', m.text, 'nurture').length) m.status = 'ready';
    c.thread.push(m);
    saveCompany(c);
    n++;
    // A few at a time: each one is written by the AI.
    if (n >= 3) break;
  }
  return n;
}

async function writeNurture(c: Company, tenantId: string): Promise<Message | null> {
  const s = told(tenantId);
  const next = s.magnets.find((x) => x.on && x.link && x.when === 'yes' && !c.thread.some((m) => m.magnets?.includes(x.id)));
  const last = c.thread.filter((m) => m.status === 'sent' || m.status === 'in').slice(-5);
  const what = next ? `Give them "${next.name}"${next.about ? ` (${next.about})` : ''}: say in a sentence what it would do for them.` : `Ask gently whether this is still useful, and offer a short call with ${s.callsWith || 'a colleague'}.`;
  let text = '';
  try {
    const a = await ask({ model: writerModel(), maxTokens: 2500, system: voice(c), prompt: `They said yes to hearing from us and went quiet. The last of it:\n${last.map((m) => `${m.who === 'us' ? 'US' : 'THEM'}: ${m.text.slice(0, 700)}`).join('\n---\n')}\n\n${what} 40 to 80 words, starting with "${hello(c)}", no guilt, one question at the end, no sign-off, no links (they are added).\nJSON only: {"text": ""}` });
    text = cleanText(jsonOf<{ text?: string }>(a)?.text || '');
  } catch { return null; }
  if (!text) return null;
  return newMessage({ kind: 'nurture', subject: `Re: ${c.thread.find((m) => m.kind === 'first')?.subject || c.name}`, text, magnets: [next ? next.id : 'booking'] });
}
