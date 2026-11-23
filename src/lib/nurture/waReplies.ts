import type { DataRecord } from '@/lib/types';
import { tenantDoc } from '@/lib/engine/tenantDoc';
import { listRecords, setRecordField } from '@/lib/data/records';
import { LEADS_SOURCE_ID } from '@/lib/data/sources';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { liveAllowed, sendingPaused } from '@/lib/email/pause';
import { log as storeLog } from '@/lib/engine/store';
import { manychat, samePhoneKey } from '@/lib/messaging/manychat';
import { discordWebhook, postDiscordNote } from './qualify';

/* What Thuso's leads type on WhatsApp.
 *
 * Thuso's leads stay with Thuso: every lead it messages is tagged thuso_lead
 * in ManyChat, and ManyChat's Default Reply passes what they type to
 * /api/webhooks/whatsapp-reply instead of to another bot. People send a
 * thought in three messages, so Thuso waits until they have stopped typing,
 * then answers once, on WhatsApp, as Naledi or Zinhle. Anything it cannot
 * answer (nobody matches, autopilot is off, an answer is stuck waiting for
 * approval) goes to the team's Discord, so nobody is left unanswered. */

const log: typeof storeLog = (actor, level, text, extra = {}) => storeLog(actor, level, text, { dept: 'admissions', ...extra });

interface Chat { id: string; phone: string; name: string; texts: string[]; firstAt: number; lastAt: number; nextTry: number; told?: boolean }
const inbox = tenantDoc<Record<string, Chat>>('whatsapp-inbox', () => ({}));

export const QUIET_MS = 20_000;
const WINDOW_MS = 23.5 * 3_600_000; // WhatsApp's 24 hours, with room to spare
const MAX_CHATS = 500;
const NOT_TEXT = '(They sent a voice note, picture or file, which cannot be read here.)';

export interface Incoming { id: string; phone: string; name: string; text: string }

const str = (v: unknown, max: number) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');

/** What ManyChat sent (its Full Contact Data, or our own short JSON). Null when there is no contact in it. */
export function readIncoming(body: Record<string, unknown>): Incoming | null {
  const id = str(body.subscriber_id ?? body.contact_id ?? body.user_id ?? body.id, 40);
  if (!/^\d{3,25}$/.test(id)) return null;
  return {
    id,
    phone: str(body.whatsapp_phone, 30) || str(body.phone, 30),
    name: str(body.name, 80) || [str(body.first_name, 40), str(body.last_name, 40)].filter(Boolean).join(' '),
    text: str(body.text ?? body.last_input_text ?? body.message, 1500),
  };
}

/** Keeps a message until they have stopped typing. The same text again within seconds is a repeat delivery, not a second message. */
export function receive(m: Incoming, tenantId = currentTenantId(), now = Date.now()): boolean {
  const all = inbox.get(tenantId);
  const text = m.text || NOT_TEXT;
  const chat = all[m.id];
  if (!chat && Object.keys(all).length >= MAX_CHATS) { log('system', 'error', 'Too many WhatsApp messages are waiting; a new one was not kept.'); return false; }
  const c: Chat = chat || { id: m.id, phone: m.phone, name: m.name, texts: [], firstAt: now, lastAt: now, nextTry: 0 };
  if (c.texts.at(-1) === text && now - c.lastAt < 10_000) return true;
  c.texts = [...c.texts, text].slice(-12);
  c.phone = m.phone || c.phone;
  c.name = m.name || c.name;
  c.lastAt = now;
  all[m.id] = c;
  inbox.save(tenantId);
  return true;
}

/** The lead this contact is: the one Thuso messaged, a recent test, or the only lead with that number. */
export function leadFor(id: string, phone: string, now = Date.now()): DataRecord | null {
  const leads = listRecords(LEADS_SOURCE_ID);
  const mine = leads.filter((r) => r.fields.manychat_id === id);
  const test = mine.find((r) => r.fields.preview === 'yes' && now - Date.parse(r.fields.whatsapp_test_at || '') < 24 * 3_600_000);
  if (test) return test;
  const real = mine.find((r) => r.fields.preview !== 'yes');
  if (real) return real;
  const key = samePhoneKey(phone);
  if (key.length < 9) return null;
  const same = leads.filter((r) => r.fields.preview !== 'yes' && samePhoneKey(r.phone) === key);
  return same.length === 1 ? same[0] : null;
}

const busy = new Set<string>();

