import fs from 'node:fs';
import { liveAllowed, sendingPaused } from '@/lib/email/pause';
import path from 'node:path';
import type {
  AgentId, AgentState, Capabilities, Deliverable, Dept, FeedActor, FeedLevel, HeadlineTone, InboxMail,
  LearnerCard, Metrics, PendingOutreach, RoomMood, Settings, Task, ToolCallLog, Visitor, WorldState,
} from '@/lib/types';
import { AGENTS, ROOMS } from '@/lib/office/layout';
import { loadArchive, scheduleSave, clearArchive } from './persist';
import { dbConfigured, loadWorldFromDb, syncWorldToDb } from '@/lib/db/postgres';
import { sandboxLearnerCards } from '@/lib/lms/sandboxData';
import { resetSandbox, sandboxAdapter } from '@/lib/lms/lmsAdapter';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import { getTenantIntegrations, publicTenantSummary } from '@/lib/auth/accounts';

type Listener = (s: WorldState) => void;
interface Hub { state: WorldState; listeners: Set<Listener>; scheduled: boolean }

const g = globalThis as unknown as { __czHubs?: Map<string, Hub>; __ssPublic?: Map<string, string | null> };

/* Where links in emails open. Set in Settings (saved to .data/config.json) or
 * PUBLIC_BASE_URL; it must be an address a learner's phone can reach. */
function configFile(tenantId = currentTenantId()): string {
  return tenantId === DEFAULT_TENANT_ID
    ? path.join(process.cwd(), '.data', 'config.json')
    : path.join(process.cwd(), '.data', 'tenants', tenantId, 'config.json');
}

export function publicUrl(tenantId = currentTenantId()): string {
  if (!g.__ssPublic) g.__ssPublic = new Map();
  if (!g.__ssPublic.has(tenantId)) {
    let v: string | null = null;
    try { v = (JSON.parse(fs.readFileSync(configFile(tenantId), 'utf8')) as { publicUrl?: string }).publicUrl || null; } catch { v = null; }
    g.__ssPublic.set(tenantId, v);
  }
  return (g.__ssPublic.get(tenantId) || process.env.PUBLIC_BASE_URL || 'http://localhost:3200').replace(/\/$/, '');
}
export function setPublicUrl(url: string | null, tenantId = currentTenantId()) {
  const clean = url && /^https?:\/\/[^\s<>]+$/.test(url.trim()) ? url.trim().replace(/\/$/, '') : null;
  if (url && !clean) throw new Error('That is not a web address (it must start with http:// or https://).');
  if (!g.__ssPublic) g.__ssPublic = new Map();
  g.__ssPublic.set(tenantId, clean);
  const file = configFile(tenantId);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ publicUrl: clean })); } catch { /* keep in memory */ }
  mutate((s) => { s.caps = capabilities(tenantId); });
}

