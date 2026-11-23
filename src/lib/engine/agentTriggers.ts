import type { AgentTrigger, DataRecord, WorkflowDef, WorkflowTrigger } from '@/lib/types';
import { tenantDoc } from './tenantDoc';
import { getState, log } from './store';
import { listWorkflows } from './workflows';
import { agentWorkedWith, hasActiveRun, noteFacts, noteReply, ranRecently, startAgentRun, type RunRecord } from './agentRuns';
import { appendConversation, findRecordsByEmail, getRecord, listRecords, setRecordField, upsertRecord, recordKey } from '@/lib/data/records';
import { LEADS_SOURCE_ID, MOODLE_SOURCE_ID, getSource, liveFields, listSources, type RecordEvent } from '@/lib/data/sources';
import { matchesAll } from '@/lib/data/conditions';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { listCustomAgents, listOffices } from './offices';

/* What starts an agent.
 *
 * Sheet changes (a new row, a changed cell), scheduled checks (every overdue
 * account at 08:00), leads from ads, LMS events, replies, and the Run button.
 * The always-on pump calls in here; nothing in this file sends anything
 * itself, it only starts runs (which then review before sending). */

export const agentWorkflows = (): WorkflowDef[] => listWorkflows().filter((w) => w.version === 2 && w.enabled && (w.steps?.length || 0) > 0);

/** Agents start by themselves only when autopilot is on; the Run button always works. */
export const autopilotOn = () => Boolean(getState().settings.autoRunMode);

/** The departments autopilot runs (empty: every department). */
export function autopilotDepartments(): string[] {
  return getTenantIntegrations(currentTenantId()).autopilotDepartments || [];
}

/** Does autopilot start this agent by itself? (Its department is on autopilot.) */
export function autopilotFor(wf: Pick<WorkflowDef, 'departmentId' | 'officeId'>): boolean {
  const only = autopilotDepartments();
  return !only.length || only.includes(wf.departmentId || wf.officeId || '');
}

/** Is any department of these kinds on autopilot? (The tutoring team works for Student Success and Learning.) */
export function autopilotForKinds(kinds: string[]): boolean {
  if (!autopilotOn()) return false;
  const only = autopilotDepartments();
  if (!only.length) return true;
  return listOffices().some((o) => only.includes(o.id) && kinds.includes(o.kind || ''));
}

const BATCH = Math.max(1, Number(process.env.AGENT_BATCH || 20));

export function toRunRecord(rec: DataRecord): RunRecord {
  return { key: rec.key, sourceId: rec.sourceId, name: rec.name, email: rec.email, phone: rec.phone };
}

/* ── Sheet events ─────────────────────────────────────────────────────────── */

export async function dispatchRecordEvents(events: RecordEvent[]): Promise<number> {
  if (!events.length || !autopilotOn()) return 0;
  let started = 0;
  for (const wf of agentWorkflows()) {
    const t = wf.agentTrigger;
    if (!t || !autopilotFor(wf)) continue;
    for (const ev of events) {
      if (t.sourceId && t.sourceId !== ev.source.id) continue;
      if (ev.record.fields.preview === 'yes') continue;
      const fields = liveFields(ev.record);
      let fire = false;
      if (t.kind === 'record.added' && ev.kind === 'added') fire = true;
      if (t.kind === 'lead.created' && ev.kind === 'added' && ev.source.kind === 'leads') fire = true;
      if (t.kind === 'record.changed' && ev.kind === 'changed') fire = !t.field || ev.changed.includes(t.field) || (t.field === 'payment_state' && ev.changed.some((c) => /amount|due|paid|payment/.test(c)));
      if (!fire || !matchesAll(t.match, fields)) continue;
      const label = ev.kind === 'added' ? `new row in ${ev.source.name}` : `${ev.changed.slice(0, 3).join(', ')} changed in ${ev.source.name}`;
      const r = await startAgentRun({ workflow: wf, record: toRunRecord(ev.record), trigger: label });
      if (r.run) started++;
    }
  }
  return started;
}

/* ── Leads from ads and forms ─────────────────────────────────────────────── */

const LEAD_KEYS: Record<string, string[]> = {
  name: ['full_name', 'name', 'fullname'],
  first_name: ['first_name', 'firstname', 'given_name'],
  last_name: ['last_name', 'lastname', 'surname', 'family_name'],
  email: ['email', 'email_address', 'e_mail'],
  phone: ['phone_number', 'phone', 'mobile', 'cell', 'whatsapp', 'whatsapp_number', 'contact_number'],
  interest: ['interest', 'course', 'programme', 'program', 'course_interest', 'which_course_are_you_interested_in'],
  source: ['source', 'platform', 'utm_source', 'channel'],
  campaign: ['campaign', 'campaign_name', 'utm_campaign', 'ad_name', 'adset_name', 'form_name'],
  message: ['message', 'question', 'comments', 'notes'],
};

