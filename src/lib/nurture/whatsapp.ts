import type { DataRecord } from '@/lib/types';
import { tenantDoc } from '@/lib/engine/tenantDoc';
import { appendConversation, getRecord, listRecords, setRecordField } from '@/lib/data/records';
import { LEADS_SOURCE_ID, liveFields } from '@/lib/data/sources';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { liveAllowed, sendingPaused } from '@/lib/email/pause';
import { log as storeLog } from '@/lib/engine/store';
import { dropProblem, isFailing, noteFine, noteProblem, safeReason } from '@/lib/engine/problems';
import { accountTrouble, manychat, type McContact } from '@/lib/messaging/manychat';
import { leadProgramme } from './programmes';
import { videoFor } from './video';
import { signTrack } from './track';
import { LEAD_TAG, isChattingTag, isStopTag, tagList } from './waTags';

/* WhatsApp follow-ups: a few, where email is not enough.
 *
 * WhatsApp lets a business start a conversation only with a template Meta
 * approved, so each message is a ManyChat automation holding one template.
 * Thuso fills the lead's fields and starts it:
 *
 *   nudge   three days on, an email delivered, nothing opened: the quiz
 *   video   they clicked or took the quiz, no video yet: their video
 *
 * Each goes once per lead, at most one WhatsApp a week, never within a day of
 * an email, only in daytime. Never to anyone who unsubscribed or sent STOP,
 * qualified or applied, replied to us, is with the sales team, or is in a
 * WhatsApp chat already. Someone another bot has (Abigail's tags) is left out
 * too: its open question would catch their reply. Old sheet rows are left
 * alone. Off until someone switches it on (Channels & API). */

const log: typeof storeLog = (actor, level, text, extra = {}) => storeLog(actor, level, text, { dept: 'admissions', ...extra });

export type WaKind = 'nudge' | 'video';
export const WA_FIELDS = ['thuso_programme', 'thuso_quiz', 'thuso_video', 'thuso_call'] as const;
const WA_NAME: Record<WaKind, string> = { nudge: 'the quiz nudge', video: 'their programme video' };

const DAY = 86_400_000;
const SAST_MS = 2 * 3_600_000; // South Africa: UTC+2 all year
const num = (v: string | undefined) => { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; };
const at = (v: string | undefined) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };

/** Weekdays 09:00 to 18:00 and Saturday 09:00 to 13:00 (South African time); never on Sunday. */
export function whatsappHours(now = Date.now()): boolean {
  const d = new Date(now + SAST_MS);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  return day === 0 ? false : day === 6 ? h >= 9 && h < 13 : h >= 9 && h < 18;
}

/** A number WhatsApp can use: +, then 10 to 15 digits. */
export const usablePhone = (p: string | undefined) => /^\+\d{10,15}$/.test(p || '');

