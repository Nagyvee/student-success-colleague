import { getRecord, listRecords, setRecordField } from '@/lib/data/records';
import { LEADS_SOURCE_ID } from '@/lib/data/sources';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { liveAllowed } from '@/lib/email/pause';
import { log as storeLog } from '@/lib/engine/store';
import { QUALIFY_REASON, dialerConnection, discordUserId, discordWebhook, isDiscordHook, leadBrief, sendToDialer, type QualifyReason } from './qualify';

/* Thuso and the dialer, kept in step (every 30 minutes, and when the server starts).
 *
 * 1. Every qualified lead is in the dialer. A lead qualified before the
 *    hand-over existed (or whose hand-over failed) is handed over now: back
 *    to New and given out fairly if nothing was happening with them there,
 *    left with whoever is working them otherwise. Once per lead; the team
 *    gets one Discord message saying who has which lead.
 * 2. Where each lead is in the dialer comes back: the stage, who has them,
 *    and "applied" once the sales team moves them to the registration stage
 *    (or past it), "enrolled" when won. Lead Nurturing shows it, and the
 *    marketing emails stop for anyone who applied. */

const log: typeof storeLog = (actor, level, text, extra = {}) => storeLog(actor, level, text, { dept: 'admissions', ...extra });

const busy = new Set<string>();

/** Both jobs, one after the other. Called by the always-on pump. */
export async function dialerUpkeep(tenantId = currentTenantId()): Promise<void> {
  if (busy.has(tenantId)) return;
  const { url, key } = dialerConnection(tenantId);
  if (!url || !key) return;
  busy.add(tenantId);
  try {
    await catchUpQualified(tenantId);
    await readPipeline(tenantId);
  } finally {
    busy.delete(tenantId);
  }
}