const snakeKey = (k: string) => k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Flatten a lead payload (Zapier, Make, Meta lead forms with field_data, plain JSON) into fields. */
export function leadFields(payload: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'object') return;
    const s = String(v).trim();
    if (s) flat[snakeKey(k)] = s.slice(0, 1000);
  };
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'field_data' && Array.isArray(v)) {
      // Meta lead forms: [{ name: 'full_name', values: ['Thandi M'] }]
      for (const item of v as Array<{ name?: string; values?: unknown[] }>) if (item?.name) put(item.name, Array.isArray(item.values) ? item.values[0] : '');
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) put(k2, v2);
    } else put(k, v);
  }
  const out: Record<string, string> = { ...flat };
  for (const [field, keys] of Object.entries(LEAD_KEYS)) {
    const hit = keys.find((k) => flat[k]);
    if (hit) out[field] = flat[hit];
  }
  if (!out.name) out.name = [out.first_name, out.last_name].filter(Boolean).join(' ');
  if (!out.first_name && out.name) out.first_name = out.name.split(/\s+/)[0];
  out.email = (out.email || '').toLowerCase();
  out.status ||= 'new';
  return out;
}

/** A lead arrived: keep it in the leads list and start the admissions agents. */
export async function receiveLead(payload: Record<string, unknown>): Promise<{ record: DataRecord; created: boolean; started: number }> {
  const f = leadFields(payload);
  let phone = (f.phone || '').replace(/[^\d+]/g, '');
  if (/^0\d{9}$/.test(phone)) phone = `+27${phone.slice(1)}`;
  else if (/^27\d{9}$/.test(phone)) phone = `+${phone}`;
  f.phone = phone;
  f.received_at = new Date().toISOString();
  const key = recordKey({ email: f.email, id: phone ? `phone:${phone}` : undefined, row: Date.now() });
  const existing = getRecord(LEADS_SOURCE_ID, key);
  const name = f.name || (f.email ? f.email.split('@')[0] : phone || 'New lead');
  if (existing) {
    // A repeat submission or a CRM update: keep what we knew, keep the status unless it changed on purpose.
    if (!payloadHasStatus(payload)) f.status = existing.fields.status || f.status;
    f.received_at = existing.fields.received_at || f.received_at;
  }
  const { record, created, changed } = upsertRecord(LEADS_SOURCE_ID, {
    key, name, email: f.email || '', phone,
    fields: existing ? { ...existing.fields, ...f } : f,
  });
  log('system', 'lms', `New lead: ${name}${f.interest ? ` · interested in ${f.interest}` : ''}${f.campaign || f.source ? ` · from ${f.campaign || f.source}` : ''}.`);
  let started = 0;
  if (autopilotOn() && (created || changed.length)) {
    const source = getSource(LEADS_SOURCE_ID)!;
    started = await dispatchRecordEvents([{ source, record, kind: created ? 'added' : 'changed', changed }]);
  }
  return { record, created, started };
}

const payloadHasStatus = (p: Record<string, unknown>) => Object.keys(p).some((k) => /^(status|lead_status|stage)$/i.test(k));

/** A person on the team changed a record by hand (e.g. marked a lead "applied"): agents react as if the sheet changed. */
export async function editRecord(sourceId: string, key: string, field: string, value: string): Promise<{ record: DataRecord | null; started: number }> {
  const rec = setRecordField(sourceId, key, field, value);
  if (!rec) return { record: null, started: 0 };
  const source = getSource(sourceId);
  const started = source ? await dispatchRecordEvents([{ source, record: rec, kind: 'changed', changed: [field] }]) : 0;
  if (rec.email) noteFacts(rec.email, { [field]: value });
  return { record: rec, started };
}

/* ── LMS events ───────────────────────────────────────────────────────────── */

export async function dispatchLmsEvent(event: WorkflowTrigger, learner: { id: string; name: string; email: string; phone?: string; fields: Record<string, string> }, label: string, opts: { manual?: boolean } = {}): Promise<number> {
  const { id: _id, ...facts } = learner.fields;
  // Runs already working on this person see the new facts (a login ends a check-in loop).
  if (learner.email) noteFacts(learner.email, facts);
  const wfs = agentWorkflows().filter((w) => w.agentTrigger?.kind === 'lms.event' && w.agentTrigger.lmsEvent === event && (opts.manual || autopilotFor(w)));
  if (!wfs.length || (!autopilotOn() && !opts.manual)) return 0;
  // Prefer the person's record on a list (Moodle's students first): it has the live fields.
  const lists = learner.email ? findRecordsByEmail(learner.email).filter((r) => r.sourceId !== LEADS_SOURCE_ID && r.fields.preview !== 'yes') : [];
  const tracked = lists.find((r) => r.sourceId === MOODLE_SOURCE_ID) || lists[0] || null;
  const record: RunRecord = tracked
    ? toRunRecord(tracked)
    : { key: learner.email ? learner.email.toLowerCase() : `id:${learner.id}`, sourceId: null, name: learner.name, email: learner.email, phone: learner.phone || '', fields: { id: learner.id, ...learner.fields } };
  let started = 0;
  for (const wf of wfs) {
    if (!matchesAll(wf.agentTrigger?.match, { ...(tracked ? liveFields(tracked) : {}), ...learner.fields })) continue;
    const r = await startAgentRun({ workflow: wf, record, trigger: label, vars: tracked ? facts : undefined });
    if (r.run) started++;
  }
  return started;
}

