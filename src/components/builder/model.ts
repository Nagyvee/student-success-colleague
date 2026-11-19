import type {
  AgentRun,
  AgentStep,
  AgentTrigger,
  AgentTriggerKind,
  ConditionOp,
  CustomAgentDef,
  DataSource,
  OfficeDef,
  StepCondition,
  StepKind,
  WorkflowDef,
  WorkflowTrigger,
} from '@/lib/types';
import { OP_LABEL } from '@/lib/data/conditions';

/* The builder's vocabulary: what each step and trigger is called in plain
 * English, how it is summarised on a card, and the tree edits the canvas
 * makes. Client-safe (no server imports). */

/* ── API ──────────────────────────────────────────────────────────────────── */

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(body?: Record<string, unknown>, query?: string): Promise<T> {
  const res = await fetch(`/api/departments${query ? `?${query}` : ''}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error
      || (res.status === 401 ? 'Your session has ended. Sign in again.' : `Something went wrong (${res.status}).`);
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export type LightRun = Omit<AgentRun, 'steps'> & { steps?: AgentStep[] };

export interface AgentCardData extends CustomAgentDef {
  workflow: WorkflowDef | null;
  activeRuns: number;
  /** An agent of this floor is working right now. */
  working?: boolean;
  /** Its latest run failed or had a failed step (last 24h). */
  hasError?: boolean;
  lastRun: LightRun | null;
}

export interface DepartmentData extends OfficeDef { agents: AgentCardData[] }

export interface Overview {
  /** The signed-in person's role; only owners and admins can change structure. */
  role?: 'owner' | 'admin' | 'advisor';
  canManage?: boolean;
  departments: DepartmentData[];
  sources: DataSource[];
  runs: LightRun[];
  autopilot: boolean;
  requireApproval: boolean;
  liveOutreach: boolean;
  /** The server's sending lock (test phase). */
  sendingPaused?: boolean;
  knowledge: { agentKnowledge: string; applyUrl: string };
  leadsWebhook: { path: string; token: string | null };
  fieldLabels: Record<string, string>;
  kindFields: Record<string, string[]>;
}

export interface MatchRow { key: string; sourceId: string; name: string; email: string; phone: string }

export interface WorkflowView {
  workflow: WorkflowDef;
  agent: CustomAgentDef | null;
  department: OfficeDef | null;
  runs: LightRun[];
  matches: MatchRow[];
  /** How many records match in total (matches holds the first 25). */
  matchCount?: number;
  role?: 'owner' | 'admin' | 'advisor';
  canManage?: boolean;
  sources: DataSource[];
  departments: OfficeDef[];
  fieldLabels: Record<string, string>;
  kindFields: Record<string, string[]>;
}

export interface RecordRow { key: string; sourceId: string; name: string; email: string; phone: string; fields: Record<string, string>; updatedAt: number }

/* ── Steps ────────────────────────────────────────────────────────────────── */

export type StepGroup = 'AI actions' | 'Logic' | 'Data & team';

export interface StepMeta { label: string; color: string; group: StepGroup; hint: string }

export const STEP_META: Record<StepKind, StepMeta> = {
  ai_message: { label: 'AI message', color: '#2563eb', group: 'AI actions', hint: 'The agent writes a personal email or WhatsApp and sends it.' },
  send_voucher: { label: 'Voucher', color: '#ea580c', group: 'AI actions', hint: 'Give them a voucher from an offer the team approved. The code is made by the system and tracked until it is used.' },
  take_over: { label: 'Take over', color: '#6d28d9', group: 'Logic', hint: 'This agent takes the person over: the other agents in the department stop working on them, so they hear from one person.' },
  ai_video: { label: 'Personal video', color: '#c2410c', group: 'AI actions', hint: 'A short video made for this person: their goal, their question, why it fits them, then their programme. The next message links to it.' },
  send_library: { label: 'Saved message', color: '#7c3aed', group: 'AI actions', hint: 'Send an approved message from the library, with their name and programme merged in. No AI per person: the cheapest way to reach many.' },
  ai_task: { label: 'AI task', color: '#7c3aed', group: 'AI actions', hint: 'The agent works something out (qualify, research, summarise) and saves it on the record.' },
  ai_lesson: { label: 'Video lesson + test', color: '#059669', group: 'AI actions', hint: 'A personal video lesson that greets them by name, then a mastery test.' },
  ai_call: { label: 'AI phone call', color: '#0891b2', group: 'AI actions', hint: 'The AI caller phones them, says the call is recorded, keeps it short.' },
  condition: { label: 'Condition', color: '#d97706', group: 'Logic', hint: 'Go one way or the other: by a rule, or let the agent decide.' },
  wait: { label: 'Wait', color: '#64748b', group: 'Logic', hint: 'Pause for hours or days, then carry on.' },
  repeat: { label: 'Follow-up loop', color: '#db2777', group: 'Logic', hint: 'Repeat some steps every few days until something is true.' },
  stop: { label: 'Stop', color: '#475569', group: 'Logic', hint: 'End the run here.' },
  update_record: { label: 'Update record', color: '#0d9488', group: 'Data & team', hint: 'Set a field on the record (and the sheet, if write-back is on).' },
  notify_team: { label: 'Notify team', color: '#ea580c', group: 'Data & team', hint: 'Brief a person on the team with the agent\'s summary.' },
  webhook: { label: 'Send to another system', color: '#4f46e5', group: 'Data & team', hint: 'Post the record to a CRM or another tool.' },
};

/** A step's look and words, never undefined (a step kind this screen does not know yet shows as a plain card). */
export const metaOf = (kind: string): StepMeta => STEP_META[kind as StepKind] || { label: kind ? kind.replace(/_/g, ' ') : 'Step', color: '#64748b', group: 'Logic', hint: 'A step this screen does not recognise. Reload the page to see it properly.' };

export const STEP_ORDER: StepKind[] = ['ai_message', 'send_library', 'ai_video', 'send_voucher', 'ai_task', 'ai_lesson', 'ai_call', 'condition', 'wait', 'repeat', 'take_over', 'stop', 'update_record', 'notify_team', 'webhook'];

export const CHANNEL_LABEL: Record<string, string> = { email: 'Email', whatsapp: 'WhatsApp', email_whatsapp: 'Email + WhatsApp' };
export const STAGE_WORD: Record<string, string> = { welcome: 'welcome', learn: 'learn', trust: 'trust', offer: 'offer', decide: 'decide', reengage: 're-engage', ongoing: 'keep in touch' };

let seq = 0;
export const newId = () => `st_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function newStep(kind: StepKind): AgentStep {
  const id = newId();
  switch (kind) {
    case 'ai_message': return { id, kind, title: 'Personal message', channel: 'email', review: true, instructions: '' };
    case 'send_library': return { id, kind, title: 'Send a saved message', stage: 'learn' };
    case 'ai_video': return { id, kind, title: 'Personal video', instructions: '' };
    case 'send_voucher': return { id, kind, title: 'Give a voucher' };
    case 'take_over': return { id, kind, title: 'Take them over' };
    case 'ai_task': return { id, kind, title: 'Work something out', instructions: '', saveAs: 'task_result' };
    case 'ai_lesson': return { id, kind, title: 'Video lesson + test', questionCount: 10, passMark: 70, instructions: '' };
    case 'ai_call': return { id, kind, title: 'Phone call', instructions: '' };
    case 'condition': return { id, kind, title: 'Check something', condition: { mode: 'rule', field: 'status', op: 'eq', value: '' }, yes: [], no: [] };
    case 'wait': return { id, kind, title: 'Wait 2 days', hours: 48 };
    case 'repeat': return { id, kind, title: 'Follow up', hours: 72, maxTimes: 3, condition: { mode: 'rule', field: 'replied', op: 'eq', value: 'yes' }, steps: [] };
    case 'update_record': return { id, kind, title: 'Update the record', setField: 'status', setValue: '' };
    case 'notify_team': return { id, kind, title: 'Tell the team', instructions: '' };
    case 'webhook': return { id, kind, title: 'Send to CRM', url: '' };
    case 'stop': return { id, kind, title: 'Stop here' };
  }
}

/* ── Words ────────────────────────────────────────────────────────────────── */

export function fmtHours(h: number | undefined): string {
  const v = h ?? 24;
  if (v < 1) return `${Math.round(v * 60)} minutes`;
  if (v % 24 === 0) { const d = v / 24; return `${d} day${d === 1 ? '' : 's'}`; }
  return `${+v.toFixed(1)} hour${v === 1 ? '' : 's'}`;
}

export const humanField = (f: string | undefined, labels?: Record<string, string>) => {
  if (!f) return 'a field';
  if (labels?.[f]) return labels[f].toLowerCase();
  return f.replace(/_/g, ' ');
};

export const OP_CHOICES: { op: ConditionOp; label: string }[] = (Object.keys(OP_LABEL) as ConditionOp[]).map((op) => ({
  op,
  label: op === 'days_until_lte' ? 'is within (days)' : op === 'days_since_gte' ? 'was at least (days) ago' : OP_LABEL[op],
}));

export function ruleText(c: StepCondition | undefined, labels?: Record<string, string>): string {
  if (!c) return 'always';
  if (c.mode === 'ai') return c.question?.trim() ? `the agent decides: "${trunc(c.question, 70)}"` : 'the agent decides';
  const f = humanField(c.field, labels);
  const v = (c.value ?? '').trim();
  switch (c.op || 'eq') {
    case 'empty': return `${f} is empty`;
    case 'not_empty': return `${f} is filled in`;
    case 'days_until_lte': return `${f} is within ${v || '?'} days`;
    case 'days_since_gte': return `${f} was ${v || '?'}+ days ago`;
    default: return `${f} ${OP_LABEL[c.op || 'eq']} ${v ? `"${v}"` : '…'}`;
  }
}

export const trunc = (t: string | undefined, n: number) => {
  const s = (t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export function stepSummary(s: AgentStep, labels?: Record<string, string>): string {
  const instr = s.instructions?.trim() ? `"${trunc(s.instructions, 64)}"` : '';
  switch (s.kind) {
    case 'ai_message': return [CHANNEL_LABEL[s.channel || 'email'], s.review === false ? 'not reviewed' : 'reviewed', instr].filter(Boolean).join(' · ');
    case 'ai_video': return instr || 'Made for them; the next message links to it';
    case 'send_voucher': return s.voucherOfferId ? 'One voucher offer · code made by the system' : 'The best active voucher for them · code made by the system';
    case 'take_over': return 'Other agents in this department stop working on them';
    case 'send_library': return [s.messageId ? 'One chosen message' : s.stage === 'ongoing' ? 'Keep in touch: the next thing they have not had' : `Best unsent "${STAGE_WORD[s.stage || 'learn']}" message for them`, s.channel ? CHANNEL_LABEL[s.channel] : '', s.personalLine ? '+ AI personal line' : 'no AI'].filter(Boolean).join(' · ');
    case 'ai_task': return [`Saves to ${humanField(s.saveAs || 'task_result')}`, instr].filter(Boolean).join(' · ');
    case 'ai_lesson': return `${s.questionCount ?? 10}-question test · pass mark ${s.passMark ?? 70}%${instr ? ` · ${instr}` : ''}`;
    case 'ai_call': return instr || 'Short, kind call; says it is recorded';
    case 'condition': return `If ${ruleText(s.condition, labels)}`;
    case 'wait': return `Wait ${fmtHours(s.hours)}`;
    case 'repeat': return `Every ${fmtHours(s.hours)} · up to ${s.maxTimes ?? 3} times${s.condition ? ` · until ${ruleText(s.condition, labels)}` : ''}${s.stopOnReply === false ? ' · pauses while they talk' : ''}`;
    case 'update_record': return `Set ${humanField(s.setField, labels)} to "${trunc(s.setValue, 30)}"`;
    case 'notify_team': return [`Brief ${s.notifyEmail || 'the manager'}`, instr].filter(Boolean).join(' · ');
    case 'webhook': { try { return s.url ? `POST to ${new URL(s.url).host}` : 'No address yet'; } catch { return 'Address not valid yet'; } }
    case 'stop': return 'End the run here';
  }
}

/* ── Triggers ─────────────────────────────────────────────────────────────── */

export const TRIGGER_CHOICES: { kind: AgentTriggerKind; label: string; hint: string }[] = [
  { kind: 'lead.created', label: 'A new lead arrives', hint: 'From ads or forms, through the leads webhook.' },
  { kind: 'record.added', label: 'A new row appears in a sheet', hint: 'A new student, invoice, lead or prospect row.' },
  { kind: 'record.changed', label: 'A value changes in a sheet', hint: 'A status, a mark, a payment, any column you pick.' },
  { kind: 'record.match', label: 'A scheduled check', hint: 'Every morning (or hour, or week): everyone who matches the rules.' },
  { kind: 'lms.event', label: 'Something happens in the LMS', hint: 'A failed quiz, a login gap, missed classes.' },
  { kind: 'reply.received', label: 'Someone replies', hint: 'An email reply from a lead, student or prospect.' },
  { kind: 'schedule', label: 'On a schedule (a report)', hint: 'Runs once each time, for the team, not per person.' },
  { kind: 'manual', label: 'Only when I press Run', hint: 'Nothing starts it by itself.' },
];

export const LMS_EVENTS: { ev: WorkflowTrigger; label: string }[] = [
  { ev: 'quiz.failed', label: 'fails a quiz or checkpoint' },
  { ev: 'login.gap', label: 'stops logging in' },
  { ev: 'attendance.missed', label: 'misses live classes' },
  { ev: 'assignment.missed', label: 'misses an assignment' },
  { ev: 'payment.overdue', label: 'has fees overdue (from the LMS)' },
];

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const hh = (h: number | undefined) => `${String(h ?? 8).padStart(2, '0')}:00`;

export function scheduleText(s: AgentTrigger['schedule'] | undefined): string {
  const sc = s || { every: 'day', hour: 8 };
  if (sc.every === 'hour') return 'Every hour';
  if (sc.every === 'week') return `Every ${WEEKDAYS[sc.weekday ?? 1]} at ${hh(sc.hour)}`;
  const h = sc.hour ?? 8;
  return `Every ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'} at ${hh(h)}`;
}

export function triggerSummary(t: AgentTrigger | undefined, sources: DataSource[], labels?: Record<string, string>): string {
  if (!t) return 'Only when someone presses Run';
  const src = sources.find((s) => s.id === t.sourceId);
  const srcName = src?.name || 'any sheet';
  const rules = t.match?.length ? ` where ${t.match.map((m) => ruleText(m, labels)).join(' and ')}` : '';
  switch (t.kind) {
    case 'lead.created': return `When a new lead arrives${src && src.kind !== 'leads' ? ` in ${srcName}` : ' from ads or forms'}${rules}`;
    case 'record.added': return `When a new row is added to ${srcName}${rules}`;
    case 'record.changed': return `When ${t.field ? humanField(t.field, labels) : 'anything'} changes in ${srcName}${rules}`;
    case 'record.match': return `${scheduleText(t.schedule)} · everyone in ${srcName}${rules || ''}`;
    case 'lms.event': return `When a student ${LMS_EVENTS.find((e) => e.ev === t.lmsEvent)?.label || 'has an LMS event'}${rules}`;
    case 'reply.received': return `When someone${src ? ` in ${srcName}` : ''} replies by email`;
    case 'schedule': return `${scheduleText(t.schedule)}${src ? ` · report on ${srcName}` : ''}`;
    default: return 'Only when someone presses Run';
  }
}

/** Fields worth suggesting for a source (its columns, mapped fields and the ones agents work out). */
export function fieldSuggestions(sources: DataSource[], sourceId?: string): string[] {
  const live = ['name', 'first_name', 'email', 'phone', 'status', 'programme', 'cohort', 'interest', 'source', 'company', 'owner',
    'amount_due', 'amount_paid', 'total_fee', 'due_date', 'payment_status', 'payment_state', 'days_until_due', 'days_overdue',
    'replied', 'last_contacted', 'lead_score', 'quiz_passed', 'quiz_score', 'days_since_login'];
  const fromSources = sources
    .filter((s) => !sourceId || s.id === sourceId)
    .flatMap((s) => [...Object.keys(s.mapping || {}), ...((s.columns || []).map((c) => c.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')))]);
  return [...new Set([...fromSources, ...live])].filter(Boolean);
}

export const VALUE_HINTS: Record<string, string[]> = {
  payment_state: ['paid', 'due', 'overdue', 'arrangement', 'unknown'],
  replied: ['yes'],
  quiz_passed: ['yes', 'no'],
  status: ['new', 'contacted', 'applied', 'enrolled', 'ready', 'completed'],
};

/* ── Runs ─────────────────────────────────────────────────────────────────── */

export const RUN_STATUS: Record<AgentRun['status'], { label: string; tone: string }> = {
  running: { label: 'Working', tone: 'run' },
  waiting: { label: 'Waiting', tone: 'wait' },
  awaiting_approval: { label: 'Needs approval', tone: 'appr' },
  completed: { label: 'Done', tone: 'ok' },
  stopped: { label: 'Stopped', tone: 'mute' },
  failed: { label: 'Failed', tone: 'bad' },
};

export const isActive = (r: { status: AgentRun['status'] }) => ['running', 'waiting', 'awaiting_approval'].includes(r.status);

export function ago(ts: number | null | undefined): string {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function when(ts: number | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/* ── Tree edits (immutable) ───────────────────────────────────────────────── */

export type Lane = 'root' | 'yes' | 'no' | 'steps';
export interface InsertAt { parentId: string | null; lane: Lane; index: number }

const kids = (s: AgentStep, lane: Lane): AgentStep[] | undefined => (lane === 'yes' ? s.yes : lane === 'no' ? s.no : lane === 'steps' ? s.steps : undefined);

function mapTree(list: AgentStep[], fn: (s: AgentStep) => AgentStep): AgentStep[] {
  return list.map((s) => {
    const n = fn(s);
    return {
      ...n,
      ...(n.yes ? { yes: mapTree(n.yes, fn) } : {}),
      ...(n.no ? { no: mapTree(n.no, fn) } : {}),
      ...(n.steps ? { steps: mapTree(n.steps, fn) } : {}),
    };
  });
}

export function findStep(list: AgentStep[], id: string): AgentStep | null {
  for (const s of list) {
    if (s.id === id) return s;
    for (const sub of [s.yes, s.no, s.steps]) {
      if (sub) { const f = findStep(sub, id); if (f) return f; }
    }
  }
  return null;
}

export function updateStep(list: AgentStep[], id: string, patch: Partial<AgentStep>): AgentStep[] {
  return mapTree(list, (s) => (s.id === id ? { ...s, ...patch } : s));
}

/** Apply fn to the list that contains id (and its index). */
function withParentList(list: AgentStep[], id: string, fn: (l: AgentStep[], i: number) => AgentStep[]): AgentStep[] {
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) return fn(list, i);
  return list.map((s) => ({
    ...s,
    ...(s.yes ? { yes: withParentList(s.yes, id, fn) } : {}),
    ...(s.no ? { no: withParentList(s.no, id, fn) } : {}),
    ...(s.steps ? { steps: withParentList(s.steps, id, fn) } : {}),
  }));
}

export const removeStep = (list: AgentStep[], id: string) => withParentList(list, id, (l, i) => [...l.slice(0, i), ...l.slice(i + 1)]);

export const moveStep = (list: AgentStep[], id: string, dir: -1 | 1) => withParentList(list, id, (l, i) => {
  const j = i + dir;
  if (j < 0 || j >= l.length) return l;
  const out = [...l];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
});

export function cloneWithNewIds(s: AgentStep): AgentStep {
  return {
    ...s,
    id: newId(),
    ...(s.yes ? { yes: s.yes.map(cloneWithNewIds) } : {}),
    ...(s.no ? { no: s.no.map(cloneWithNewIds) } : {}),
    ...(s.steps ? { steps: s.steps.map(cloneWithNewIds) } : {}),
  };
}

export const duplicateStep = (list: AgentStep[], id: string) => withParentList(list, id, (l, i) => [...l.slice(0, i + 1), cloneWithNewIds(l[i]), ...l.slice(i + 1)]);

export function insertStep(list: AgentStep[], at: InsertAt, step: AgentStep): AgentStep[] {
  if (!at.parentId || at.lane === 'root') {
    const out = [...list];
    out.splice(Math.min(at.index, out.length), 0, step);
    return out;
  }
  return mapTree(list, (s) => {
    if (s.id !== at.parentId) return s;
    const cur = [...(kids(s, at.lane) || [])];
    cur.splice(Math.min(at.index, cur.length), 0, step);
    return { ...s, [at.lane]: cur };
  });
}

export function countSteps(list: AgentStep[] | undefined): number {
  return (list || []).reduce((n, s) => n + 1 + countSteps(s.yes) + countSteps(s.no) + countSteps(s.steps), 0);
}

/** Position of a step among its siblings (for disabling move up/down). */
export function siblingInfo(list: AgentStep[], id: string): { index: number; length: number } | null {
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) return { index: i, length: list.length };
  for (const s of list) {
    for (const sub of [s.yes, s.no, s.steps]) {
      if (sub) { const r = siblingInfo(sub, id); if (r) return r; }
    }
  }
  return null;
}

export const AGENT_COLORS = ['#7c3aed', '#2563eb', '#0891b2', '#059669', '#d97706', '#db2777', '#4f46e5', '#0d9488', '#ea580c'];