/** Qualified leads not yet handed over the new way go to the dialer now. Returns what happened to each. */
export async function catchUpQualified(tenantId = currentTenantId()): Promise<{ name: string; words: string; assignee?: string; discord?: string }[]> {
  const ti = getTenantIntegrations(tenantId);
  if (!ti.handoff?.dialerOn || !liveAllowed(ti.liveOutreachEnabled)) return [];
  const due = listRecords(LEADS_SOURCE_ID).filter((r) => r.fields.qualified === 'yes' && r.fields.preview !== 'yes'
    && r.fields.opted_out !== 'yes' && r.fields.dialer_handed_over !== 'yes');
  const done: { name: string; words: string; assignee?: string; discord?: string }[] = [];
  for (const r of due) {
    const reason = (QUALIFY_REASON[r.fields.qualified_reason as QualifyReason] ? r.fields.qualified_reason : 'hot') as QualifyReason;
    const q = { reason, bestTime: r.fields.best_time_to_call || undefined, phone: r.fields.callback_phone || undefined, note: r.fields.call_note || undefined };
    const brief = (r.fields.lead_brief_sales || '').trim() || leadBrief(r, q);
    const sent = await sendToDialer(r.sourceId, r.key, q, brief, tenantId);
    // A dialer without the hand-over yet: try again next time.
    if (sent.reply.missing) return done;
    if (!sent.reply.ok) { done.push({ name: r.name, words: sent.words }); continue; }
    setRecordField(r.sourceId, r.key, 'dialer_handed_over', 'yes');
    done.push({ name: r.name, words: sent.words, assignee: sent.reply.assigned?.name, discord: sent.reply.assigned?.discord });
  }
  if (!done.length) return done;
  const ok = done.filter((d) => !/^failed/.test(d.words));
  log('system', 'dispatch', `Qualified leads checked in the dialer: ${ok.length} in, ${done.length - ok.length} could not be sent. ${done.map((d) => `${d.name}: ${d.words}${d.assignee ? `, ${d.assignee}` : ''}`).join('; ')}.`);
  // One message for the team: who has which lead now.
  const hook = discordWebhook(tenantId);
  if (ok.length && isDiscordHook(hook)) {
    const pings = [...new Set(ok.map((d) => discordUserId(d.discord)).filter((x): x is string => Boolean(x)))];
    const who = (d: (typeof ok)[number]) => {
      const id = discordUserId(d.discord);
      return id ? `<@${id}>` : d.discord ? `@${d.discord}` : d.assignee ? `**${d.assignee}**` : 'nobody yet';
    };
    const lines = ok.map((d) => `• **${d.name}** → ${who(d)} · ${d.words.replace(/ in the dialer/, '')}`);
    const content = `📋 **Qualified leads now in the dialer** (${ok.length}). Each one has Thuso's brief in its notes.\n${lines.join('\n')}`.slice(0, 1990);
    await fetch(`${hook}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Thuso', content, allowed_mentions: { parse: [], users: pings.slice(0, 100) } }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
  }
  return done;
}

type Where = { id: string; stage: string | null; status: string; assigned_to: { id: string; name: string; discord_id?: string | null } | null };

const DONE = /^(applied|enrolled|registered|student)$/i;

/** Where Thuso's leads are in the dialer: stage, who has them, applied or enrolled. Returns how many changed status. */
export async function readPipeline(tenantId = currentTenantId()): Promise<number> {
  const { url, key } = dialerConnection(tenantId);
  if (!url || !key) return 0;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Leads Thuso handed over, and leads the team took over from a nurturing stage.
  const byId = new Map<string, { sourceId: string; key: string }>();
  for (const r of listRecords(LEADS_SOURCE_ID)) {
    if (r.fields.preview === 'yes') continue;
    const id = uuid.test(r.fields.dialer_lead_id || '') ? r.fields.dialer_lead_id : r.fields.dialer_left === 'yes' && uuid.test(r.fields.dialer_row_id || '') ? r.fields.dialer_row_id : '';
    if (id) byId.set(id, { sourceId: r.sourceId, key: r.key });
  }
  const ids = [...byId.keys()];
  let changed = 0;
  for (let i = 0; i < ids.length; i += 400) {
    let leads: Where[] = [];
    try {
      const res = await fetch(`${url}/api/v1/handoff/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids.slice(i, i + 400) }),
        signal: AbortSignal.timeout(25000),
        cache: 'no-store',
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; leads?: Where[] };
      if (!res.ok || !j.ok) return changed; // an older dialer, or it is down: next time
      leads = j.leads || [];
    } catch {
      return changed;
    }
    for (const w of leads) {
      const at = byId.get(w.id);
      const rec = at ? getRecord(at.sourceId, at.key) : null;
      if (!at || !rec) continue;
      const f = rec.fields;
      const set = (k: string, v: string) => { if ((f[k] || '') !== v) setRecordField(at.sourceId, at.key, k, v); };
      set('dialer_stage', w.stage || '');
      set('dialer_pipeline', w.status);
      set('dialer_assigned_to', w.assigned_to?.name || '');
      const next = w.status === 'enrolled' ? 'enrolled' : w.status === 'applied' ? 'applied' : '';
      // Never backwards: applied stays applied if the stage moves back; enrolled is the end.
      if (!next || (f.status || '').toLowerCase() === next || (next === 'applied' && DONE.test(f.status || ''))) continue;
      const now = new Date().toISOString();
      setRecordField(at.sourceId, at.key, 'status', next);
      setRecordField(at.sourceId, at.key, `${next}_at`, now);
      changed++;
      // Their running journeys see it (the marketing emails stop once they applied).
      const { noteFacts } = await import('@/lib/engine/agentRuns');
      if (rec.email) noteFacts(rec.email, { status: next });
      log('system', 'lms', `${rec.name} ${next === 'enrolled' ? 'enrolled' : 'applied'}: ${w.assigned_to?.name ? `${w.assigned_to.name} moved them` : 'moved'} to ${w.stage || 'the next stage'} in the dialer.`);
    }
  }
  return changed;
}
