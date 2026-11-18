import fs from 'node:fs';
import path from 'node:path';
import type { FollowUpCase } from '@/lib/types';
import { getState, log, setLearner } from './store';
import { draftFollowUp } from '@/lib/ai/agents';
import { followUpEmail, sendMail } from '@/lib/email/send';
import { getLearnerMemories, loadFollowUpsFromDb, syncFollowUpsToDb } from '@/lib/db/postgres';
import { confirmedAt, fileTime, localWins, markSynced } from '@/lib/db/syncState';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';

/* Persistent follow-ups ("follow-ups forever") per tenant workspace. */

function fileFor(tenantId = currentTenantId()): string {
  return tenantId === DEFAULT_TENANT_ID
    ? path.join(process.cwd(), '.data', 'followups.json')
    : path.join(process.cwd(), '.data', 'tenants', tenantId, 'followups.json');
}

type Store = { list: FollowUpCase[]; running: boolean };
const g = globalThis as unknown as { __thusoFollowUpsByTenant?: Map<string, Store> };

function storeMap(): Map<string, Store> {
  if (!g.__thusoFollowUpsByTenant) g.__thusoFollowUpsByTenant = new Map();
  return g.__thusoFollowUpsByTenant;
}

function store(tenantId = currentTenantId()): Store {
  const m = storeMap();
  if (!m.has(tenantId)) {
    const file = fileFor(tenantId);
    let list: FollowUpCase[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as FollowUpCase[];
      if (Array.isArray(raw)) list = raw;
    } catch { /* none saved yet */ }
    m.set(tenantId, { list, running: false });
  }
  return m.get(tenantId)!;
}

function save(tenantId = currentTenantId()) {
  const file = fileFor(tenantId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store(tenantId).list, null, 2), 'utf8');
  } catch { /* keep in memory on read-only disk */ }
  void syncFollowUpsToDb(store(tenantId).list, tenantId).then((ok) => { if (ok) markSynced('followups', tenantId); });
}

export async function hydrateFollowUpsFromDb(tenantId = currentTenantId()) {
  const rows = await loadFollowUpsFromDb(tenantId);
  // Follow-ups changed here while the database was unreachable (e.g. one paused by hand) win over its older copy.
  if (rows && rows.length && !localWins(fileTime(fileFor(tenantId)), confirmedAt('followups', tenantId), null)) {
    store(tenantId).list = rows;
    save(tenantId);
  } else if (rows) {
    void syncFollowUpsToDb(store(tenantId).list, tenantId).then((ok) => { if (ok) markSynced('followups', tenantId); });
  }
}

export function listFollowUps(): FollowUpCase[] {
  return [...store().list].sort((a, b) => b.lastSentAt - a.lastSentAt);
}