/** Which WhatsApp a lead is due now, or why none. Pure. */
export function whatsappDue(r: Pick<DataRecord, 'firstSeenAt' | 'phone' | 'fields'>, now: number, videoReady: boolean): { kind: WaKind | null; why: string } {
  const f = r.fields;
  const none = (why: string) => ({ kind: null, why });
  if (f.preview === 'yes') return none('a test lead');
  if (f.imported_quietly === 'yes') return none('an old sheet row');
  if (f.opted_out === 'yes') return none('unsubscribed');
  if (f.whatsapp_stopped === 'yes') return none('asked WhatsApp to stop');
  if (f.qualified === 'yes' || f.dialer_left === 'yes' || f.dialer_in === 'yes') return none('with the sales team');
  if (/^(applied|enrolled|registered|student|qualified|with sales)$/i.test(f.status || '')) return none('applied or with the sales team');
  if (f.replied === 'yes') return none('replied: a conversation is going');
  if (!usablePhone(r.phone)) return none('no usable phone number');
  if (at(f.whatsapp_last_at) > now - 7 * DAY) return none('had a WhatsApp this week');
  if (at(f.whatsapp_retry_at) > now) return none('tried recently');
  if (!f.nurture_delivered_at) return none('no email has reached them yet');
  if (Math.max(at(f.nurture_delivered_at), at(f.nurture_last_sent_at)) > now - DAY) return none('had an email in the last day');

  const did = num(f.nurture_clicks) > 0 || f.fit_done === 'yes';
  if (did && !f.whatsapp_video_at && !/(^|\|)video:/.test(f.nurture_seen || '')) {
    const last = at(f.last_engaged_at);
    if (!videoReady) return none('no video for their programme');
    if (last && last <= now - 4 * 3_600_000 && last > now - 14 * DAY) return { kind: 'video', why: 'clicked or took the quiz, and has not watched their video' };
    return none(last ? 'clicked too recently, or too long ago' : 'no date for what they did');
  }
  const silent = !did && num(f.nurture_opens) === 0 && num(f.engagement_score) === 0;
  if (silent && !f.whatsapp_nudge_at && r.firstSeenAt <= now - 3 * DAY && r.firstSeenAt > now - 30 * DAY) {
    return { kind: 'nudge', why: 'three days on, nothing opened' };
  }
  return none('nothing due');
}

/** A video that really is about their programme (or the general one, for someone who has not chosen). */
function videoFits(programme: string): boolean {
  const v = videoFor(programme || 'general');
  if (!v) return false;
  return v.programme.toLowerCase() === (programme || 'general').toLowerCase();
}

interface WaState {
  day: string; sent: number; pausedUntil: number; lastError: string; fails: number;
  /** Who one could not be sent to, for the daily report. */
  failed?: { at: number; name: string; why: string }[];
  /** Handed over with no confirmation, in a row: ManyChat may be down. */
  unsure?: number;
  /** The lead the last account problem came up with: another one is tried next. */
  stuckOn?: string;
}
const waDoc = tenantDoc<WaState>('nurture-whatsapp', () => ({ day: '', sent: 0, pausedUntil: 0, lastError: '', fails: 0 }));
const today = (now: number) => new Date(now + SAST_MS).toISOString().slice(0, 10);

function settings(tenantId: string) {
  const ti = getTenantIntegrations(tenantId);
  const w = ti.whatsappFollowups || {};
  return {
    key: (ti.manychatApiKey || '').trim(), on: Boolean(w.on), live: liveAllowed(ti.liveOutreachEnabled),
    flows: { nudge: (w.nudgeFlow || '').trim(), video: (w.videoFlow || '').trim() } as Record<WaKind, string>,
    perDay: Math.max(1, Math.min(200, Number(w.perDay) || 20)), addContacts: Boolean(w.addContacts),
    leaveOut: tagList(w.leaveOutTags),
  };
}

type Outcome = { result: 'sent' | 'unknown' | 'skipped' | 'failed' | 'account'; detail: string };
const ACCOUNT_STATUS = new Set([0, 401, 403, 429]);
const accountProblem = (status: number, error = '') => ACCOUNT_STATUS.has(status) || status >= 500 || accountTrouble(error);
/** A reason that will not pass by itself (an unpaid plan, a switched-off channel, a refused key). */
const lasting = (why: string) => accountTrouble(why) || /HTTP 40[13]|token|unauthori[sz]ed|forbidden|field|flow|automation/i.test(why);