/** Answers everyone who has stopped typing. Called every few seconds. */
export async function pumpWaReplies(tenantId = currentTenantId(), now = Date.now()): Promise<number> {
  const all = inbox.get(tenantId);
  const due = Object.values(all).filter((c) => c.lastAt <= now - QUIET_MS && c.nextTry <= now);
  if (!due.length || busy.has(tenantId)) return 0;
  busy.add(tenantId);
  let answered = 0;
  try {
    const tell = (text: string) => postDiscordNote(discordWebhook(tenantId), text);
    for (const c of due) {
      const texts = c.texts.slice();
      const said = texts.join('\n');
      const quote = said.replace(/\s+/g, ' ').slice(0, 400);
      const rec = leadFor(c.id, c.phone, now);
      // Only what was handled is taken out: something typed meanwhile stays.
      const done = () => {
        const cur = all[c.id];
        if (!cur) return;
        cur.texts = cur.texts.slice(texts.length);
        if (!cur.texts.length) delete all[c.id]; else { cur.firstAt = now; cur.nextTry = 0; cur.told = false; }
        inbox.save(tenantId);
      };
      if (!rec) {
        done();
        log('system', 'error', `A WhatsApp from ${c.name || c.phone || 'someone'} could not be matched to one lead, so nobody answered it.`);
        await tell(`💬 **WhatsApp needs a person:** ${c.name || 'someone'}${c.phone ? ` (${c.phone})` : ''} wrote to Thuso, but I could not match them to one lead. They said: "${quote}". Please answer in ManyChat.`);
        continue;
      }
      if (rec.fields.manychat_id !== c.id) setRecordField(rec.sourceId, rec.key, 'manychat_id', c.id);
      // After a voice note ManyChat still shows their last typed message: not answered a second time.
      const stale = texts.length === 1 && said.length > 12 && said === rec.fields.whatsapp_last_text;
      const { dispatchWhatsAppReply } = await import('@/lib/engine/agentTriggers');
      const r = await dispatchWhatsAppReply(rec, stale ? NOT_TEXT : said, { contactId: c.id, at: c.lastAt });
      if (r !== 'busy') setRecordField(rec.sourceId, rec.key, 'whatsapp_last_text', said.slice(0, 1500));
      const test = rec.fields.preview === 'yes' ? '[TEST] ' : '';
      if (r === 'started') { done(); answered++; continue; }
      if (r === 'nobody') {
        done();
        await tell(`💬 ${test}**WhatsApp needs a person:** ${rec.name} wrote, and no agent may answer (Autopilot for Admissions or the reply agent is off, or they unsubscribed). They said: "${quote}". Please answer in ManyChat.`);
        continue;
      }
      // Busy: their last message is still being answered. After half an hour the team hears; after a day it is too late for WhatsApp.
      if (!c.told && now - c.firstAt > 30 * 60_000) {
        c.told = true;
        await tell(`💬 ${test}**WhatsApp is waiting:** ${rec.name} wrote again while an earlier answer is not finished (it may need your approval in Thuso's Inbox). They said: "${quote}".`);
      }
      if (now - c.firstAt > WINDOW_MS) { done(); log('system', 'error', `${rec.name}'s WhatsApp was not answered within a day.`); continue; }
      c.nextTry = now + 60_000;
      inbox.save(tenantId);
    }
  } finally {
    busy.delete(tenantId);
  }
  return answered;
}

/** Sends the answer in the same chat, while WhatsApp still allows it. */
export async function answerWhatsApp(contactId: string, wroteAt: number, text: string, tenantId = currentTenantId(), now = Date.now()): Promise<{ ok: boolean; detail: string }> {
  const ti = getTenantIntegrations(tenantId);
  if (!liveAllowed(ti.liveOutreachEnabled)) return { ok: true, detail: sendingPaused() ? 'kept in the app (sending is paused)' : 'kept in the app (Live Outreach is off)' };
  const key = (ti.manychatApiKey || '').trim();
  if (!key) return { ok: false, detail: 'ManyChat is not connected' };
  if (!wroteAt || now - wroteAt > WINDOW_MS) return { ok: false, detail: 'too late: WhatsApp allows typed answers for 24 hours after they write' };
  const r = await manychat(key).sendText(contactId, text.trim().slice(0, 1500));
  if (r.ok) return { ok: true, detail: 'answered in the chat' };
  // No answer: it may have gone, so it is not sent again by email.
  if (r.status === 0) return { ok: true, detail: 'sent, but ManyChat did not confirm it' };
  return { ok: false, detail: r.error };
}
