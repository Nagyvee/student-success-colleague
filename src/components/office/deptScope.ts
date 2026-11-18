import type { Deliverable, FeedEntry, InboxMail, PendingOutreach, Task, WorldState } from '@/lib/types';
import type { DepartmentRow } from './buildingData';

/* Which department each thing in the office belongs to.
 *
 * The building view shows everything with a department filter; inside a
 * department, only its own activity, inbox, approvals and outputs. Things are
 * traced to a department, most certain first:
 *   - a department stamped on it (agents' mails and Admissions' nurture
 *     events carry one: an id, or a kind such as "admissions"),
 *   - the agent run it came from (runs know their department),
 *   - the tutoring task's workflow (which agent, so which floor),
 *   - an activity line written as "[Admissions · Naledi] …",
 *   - what it is (a catch-up quiz is Learning's, a check-in Student Success').
 * Anything still unknown belongs to the whole workspace: it shows under "All". */

export interface DeptIndex {
  ids: Set<string>;
  byKind: Map<string, string>;
  byName: Map<string, string>;
  byRun: Map<string, string>;
  byWorkflow: Map<string, string>;
  byTask: Map<string, string>;
  deliverableTask: Map<string, string>;
  deliverableKind: Map<string, Deliverable['kind']>;
}

export function buildDeptIndex(departments: DepartmentRow[], runDepartments: Record<string, string> | undefined, state: WorldState | null): DeptIndex {
  const ids = new Set(departments.map((d) => d.id));
  const byKind = new Map<string, string>();
  const byName = new Map<string, string>();
  const byWorkflow = new Map<string, string>();
  for (const d of departments) {
    if (d.kind && !byKind.has(d.kind)) byKind.set(d.kind, d.id);
    byName.set(d.name.toLowerCase(), d.id);
    for (const a of d.agents) if (a.workflow?.id) byWorkflow.set(a.workflow.id, d.id);
  }
  const byRun = new Map(Object.entries(runDepartments || {}));
  const byTask = new Map<string, string>();
  for (const t of state?.tasks || []) {
    const d = byRun.get(t.id) || (t.workflowId ? byWorkflow.get(t.workflowId) : undefined);
    if (d) byTask.set(t.id, d);
  }
  const deliverableTask = new Map<string, string>();
  const deliverableKind = new Map<string, Deliverable['kind']>();
  for (const d of state?.deliverables || []) { deliverableTask.set(d.id, d.taskId); deliverableKind.set(d.id, d.kind); }
  return { ids, byKind, byName, byRun, byWorkflow, byTask, deliverableTask, deliverableKind };
}

/** A stamped department (an id, or a kind) as a department id. */
function stamped(ix: DeptIndex, v: string | undefined): string | null {
  if (!v) return null;
  if (ix.ids.has(v)) return v;
  return ix.byKind.get(v) || null;
}

function ofTask(ix: DeptIndex, taskId: string | undefined | null): string | null {
  if (!taskId) return null;
  return ix.byRun.get(taskId) || ix.byTask.get(taskId) || null;
}

/** What a deliverable is says whose it is, when nothing else does. */
function ofKind(ix: DeptIndex, kind: Deliverable['kind'] | undefined): string | null {
  if (kind === 'remedial_quiz') return ix.byKind.get('learning') || null;
  if (kind === 'checkin_message' || kind === 'catchup_plan') return ix.byKind.get('student_success') || null;
  return null;
}

function ofDeliverable(ix: DeptIndex, id: string | null | undefined): string | null {
  if (!id) return null;
  return ofTask(ix, ix.deliverableTask.get(id)) || ofKind(ix, ix.deliverableKind.get(id));
}

export function deptOfFeed(ix: DeptIndex, f: FeedEntry): string | null {
  const s = stamped(ix, f.dept) || ofTask(ix, f.taskId) || ofDeliverable(ix, f.deliverableId);
  if (s) return s;
  // "[Admissions · Naledi] Finished for Thandi."
  const m = /^\[([^·\]]+?)\s*·/.exec(f.text);
  if (m) return ix.byName.get(m[1].trim().toLowerCase()) || null;
  // Lines written before departments were stamped: lead nurturing is Admissions'.
  if (/^Programme video|career-fit quiz|voucher|lead(s)?|nurtur|unsubscribe|marketing messages/i.test(f.text)) return ix.byKind.get('admissions') || null;
  return null;
}

export function deptOfMail(ix: DeptIndex, m: InboxMail): string | null {
  return stamped(ix, m.dept) || ofTask(ix, m.taskId) || ofDeliverable(ix, m.deliverableId)
    || (/^(sample_journey|cmp_|campaign)/.test(m.taskId) ? ix.byKind.get('admissions') || null : null)
    || (/^sample_/.test(m.taskId) ? ix.byKind.get('learning') || null : null);
}

export function deptOfPending(ix: DeptIndex, p: PendingOutreach): string | null {
  return (p.runId ? ix.byRun.get(p.runId) : null) || (p.workflowId ? ix.byWorkflow.get(p.workflowId) || null : null) || ofTask(ix, p.taskId) || ofDeliverable(ix, p.deliverableId);
}

export function deptOfDeliverable(ix: DeptIndex, d: Deliverable): string | null {
  return ofTask(ix, d.taskId) || ofKind(ix, d.kind);
}

export function deptOfTaskItem(ix: DeptIndex, t: Task): string | null {
  return ofTask(ix, t.id) || (t.workflowId ? ix.byWorkflow.get(t.workflowId) || null : null);
}

/** The office as one department sees it (null: everything). */
export function scopeState(state: WorldState, ix: DeptIndex, deptId: string | null): WorldState {
  if (!deptId) return state;
  return {
    ...state,
    tasks: state.tasks.filter((t) => deptOfTaskItem(ix, t) === deptId),
    deliverables: state.deliverables.filter((d) => deptOfDeliverable(ix, d) === deptId),
    feed: state.feed.filter((f) => deptOfFeed(ix, f) === deptId),
    inbox: state.inbox.filter((m) => deptOfMail(ix, m) === deptId),
    pendingOutreach: (state.pendingOutreach || []).filter((p) => deptOfPending(ix, p) === deptId),
  };
}

/** A small label for an item when everything is shown: which department it came from. */
export interface DeptTag { name: string; color: string }
export type TagOf = {
  feed: (f: FeedEntry) => DeptTag | null;
  mail: (m: InboxMail) => DeptTag | null;
  pending: (p: PendingOutreach) => DeptTag | null;
  deliverable: (d: Deliverable) => DeptTag | null;
};

export function tagger(ix: DeptIndex, departments: DepartmentRow[]): TagOf {
  const byId = new Map(departments.map((d) => [d.id, { name: d.name, color: d.color || '#64748b' }]));
  const t = (id: string | null) => (id ? byId.get(id) || null : null);
  return {
    feed: (f) => t(deptOfFeed(ix, f)),
    mail: (m) => t(deptOfMail(ix, m)),
    pending: (p) => t(deptOfPending(ix, p)),
    deliverable: (d) => t(deptOfDeliverable(ix, d)),
  };
}