/** Fills a contact's fields and starts the automation. `onStart` runs just before the message may leave. */
async function deliver(mc: ReturnType<typeof manychat>, contact: McContact, who: { sourceId: string; key: string; programme: string }, kind: WaKind, flow: string, tenantId: string, onStart: () => void): Promise<Outcome> {
  const link = (x: 'quiz' | 'video' | 'call') => signTrack({ t: tenantId, s: who.sourceId, k: who.key, m: `wa_${kind}`, x });
  // No line breaks or long text: WhatsApp refuses a template whose fields have them.
  const programme = (who.programme || 'a tech career').replace(/\s+/g, ' ').trim().slice(0, 60);
  const values: Record<(typeof WA_FIELDS)[number], string> = { thuso_programme: programme, thuso_quiz: link('quiz'), thuso_video: link('video'), thuso_call: link('call') };
  // Theirs is a Thuso conversation from the first message: without the tag their reply would go to another bot.
  const tagged = await mc.tag(contact.id, LEAD_TAG);
  if (!tagged.ok) return { result: 'account', detail: `the tag ${LEAD_TAG} could not be set: ${tagged.error}` };
  setRecordField(who.sourceId, who.key, 'manychat_id', String(contact.id));
  // Templates have no fallback for an empty field, so every field must be in before anything is sent.
  for (const name of WA_FIELDS) {
    const r = await mc.setField(contact.id, name, values[name]);
    if (!r.ok) return { result: accountProblem(r.status, r.error) || /field/i.test(r.error) ? 'account' : 'failed', detail: `${name} could not be set: ${r.error}` };
  }
  onStart();
  const r = await mc.sendFlow(contact.id, flow);
  if (r.ok) return { result: 'sent', detail: 'ManyChat started the message' };
  // No answer (or a server error): it may have gone, so it is never sent again.
  if (r.status === 0 || r.status >= 500) return { result: 'unknown', detail: r.error };
  return { result: ACCOUNT_STATUS.has(r.status) || accountTrouble(r.error) || /flow/i.test(r.error) ? 'account' : 'failed', detail: r.error };
}

async function phoneFieldIds(mc: ReturnType<typeof manychat>, known?: Awaited<ReturnType<ReturnType<typeof manychat>['fields']>>): Promise<number[]> {
  const r = known || await mc.fields();
  return (r.data || []).filter((x) => /phone|whatsapp.?(number|no)/i.test(x.name) && (!x.type || x.type === 'text')).map((x) => x.id);
}

const firstNameOf = (rec: Pick<DataRecord, 'name' | 'fields'>) => (rec.fields.first_name || rec.name).trim().split(/\s+/)[0] || '';

