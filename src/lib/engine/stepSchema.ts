import type { AgentStep, AgentTrigger, AgentTriggerKind, ConditionOp, MessageChannel, StepCondition, StepKind, WorkflowTrigger } from '@/lib/types';

/* Validates workflows coming from the builder before they are saved: known
 * step kinds only, numbers clamped to sane ranges, ids kept (or made), and a
 * cap on depth and size so a bad payload cannot wedge the runtime. */

const KINDS: StepKind[] = ['ai_message', 'send_library', 'ai_video', 'send_voucher', 'take_over', 'ai_lesson', 'ai_task', 'condition', 'wait', 'repeat', 'ai_call', 'update_record', 'notify_team', 'webhook', 'stop'];
const OPS: ConditionOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'empty', 'not_empty', 'days_until_lte', 'days_since_gte'];
const CHANNELS: MessageChannel[] = ['email', 'whatsapp', 'email_whatsapp'];
type Stage = NonNullable<AgentStep['stage']>;
const STAGES: Stage[] = ['welcome', 'learn', 'trust', 'offer', 'decide', 'reengage', 'ongoing'];
const TRIGGERS: AgentTriggerKind[] = ['record.added', 'record.changed', 'record.match', 'lead.created', 'lms.event', 'reply.received', 'schedule', 'manual'];
const LMS_EVENTS: WorkflowTrigger[] = ['quiz.failed', 'attendance.missed', 'assignment.missed', 'payment.overdue', 'invoice.unpaid', 'login.gap'];

const str = (x: unknown, max = 2000) => (typeof x === 'string' ? x.slice(0, max) : undefined);
const num = (x: unknown, lo: number, hi: number) => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : undefined;
};
const field = (x: unknown) => (typeof x === 'string' ? x.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) : undefined);
const newId = () => `st_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function sanitizeCondition(x: unknown): StepCondition | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const c = x as Record<string, unknown>;
  if (c.mode === 'ai') return { mode: 'ai', question: str(c.question, 400) || 'Should we carry on?' };
  const op = OPS.includes(c.op as ConditionOp) ? (c.op as ConditionOp) : 'eq';
  return { mode: 'rule', field: field(c.field) || 'status', op, value: c.value === undefined || c.value === null ? '' : String(c.value).slice(0, 200) };
}

export function sanitizeSteps(x: unknown, depth = 0, seen = new Set<string>(), budget = { left: 80 }): AgentStep[] {
  if (!Array.isArray(x) || depth > 4) return [];
  const out: AgentStep[] = [];
  for (const raw of x) {
    if (budget.left-- <= 0) break;
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (!KINDS.includes(o.kind as StepKind)) continue;
    let id = typeof o.id === 'string' && /^[\w-]{1,64}$/.test(o.id) ? o.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    const kind = o.kind as StepKind;
    const s: AgentStep = { id, kind, title: (str(o.title, 80) || '').trim() || kind.replace('_', ' ') };
    const instructions = str(o.instructions);
    if (instructions !== undefined) s.instructions = instructions;
    if (kind === 'ai_message') {
      s.channel = CHANNELS.includes(o.channel as MessageChannel) ? (o.channel as MessageChannel) : 'email';
      s.review = o.review !== false;
      const subject = str(o.subject, 160); if (subject) s.subject = subject;
    }
    if (kind === 'send_library') {
      const mid = str(o.messageId, 60)?.trim();
      if (mid && /^msg_[\w]+$/.test(mid)) s.messageId = mid;
      else s.stage = STAGES.includes(o.stage as Stage) ? (o.stage as Stage) : 'learn';
      if (CHANNELS.includes(o.channel as MessageChannel)) s.channel = o.channel as MessageChannel;
      if (o.personalLine === true) s.personalLine = true;
    }
    if (kind === 'send_voucher') {
      const vid = str(o.voucherOfferId, 60)?.trim();
      if (vid && /^vof_[\w]+$/.test(vid)) s.voucherOfferId = vid;
      if (CHANNELS.includes(o.channel as MessageChannel)) s.channel = o.channel as MessageChannel;
    }
    if (kind === 'ai_lesson') {
      s.questionCount = Math.round(num(o.questionCount, 3, 15) ?? 10);
      s.passMark = Math.round(num(o.passMark, 30, 100) ?? 70);
    }
    if (kind === 'ai_task') s.saveAs = field(o.saveAs) || 'task_result';
    if (kind === 'condition') {
      s.condition = sanitizeCondition(o.condition) || { mode: 'rule', field: 'status', op: 'not_empty', value: '' };
      s.yes = sanitizeSteps(o.yes, depth + 1, seen, budget);
      s.no = sanitizeSteps(o.no, depth + 1, seen, budget);
    }
    if (kind === 'wait') s.hours = num(o.hours, 0.05, 24 * 90) ?? 24;
    if (kind === 'repeat') {
      s.hours = num(o.hours, 0.05, 24 * 90) ?? 48;
      s.maxTimes = Math.round(num(o.maxTimes, 1, 20) ?? 3);
      const c = sanitizeCondition(o.condition); if (c) s.condition = c;
      s.steps = sanitizeSteps(o.steps, depth + 1, seen, budget);
      if (o.stopOnReply === false) s.stopOnReply = false;
    }
    if (kind === 'update_record') {
      s.setField = field(o.setField) || 'status';
      s.setValue = str(o.setValue, 300) ?? '';
    }
    if (kind === 'notify_team') { const e = str(o.notifyEmail, 200)?.trim(); if (e) s.notifyEmail = e; }
    if (kind === 'webhook') { const u = str(o.url, 500)?.trim(); if (u) s.url = u; }
    out.push(s);
  }
  return out;
}

export function sanitizeTrigger(x: unknown): AgentTrigger {
  const t = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const kind = TRIGGERS.includes(t.kind as AgentTriggerKind) ? (t.kind as AgentTriggerKind) : 'manual';
  const out: AgentTrigger = { kind };
  const sourceId = str(t.sourceId, 80); if (sourceId) out.sourceId = sourceId;
  const f = field(t.field); if (f) out.field = f;
  if (Array.isArray(t.match)) out.match = t.match.map(sanitizeCondition).filter((c): c is StepCondition => Boolean(c && c.mode === 'rule')).slice(0, 6);
  if (kind === 'lms.event') out.lmsEvent = LMS_EVENTS.includes(t.lmsEvent as WorkflowTrigger) ? (t.lmsEvent as WorkflowTrigger) : 'quiz.failed';
  if (kind === 'record.match' || kind === 'schedule') {
    const sc = (t.schedule && typeof t.schedule === 'object' ? t.schedule : {}) as Record<string, unknown>;
    const every = sc.every === 'hour' || sc.every === 'week' ? sc.every : 'day';
    out.schedule = { every, hour: Math.round(num(sc.hour, 0, 23) ?? 8), ...(every === 'week' ? { weekday: Math.round(num(sc.weekday, 0, 6) ?? 1) } : {}) };
  }
  const cd = num(t.cooldownHours, 0, 24 * 365); if (cd !== undefined) out.cooldownHours = cd;
  return out;
}

/** The legacy trigger field kept on a workflow (used by older reports and filters). */
export function legacyTrigger(t: AgentTrigger): WorkflowTrigger {
  if (t.kind === 'lms.event' && t.lmsEvent) return t.lmsEvent;
  if (t.kind === 'lead.created') return 'contact.created';
  if (t.kind === 'schedule' || t.kind === 'record.match') return 'schedule';
  if (t.kind === 'reply.received') return 'webhook.custom';
  return 'manual';
}
