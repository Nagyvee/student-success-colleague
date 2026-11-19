import fs from 'node:fs';
import path from 'node:path';
import type {
  FlowEdge,
  FlowNode,
  FollowUpCadence,
  WorkflowDef,
  WorkflowDomain,
  WorkflowTrigger,
} from '@/lib/types';
import { loadWorkflowsFromDb, syncWorkflowsToDb } from '@/lib/db/postgres';
import { confirmedAt, fileTime, localWins, markSynced } from '@/lib/db/syncState';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import { workflowToDefaultGraph } from './flowGraph';

/* Offices of workflows (scoped per workspace/tenant). */

function fileFor(tenantId = currentTenantId()): string {
  return tenantId === DEFAULT_TENANT_ID
    ? path.join(process.cwd(), '.data', 'workflows.json')
    : path.join(process.cwd(), '.data', 'tenants', tenantId, 'workflows.json');
}

const DEFAULT_WORKFLOWS: WorkflowDef[] = [
  {
    id: 'wf_quiz_recovery',
    name: 'Quiz Recovery Coach',
    officeName: 'Assessment Recovery Office',
    description: 'Watches Moodle quiz results. Inspects the exact questions a learner got wrong, builds a personal video lesson + 10-question test, audits it, emails it, and follows up until passed.',
    enabled: true,
    trigger: 'quiz.failed',
    threshold: 60,
    goalTemplate: 'Moodle alert ({{office}}): {{name}} scored {{score}}% on {{module}}. Inspect missed questions, build targeted catch-up resources, and get {{first}} back on track.',
    instructions: 'Focus the tutoring summary, narrated lesson, and catch-up questions directly on the specific quiz questions the learner missed.',
    followUpCadence: { enabled: true, intervalHours: 48, repeatForever: true, maxAttempts: null },
    runs: 0,
    lastRunAt: null,
    createdAt: 1731600000000,
  },
  {
    id: 'wf_attendance',
    name: 'Attendance Watchdog',
    officeName: 'Live Class Attendance Office',
    description: 'Tracks live class attendance from the Melsoft attendance sheet. Reaches out warmly after missed classes with a short session recap and one easy next step.',
    enabled: true,
    trigger: 'attendance.missed',
    threshold: 2,
    goalTemplate: 'Attendance alert ({{office}}): {{name}} missed {{detail}}. Check whether a topic blocker or schedule conflict got in the way and send a supportive check-in.',
    instructions: 'Warmly share that the class missed them, ask what got in the way (load shedding, connectivity, work, or a concept blocker), and offer the class recap link.',
    followUpCadence: { enabled: true, intervalHours: 48, repeatForever: true, maxAttempts: null },
    runs: 0,
    lastRunAt: null,
    createdAt: 1731600000001,
  },
  {
    id: 'wf_quiet_rescue',
    name: 'Silent Disengagement Rescue',
    officeName: 'Student Retention Office',
    description: 'Catches learners who are passing assessments but stopped logging into Moodle/LMS. Sends a human check-in instead of another quiz and keeps checking in.',
    enabled: true,
    trigger: 'login.gap',
    threshold: 5,
    goalTemplate: 'Engagement alert ({{office}}): {{name}} has not logged in for {{days}} days. Diagnose whether they went quiet due to life/momentum and send a personal check-in.',
    instructions: 'Never send a quiz when marks are already passing. Write a short, pressure-free personal check-in from Bongani and follow up persistently.',
    followUpCadence: { enabled: true, intervalHours: 72, repeatForever: true, maxAttempts: null },
    runs: 0,
    lastRunAt: null,
    createdAt: 1731600000002,
  },
  {
    id: 'wf_payments_assignments',
    name: 'Submissions & Tuition Support',
    officeName: 'Learner Care & Accounts Office',
    description: 'Watches overdue Moodle assignments and Google Sheet tuition alerts. Sends a respectful, private support message offering a catch-up or payment arrangement—never shaming.',
    enabled: true,
    trigger: 'payment.overdue',
    threshold: 1,
    goalTemplate: 'Support alert ({{office}}): {{name}} was flagged for {{detail}}. Reach out privately and respectfully to offer support or a flexible arrangement.',
    instructions: 'Be strictly confidential, kind, and non-judgmental. Never label the learner or threaten suspension; invite them to reply to arrange support.',
    followUpCadence: { enabled: true, intervalHours: 72, repeatForever: true, maxAttempts: null },
    domain: 'academy',
    officeId: 'of_success',
    runs: 0,
    lastRunAt: null,
    createdAt: 1731600000003,
  },
  {
    id: 'wf_late_payment_recovery',
    name: 'Late Payment & Unpaid Tuition Recovery',
    officeName: 'Finance & Collections Office',
    officeId: 'of_finance',
    agentId: 'ag_kagiso',
    domain: 'finance',
    description: 'Follows up automatically on unpaid fees and overdue invoices across Email, WhatsApp, and AI Call escalation with flexible payment arrangements.',
    enabled: true,
    trigger: 'invoice.unpaid',
    threshold: 3,
    channel: 'all',
    goalTemplate: 'Finance alert ({{office}}): {{name}} has an unpaid balance ({{detail}}). Send a respectful reminder with arrangement options and follow up every 48h until settled.',
    instructions: 'Remain warm, private, and helpful. Include overdue reference/amount, never threaten suspension, and offer a payment plan option.',
    followUpCadence: { enabled: true, intervalHours: 48, repeatForever: true, maxAttempts: null },
    runs: 0,
    lastRunAt: null,
    createdAt: 1731600000004,
  },
];