/** Sends one lead the WhatsApp they are due, and remembers it. Everything is checked again here. */
async function sendTo(mc: ReturnType<typeof manychat>, rec: DataRecord, kind: WaKind, s: ReturnType<typeof settings>, fields: number[], tenantId: string): Promise<Outcome> {
  const set = (k: string, v: string) => setRecordField(rec.sourceId, rec.key, k, v);
  const later = (days: number) => set('whatsapp_retry_at', new Date(Date.now() + days * DAY).toISOString());
  const found = await mc.find(rec.phone, rec.email, fields);
  if (found.error) return { result: 'account', detail: found.error };
  let contact = found.contact;
  if (!contact) {
    if (!s.addContacts) { later(7); return { result: 'skipped', detail: 'not in ManyChat (adding contacts is off)' }; }
    const parts = rec.name.trim().split(/\s+/);
    const made = await mc.create(rec.phone, firstNameOf(rec), parts.slice(1).join(' '));
    if (!made.ok || !made.data?.id) {
      if (accountProblem(made.status, made.error)) return { result: 'account', detail: made.error };
      later(7);
      return { result: 'failed', detail: `could not be added to ManyChat: ${made.error}` };
    }
    contact = { ...made.data, first_name: made.data.first_name || firstNameOf(rec) };
  } else {
    const tags = (contact.tags || []).map((t) => t?.name || '');
    // Opted out with any bot is opted out: it is the same WhatsApp number.
    const stopped = tags.some(isStopTag);
    if (stopped || contact.optin_whatsapp === false) {
      if (stopped) set('whatsapp_stopped', 'yes'); else later(30);
      return { result: 'skipped', detail: stopped ? 'sent STOP on WhatsApp' : 'not opted in to WhatsApp in ManyChat' };
    }
    const other = tags.find((t) => s.leaveOut.includes(t.trim().toLowerCase()));
    if (other) { later(3); return { result: 'skipped', detail: `tagged ${other} in ManyChat (with another bot or a person)` }; }
    // Someone else's chat is never interrupted. In a chat that is already Thuso's, a day's quiet is enough.
    const ours = tags.includes(LEAD_TAG);
    const lastWrote = at(contact.last_interaction || '');
    if (ours ? lastWrote > Date.now() - DAY : tags.some(isChattingTag) || lastWrote > Date.now() - 7 * DAY) {
      later(7);
      return { result: 'skipped', detail: 'already chatting on WhatsApp' };
    }
  }
  // The template greets them by ManyChat's First Name, which has no fallback either.
  if (!(contact.first_name || '').trim()) { later(30); return { result: 'skipped', detail: 'no first name in ManyChat' }; }

  const stamp = kind === 'nudge' ? 'whatsapp_nudge_at' : 'whatsapp_video_at';
  const prevLast = rec.fields.whatsapp_last_at || '';
  const out = await deliver(mc, contact, { sourceId: rec.sourceId, key: rec.key, programme: leadProgramme(liveFields(rec)) }, kind, s.flows[kind], tenantId, () => {
    // Remembered before it leaves: a crash or a lost answer never sends it twice.
    const now = new Date().toISOString();
    set(stamp, now);
    set('whatsapp_last_at', now);
  });
  if (out.result === 'failed' || out.result === 'account') {
    set(stamp, '');
    set('whatsapp_last_at', prevLast);
    if (out.result === 'failed') later(3);
  } else {
    appendConversation(rec.sourceId, rec.key, 'us', `WhatsApp: ${WA_NAME[kind]}`, 'Naledi');
  }
  set('whatsapp_result', `${kind}: ${out.result}${out.result === 'sent' ? '' : ` (${out.detail})`}`.slice(0, 200));
  return out;
}

/** Who is due a WhatsApp now. */
export function dueLeads(now = Date.now()): { rec: DataRecord; kind: WaKind; why: string }[] {
  const out: { rec: DataRecord; kind: WaKind; why: string }[] = [];
  for (const rec of listRecords(LEADS_SOURCE_ID)) {
    const d = whatsappDue(rec, now, videoFits(leadProgramme(liveFields(rec))));
    if (d.kind) out.push({ rec, kind: d.kind, why: d.why });
  }
  // The people who did something first, then the ones waiting longest.
  return out.sort((a, b) => (a.kind === b.kind ? a.rec.firstSeenAt - b.rec.firstSeenAt : a.kind === 'video' ? -1 : 1));
}

const busy = new Set<string>();
const PER_TICK = 5;

const KEPT_FAILED = 60;