export function registerFollowUp(input: {
  learnerId: string;
  learnerName: string;
  learnerEmail: string;
  cohort: string;
  workflowId: string | null;
  workflowName: string;
  triggerKind: string;
  reason: string;
  link: string | null;
  moduleCode: string | null;
  topic: string | null;
  intervalHours: number;
  repeatForever: boolean;
  maxAttempts: number | null;
  initialSubject: string;
}): FollowUpCase {
  const s = store();
  const now = Date.now();
  const intervalHours = Math.max(1, input.intervalHours || 48);
  const existing = s.list.find(
    (c) => c.learnerId === input.learnerId && c.status === 'active' && (c.workflowId || 'default') === (input.workflowId || 'default'),
  );
  if (existing) {
    existing.reason = input.reason;
    existing.link = input.link || existing.link;
    existing.moduleCode = input.moduleCode || existing.moduleCode;
    existing.topic = input.topic || existing.topic;
    existing.lastSentAt = now;
    existing.nextDueAt = now + intervalHours * 3_600_000;
    existing.history.push({ ts: now, attempt: existing.attempts, subject: input.initialSubject, note: 'Initial / refreshed outreach sent' });
    save();
    return existing;
  }

  const c: FollowUpCase = {
    id: `fu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    learnerId: input.learnerId,
    learnerName: input.learnerName,
    learnerEmail: input.learnerEmail,
    cohort: input.cohort,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    triggerKind: input.triggerKind,
    reason: input.reason,
    link: input.link,
    moduleCode: input.moduleCode,
    topic: input.topic,
    attempts: 1,
    maxAttempts: input.repeatForever ? null : (input.maxAttempts ?? 3),
    intervalHours,
    repeatForever: input.repeatForever,
    nextDueAt: now + intervalHours * 3_600_000,
    lastSentAt: now,
    status: 'active',
    history: [{ ts: now, attempt: 1, subject: input.initialSubject, note: 'Initial outreach sent' }],
  };
  s.list.unshift(c);
  save();
  return c;
}

export function markFollowUpRecovered(learnerId: string) {
  const s = store();
  let changed = false;
  for (const c of s.list) {
    if (c.learnerId === learnerId && (c.status === 'active' || c.status === 'paused')) {
      c.status = 'recovered';
      c.history.push({ ts: Date.now(), attempt: c.attempts, subject: 'Recovered', note: 'Learner recovered on the LMS; follow-ups closed.' });
      changed = true;
    }
  }
  if (changed) save();
}

export function setFollowUpStatus(id: string, status: 'active' | 'paused' | 'resolved'): FollowUpCase | null {
  const s = store();
  const c = s.list.find((x) => x.id === id);
  if (!c) return null;
  c.status = status;
  if (status === 'active') c.nextDueAt = Date.now() + c.intervalHours * 3_600_000;
  save();
  return c;
}

export async function processDueFollowUps(opts: { forceId?: string; forceAll?: boolean } = {}): Promise<number> {
  const s = store();
  if (s.running) return 0;
  // Background auto follow-ups must never bypass Manual Review / Approval Gate.
  if (!opts.forceId && !opts.forceAll) {
    const st = getState();
    if (!st.settings.autoRunMode || st.settings.requireApproval !== false) return 0;
  }
  s.running = true;
  let sentCount = 0;
  try {
    const now = Date.now();
    const learners = new Map(getState().learners.map((l) => [l.id, l]));
    for (const c of s.list) {
      if (opts.forceId && c.id !== opts.forceId) continue;
      if (c.status !== 'active') continue;
      const card = learners.get(c.learnerId);
      if (card && (card.status === 'recovered' || card.status === 'on_track')) {
        markFollowUpRecovered(c.learnerId);
        continue;
      }
      if (!opts.forceId && !opts.forceAll && now < c.nextDueAt) continue;
      if (!c.repeatForever && c.maxAttempts !== null && c.attempts >= c.maxAttempts) {
        c.status = 'resolved';
        save();
        continue;
      }

      const nextAttempt = c.attempts + 1;
      const memories = await getLearnerMemories([c.learnerId]);
      const { value: msg } = await draftFollowUp({
        learnerName: c.learnerName,
        cohort: c.cohort,
        attempt: nextAttempt,
        reason: c.reason,
        workflowName: c.workflowName,
        moduleCode: c.moduleCode,
        topic: c.topic,
        hasLink: Boolean(c.link),
        memory: memories.get(c.learnerId),
      });
      const emailPayload = followUpEmail({
        learnerName: c.learnerName,
        attempt: nextAttempt,
        subject: msg.subject,
        body: msg.body,
        ask: msg.ask,
        link: c.link,
      });
      const mail = await sendMail({
        to: card?.email || c.learnerEmail,
        toName: c.learnerName,
        ...emailPayload,
        link: c.link,
        taskId: 'followup',
        deliverableId: null,
      });
      c.attempts = nextAttempt;
      c.lastSentAt = Date.now();
      c.nextDueAt = c.lastSentAt + c.intervalHours * 3_600_000;
      c.history.push({
        ts: c.lastSentAt,
        attempt: nextAttempt,
        subject: msg.subject,
        note: `Follow-up #${nextAttempt} (${mail.delivery === 'smtp' ? 'sent via Nodemailer SMTP' : 'saved to Inbox'})`,
      });
      setLearner(c.learnerId, { lastEvent: `Follow-up #${nextAttempt} sent · ${c.repeatForever ? 'repeating' : 'scheduled'}` });
      log('success', 'dispatch', `Follow-up #${nextAttempt} sent to ${c.learnerName} (${c.workflowName}): "${msg.subject}".`, {
        toolCall: { tool: 'followups.send_recurring', payload: { followUpId: c.id, learnerId: c.learnerId, attempt: nextAttempt, delivery: mail.delivery, nextDueAt: new Date(c.nextDueAt).toISOString() } },
      });
      sentCount += 1;
      save();
    }
  } finally {
    s.running = false;
  }
  return sentCount;
}