export function capabilities(tenantId = currentTenantId()): Capabilities {
  const anthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const openai = Boolean(process.env.OPENAI_API_KEY);
  const provider = anthropic ? 'anthropic' : openai ? 'openai' : 'simulation';
  const model = anthropic
    ? (process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5')
    : openai ? (process.env.OPENAI_MODEL || 'gpt-4o-mini') : 'deterministic simulation';
  const ti = getTenantIntegrations(tenantId);
  const hasTenantMoodle = Boolean(ti.moodleUrl && ti.moodleToken);
  const hasTenantRest = Boolean(ti.lmsApiUrl && ti.lmsApiKey);
  const hasTenantSmtp = Boolean(ti.smtpHost && ti.smtpUser && ti.smtpPass);
  const hasEnvSmtp = Boolean(tenantId === DEFAULT_TENANT_ID && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  const hasEnvMoodle = Boolean(tenantId === DEFAULT_TENANT_ID && process.env.MOODLE_URL && process.env.MOODLE_TOKEN);
  return {
    ai: { provider, model },
    email: liveAllowed(ti.liveOutreachEnabled) && (hasTenantSmtp || hasEnvSmtp) ? 'smtp' : 'simulated',
    liveOutreach: liveAllowed(ti.liveOutreachEnabled),
    sendingPaused: sendingPaused(),
    lmsLiveConfigured: hasTenantMoodle || hasTenantRest || ti.lmsProvider === 'webhook' || hasEnvMoodle || Boolean(tenantId === DEFAULT_TENANT_ID && process.env.LMS_API_URL && process.env.LMS_API_KEY),
    moodleConfigured: hasTenantMoodle || hasEnvMoodle,
    whatsappConfigured: Boolean(ti.whatsappUrl || (tenantId === DEFAULT_TENANT_ID && process.env.WHATSAPP_API_URL)),
    manychatConfigured: Boolean(ti.manychatApiKey),
    postgresConfigured: dbConfigured(),
    baseUrl: publicUrl(tenantId),
    dialer: Boolean(liveAllowed(ti.liveOutreachEnabled) && process.env.DIALER_URL && process.env.DIALER_API_KEY),
  };
}

function freshAgents(): Record<AgentId, AgentState> {
  const out = {} as Record<AgentId, AgentState>;
  for (const a of AGENTS) {
    out[a.id] = {
      id: a.id, name: a.name, title: a.title, dept: a.dept,
      pos: { ...a.home }, home: { ...a.home }, path: null, walkMs: 0,
      status: 'idle', thought: null, carrying: null, tasksDone: 0,
    };
  }
  return out;
}

function freshRooms() {
  const out = {} as Record<Dept, { mood: RoomMood; caption: string | null }>;
  for (const id of Object.keys(ROOMS) as Dept[]) out[id] = { mood: 'calm', caption: null };
  return out;
}

const ZERO: Metrics = { processed: 0, approved: 0, corrections: 0, dispatched: 0, quizzesCompleted: 0, aiCalls: 0 };

export function freshWorld(keepArchive = true, tenantId = currentTenantId()): WorldState {
  const caps = capabilities(tenantId);
  const archive = keepArchive ? loadArchive(tenantId) : null;
  const ti = getTenantIntegrations(tenantId);
  const tasks = (archive?.tasks || []).map((t) => (t.status === 'running' ? { ...t, status: 'failed' as const, stepLabel: 'Interrupted by a restart' } : t));
  const state: WorldState = {
    version: 1,
    startedAt: Date.now(),
    busy: null,
    agents: freshAgents(),
    visitors: [],
    rooms: freshRooms(),
    feed: archive?.feed || [],
    headlines: [],
    tasks,
    deliverables: archive?.deliverables || [],
    inbox: archive?.inbox || [],
    learners: archive?.learners?.length
      ? archive.learners
      : ti.lmsProvider === 'sandbox'
        ? sandboxLearnerCards().filter((c) => !sandboxAdapter().isHidden(c.id))
        : [],
    metrics: { ...ZERO, ...(archive?.metrics || {}) },
    settings: {
      injectDefects: false,
      lmsMode: ti.lmsProvider === 'sandbox' ? 'sandbox' : 'live',
      speed: 'normal',
      tutorLanguage: ti.tutorLanguage || 'en',
      scheduleEnabled: Boolean(ti.autoRunMode),
      requireApproval: typeof ti.requireApproval === 'boolean' ? ti.requireApproval : true,
      autoRunMode: Boolean(ti.autoRunMode),
      liveOutreachEnabled: Boolean(ti.liveOutreachEnabled),
    },
    caps,
    spotlight: null,
    automation: defaultAutomation(),
    pendingOutreach: archive?.pendingOutreach || [],
    tenant: publicTenantSummary(tenantId),
  };
  state.feed.push({
    id: uid('f'), ts: Date.now(), actor: 'system', level: 'system',
    text: archive ? 'Colleague online. Archive restored, agents back at their desks.' : 'Colleague online. Planner, two workers and the Reviewer on duty. Give it a goal.',
  });
  return state;
}

export function hub(tenantId = currentTenantId()): Hub {
  if (!g.__czHubs) g.__czHubs = new Map();
  if (!g.__czHubs.has(tenantId)) {
    g.__czHubs.set(tenantId, { state: freshWorld(true, tenantId), listeners: new Set(), scheduled: false });
  }
  const h = g.__czHubs.get(tenantId)!;
  upgrade(h.state);
  const ti = getTenantIntegrations(tenantId);
  h.state.caps = capabilities(tenantId);
  h.state.tenant = publicTenantSummary(tenantId);
  h.state.settings.requireApproval = typeof ti.requireApproval === 'boolean' ? ti.requireApproval : true;
  h.state.settings.autoRunMode = Boolean(ti.autoRunMode);
  h.state.settings.liveOutreachEnabled = Boolean(ti.liveOutreachEnabled);
  h.state.settings.lmsMode = ti.lmsProvider === 'sandbox' ? 'sandbox' : 'live';
  return h;
}

/* The hub outlives hot reloads, so a world created by older code can be
 * missing fields added since. Fill them in rather than crash the client. */
function upgrade(s: WorldState) {
  s.headlines ??= [];
  s.visitors ??= [];
  s.feed ??= [];
  s.tasks ??= [];
  s.deliverables ??= [];
  s.inbox ??= [];
  s.learners ??= [];
  s.pendingOutreach ??= [];
  if (s.settings) s.settings.tutorLanguage ??= 'en';
  else s.settings = { injectDefects: true, lmsMode: 'sandbox', speed: 'normal', tutorLanguage: 'en' };
  s.metrics = { ...ZERO, ...(s.metrics || {}) };
  s.automation ??= defaultAutomation();
  if (s.settings.scheduleEnabled === undefined) s.settings.scheduleEnabled = true;
  s.rooms = { ...freshRooms(), ...(s.rooms || {}) };
  const agents = freshAgents();
  for (const id of Object.keys(agents) as AgentId[]) s.agents[id] = { ...agents[id], ...(s.agents?.[id] || {}) };
}

export function getState(): WorldState { return hub().state; }

export function mutate(fn: (s: WorldState) => void) {
  const tid = currentTenantId();
  const h = hub(tid);
  fn(h.state);
  h.state.version += 1;
  if (!h.scheduled) {
    h.scheduled = true;
    setTimeout(() => {
      h.scheduled = false;
      for (const l of h.listeners) { try { l(h.state); } catch { /* a closed stream */ } }
    }, 0);
  }
  scheduleSave(() => h.state, tid);
}

export function subscribe(fn: Listener) {
  const h = hub();
  h.listeners.add(fn);
  return () => { h.listeners.delete(fn); };
}

export function listenerCount() { return hub().listeners.size; }

export async function hydrateStoreFromDb(): Promise<boolean> {
  if (!dbConfigured()) return false;
  const loaded = await loadWorldFromDb();
  const s = hub().state;
  if (!loaded) {
    // First boot against an empty Postgres DB: seed current snapshot immediately.
    void syncWorldToDb({
      learners: s.learners,
      deliverables: s.deliverables,
      inbox: s.inbox,
      metrics: s.metrics,
      tasks: s.tasks,
      feed: s.feed,
    });
    return false;
  }
  if (s.busy) return false;
  // Merge, never replace: the local archive and the database can each be
  // missing what the other has (a restart, a failed write), so keep the union
  // and, where both have an item, the newer copy.
  mutate((cur) => {
    cur.learners = mergeById(cur.learners, loaded.learners, () => 0, 'local');
    cur.deliverables = mergeById(cur.deliverables, loaded.deliverables, (d) => d.updatedAt || d.createdAt || 0).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    cur.inbox = mergeById(cur.inbox, loaded.inbox, (m) => m.ts || 0).sort((a, b) => b.ts - a.ts).slice(0, 60);
    if (loaded.metrics) {
      const m = { ...ZERO, ...loaded.metrics };
      for (const k of Object.keys(m) as (keyof Metrics)[]) m[k] = Math.max(m[k] || 0, cur.metrics?.[k] || 0);
      cur.metrics = m;
    }
    if (loaded.tasks?.length) {
      const dbTasks = loaded.tasks.map((t) => (t.status === 'running' ? { ...t, status: 'failed' as const, stepLabel: 'Interrupted by a restart' } : t));
      cur.tasks = mergeById(cur.tasks, dbTasks, (t) => t.endedAt || t.startedAt || 0).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 60);
    }
    if (loaded.feed?.length) cur.feed = mergeById(cur.feed, loaded.feed, (f) => f.ts).sort((a, b) => a.ts - b.ts).slice(-200);
    if (loaded.pendingOutreach?.length) {
      // A decision (approved/rejected) always beats "pending".
      cur.pendingOutreach = mergeById(cur.pendingOutreach || [], loaded.pendingOutreach, (p) => (p.status === 'pending' ? 0 : p.resolvedAt || 1));
    }
  });
  return true;
}

/** Union of two lists by id; when both have an item, keep the one with the larger stamp (ties: the local one). */
function mergeById<T extends { id: string }>(local: T[], db: T[], stamp: (x: T) => number, prefer: 'stamp' | 'local' = 'stamp'): T[] {
  const out = new Map<string, T>();
  for (const x of db || []) out.set(x.id, x);
  for (const x of local || []) {
    const other = out.get(x.id);
    if (!other || prefer === 'local' || stamp(x) >= stamp(other)) out.set(x.id, x);
  }
  return [...out.values()];
}

export function enqueueOutreachApproval(item: PendingOutreach) {
  mutate((s) => {
    s.pendingOutreach ??= [];
    s.pendingOutreach.unshift(item);
    // Never drop something still waiting for a decision; trim only resolved history.
    const pending = s.pendingOutreach.filter((x) => x.status === 'pending');
    const resolved = s.pendingOutreach.filter((x) => x.status !== 'pending').slice(0, 60);
    if (pending.length + resolved.length < s.pendingOutreach.length) s.pendingOutreach = [...pending, ...resolved];
  });
}

export function markOutreachApproval(id: string, status: 'approved' | 'rejected'): PendingOutreach | null {
  let found: PendingOutreach | null = null;
  mutate((s) => {
    const item = (s.pendingOutreach || []).find((x) => x.id === id);
    if (item) {
      item.status = status;
      item.resolvedAt = Date.now();
      found = { ...item };
    }
  });
  return found;
}

export function resetWorld() {
  const h = hub();
  clearArchive();
  resetSandbox();
  h.state = freshWorld(false);
  h.state.feed.push({ id: uid('f'), ts: Date.now(), actor: 'system', level: 'system', text: 'Reset. Archive cleared, cohort reseeded from the LMS sandbox.' });
  mutate(() => {});
}

let seq = 0;
export function uid(prefix: string) {
  seq = (seq + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

/* ── Mutators the engine uses ────────────────────────────────────────────── */

export function log(actor: FeedActor, level: FeedLevel, text: string, extra: { taskId?: string; deliverableId?: string; toolCall?: ToolCallLog; dept?: string } = {}) {
  mutate((s) => {
    s.feed.push({ id: uid('f'), ts: Date.now(), actor, level, text, ...extra });
    if (s.feed.length > 160) s.feed.splice(0, s.feed.length - 160);
  });
}

export function announce(actor: FeedActor, text: string, tone: HeadlineTone = 'info') {
  mutate((s) => {
    s.headlines.push({ id: uid('h'), ts: Date.now(), actor, text, tone });
    if (s.headlines.length > 4) s.headlines.splice(0, s.headlines.length - 4);
  });
}

export function setAgent(id: AgentId, patch: Partial<AgentState>) {
  mutate((s) => { Object.assign(s.agents[id], patch); });
}

export function setRoom(dept: Dept, mood: RoomMood, caption: string | null = null) {
  mutate((s) => { s.rooms[dept] = { mood, caption }; });
}

export function upsertVisitor(v: Visitor) {
  mutate((s) => {
    const i = s.visitors.findIndex((x) => x.id === v.id);
    if (i >= 0) s.visitors[i] = v; else s.visitors.push(v);
  });
}

export function patchVisitor(id: string, patch: Partial<Visitor>) {
  mutate((s) => { const v = s.visitors.find((x) => x.id === id); if (v) Object.assign(v, patch); });
}

export function removeVisitor(id: string) {
  mutate((s) => { s.visitors = s.visitors.filter((x) => x.id !== id); });
}

export function upsertDeliverable<T>(d: Deliverable<T>) {
  mutate((s) => {
    const i = s.deliverables.findIndex((x) => x.id === d.id);
    const next = { ...d, updatedAt: Date.now() } as Deliverable;
    if (i >= 0) s.deliverables[i] = next; else s.deliverables.unshift(next);
    const t = s.tasks.find((x) => x.id === d.taskId);
    if (t && !t.deliverableIds.includes(d.id)) t.deliverableIds.push(d.id);
  });
}

export function getDeliverable<T = unknown>(id: string) {
  return getState().deliverables.find((d) => d.id === id) as Deliverable<T> | undefined;
}

export function upsertTask(t: Task) {
  mutate((s) => {
    const i = s.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) s.tasks[i] = t; else s.tasks.unshift(t);
    if (s.tasks.length > 30) s.tasks.length = 30;
  });
}

export function patchTask(id: string, patch: Partial<Task>) {
  mutate((s) => { const t = s.tasks.find((x) => x.id === id); if (t) Object.assign(t, patch); });
}

export function pushMail(m: InboxMail) {
  mutate((s) => { s.inbox.unshift(m); if (s.inbox.length > 60) s.inbox.length = 60; });
}

export function appendMailReply(fromEmail: string, reply: { from: string; text: string; ts?: number }) {
  const emailLower = fromEmail.trim().toLowerCase();
  mutate((s) => {
    const mail = s.inbox.find((m) => m.to.toLowerCase() === emailLower);
    if (mail) {
      mail.replies = mail.replies || [];
      mail.replies.push({ ts: reply.ts || Date.now(), from: reply.from, text: reply.text });
    }
  });
}

export function setLearner(id: string, patch: Partial<LearnerCard>) {
  mutate((s) => { const l = s.learners.find((x) => x.id === id); if (l) Object.assign(l, patch); });
}

export function setLearners(list: LearnerCard[]) {
  mutate((s) => {
    // keep what the office already learned about a student this session
    const prev = new Map(s.learners.map((l) => [l.id, l]));
    s.learners = list.map((l) => {
      const p = prev.get(l.id);
      return p && (p.status === 'intervention' || p.status === 'recovered') ? { ...l, status: p.status, lastEvent: p.lastEvent } : l;
    });
  });
}

export function bump(metric: keyof Metrics, n = 1) {
  mutate((s) => { s.metrics[metric] += n; });
}

export function setSettings(patch: Partial<Settings>) {
  mutate((s) => { Object.assign(s.settings, patch); });
}

export function setSpotlight(s: WorldState['spotlight']) {
  mutate((w) => { w.spotlight = s; });
}

export function setAutomation(patch: Partial<NonNullable<WorldState['automation']>>) {
  mutate((w) => { w.automation = { ...(w.automation || defaultAutomation()), ...patch }; });
}

export function defaultAutomation(): NonNullable<WorldState['automation']> {
  return {
    webhookPath: '/api/webhooks/lms', lastEvent: null, events: 0, schedule: { enabled: true, label: 'Mondays 07:00', nextAt: null, lastAt: null }, queued: 0,
    sheet: { connected: false, url: null, rows: 0, lastReadAt: null, lastError: null, lastChangeAt: null }, writeBack: Boolean(process.env.SHEET_WRITEBACK_URL),
  };
}

export function setBusy(b: WorldState['busy']) {
  mutate((s) => { s.busy = b; });
}
