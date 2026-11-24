import type { NurtureStats } from './types';
import { tenantDoc } from '@/lib/engine/tenantDoc';
import { getState } from '@/lib/engine/store';
import { listRecords } from '@/lib/data/records';
import { LEADS_SOURCE_ID, rowTime } from '@/lib/data/sources';
import type { DataRecord } from '@/lib/types';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { meta } from './store';
import { QUALIFY_REASON, discordWebhook, isDiscordHook, type QualifyReason } from './qualify';
import { UNKNOWN_CHANNEL, leadChannel } from './channel';
import { KINDS, fixedProblems, openProblems, safeReason, type Problem } from '@/lib/engine/problems';
import { silentWhatsApps, whatsappDay } from './whatsapp';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';

/* The Admissions daily report, in the team's Discord channel.
 *
 * Every weekday at 17:00 (South African time) Thuso posts what happened in
 * nurturing since its previous report: new leads (and where they came from;
 * someone who enquired earlier and was only now given to Thuso is counted on
 * their own, not as new), emails sent, opens and clicks, quizzes and videos, replies, who qualified
 * (and what the dialer did with them), who unsubscribed, and where things
 * stand now. Whatever is broken comes first, in red: who it stops, since when
 * and what to do. No report on Saturday or Sunday, so Monday's covers Friday 17:00
 * to Monday 17:00. If the server is down at 17:00, the report goes when it is
 * back. Counters (emails, opens, clicks...) are compared with a snapshot taken
 * at the previous report; everything else is read from the leads' own dates. */

const SAST_MS = 2 * 3_600_000; // South Africa: UTC+2 all year
export const REPORT_HOUR = 17;

type ReportState = { lastAt: number; stats: NurtureStats | null; /** Where the last report began. */ prevAt?: number };
const reportDoc = tenantDoc<ReportState>('nurture-report', () => ({ lastAt: 0, stats: null }));

const isWeekday = (t: number) => { const d = new Date(t + SAST_MS).getUTCDay(); return d !== 0 && d !== 6; };

/** The most recent weekday 17:00 (South African time) at or before `now`. */
export function lastReportSlot(now = Date.now()): number {
  const d = new Date(now + SAST_MS);
  let slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), REPORT_HOUR) - SAST_MS;
  for (let i = 0; i < 9; i++) {
    if (slot <= now && isWeekday(slot)) return slot;
    slot -= 86_400_000;
  }
  return slot;
}

const when = (t: number) => new Date(t).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const day = (t: number) => new Date(t).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'short', day: 'numeric', month: 'short' });
const stamp = (v: string | undefined) => { if (!v) return NaN; const n = Number(v); return Number.isFinite(n) && n > 1e11 ? n : Date.parse(v); };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface NurtureReport {
  title: string; description: string;
  fields: { name: string; value: string; inline?: boolean; tone?: 'bad' | 'warn' }[];
  /** What is broken now, in a line each (the report is red, and says it in the notification). */
  critical?: string[];
}

const DAY_MS = 86_400_000;

/** When a lead first enquired, as far as anything says: the form's own time, when the dialer (or Thuso) first had them. */
export function enquiredAt(r: Pick<DataRecord, 'fields' | 'firstSeenAt'>): number {
  const f = r.fields;
  const said = [rowTime(f), Date.parse(f.agent_dialer_first_seen || f.dialer_first_seen || ''), Date.parse(f.received_at || '')];
  return Math.min(r.firstSeenAt, ...said.filter((t) => Number.isFinite(t) && t > 1e12));
}

/** Who came to Thuso in a window: people who had just enquired, and older ones it was only now given
 *  (moved to a nurturing stage by the team, or rows a list already had). Never a sheet's old rows imported quietly. */
export function cameIn(recs: DataRecord[], from: number, to: number): { fresh: DataRecord[]; older: DataRecord[] } {
  const inWindow = (t: number) => Number.isFinite(t) && t > from && t <= to;
  const fresh: DataRecord[] = [];
  const older: DataRecord[] = [];
  for (const r of recs) {
    if (r.fields.preview === 'yes') continue;
    if (inWindow(r.firstSeenAt) && r.fields.imported_quietly !== 'yes') (r.firstSeenAt - enquiredAt(r) < DAY_MS ? fresh : older).push(r);
    else if (inWindow(Date.parse(r.fields.back_for_nurturing_at || ''))) older.push(r);
  }
  return { fresh, older };
}