function withGraph(w: WorkflowDef): WorkflowDef {
  // Agent workflows are step lists, not node graphs.
  if (w.version === 2) return w;
  if (Array.isArray(w.nodes) && w.nodes.length > 0) return w;
  const g = workflowToDefaultGraph(w);
  return { ...w, nodes: g.nodes, edges: g.edges };
}

type Store = { list: WorkflowDef[]; loaded: boolean };
const g = globalThis as unknown as { __thusoWorkflowsByTenant?: Map<string, Store> };

function storeMap(): Map<string, Store> {
  if (!g.__thusoWorkflowsByTenant) g.__thusoWorkflowsByTenant = new Map();
  return g.__thusoWorkflowsByTenant;
}

function load(tenantId = currentTenantId()): Store {
  const m = storeMap();
  if (!m.has(tenantId)) {
    const file = fileFor(tenantId);
    let list: WorkflowDef[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowDef[];
      if (Array.isArray(raw) && raw.length) list = raw;
    } catch { /* seed defaults below */ }
    if (!list.length) list = DEFAULT_WORKFLOWS.map((w) => withGraph({ ...w, followUpCadence: { ...w.followUpCadence } }));
    else list = list.map((w) => withGraph(w));
    m.set(tenantId, { list, loaded: true });
  }
  return m.get(tenantId)!;
}

function save(tenantId = currentTenantId()) {
  const file = fileFor(tenantId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(load(tenantId).list, null, 2), 'utf8');
  } catch { /* read-only disk: keep in memory */ }
  void syncWorkflowsToDb(load(tenantId).list, tenantId).then((ok) => { if (ok) markSynced('workflows', tenantId); });
}

export async function hydrateWorkflowsFromDb(tenantId = currentTenantId()) {
  const rows = await loadWorkflowsFromDb(tenantId);
  // Jobs changed here while the database was unreachable win over its older copy.
  if (rows && rows.length && !localWins(fileTime(fileFor(tenantId)), confirmedAt('workflows', tenantId), null)) {
    load(tenantId).list = rows.map((w) => withGraph(w));
    save(tenantId);
  } else if (rows) {
    void syncWorkflowsToDb(load(tenantId).list, tenantId).then((ok) => { if (ok) markSynced('workflows', tenantId); });
  }
}

export function listWorkflows(): WorkflowDef[] {
  return load().list.map((w) => withGraph(w));
}

export function getWorkflow(id: string): WorkflowDef | null {
  const found = load().list.find((w) => w.id === id);
  return found ? withGraph(found) : null;
}

/** Legacy (single-step) workflows for an LMS trigger. Agent workflows are started by agentTriggers instead. */
export function workflowsForTrigger(trigger: WorkflowTrigger): WorkflowDef[] {
  const legacy = load().list.filter((w) => w.version !== 2);
  const all = legacy.filter((w) => w.enabled && w.trigger === trigger).map((w) => withGraph(w));
  if (all.length) return all;
  if (trigger === 'assignment.missed' || trigger === 'invoice.unpaid' || trigger === 'payment.overdue') {
    const finance = legacy.filter((w) => w.enabled && (w.domain === 'finance' || w.trigger === 'payment.overdue' || w.trigger === 'invoice.unpaid'));
    if (finance.length) return finance.map((w) => withGraph(w));
  }
  return [];
}