/* ── Replies ──────────────────────────────────────────────────────────────── */

export async function dispatchReply(email: string, text: string, name?: string, meta: { messageId?: string; subject?: string; manual?: boolean } = {}): Promise<number> {
  const recs = findRecordsByEmail(email);
  for (const r of recs) appendConversation(r.sourceId, r.key, 'them', text);
  noteReply(email, text, (field, value) => {
    for (const r of recs) setRecordField(r.sourceId, r.key, field, value);
  });
  // A lead who replies is engaged: it counts towards warm and hot.
  for (const r of recs.filter((x) => x.sourceId === LEADS_SOURCE_ID)) {
    const { noteEngagement } = await import('@/lib/nurture/track');
    await noteEngagement({ t: currentTenantId(), s: r.sourceId, k: r.key, m: `reply_${Date.now().toString(36)}`, x: 'reply' }, 'reply').catch(() => null);
  }
  // A person testing a reply from the Inbox wants to see the answer, autopilot or not.
  if (!autopilotOn() && !meta.manual) return 0;
  const wfs = agentWorkflows().filter((w) => w.agentTrigger?.kind === 'reply.received' && (meta.manual || autopilotFor(w)));
  let started = 0;
  for (const wf of wfs) {
    const src = wf.agentTrigger?.sourceId;
    const rec = recs.find((r) => !src || r.sourceId === src) || (src ? null : recs[0]);
    if (src && !rec) continue;
    const record: RunRecord = rec ? toRunRecord(rec) : { key: email.toLowerCase(), sourceId: null, name: name || email.split('@')[0], email, phone: '', fields: {} };
    const r = await startAgentRun({ workflow: wf, record, trigger: 'a reply', vars: { last_reply: text.slice(0, 1500), _extra: `They just wrote (answer this): "${text.slice(0, 1500)}"`, ...(meta.messageId ? { _reply_msgid: meta.messageId } : {}), ...(meta.subject ? { _reply_subject: meta.subject.slice(0, 160) } : {}) }, force: true });
    if (r.run) started++;
  }
  return started;
}

/** A lead typed something on WhatsApp. 'busy': the agent is still on their last message (try again); 'nobody': no agent answers now. */
export async function dispatchWhatsAppReply(rec: DataRecord, text: string, meta: { contactId: string; at: number }): Promise<'started' | 'busy' | 'nobody'> {
  // A test reply (from a hidden test lead) is answered whether or not autopilot is on.
  const manual = rec.fields.preview === 'yes';
  const wfs = agentWorkflows().filter((w) => w.agentTrigger?.kind === 'reply.received' && w.agentTrigger.sourceId === rec.sourceId && (manual || autopilotFor(w)));
  const can = manual || autopilotOn();
  // Looked at before anything is noted, so trying again never notes it twice.
  if (can && wfs.some((w) => hasActiveRun(w.id, rec.key))) return 'busy';
  appendConversation(rec.sourceId, rec.key, 'them', text);
  noteReply(rec.email, text, (field, value) => { setRecordField(rec.sourceId, rec.key, field, value); }, rec.key);
  const { noteEngagement } = await import('@/lib/nurture/track');
  await noteEngagement({ t: currentTenantId(), s: rec.sourceId, k: rec.key, m: `reply_${meta.at.toString(36)}`, x: 'reply' }, 'reply').catch(() => null);
  // Unsubscribed (nothing is sent by an agent): a person answers what they asked.
  if (!can || rec.fields.opted_out === 'yes') return 'nobody';
  // Whoever they have been hearing from: Zinhle once she has worked with them, otherwise Naledi (who signs the WhatsApps).
  const agents = listCustomAgents();
  const speaker = agents.find((a) => a.id === (agentWorkedWith('ag_zinhle', rec.key) ? 'ag_zinhle' : 'ag_naledi'));
  let started = 0;
  for (const wf of wfs) {
    const r = await startAgentRun({
      workflow: wf, record: toRunRecord(getRecord(rec.sourceId, rec.key) || rec), trigger: 'a WhatsApp reply', force: true, as: speaker?.name,
      vars: {
        last_reply: text.slice(0, 1500),
        _extra: `They just wrote on WhatsApp (answer this): "${text.slice(0, 1500)}"\nYou are answering in the same WhatsApp chat: short, plain text, no subject, no links you were not given.`,
        _wa_id: meta.contactId, _wa_at: String(meta.at),
      },
    });
    if (r.run) started++;
  }
  return started ? 'started' : 'nobody';
}

