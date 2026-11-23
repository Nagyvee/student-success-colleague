import type { DataRecord } from '@/lib/types';
import { tenantDoc } from '@/lib/engine/tenantDoc';
import { appendConversation, getRecord, listRecords, setRecordField } from '@/lib/data/records';
import { LEADS_SOURCE_ID, liveFields } from '@/lib/data/sources';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { liveAllowed, sendingPaused } from '@/lib/email/pause';
import { log as storeLog } from '@/lib/engine/store';
import { manychat, type McContact } from '@/lib/messaging/manychat';
import { leadProgramme } from './programmes';
import { videoFor } from './video';
import { signTrack } from './track';

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
 * WhatsApp chat already (Abigail or a person answers those). Old sheet rows
 * are left alone. Off until someone switches it on (Channels & API). */

const log: typeof storeLog = (actor, level, text, extra = {}) => storeLog(actor, level, text, { dept: 'admissions', ...extra });

export type WaKind = 'nudge' | 'video';
export const WA_FIELDS = ['thuso_programme', 'thuso_quiz', 'thuso_video', 'thuso_call'] as const;
/** On every contact Thuso messages: ManyChat passes what they type to Thuso, not to another bot. */
export const LEAD_TAG = 'thuso_lead';
const STOP_TAG = 'thuso_whatsapp_stop';
const CHATTING_TAG = /^wa\s*-\s*replied$/i;
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

interface WaState { day: string; sent: number; pausedUntil: number; lastError: string; fails: number }
const waDoc = tenantDoc<WaState>('nurture-whatsapp', () => ({ day: '', sent: 0, pausedUntil: 0, lastError: '', fails: 0 }));
const today = (now: number) => new Date(now + SAST_MS).toISOString().slice(0, 10);

function settings(tenantId: string) {
  const ti = getTenantIntegrations(tenantId);
  const w = ti.whatsappFollowups || {};
  return {
    key: (ti.manychatApiKey || '').trim(), on: Boolean(w.on), live: liveAllowed(ti.liveOutreachEnabled),
    flows: { nudge: (w.nudgeFlow || '').trim(), video: (w.videoFlow || '').trim() } as Record<WaKind, string>,
    perDay: Math.max(1, Math.min(200, Number(w.perDay) || 20)), addContacts: Boolean(w.addContacts),
  };
}

type Outcome = { result: 'sent' | 'unknown' | 'skipped' | 'failed' | 'account'; detail: string };
const ACCOUNT_STATUS = new Set([0, 401, 403, 429]);
const accountProblem = (status: number) => ACCOUNT_STATUS.has(status) || status >= 500;

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
    if (!r.ok) return { result: accountProblem(r.status) || /field/i.test(r.error) ? 'account' : 'failed', detail: `${name} could not be set: ${r.error}` };
  }
  onStart();
  const r = await mc.sendFlow(contact.id, flow);
  if (r.ok) return { result: 'sent', detail: 'ManyChat started the message' };
  // No answer (or a server error): it may have gone, so it is never sent again.
  if (r.status === 0 || r.status >= 500) return { result: 'unknown', detail: r.error };
  return { result: ACCOUNT_STATUS.has(r.status) || /flow/i.test(r.error) ? 'account' : 'failed', detail: r.error };
}

async function phoneFieldIds(mc: ReturnType<typeof manychat>): Promise<number[]> {
  const r = await mc.fields();
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
      if (accountProblem(made.status)) return { result: 'account', detail: made.error };
      later(7);
      return { result: 'failed', detail: `could not be added to ManyChat: ${made.error}` };
    }
    contact = { ...made.data, first_name: made.data.first_name || firstNameOf(rec) };
  } else {
    const tags = (contact.tags || []).map((t) => t?.name || '');
    if (tags.includes(STOP_TAG) || contact.optin_whatsapp === false) {
      if (tags.includes(STOP_TAG)) set('whatsapp_stopped', 'yes'); else later(30);
      return { result: 'skipped', detail: tags.includes(STOP_TAG) ? 'sent STOP on WhatsApp' : 'not opted in to WhatsApp in ManyChat' };
    }
    // Someone else's chat is never interrupted. In a chat that is already Thuso's, a day's quiet is enough.
    const ours = tags.includes(LEAD_TAG);
    const lastWrote = at(contact.last_interaction || '');
    if (ours ? lastWrote > Date.now() - DAY : tags.some((t) => CHATTING_TAG.test(t.trim())) || lastWrote > Date.now() - 7 * DAY) {
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

/** A few due WhatsApp follow-ups. Called by the always-on pump while Admissions is on autopilot. */
export async function pumpWhatsApp(tenantId = currentTenantId(), now = Date.now()): Promise<number> {
  const s = settings(tenantId);
  if (!s.on || !s.live || !s.key || !whatsappHours(now) || busy.has(tenantId)) return 0;
  const st = waDoc.get(tenantId);
  if (st.pausedUntil > now) return 0;
  if (st.day !== today(now)) { st.day = today(now); st.sent = 0; st.fails = 0; }
  if (st.sent >= s.perDay) return 0;
  const due = dueLeads(now).filter((d) => s.flows[d.kind]);
  if (!due.length) return 0;
  busy.add(tenantId);
  let sent = 0;
  try {
    const mc = manychat(s.key);
    const fields = await phoneFieldIds(mc);
    // Each lead tried is checked again against its newest record; skips do not use up the day.
    for (const d of due.slice(0, PER_TICK * 4)) {
      if (sent >= PER_TICK || st.sent >= s.perDay) break;
      const rec = getRecord(d.rec.sourceId, d.rec.key);
      if (!rec || whatsappDue(rec, now, videoFits(leadProgramme(liveFields(rec)))).kind !== d.kind) continue;
      const out = await sendTo(mc, rec, d.kind, s, fields, tenantId);
      if (out.result === 'sent' || out.result === 'unknown') {
        sent++; st.sent++; st.fails = 0;
        log('system', 'email', `WhatsApp (${WA_NAME[d.kind]}) → ${rec.name}: ${d.why}${out.result === 'unknown' ? '. ManyChat did not confirm it, so it is not sent again' : ''}.`);
      } else if (out.result === 'skipped') {
        log('system', 'info', `WhatsApp to ${rec.name} left out: ${out.detail}.`);
      } else {
        st.lastError = out.detail;
        st.fails++;
        // The account (key, field, automation, limit) or three leads in a row: stop and say so, do not try everyone.
        if (out.result === 'account' || st.fails >= 3) {
          const hours = out.result === 'account' ? 1 : 24;
          st.pausedUntil = now + hours * 3_600_000;
          st.fails = 0;
          log('system', 'error', `WhatsApp follow-ups paused for ${hours === 1 ? 'an hour' : 'a day'}: ${out.detail}`);
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
    st.pausedUntil = 0; st.fails = 0; st.lastError = '';
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
  if (out.result === 'sent') setRecordField(preview.sourceId, preview.key, 'whatsapp_test_at', new Date().toISOString());
  return out.result === 'sent'
    ? { ok: true, detail: `ManyChat accepted ${WA_NAME[kind]}. Check that it arrives on ${phone}.` }
    : { ok: false, detail: out.detail };
}
