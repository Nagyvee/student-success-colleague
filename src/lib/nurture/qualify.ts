import type { DataRecord } from '@/lib/types';
import { getRecord, setRecordField } from '@/lib/data/records';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { liveAllowed, sendingPaused } from '@/lib/email/pause';
import { log as storeLog } from '@/lib/engine/store';

/** Lead nurturing is Admissions' work: its activity shows on that floor. */
const log: typeof storeLog = (actor, level, text, extra = {}) => storeLog(actor, level, text, { dept: 'admissions', ...extra });
import { leadProgramme } from './programmes';
import { leadProfile } from './profile';

/* A qualified lead goes to the people who close.
 *
 * Nurturing exists to get a lead to say yes. The moment they do (they tap
 * "Yes, I want to enrol" or "Call me", Thabo reads "I want to sign up" in a
 * reply) or their actions add up to 8 points, Thuso:
 *   1. marks them qualified on their record (and stops the marketing emails
 *      once they have said yes: a person takes it from here),
 *   2. posts a "call now" card in the team's Discord channel,
 *   3. adds them to the dialer as a new lead, with a brief in the notes
 *      (where they came from, what they want, how they would pay, what they
 *      did), so whoever calls knows the story before they dial.
 * The dialer rings real people, so it waits for Live Outreach like every
 * message does; Discord only reaches the team. */

export type QualifyReason = 'enrol' | 'call' | 'offer' | 'ready' | 'hot';

export const QUALIFY_REASON: Record<QualifyReason, { said: string; urgency: string; now: boolean }> = {
  enrol: { said: 'tapped "Yes, I want to enrol"', urgency: 'Call immediately', now: true },
  call: { said: 'asked us to call them', urgency: 'Call immediately', now: true },
  offer: { said: 'wants the offer', urgency: 'Call immediately', now: true },
  ready: { said: 'replied that they want to sign up', urgency: 'Call immediately', now: true },
  hot: { said: 'is hot: 8+ points from opening, clicking, the quiz and their video', urgency: 'Call today', now: false },
};

/** Where a lead came from, the way the sales team says it. */
export function leadChannel(f: Record<string, string>): string {
  const platform = (f.platform || '').trim().toLowerCase();
  if (platform === 'fb' || platform === 'facebook') return 'Facebook ads';
  if (platform === 'ig' || platform === 'instagram') return 'Instagram ads';
  if (/tiktok/.test(platform)) return 'TikTok';
  if (/whatsapp/.test(platform)) return 'WhatsApp';
  const tab = (f.agent_sheet_tab || f.sheet_tab || '').toLowerCase();
  if (/whatsapp/.test(tab)) return 'WhatsApp';
  if (/tiktok/.test(tab)) return 'TikTok';
  if (/openclaw|social/.test(tab)) return 'Social media';
  const src = (f.source || f.lead_source || '').trim();
  if (/whatsapp/i.test(src)) return 'WhatsApp';
  if (/tiktok/i.test(src)) return 'TikTok';
  if (/facebook|meta|\bfb\b/i.test(src)) return 'Facebook ads';
  if (/instagram|\big\b/i.test(src)) return 'Instagram ads';
  if (src && !/preview/i.test(src)) return src.slice(0, 40);
  return 'Website form';
}

export interface QualifyInput {
  reason: QualifyReason;
  /** The message or offer it came from ("Black Friday: half price"). */
  detail?: string;
  /** What the lead typed on the confirmation page, or a summary of their reply. */
  note?: string;
  /** "Today, afternoon". */
  bestTime?: string;
  /** A number they gave us now (when it differs from the sheet). */
  phone?: string;
  /** The agent run that qualified them keeps going (Thabo still finishes his reply). */
  keepRunId?: string;
}