/** "Instagram ads: 35", one line each, the most first; the ones nobody recorded come last. */
function bySource(recs: DataRecord[]): string {
  const n = new Map<string, number>();
  for (const r of recs) { const c = leadChannel(r.fields); n.set(c, (n.get(c) || 0) + 1); }
  const lines = [...n].sort((x, y) => Number(x[0] === UNKNOWN_CHANNEL) - Number(y[0] === UNKNOWN_CHANNEL) || y[1] - x[1]);
  const rest = lines.slice(9).reduce((t, [, k]) => t + k, 0);
  return [...lines.slice(0, 9).map(([c, k]) => `${c === UNKNOWN_CHANNEL ? 'Source not recorded' : c}: ${k}`), ...(rest ? [`Other sources: ${rest}`] : [])].join('\n');
}

function leadFields(recs: DataRecord[], from: number, to: number): NurtureReport['fields'] {
  const { fresh, older } = cameIn(recs, from, to);
  return [
    { name: '🆕 New leads', value: fresh.length ? `**${fresh.length}**\n${bySource(fresh)}` : '0', inline: true },
    ...(older.length ? [{ name: '📥 Older leads given to Thuso', value: `**${older.length}**\n${bySource(older)}`, inline: true }] : []),
  ];
}

/** As many whole lines as Discord takes in one box (1024 characters), then how many are left out. */
export function fitLines(lines: string[], max = 1024): string {
  const out: string[] = [];
  let size = 0;
  for (const [i, line] of lines.entries()) {
    const more = `…and ${lines.length - i} more`;
    const last = i === lines.length - 1;
    if (size + line.length + (last ? 0 : more.length + 1) > max) { out.push(more); break; }
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n');
}

const names = (list: string[], max = 8) => `${list.slice(0, max).join(', ')}${list.length > max ? ` and ${list.length - max} more` : ''}`;
const sentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);

/** What is broken now (one red box each), and what is worth a look. */
function problemFields(recs: DataRecord[], from: number, to: number, wa: ReturnType<typeof whatsappDay>): { fields: NurtureReport['fields']; critical: string[] } {
  const inWindow = (t: number) => Number.isFinite(t) && t > from && t <= to;
  const open = openProblems(undefined, to);
  const fields: NurtureReport['fields'] = [];
  const critical: string[] = [];
  const box = (what: string, lines: string[]) => { critical.push(what); fields.push({ name: `🚨 CRITICAL: ${what}`, value: lines.filter(Boolean).join('\n').slice(0, 1024), tone: 'bad' }); };

  for (const p of open.filter((x) => x.critical)) {
    const failed = p.key === 'whatsapp' ? wa.failed.map((x) => x.name) : p.people;
    box(KINDS[p.key].what, [
      `Since **${when(p.firstAt)}**${p.times > 1 ? ` (failed ${p.times} times, last ${when(p.lastAt)})` : ''}.`,
      `Why: ${sentence(p.why)}`,
      failed.length ? `Could not be sent to: ${names(failed)}.` : '',
      p.key === 'whatsapp' && wa.waiting ? `${plural(wa.waiting, 'lead is', 'leads are')} waiting for one.` : '',
      `What to do: ${KINDS[p.key].fix}`,
    ]);
  }
  // Someone said yes, and the sales team does not have them.
  const lost = recs.filter((r) => r.fields.qualified === 'yes' && r.fields.opted_out !== 'yes' && r.fields.dialer_in !== 'yes' && /^failed/.test(r.fields.dialer_status || '') && stamp(r.fields.qualified_at) > to - 14 * DAY_MS);
  if (lost.length) box(`${plural(lost.length, 'qualified lead')} not in the dialer`, [
    names(lost.map((r) => `${r.name.slice(0, 60)}${r.phone ? ` (${r.phone})` : ''}`)) + '.',
    `Why: ${sentence(safeReason((lost[0].fields.dialer_status || '').replace(/^failed: ?/, '')))}`,
    'What to do: call them now. Thuso tries the dialer again every 30 minutes.',
  ]);

  const look: string[] = [];
  const line = (p: Problem) => `• ${KINDS[p.key].what}, since ${when(p.firstAt)}: ${sentence(p.why)}${p.people.length ? ` (${names(p.people, 5)})` : ''} ${KINDS[p.key].fix}`;
  for (const p of open.filter((x) => !x.critical)) look.push(line(p));
  if (wa.failed.length && !open.some((p) => p.key === 'whatsapp')) look.push(`• WhatsApp could not be sent to ${names(wa.failed.map((x) => x.name))}: ${sentence(wa.failed[0].why)}`);
  if (wa.unsure && !open.some((p) => p.key === 'whatsapp')) look.push(`• ${plural(wa.unsure, 'WhatsApp')} ManyChat did not confirm: they may not have arrived.`);
  const silent = silentWhatsApps(to);
  if (silent) look.push(`• Nobody tapped or answered any of the last ${silent} WhatsApps. ManyChat takes a message even when WhatsApp does not deliver it: open one in ManyChat → Live Chat and see if it arrived.`);
  const mails = getState().inbox.filter((m) => m.error && inWindow(m.ts) && /admissions/i.test(m.dept || ''));
  if (mails.length) look.push(`• ${plural(mails.length, 'email')} could not be sent: ${names([...new Set(mails.map((m) => m.toName || 'someone'))], 6)}. Why: ${sentence(safeReason(mails[0].error || ''))}`);
  for (const p of fixedProblems(from, to)) look.push(`• ${KINDS[p.key].was} from ${when(p.firstAt)} to ${when(p.fixedAt || p.lastAt)}. Working again. (${p.why})`);
  if (look.length) fields.push({ name: '⚠️ Worth a look', value: fitLines(look.map((l) => l.slice(0, 480))), tone: 'warn' });
  return { fields, critical };
}