/** A few due WhatsApp follow-ups. Called by the always-on pump while Admissions is on autopilot. */
export async function pumpWhatsApp(tenantId = currentTenantId(), now = Date.now()): Promise<number> {
  const s = settings(tenantId);
  // Switched off: not broken.
  if (!s.on || !s.key) { dropProblem('whatsapp', tenantId); return 0; }
  if (!s.live || !whatsappHours(now) || busy.has(tenantId)) return 0;
  const st = waDoc.get(tenantId);
  if (st.pausedUntil > now) {
    // Paused before problems were kept: it is still one.
    if (st.lastError && !isFailing('whatsapp', tenantId)) noteProblem('whatsapp', { why: st.lastError, sure: true }, tenantId, now);
    return 0;
  }
  if (st.day !== today(now)) { st.day = today(now); st.sent = 0; st.fails = 0; }
  if (st.sent >= s.perDay) return 0;
  const due = dueLeads(now).filter((d) => s.flows[d.kind]);
  if (!due.length) return 0;
  busy.add(tenantId);
  let sent = 0;
  /** Stop, and say so: everyone can see it (the daily report, the page, Discord when that is on). */
  const stop = (why: string, hours: number, sure: boolean) => {
    st.lastError = why;
    st.pausedUntil = now + hours * 3_600_000;
    st.fails = 0;
    st.unsure = 0;
    noteProblem('whatsapp', { why, sure }, tenantId, now);
    log('system', 'error', `WhatsApp follow-ups paused for ${hours === 1 ? 'an hour' : 'a day'}: ${why}`);
  };
  const failedFor = (name: string, why: string) => { st.failed = [...(st.failed || []), { at: now, name: name.slice(0, 60), why: safeReason(why) }].slice(-KEPT_FAILED); };
  try {
    const mc = manychat(s.key);
    // The account first: when ManyChat refuses us, every lead would look like "not in ManyChat" and be put off for a week.
    const [page, known] = await Promise.all([mc.pageInfo(), mc.fields()]);
    const broken = [page, known].find((r) => !r.ok);
    if (broken) { stop(broken.error, 1, broken.status !== 0 && broken.status !== 429 && broken.status < 500); return 0; }
    const fields = await phoneFieldIds(mc, known);
    // Each lead tried is checked again against its newest record; skips do not use up the day.
    for (const d of due.slice(0, PER_TICK * 4)) {
      if (sent >= PER_TICK || st.sent >= s.perDay) break;
      const rec = getRecord(d.rec.sourceId, d.rec.key);
      if (!rec || whatsappDue(rec, now, videoFits(leadProgramme(liveFields(rec)))).kind !== d.kind) continue;
      const out = await sendTo(mc, rec, d.kind, s, fields, tenantId);
      if (out.result === 'sent') {
        sent++; st.sent++; st.fails = 0; st.unsure = 0; st.stuckOn = ''; st.lastError = '';
        noteFine('whatsapp', tenantId, now);
        noteFine('whatsapp_connect', tenantId, now);
        log('system', 'email', `WhatsApp (${WA_NAME[d.kind]}) → ${rec.name}: ${d.why}.`);
      } else if (out.result === 'unknown') {
        sent++; st.sent++;
        st.unsure = (st.unsure || 0) + 1;
        log('system', 'email', `WhatsApp (${WA_NAME[d.kind]}) → ${rec.name}: ${d.why}. ManyChat did not confirm it, so it is not sent again.`);
        // One is bad luck. Three in a row is ManyChat failing, and each one uses up a lead's only message.
        if (st.unsure >= 3) { stop(`ManyChat did not confirm the last ${st.unsure}: ${out.detail}`, 1, true); break; }
      } else if (out.result === 'skipped') {
        log('system', 'info', `WhatsApp to ${rec.name} left out: ${out.detail}.`);
      } else {
        st.lastError = out.detail;
        st.fails++;
        failedFor(rec.name, out.detail);
        // The account (key, plan, channel, field, automation, limit) or three leads in a row: stop and say so, do not try everyone.
        if (out.result === 'account' || st.fails >= 3) {
          // The same lead twice: it may be them after all, so someone else is tried next.
          if (out.result === 'account' && st.stuckOn === rec.key) setRecordField(rec.sourceId, rec.key, 'whatsapp_retry_at', new Date(now + DAY).toISOString());
          st.stuckOn = rec.key;
          stop(out.detail, out.result === 'account' ? 1 : 24, out.result !== 'account' || lasting(out.detail));
          break;
        }
        log('system', 'error', `WhatsApp to ${rec.name} was not sent: ${out.detail}`);
      }
    }
  } finally {
    waDoc.save(tenantId);
    busy.delete(tenantId);
  }
  return sent;
}

/** Can Thuso use the ManyChat account? Asked twice an hour while follow-ups are on, so an account that stopped is
 *  noticed even when nobody is due. Reads only. */