export function createWorkflow(input: {
  name: string;
  officeName?: string;
  officeId?: string;
  agentId?: string;
  domain?: WorkflowDomain;
  description?: string;
  trigger: WorkflowTrigger;
  threshold?: number;
  channel?: WorkflowDef['channel'];
  goalTemplate?: string;
  instructions?: string;
  followUpCadence?: Partial<FollowUpCadence>;
  nodes?: FlowNode[];
  edges?: FlowEdge[];
  version?: 2;
  departmentId?: string;
  agentTrigger?: WorkflowDef['agentTrigger'];
  steps?: WorkflowDef['steps'];
}, fixedId?: string): WorkflowDef {
  const raw: WorkflowDef = {
    id: fixedId || `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: input.name.trim(),
    officeName: (input.officeName || `${input.name.trim()} Office`).trim(),
    officeId: input.officeId,
    agentId: input.agentId,
    domain: input.domain || 'custom',
    description: (input.description || 'Custom automated workflow.').trim(),
    enabled: true,
    trigger: input.trigger,
    threshold: typeof input.threshold === 'number' && Number.isFinite(input.threshold) ? input.threshold : undefined,
    channel: input.channel || 'email',
    goalTemplate: (input.goalTemplate || '{{office}}: Follow up with {{name}} regarding {{detail}}.').trim(),
    instructions: (input.instructions || '').trim(),
    followUpCadence: {
      enabled: input.followUpCadence?.enabled !== false,
      intervalHours: Math.max(1, Number(input.followUpCadence?.intervalHours || 48)),
      repeatForever: input.followUpCadence?.repeatForever !== false,
      maxAttempts: input.followUpCadence?.repeatForever === false
        ? Math.max(1, Number(input.followUpCadence?.maxAttempts || 3))
        : null,
    },
    nodes: input.nodes,
    edges: input.edges,
    runs: 0,
    lastRunAt: null,
    createdAt: Date.now(),
    ...(input.version === 2 ? { version: 2 as const, departmentId: input.departmentId, agentTrigger: input.agentTrigger, steps: input.steps || [] } : {}),
  };
  const wf = withGraph(raw);
  load().list.unshift(wf);
  save();
  return wf;
}

export function updateWorkflow(id: string, patch: Partial<Omit<WorkflowDef, 'id' | 'createdAt'>>): WorkflowDef | null {
  const s = load();
  const idx = s.list.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  const cur = s.list[idx];
  const next: WorkflowDef = {
    ...cur,
    ...patch,
    followUpCadence: patch.followUpCadence ? { ...cur.followUpCadence, ...patch.followUpCadence } : cur.followUpCadence,
  };
  s.list[idx] = next;
  save();
  return next;
}

export function deleteWorkflow(id: string): boolean {
  const s = load();
  const before = s.list.length;
  s.list = s.list.filter((w) => w.id !== id);
  if (s.list.length === before) return false;
  save();
  return true;
}

export function recordWorkflowRun(id: string) {
  const s = load();
  const wf = s.list.find((w) => w.id === id);
  if (!wf) return;
  wf.runs += 1;
  wf.lastRunAt = Date.now();
  save();
}

export function renderWorkflowGoal(
  wf: WorkflowDef,
  vars: { name: string; first?: string; module?: string; score?: number | string; days?: number | string; detail?: string },
): string {
  const first = vars.first || vars.name.split(' ')[0];
  return wf.goalTemplate
    .replace(/\{\{office\}\}/g, wf.officeName)
    .replace(/\{\{workflow\}\}/g, wf.name)
    .replace(/\{\{name\}\}/g, vars.name)
    .replace(/\{\{first\}\}/g, first)
    .replace(/\{\{module\}\}/g, vars.module || 'current module')
    .replace(/\{\{score\}\}/g, vars.score !== undefined ? String(vars.score) : '–')
    .replace(/\{\{days\}\}/g, vars.days !== undefined ? String(vars.days) : '–')
    .replace(/\{\{detail\}\}/g, vars.detail || 'needs attention');
}