/** One qualified lead on one line: why, what the dialer did with them, who has them. */
function qualifiedLine(r: DataRecord): string {
  const f = r.fields;
  const why = f.qualified_reason === 'hot' ? 'reached 8 points' : QUALIFY_REASON[f.qualified_reason as QualifyReason]?.said || 'qualified';
  const was = /^moved back to New in the dialer \(was in (.+)\)$/.exec(f.dialer_status || '')?.[1];
  const dialer = !was ? (f.dialer_status || '').replace(/ (to|in) the dialer/, '')
    // Moved back from the stage new leads are in: they were there already.
    : /^new( lead)?s?$/i.test(was) ? `already in ${was}: given out again` : `back to New from ${was}`;
  return `• **${r.name.slice(0, 60)}** ${[why, dialer, (f.dialer_assigned_to || '').split(' ')[0]].filter(Boolean).join(' · ').slice(0, 160)}`;
}

/** What happened in nurturing between `from` and `to`, as Discord embed fields. */
export function buildNurtureReport(from: number, to: number, base: NurtureStats | null): NurtureReport {
  const recs = listRecords(LEADS_SOURCE_ID).filter((r) => r.fields.preview !== 'yes');
  const inWindow = (t: number) => Number.isFinite(t) && t > from && t <= to;

  const emailed = recs.filter((r) => inWindow(stamp(r.fields.nurture_delivered_at))).length;
  const wa = whatsappDay(from, to, undefined, to);
  const problems = problemFields(recs, from, to, wa);
  const replied = recs.filter((r) => inWindow(stamp(r.fields.replied_at_ms)));
  const quizzes = recs.filter((r) => inWindow(stamp(r.fields.fit_at))).length;
  const qualified = recs.filter((r) => inWindow(stamp(r.fields.qualified_at)));
  const stopped = recs.filter((r) => inWindow(stamp(r.fields.opted_out_at))).length;

  const cur = meta().stats;
  const diff = (k: keyof NurtureStats) => Math.max(0, (cur[k] || 0) - (base?.[k] || 0));
  // Only emails that really left the server (previews kept while sending was off do not count).
  const sent = diff('delivered');

  // Being nurtured: the leads Thuso is working (emailed or engaged, or just in from the dialer). Old rows the dialer
  // holds for Thuso that nobody messaged are waiting, not being nurtured. (8 points qualifies a lead at once, so
  // nobody is hot and still here.)
  const here = recs.filter((r) => r.fields.opted_out !== 'yes' && r.fields.dialer_left !== 'yes' && r.fields.qualified !== 'yes');
  const started = (r: DataRecord) => Number(r.fields.nurture_count || 0) > 0 || Number(r.fields.engagement_score || 0) > 0;
  const nurturing = here.filter((r) => started(r) || (r.fields.dialer_row_id && r.fields.imported_quietly !== 'yes'));
  const waitingOld = here.filter((r) => !started(r) && r.fields.dialer_row_id && r.fields.imported_quietly === 'yes').length;
  const warm = nurturing.filter((r) => r.fields.engagement === 'warm').length;
  const st = getState();
  const waiting = (st.pendingOutreach || []).filter((p) => p.status === 'pending' && /^admissions\b/i.test(p.workflowName || '')).length;

  const fields: NurtureReport['fields'] = [
    ...problems.fields,
    ...leadFields(recs, from, to),
    { name: '✉️ Emails sent', value: `**${sent}**${emailed ? `\nto ${plural(emailed, 'lead')}` : ''}`, inline: true },
    // Always there while they are on: 0 is news too. ManyChat only says it took a message, not that it arrived.
    ...(wa.on || wa.accepted || wa.unsure || wa.failed.length ? [{
      name: '📱 WhatsApp follow-ups', inline: true,
      value: [`**${wa.accepted}** taken by ManyChat`, wa.unsure ? `**${wa.unsure}** not confirmed` : '', wa.failed.length ? `**${wa.failed.length}** failed` : '', wa.pausedUntil ? `Paused until ${when(wa.pausedUntil)}` : ''].filter(Boolean).join('\n'),
      ...(wa.failed.length ? { tone: 'bad' as const } : {}),
    }] : []),
    { name: '👀 Emails opened · links clicked', value: `**${diff('opens')}** · **${diff('clicks')}**`, inline: true },
    { name: '🧭 Quizzes · 🎬 videos', value: `**${Math.max(quizzes, diff('quizzes'))}** · **${diff('videoViews')}**`, inline: true },
    { name: '💬 Leads who replied', value: replied.length ? `**${replied.length}**\n${replied.slice(0, 6).map((r) => r.name.slice(0, 60)).join(', ')}${replied.length > 6 ? ` and ${replied.length - 6} more` : ''}` : '0', inline: true },
    { name: '🚫 Unsubscribed', value: String(stopped), inline: true },
    { name: `🔥 Qualified (${qualified.length})`, value: qualified.length ? fitLines(qualified.map(qualifiedLine)) : 'Nobody yet.' },
    { name: '📍 Right now (all leads, not only this time)', value: `**${nurturing.length}** being nurtured · **${warm}** warming up (3 to 7 points)${waitingOld ? ` · ${plural(waitingOld, 'old row')} in the dialer, not messaged` : ''}${waiting ? ` · **${waiting}** waiting for your approval` : ''}` },
  ];

  return {
    title: `${problems.critical.length ? '🚨' : '📊'} Admissions report · ${day(to)}`,
    description: `${getAcademyContext().academyName} · from ${when(from)} to ${when(to)} (South African time). Everything here happened in that time, except Right now.`,
    fields,
    ...(problems.critical.length ? { critical: problems.critical } : {}),
  };
}

