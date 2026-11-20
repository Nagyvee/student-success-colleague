import type { NurtureStats } from './types';
import { tenantDoc } from '@/lib/engine/tenantDoc';
import { getState } from '@/lib/engine/store';
import { listRecords } from '@/lib/data/records';
import { LEADS_SOURCE_ID } from '@/lib/data/sources';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { meta } from './store';
import { QUALIFY_REASON, discordWebhook, isDiscordHook, leadChannel, type QualifyReason } from './qualify';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';

/* The Admissions daily report, in the team's Discord channel.
 *
 * Every weekday at 17:00 (South African time) Thuso posts what happened in
 * nurturing since its previous report: new leads (and where they came from),
 * emails sent, opens and clicks, quizzes and videos, replies, who qualified
 * (and what the dialer did with them), who unsubscribed, and where things
 * stand now. No report on Saturday or Sunday, so Monday's covers Friday 17:00
 * to Monday 17:00. If the server is down at 17:00, the report goes when it is
 * back. Counters (emails, opens, clicks...) are compared with a snapshot taken
 * at the previous report; everything else is read from the leads' own dates. */

const SAST_MS = 2 * 3_600_000; // South Africa: UTC+2 all year
export const REPORT_HOUR = 17;

type ReportState = { lastAt: number; stats: NurtureStats | null };
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

export interface NurtureReport { title: string; description: string; fields: { name: string; value: string; inline?: boolean }[] }

/** What happened in nurturing between `from` and `to`, as Discord embed fields. */
export function buildNurtureReport(from: number, to: number, base: NurtureStats | null): NurtureReport {
  const recs = listRecords(LEADS_SOURCE_ID).filter((r) => r.fields.preview !== 'yes');
  const inWindow = (t: number) => Number.isFinite(t) && t > from && t <= to;

  // New: people who came in for nurturing (never a sheet's old rows imported quietly).
  const fresh = recs.filter((r) => inWindow(r.firstSeenAt) && r.fields.imported_quietly !== 'yes');
  const channels = new Map<string, number>();
  for (const r of fresh) { const c = leadChannel(r.fields); channels.set(c, (channels.get(c) || 0) + 1); }
  const emailed = recs.filter((r) => inWindow(stamp(r.fields.nurture_delivered_at))).length;
  const replied = recs.filter((r) => inWindow(stamp(r.fields.replied_at_ms)));
  const quizzes = recs.filter((r) => inWindow(stamp(r.fields.fit_at))).length;
  const qualified = recs.filter((r) => inWindow(stamp(r.fields.qualified_at)));
  const stopped = recs.filter((r) => inWindow(stamp(r.fields.opted_out_at))).length;

  const cur = meta().stats;
  const diff = (k: keyof NurtureStats) => Math.max(0, (cur[k] || 0) - (base?.[k] || 0));
  // Only emails that really left the server (previews kept while sending was off do not count).
  const sent = diff('delivered');

  // In nurturing: the leads Thuso is actually working (emailed or engaged, or waiting for it in the dialer).
  const nurturing = recs.filter((r) => (Number(r.fields.nurture_count || 0) > 0 || Number(r.fields.engagement_score || 0) > 0 || r.fields.dialer_row_id)
    && r.fields.opted_out !== 'yes' && r.fields.dialer_left !== 'yes' && r.fields.qualified !== 'yes');
  const hot = nurturing.filter((r) => r.fields.engagement === 'hot').length;
  const warm = nurturing.filter((r) => r.fields.engagement === 'warm').length;
  const st = getState();
  const waiting = (st.pendingOutreach || []).filter((p) => p.status === 'pending' && /^admissions\b/i.test(p.workflowName || '')).length;
  const failed = st.inbox.filter((m) => m.error && inWindow(m.ts) && /admissions/i.test(m.dept || '')).length;

  const fields: NurtureReport['fields'] = [
    { name: '🆕 New leads', value: fresh.length ? `**${fresh.length}**\n${[...channels].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}: ${n}`).join('\n')}` : '0', inline: true },
    { name: '✉️ Emails sent', value: `**${sent}**${emailed ? `\nto ${plural(emailed, 'lead')}` : ''}`, inline: true },
    { name: '👀 Opened · clicked', value: `**${diff('opens')}** · **${diff('clicks')}**`, inline: true },
    { name: '🧭 Quizzes · 🎬 videos', value: `**${Math.max(quizzes, diff('quizzes'))}** · **${diff('videoViews')}**`, inline: true },
    { name: '💬 Replies', value: replied.length ? `**${replied.length}**\n${replied.slice(0, 6).map((r) => r.name).join(', ')}` : '0', inline: true },
    { name: '🚫 Unsubscribed', value: String(stopped), inline: true },
    {
      name: `🔥 Qualified (${qualified.length})`,
      value: qualified.length
        ? qualified.slice(0, 10).map((r) => {
          const reason = QUALIFY_REASON[r.fields.qualified_reason as QualifyReason]?.said || 'qualified';
          const who = r.fields.dialer_assigned_to ? ` · ${r.fields.dialer_assigned_to.split(' ')[0]} has them` : '';
          return `• **${r.name}** ${reason}${r.fields.dialer_status ? ` · dialer: ${r.fields.dialer_status}` : ''}${who}`;
        }).join('\n') + (qualified.length > 10 ? `\n…and ${qualified.length - 10} more` : '')
        : 'Nobody yet.',
    },
    { name: '📍 Right now', value: `${plural(nurturing.length, 'lead')} in nurturing · **${hot}** hot · ${warm} warming up${waiting ? ` · **${waiting}** waiting for your approval` : ''}` },
  ];
  if (failed) fields.push({ name: '⚠️ Emails that could not be sent', value: `${failed}: see Live Office → Admissions → Inbox for why.` });

  return {
    title: `📊 Admissions report · ${day(to)}`,
    description: `${getAcademyContext().academyName} · from ${when(from)} to ${when(to)} (South African time).`,
    fields,
  };
}

async function post(webhook: string, report: NurtureReport, preview: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!isDiscordHook(webhook)) return { ok: false, error: 'Connect Discord first (Channels & API → Qualified leads).' };
  try {
    const res = await fetch(`${webhook}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Thuso',
        content: preview ? '🧪 A preview of the daily report (the real one posts every weekday at 17:00).' : undefined,
        allowed_mentions: { parse: [] },
        embeds: [{ title: report.title, description: report.description, color: 0x0a1733, fields: report.fields.map((f) => ({ ...f, value: f.value.slice(0, 1024) })), timestamp: new Date().toISOString() }],
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
  reportDoc.set({ lastAt: now, stats: { ...meta(tenantId).stats } }, tenantId);
  return Boolean(webhook);
}

/** The report so far (since the last one), to look at in the app. Nothing is posted; the schedule does not move. */
export function previewNurtureReport(tenantId = currentTenantId()): { ok: true; detail: string; report: NurtureReport } {
  const st = reportDoc.get(tenantId);
  const now = Date.now();
  const report = buildNurtureReport(st.lastAt || lastReportSlot(now), now, st.stats);
  return { ok: true, detail: 'This is what the report says so far (nothing was posted).', report };
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