/* ── Schedules ────────────────────────────────────────────────────────────── */

type SchedState = Record<string, { last: number; nextTry?: number }>;
const sched = tenantDoc<SchedState>('agent-schedule', () => ({}));
const scanning = new Set<string>();

export function hydrateAgentSchedule(tenantId = currentTenantId()) {
  return sched.hydrate(tenantId);
}

/** The most recent scheduled slot at or before now. */
export function lastSlot(s: NonNullable<AgentTrigger['schedule']>, now = Date.now()): number {
  if (s.every === 'hour') { const d = new Date(now); d.setMinutes(0, 0, 0); return d.getTime(); }
  const d = new Date(now);
  d.setHours(s.hour ?? 8, 0, 0, 0);
  if (s.every === 'day') {
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  const wd = s.weekday ?? 1;
  d.setDate(d.getDate() - ((d.getDay() - wd + 7) % 7));
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

export function nextSlot(s: NonNullable<AgentTrigger['schedule']>, now = Date.now()): number {
  const last = lastSlot(s, now);
  const step = s.every === 'hour' ? 3_600_000 : s.every === 'day' ? 86_400_000 : 7 * 86_400_000;
  return last + step;
}

/** Scheduled agents whose slot has come: report jobs run once; match jobs run for every matching record. */
export async function runScheduledAgents(tenantId = currentTenantId()): Promise<void> {
  if (!autopilotOn() || scanning.has(tenantId)) return;
  scanning.add(tenantId);
  try {
    const st = sched.get(tenantId);
    const now = Date.now();
    for (const wf of agentWorkflows()) {
      const t = wf.agentTrigger;
      if (!t || (t.kind !== 'record.match' && t.kind !== 'schedule') || !autopilotFor(wf)) continue;
      const s = t.schedule || { every: 'day', hour: 8 };
      const mine = st[wf.id];
      if (mine?.nextTry && now < mine.nextTry) continue;
      if (mine && mine.last >= lastSlot(s, now)) continue;
      if (!mine) {
        // A new scheduled agent waits for its first slot instead of firing the moment it is saved.
        st[wf.id] = { last: lastSlot(s, now) };
        sched.save(tenantId);
        continue;
      }
      if (t.kind === 'schedule') {
        await startAgentRun({ workflow: wf, record: { key: '__report__', sourceId: t.sourceId || null, name: 'Team report', email: '', phone: '' }, trigger: `schedule (${s.every})`, force: true });
        st[wf.id] = { last: now };
        sched.save(tenantId);
        continue;
      }
      const result = await scanMatches(wf, `scheduled check (${s.every})`);
      st[wf.id] = result.more ? { last: mine.last, nextTry: now + 10 * 60_000 } : { last: now };
      sched.save(tenantId);
    }
  } finally {
    scanning.delete(tenantId);
  }
}

/** Start the agent for every record that matches its rules (a batch at a time). */
export async function scanMatches(wf: WorkflowDef, label: string): Promise<{ started: number; matched: number; more: boolean }> {
  const t = wf.agentTrigger;
  const sources = t?.sourceId ? [t.sourceId] : listSources().map((s) => s.id);
  let started = 0;
  let matched = 0;
  const cooldown = t?.cooldownHours ?? 72;
  for (const sid of sources) {
    for (const rec of listRecords(sid)) {
      // A team member's preview lead (trying the quiz or video) is never worked on.
      if (rec.fields.preview === 'yes' || !matchesAll(t?.match, liveFields(rec))) continue;
      matched++;
      if (ranRecently(wf.id, rec.key, cooldown)) continue;
      if (started >= BATCH) return { started, matched, more: true };
      const r = await startAgentRun({ workflow: wf, record: toRunRecord(rec), trigger: label });
      if (r.run) started++;
    }
  }
  return { started, matched, more: false };
}

/** Who would this agent pick up right now? (the builder's preview) */
export function previewMatches(wf: WorkflowDef, limit = 50): DataRecord[] {
  const t = wf.agentTrigger;
  const sources = t?.sourceId ? [t.sourceId] : listSources().map((s) => s.id);
  const out: DataRecord[] = [];
  for (const sid of sources) {
    for (const rec of listRecords(sid)) {
      if (rec.fields.preview !== 'yes' && matchesAll(t?.match, liveFields(rec))) out.push(rec);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