export async function watchWhatsApp(tenantId = currentTenantId(), now = Date.now()): Promise<void> {
  const s = settings(tenantId);
  if (!s.on || !s.key) { dropProblem('whatsapp_connect', tenantId); dropProblem('whatsapp', tenantId); return; }
  const page = await manychat(s.key).pageInfo();
  if (page.ok) noteFine('whatsapp_connect', tenantId, now);
  else noteProblem('whatsapp_connect', { why: page.error, sure: page.status !== 0 && page.status !== 429 && page.status < 500 }, tenantId, now);
}

/** How the follow-ups went in a window, for the daily report. */
export function whatsappDay(from: number, to: number, tenantId = currentTenantId(), now = Date.now()): { on: boolean; accepted: number; unsure: number; failed: { name: string; why: string }[]; waiting: number; pausedUntil: number } {
  const s = settings(tenantId);
  const st = waDoc.get(tenantId);
  const inWindow = (t: number) => t > from && t <= to;
  let accepted = 0, unsure = 0;
  for (const r of listRecords(LEADS_SOURCE_ID)) {
    if (r.fields.preview === 'yes') continue;
    for (const [kind, v] of [['nudge', r.fields.whatsapp_nudge_at], ['video', r.fields.whatsapp_video_at]] as const) {
      if (!inWindow(at(v))) continue;
      if ((r.fields.whatsapp_result || '').startsWith(`${kind}: unknown`)) unsure++; else accepted++;
    }
  }
  const failed = new Map<string, string>();
  for (const x of st.failed || []) if (inWindow(x.at)) failed.set(x.name, x.why);
  return {
    on: s.on && Boolean(s.key), accepted, unsure, failed: [...failed].map(([name, why]) => ({ name, why })),
    waiting: s.on && s.key ? dueLeads(now).filter((d) => s.flows[d.kind]).length : 0, pausedUntil: st.pausedUntil > now ? st.pausedUntil : 0,
  };
}

/** The last follow-ups ManyChat took, when not one was tapped or answered: it takes a message even when WhatsApp does
 *  not deliver it, and never says so. 0 when there are too few to tell, or somebody did something. */
export function silentWhatsApps(now = Date.now(), atLeast = 20): number {
  const got = listRecords(LEADS_SOURCE_ID).filter((r) => r.fields.preview !== 'yes'
    && [r.fields.whatsapp_nudge_at, r.fields.whatsapp_video_at].some((v) => at(v) > now - 14 * DAY && at(v) < now - DAY));
  const alive = got.some((r) => /(^|\|)(click|quiz|video):wa_/.test(r.fields.nurture_seen || '') || r.fields.whatsapp_last_text || r.fields.whatsapp_stopped === 'yes');
  return got.length >= atLeast && !alive ? got.length : 0;
}

/** What would go out, and how things stand. Sends nothing. */
export function previewWhatsApp(tenantId = currentTenantId(), now = Date.now()) {
  const s = settings(tenantId);
  const st = waDoc.get(tenantId);
  const due = dueLeads(now);
  return {
    nudge: due.filter((d) => d.kind === 'nudge').length,
    video: due.filter((d) => d.kind === 'video').length,
    sample: due.slice(0, 8).map((d) => ({ name: d.rec.name, kind: d.kind, why: d.why })),
    perDay: s.perDay, sentToday: st.day === today(now) ? st.sent : 0,
    on: s.on, live: s.live, hours: whatsappHours(now), pausedUntil: st.pausedUntil > now ? st.pausedUntil : 0, lastError: st.lastError,
  };
}