/** Discord takes 6000 characters in one card and refuses the whole of it above that: the long lists give way, the
 *  critical boxes never do. */
export function fitCard(report: NurtureReport, max = 5800): { name: string; value: string; inline?: boolean }[] {
  const fields = report.fields.map((f) => ({ ...f, name: f.name.slice(0, 256), value: f.value.slice(0, 1024) }));
  const size = () => report.title.length + report.description.length + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  for (let over = size() - max; over > 0; over = size() - max) {
    const longest = fields.filter((f) => f.tone !== 'bad').sort((a, b) => b.value.length - a.value.length)[0];
    if (!longest || longest.value.length < 80) break;
    const lines = longest.value.split('\n');
    const shorter = lines.length > 1 ? fitLines(lines, Math.max(60, longest.value.length - over)) : longest.value.slice(0, Math.max(60, longest.value.length - over - 1));
    if (shorter.length >= longest.value.length) break;
    longest.value = shorter;
  }
  return fields.slice(0, 25).map(({ name, value, inline }) => ({ name, value, ...(inline ? { inline } : {}) }));
}

async function post(webhook: string, report: NurtureReport, preview: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!isDiscordHook(webhook)) return { ok: false, error: 'Connect Discord first (Channels & API → Qualified leads).' };
  try {
    const res = await fetch(`${webhook}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Thuso',
        content: preview ? '🧪 A preview of the daily report (the real one posts every weekday at 17:00).' : report.critical?.length ? `🚨 **Critical:** ${report.critical.join('; ')}.`.slice(0, 1900) : undefined,
        allowed_mentions: { parse: [] },
        embeds: [{ title: report.title, description: report.description, color: report.critical?.length ? 0xd92d20 : 0x0a1733, fields: fitCard(report), timestamp: new Date().toISOString() }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Discord answered HTTP ${res.status}.` };
  } catch (e) {
    return { ok: false, error: `Discord could not be reached: ${(e as Error).message}` };
  }
}