const clean = (v: string | undefined, max = 200) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The brief the caller reads before dialling. Facts from the record only. */
export function leadBrief(rec: Pick<DataRecord, 'name' | 'email' | 'phone' | 'fields'>, q: QualifyInput): string {
  const f = rec.fields;
  const programme = leadProgramme(f) || clean(f.programme || f.interest, 60) || 'not chosen yet';
  const profile: Record<string, string> = { ...leadProfile(f), ...(f.funding_said ? { funding_said: f.funding_said } : {}), ...(f.monthly_budget ? { monthly_budget: f.monthly_budget } : {}) };
  const did: string[] = [];
  if (Number(f.nurture_opens || 0)) did.push(`opened ${f.nurture_opens} email${f.nurture_opens === '1' ? '' : 's'}`);
  if (f.fit_done === 'yes' || f.fit_track) did.push(`took the career-fit quiz${f.fit_track ? ` (${clean(f.fit_track, 40)}${f.fit_programme ? `, best fit ${clean(f.fit_programme, 40)}` : ''})` : ''}`);
  if (/video/i.test(f.nurture_seen || '')) did.push('watched their programme video');
  if (f.last_clicked) did.push(`last opened "${clean(f.last_clicked, 60)}"`);
  if (f.voucher_code) did.push(`holds voucher ${f.voucher_code}${f.voucher_value ? ` (${clean(f.voucher_value, 30)})` : ''}`);
  const lines = [
    `Thuso qualified: ${rec.name} ${QUALIFY_REASON[q.reason].said}${q.detail ? ` (${clean(q.detail, 80)})` : ''}. ${QUALIFY_REASON[q.reason].urgency}.`,
    `Programme: ${programme}${f.track ? ` (${clean(f.track, 20)})` : ''}`,
    `Paying: ${profile.funding_said || 'not said'}${profile.pay_preference ? ` · prefers ${profile.pay_preference}` : ''}${profile.monthly_budget ? ` · budget: ${profile.monthly_budget}` : ''}`,
    `Source: ${leadChannel(f)}${f.campaign_name ? ` · ${clean(f.campaign_name, 60)}` : ''}${f.ad_name ? ` · ${clean(f.ad_name, 60)}` : ''}`,
    `Engagement: ${f.engagement_score || '0'} points${did.length ? ` · ${did.join(', ')}` : ''}`,
    q.bestTime ? `Best time to call: ${clean(q.bestTime, 60)}` : '',
    q.phone && q.phone !== rec.phone ? `Call this number: ${clean(q.phone, 30)} (the sheet has ${rec.phone || 'none'})` : '',
    q.note ? `They said: "${clean(q.note, 400)}"` : f.last_reply ? `Their last reply: "${clean(f.last_reply, 300)}"` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export interface Handoff {
  discordWebhook?: string;
  dialerUrl?: string;
  dialerKey?: string;
  /** Send qualified leads to the dialer (only when Live Outreach is on, because the dialer rings them). */
  dialerOn?: boolean;
  /** Post the Admissions daily report in Discord (weekdays 17:00). */
  reportOn?: boolean;
}

function handoffSettings(tenantId = currentTenantId()): Required<Pick<Handoff, 'discordWebhook' | 'dialerUrl' | 'dialerKey'>> & { dialerOn: boolean } {
  const h = getTenantIntegrations(tenantId).handoff || {};
  return {
    discordWebhook: (h.discordWebhook || process.env.DISCORD_LEADS_WEBHOOK || '').trim(),
    dialerUrl: (h.dialerUrl || process.env.DIALER_URL || '').trim().replace(/\/$/, ''),
    dialerKey: (h.dialerKey || process.env.DIALER_API_KEY || '').trim(),
    dialerOn: Boolean(h.dialerOn),
  };
}

/** The dialer's address and key (Settings, else DIALER_URL / DIALER_API_KEY), for reading and releasing leads. */
export function dialerConnection(tenantId = currentTenantId()): { url: string; key: string } {
  const s = handoffSettings(tenantId);
  return { url: s.dialerUrl, key: s.dialerKey };
}

/** A lead the dialer holds for Thuso comes in there as a new lead (POST /api/v1/nurture/<row>/release). */
async function releaseInDialer(s: ReturnType<typeof handoffSettings>, rowId: string, q: QualifyInput, brief: string): Promise<{ ok: boolean; outcome?: string; id?: string; error?: string }> {
  try {
    const res = await fetch(`${s.dialerUrl}/api/v1/nurture/${encodeURIComponent(rowId)}/release`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.dialerKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: brief, source_detail: `Thuso qualified: ${QUALIFY_REASON[q.reason].said}`.slice(0, 200) }),
      signal: AbortSignal.timeout(20000),
      cache: 'no-store',
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; outcome?: string; lead_id?: string; lead?: { id?: string }; error?: string };
    if (!res.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${res.status}` };
    return { ok: true, outcome: j.outcome, id: j.lead?.id || j.lead_id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The team's Discord webhook (Settings, else DISCORD_LEADS_WEBHOOK), or ''. */
export function discordWebhook(tenantId = currentTenantId()): string {
  return handoffSettings(tenantId).discordWebhook;
}

export const isDiscordHook = (u: string) => /^https:\/\/(?:canary\.|ptb\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(u);

/** Posts a card in the team's Discord channel. Only the team sees it. */
export async function postDiscord(webhook: string, card: { title: string; text: string; urgent: boolean; test?: boolean }): Promise<{ ok: boolean; error?: string }> {
  if (!isDiscordHook(webhook)) return { ok: false, error: 'That is not a Discord webhook address (Server settings → Integrations → Webhooks → Copy webhook URL).' };
  try {
    const res = await fetch(`${webhook}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Thuso',
        content: card.test ? '🧪 Test from Thuso: nothing to do.' : card.urgent ? '🔥 **Hot qualified lead: call immediately**' : '🔥 **Hot lead: call today**',
        allowed_mentions: { parse: [] },
        embeds: [{ title: card.title.slice(0, 250), description: card.text.slice(0, 3900), color: card.urgent ? 0xff7300 : 0x720075, timestamp: new Date().toISOString() }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Discord answered HTTP ${res.status}.` };
  } catch (e) {
    return { ok: false, error: `Discord could not be reached: ${(e as Error).message}` };
  }
}

/** Adds (or updates) the lead in the dialer, with the brief in its notes. */
async function pushToDialer(s: ReturnType<typeof handoffSettings>, rec: Pick<DataRecord, 'name' | 'email' | 'phone' | 'fields'>, q: QualifyInput, brief: string): Promise<{ ok: boolean; outcome?: string; id?: string; error?: string }> {
  const phone = clean(q.phone || rec.phone, 30);
  if (!phone) return { ok: false, error: 'no phone number' };
  try {
    const res = await fetch(`${s.dialerUrl}/api/v1/leads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.dialerKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: rec.name, phone, email: rec.email || undefined,
        source: leadChannel(rec.fields),
        source_detail: `Thuso qualified: ${QUALIFY_REASON[q.reason].said}`.slice(0, 200),
        programme: leadProgramme(rec.fields) || undefined,
        notes: brief,
      }),
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; outcome?: string; lead?: { id?: string }; error?: string };
    if (!res.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${res.status}` };
    return { ok: true, outcome: j.outcome, id: j.lead?.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface QualifyResult { qualified: boolean; alreadyQualified: boolean; discord: string; dialer: string; brief: string }

/** A lead said yes (or earned it): mark them, tell the team, put them in the dialer. Safe to call twice:
 *  a second "hot" changes nothing, but "Call me" after "hot" is news and goes out again. */
export async function qualifyLead(sourceId: string, key: string, q: QualifyInput, tenantId = currentTenantId()): Promise<QualifyResult | null> {
  const rec = getRecord(sourceId, key);
  if (!rec) return null;
  const f = rec.fields;
  const before = f.qualified_reason as QualifyReason | undefined;
  const already = f.qualified === 'yes';
  const news = !already || (QUALIFY_REASON[q.reason].now && (!before || !QUALIFY_REASON[before]?.now)) || (QUALIFY_REASON[q.reason].now && Date.now() - Date.parse(f.qualified_at || '') > 24 * 3600_000);
  const brief = leadBrief(rec, q);
  if (!news) return { qualified: true, alreadyQualified: true, discord: 'already sent', dialer: f.dialer_status || 'unchanged', brief };

  const now = new Date().toISOString();
  setRecordField(sourceId, key, 'qualified', 'yes');
  setRecordField(sourceId, key, 'qualified_at', now);
  setRecordField(sourceId, key, 'qualified_reason', q.reason);
  setRecordField(sourceId, key, 'lead_brief_sales', brief.slice(0, 1500));
  if (q.bestTime) setRecordField(sourceId, key, 'best_time_to_call', clean(q.bestTime, 60));
  if (q.phone && q.phone !== rec.phone) setRecordField(sourceId, key, 'callback_phone', clean(q.phone, 30));
  if (q.note) setRecordField(sourceId, key, 'call_note', clean(q.note, 600));
  if (QUALIFY_REASON[q.reason].now) setRecordField(sourceId, key, 'status', 'qualified');

  const preview = f.preview === 'yes';
  const s = handoffSettings(tenantId);
  const academy = getAcademyContext().academyName;

  // 1. Discord (the team only).
  let discord = 'not connected';
  if (s.discordWebhook) {
    const r = await postDiscord(s.discordWebhook, { title: `${preview ? '[TEST] ' : ''}${rec.name}: ${QUALIFY_REASON[q.reason].said}`, text: `${brief}\n\nPhone: ${clean(q.phone || rec.phone, 30) || 'none'}${rec.email ? `\nEmail: ${rec.email}` : ''}\n${academy} · Thuso`, urgent: QUALIFY_REASON[q.reason].now, test: false });
    discord = r.ok ? 'sent' : `failed: ${r.error}`;
  }

  // 2. The dialer (it rings real people: only with Live Outreach on, never for a preview).
  let dialer = 'not connected';
  if (preview) dialer = 'skipped: a preview lead';
  else if (!s.dialerUrl || !s.dialerKey) dialer = 'not connected';
  else if (!s.dialerOn) dialer = 'held: sending to the dialer is switched off';
  else if (!liveAllowed(getTenantIntegrations(tenantId).liveOutreachEnabled)) dialer = sendingPaused() ? 'held: test phase (sending is paused on this server)' : 'held: Live Outreach is off';
  else {
    // Held in the dialer for Thuso: release it there; otherwise (a lead from elsewhere) add it.
    const r = f.dialer_row_id ? await releaseInDialer(s, f.dialer_row_id, q, brief) : await pushToDialer(s, rec, q, brief);
    dialer = r.ok ? (r.outcome === 'already' ? 'already a lead in the dialer' : r.outcome === 'merged' ? 'already in the dialer: brief added' : 'moved to New in the dialer') : `failed: ${r.error}`;
    if (r.id) setRecordField(sourceId, key, 'dialer_lead_id', r.id);
  }
  setRecordField(sourceId, key, 'dialer_status', dialer);

  // 3. Once they said yes, the marketing journey stops: a person takes it from here.
  if (QUALIFY_REASON[q.reason].now && !preview) {
    const { stopRunsFor } = await import('@/lib/engine/agentRuns');
    stopRunsFor(rec.email, rec.key, `${rec.name} ${QUALIFY_REASON[q.reason].said}: handed to the sales team, so the nurturing emails stop.`, q.keepRunId);
  }
  log('system', 'dispatch', `${preview ? '[preview] ' : ''}${rec.name} ${QUALIFY_REASON[q.reason].said} (${leadChannel(f)}). Qualified: Discord ${discord}; dialer ${dialer}.`);
  return { qualified: true, alreadyQualified: already, discord, dialer, brief };
}

/** "Send a test" from Settings: a card in Discord, nothing else. */
export async function testDiscord(webhook: string): Promise<{ ok: boolean; detail?: string; error?: string }> {
  const r = await postDiscord(webhook, { title: 'Thuso is connected', text: 'Qualified leads will appear here: who they are, where they came from, what they want, how they would pay, and what they did before they said yes.', urgent: false, test: true });
  return r.ok ? { ok: true, detail: 'A test card was posted in your Discord channel.' } : { ok: false, error: r.error };
}

/** "Test" for the dialer: can we read leads with this key? (Nothing is created.) */
export async function testDialer(url: string, key: string): Promise<{ ok: boolean; detail?: string; error?: string }> {
  const base = url.trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base) || !key.trim()) return { ok: false, error: 'Add the dialer address and an API key first.' };
  try {
    const res = await fetch(`${base}/api/v1/leads?per=1`, { headers: { Authorization: `Bearer ${key.trim()}` }, signal: AbortSignal.timeout(10000), cache: 'no-store' });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; total?: number; error?: string };
    if (res.status === 403) return { ok: true, detail: 'Connected. (This key cannot list leads, which is fine: it only needs to create them.)' };
    return res.ok && j.ok ? { ok: true, detail: `Connected to the dialer${typeof j.total === 'number' ? ` (${j.total} leads)` : ''}.` } : { ok: false, error: j.error || `The dialer answered HTTP ${res.status}.` };
  } catch (e) {
    return { ok: false, error: `The dialer could not be reached: ${(e as Error).message}` };
  }
}