/** Is the key for the account that has these automations and fields? Reads only. */
export async function checkWhatsApp(tenantId = currentTenantId()): Promise<{ ok: boolean; detail: string; problems: string[] }> {
  const s = settings(tenantId);
  if (!s.key) return { ok: false, detail: 'Add the ManyChat API key first (card 5).', problems: ['no API key'] };
  const mc = manychat(s.key);
  const [page, flows, fields] = await Promise.all([mc.pageInfo(), mc.flows(), mc.fields()]);
  if (!page.ok) return { ok: false, detail: page.error, problems: [page.error] };
  const problems: string[] = [];
  const account = `${page.data?.name || 'a ManyChat account'}${page.data?.id ? ` (${page.data.id})` : ''}`;
  for (const kind of ['nudge', 'video'] as WaKind[]) {
    const ns = s.flows[kind];
    if (!ns) problems.push(`no flow ID for ${WA_NAME[kind]}`);
    else if (!flows.ok) problems.push(`the automations could not be read: ${flows.error}`);
    else if (!(flows.data || []).some((x) => x.ns === ns)) problems.push(`this account has no automation ${ns}`);
  }
  if (!fields.ok) problems.push(`the fields could not be read: ${fields.error}`);
  else for (const name of WA_FIELDS) if (!(fields.data || []).some((x) => x.name === name)) problems.push(`no field ${name}`);
  const names = (['nudge', 'video'] as WaKind[]).map((k) => (flows.data || []).find((x) => x.ns === s.flows[k])?.name).filter(Boolean);
  const unique = [...new Set(problems)];
  // Put right: carry on now, not when the pause ends.
  if (!unique.length) {
    const st = waDoc.get(tenantId);
    st.pausedUntil = 0; st.fails = 0; st.unsure = 0; st.lastError = '';
    noteFine('whatsapp_connect', tenantId);
    waDoc.save(tenantId);
  }
  return unique.length
    ? { ok: false, detail: `${account}: ${unique.join('; ')}.`, problems: unique }
    : { ok: true, detail: `${account} has both automations (${names.join(', ')}) and all four fields.`, problems: [] };
}

/** Sends one message to one number (yours), with links that work on a hidden test lead. */
export async function testWhatsApp(kind: WaKind, phone: string, preview: { sourceId: string; key: string }, tenantId = currentTenantId()): Promise<{ ok: boolean; detail: string }> {
  const s = settings(tenantId);
  if (!s.key) return { ok: false, detail: 'Add the ManyChat API key first (card 5).' };
  if (!s.live) return { ok: false, detail: sendingPaused() ? 'Sending is paused on the server.' : 'Live Outreach is off.' };
  if (!s.flows[kind]) return { ok: false, detail: `Save the flow ID for ${WA_NAME[kind]} first.` };
  if (!usablePhone(phone)) return { ok: false, detail: 'Use the full number with the country code, like +27821234567.' };
  const rec = getRecord(preview.sourceId, preview.key);
  if (!rec || rec.fields.preview !== 'yes') return { ok: false, detail: 'A test can only use a test lead.' };
  const mc = manychat(s.key);
  const found = await mc.find(phone, '', await phoneFieldIds(mc));
  if (found.error) return { ok: false, detail: found.error };
  if (!found.contact) return { ok: false, detail: 'ManyChat could not find that number. Open your contact in ManyChat and put the number in its Phone field (or "SA Phone"), then try again.' };
  if (!(found.contact.first_name || '').trim()) return { ok: false, detail: 'Your ManyChat contact has no first name. Add one, then try again.' };
  const out = await deliver(mc, found.contact, { ...preview, programme: leadProgramme(liveFields(rec)) }, kind, s.flows[kind], tenantId, () => undefined);
  // Typing a reply to a test gets a real answer, for the test lead.
  if (out.result === 'sent') { setRecordField(preview.sourceId, preview.key, 'whatsapp_test_at', new Date().toISOString()); noteFine('whatsapp', tenantId); }
  const theirs = (found.contact.tags || []).map((t) => (t?.name || '').trim()).filter((t) => s.leaveOut.includes(t.toLowerCase()));
  return out.result === 'sent'
    ? { ok: true, detail: `ManyChat accepted ${WA_NAME[kind]}. Check that it arrives on ${phone}.${theirs.length ? ` Your contact is tagged ${theirs.join(', ')}, so another bot may answer what you type (a lead with that tag would be left out).` : ''}` }
    : { ok: false, detail: out.detail };
}