/** The daily report posts unless it was switched off (Channels & API → Qualified leads). */
export function reportSwitchedOn(tenantId = currentTenantId()): boolean {
  return getTenantIntegrations(tenantId).handoff?.reportOn !== false;
}

/** Called once a minute by the always-on pump: posts the report when a weekday's 17:00 has come. */
export async function maybeSendNurtureReport(tenantId = currentTenantId(), now = Date.now()): Promise<boolean> {
  const st = reportDoc.get(tenantId);
  const slot = lastReportSlot(now);
  // First time: start counting from the most recent slot (no report for the past).
  if (!st.lastAt) { reportDoc.set({ lastAt: slot, stats: { ...meta(tenantId).stats } }, tenantId); return false; }
  if (slot <= st.lastAt) return false;
  // Posting is a switch (Channels & API), on unless someone switched it off.
  const webhook = reportSwitchedOn(tenantId) ? discordWebhook(tenantId) : '';
  const report = buildNurtureReport(st.lastAt, now, st.stats);
  // Not posting (switched off, or no Discord): the window still moves on, so the first post is never a huge backlog.
  if (webhook) {
    const r = await post(webhook, report, false);
    if (!r.ok) { console.warn(`[thuso] daily report not posted: ${r.error}`); return false; }
  }
  reportDoc.set({ lastAt: now, stats: { ...meta(tenantId).stats }, prevAt: st.lastAt }, tenantId);
  return Boolean(webhook);
}

/** The report so far (since the last one), to look at in the app, and who came in during the one before, as counted
 *  now. Nothing is posted; the schedule does not move. */
export function previewNurtureReport(tenantId = currentTenantId(), now = Date.now()): { ok: true; detail: string; report: NurtureReport; last: NurtureReport | null } {
  const st = reportDoc.get(tenantId);
  const report = buildNurtureReport(st.lastAt || lastReportSlot(now), now, st.stats);
  // Only who came in: sends, opens and replies keep a lead's latest, so an earlier day cannot be counted again.
  const from = st.prevAt || (st.lastAt ? lastReportSlot(lastReportSlot(st.lastAt) - 1) : 0);
  const recs = listRecords(LEADS_SOURCE_ID);
  const last = st.lastAt && from < st.lastAt
    ? { title: 'Who came in during the last report', description: `From ${when(from)} to ${when(st.lastAt)}, counted again now.`, fields: leadFields(recs, from, st.lastAt) }
    : null;
  return { ok: true, detail: 'This is what the report says so far (nothing was posted).', report, last };
}

/** Post the report so far in Discord now (after checking the preview); the schedule does not move. */
export async function postNurtureReportNow(tenantId = currentTenantId()): Promise<{ ok: boolean; detail?: string; error?: string }> {
  const st = reportDoc.get(tenantId);
  const now = Date.now();
  const webhook = discordWebhook(tenantId);
  if (!webhook) return { ok: false, error: 'Connect Discord first (paste the webhook above and Save).' };
  const r = await post(webhook, buildNurtureReport(st.lastAt || lastReportSlot(now), now, st.stats), false);
  return r.ok ? { ok: true, detail: 'Posted in Discord.' } : { ok: false, error: r.error };
}
