import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentId, AgentState, Capabilities, Deliverable, Dept, FeedActor, FeedLevel, HeadlineTone, InboxMail,
  LearnerCard, Metrics, RoomMood, Settings, Task, ToolCallLog, Visitor, WorldState,
} from '@/lib/types';
import { AGENTS, ROOMS } from '@/lib/office/layout';
import { loadArchive, scheduleSave, clearArchive } from './persist';
import { sandboxLearnerCards } from '@/lib/lms/sandboxData';
import { resetSandbox, sandboxAdapter } from '@/lib/lms/lmsAdapter';

/* The one world.
 *
 * A single object on globalThis, so the dev server's hot reloads and every
 * API route share it. mutate() applies a change, bumps the version and tells
 * every open stream once per tick, however many changes landed in that tick. */

type Listener = (s: WorldState) => void;
interface Hub { state: WorldState; listeners: Set<Listener>; scheduled: boolean }

const g = globalThis as unknown as { __czHub?: Hub; __ssPublic?: string | null };

/* Where links in emails open. Set in Settings (saved to .data/config.json) or
 * PUBLIC_BASE_URL; it must be an address a learner's phone can reach. */
const CONFIG = path.join(process.cwd(), '.data', 'config.json');
export function publicUrl(): string {
  if (g.__ssPublic === undefined) {
    try { g.__ssPublic = (JSON.parse(fs.readFileSync(CONFIG, 'utf8')) as { publicUrl?: string }).publicUrl || null; } catch { g.__ssPublic = null; }
  }
  return (g.__ssPublic || process.env.PUBLIC_BASE_URL || 'http://localhost:3200').replace(/\/$/, '');
}
export function setPublicUrl(url: string | null) {
  const clean = url && /^https?:\/\/[^\s<>]+$/.test(url.trim()) ? url.trim().replace(/\/$/, '') : null;
  if (url && !clean) throw new Error('That is not a web address (it must start with http:// or https://).');
  g.__ssPublic = clean;
  try { fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify({ publicUrl: clean })); } catch { /* keep in memory */ }
  mutate((s) => { s.caps = capabilities(); });
}

export function capabilities(): Capabilities {
  const anthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const openai = Boolean(process.env.OPENAI_API_KEY);
  const provider = anthropic ? 'anthropic' : openai ? 'openai' : 'simulation';
  const model = anthropic
    ? (process.env.ANTHROPIC_MODEL || 'claude-opus-5-5')
    : openai ? (process.env.OPENAI_MODEL || 'gpt-4o-mini') : 'deterministic simulation';
  return {
    ai: { provider, model },
    email: process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS ? 'smtp' : process.env.RESEND_API_KEY ? 'resend' : 'simulated',
    lmsLiveConfigured: Boolean(process.env.LMS_API_URL && process.env.LMS_API_KEY),
    baseUrl: publicUrl(),
    dialer: Boolean(process.env.DIALER_URL && process.env.DIALER_API_KEY),
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

export function freshWorld(keepArchive = true): WorldState {
  const caps = capabilities();
  const archive = keepArchive ? loadArchive() : null;
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
    learners: archive?.learners?.length ? archive.learners : sandboxLearnerCards().filter((c) => !sandboxAdapter().isHidden(c.id)),
    metrics: { ...ZERO, ...(archive?.metrics || {}) },
    settings: { injectDefects: true, lmsMode: caps.lmsLiveConfigured ? 'live' : 'sandbox', speed: 'normal', tutorLanguage: 'en', scheduleEnabled: true },
    caps,
    spotlight: null,
    automation: defaultAutomation(),
  };
  state.feed.push({
    id: uid('f'), ts: Date.now(), actor: 'system', level: 'system',
    text: archive ? 'Colleague online. Archive restored, agents back at their desks.' : 'Colleague online. Planner, two workers and the Reviewer on duty. Give it a goal.',
  });
  return state;
}

export function hub(): Hub {
  if (!g.__czHub) g.__czHub = { state: freshWorld(), listeners: new Set(), scheduled: false };
  else upgrade(g.__czHub.state);
  // Keys and addresses are read live, so editing .env.local needs no restart.
  g.__czHub.state.caps = capabilities();
  return g.__czHub;
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
  const h = hub();
  fn(h.state);
  h.state.version += 1;
  if (!h.scheduled) {
    h.scheduled = true;
    setTimeout(() => {
      h.scheduled = false;
      for (const l of h.listeners) { try { l(h.state); } catch { /* a closed stream */ } }
    }, 0);
  }
  scheduleSave(() => h.state);
}

export function subscribe(fn: Listener) {
  const h = hub();
  h.listeners.add(fn);
  return () => { h.listeners.delete(fn); };
}

export function listenerCount() { return hub().listeners.size; }

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

export function log(actor: FeedActor, level: FeedLevel, text: string, extra: { taskId?: string; deliverableId?: string; toolCall?: ToolCallLog } = {}) {
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
  mutate((s) => { s.inbox.unshift(m); if (s.inbox.length > 12) s.inbox.length = 12; });
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
