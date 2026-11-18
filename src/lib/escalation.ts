import type { AgentRun } from '@/lib/types';

/* Who hears about what.
 *
 * Every "tell the team" step is one of a few kinds of escalation, and each kind
 * can go to its own person (or several, comma-separated): a hot lead to the
 * admissions consultant, a student in trouble to Student Success, a tutor
 * booking to the learning team, an overdue account to finance, the Monday
 * reports to management. Anything not routed goes to the manager email. A step
 * can still name its own address in the builder; that wins. */

export const ESCALATION_TYPES = ['admissions', 'support', 'academic', 'placement', 'finance', 'reports'] as const;
export type EscalationType = (typeof ESCALATION_TYPES)[number];

export const ESCALATION_LABEL: Record<EscalationType, { title: string; who: string }> = {
  admissions: { title: 'Leads to call or close', who: 'Hot leads, leads ready to sign up, enquiries that need a person, stuck applications (Zinhle, Thabo, Ayanda)' },
  support: { title: 'Students who need a person', who: 'Students who stay quiet, overdue work that is not coming in, sensitive student emails (Bongani, Nomsa, Zodwa)' },
  academic: { title: 'Tutoring and academic', who: 'A tutor session for a student who has not passed their catch-up test (Lindiwe)' },
  placement: { title: 'Placement', who: 'Students who finished and are ready for placement (Mpho)' },
  finance: { title: 'Fees and accounts', who: 'Overdue accounts after follow-ups, payment arrangements (Refilwe)' },
  reports: { title: 'Weekly reports', who: 'Monday reports: at-risk students, academic report, collections (Karabo, Thandi, Musa)' },
};

/** What kind of escalation a run's "tell the team" step is. */
export function escalationType(run: Pick<AgentRun, 'record' | 'departmentId' | 'workflowId' | 'workflowName'>): EscalationType | null {
  if (run.record.key === '__report__') return 'reports';
  if (run.workflowId === 'wf_mpho' || /placement/i.test(run.workflowName || '')) return 'placement';
  switch (run.departmentId) {
    case 'dep_admissions': return 'admissions';
    case 'dep_success': return 'support';
    case 'dep_learning': return 'academic';
    case 'dep_finance': return 'finance';
    default: return null;
  }
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Clean a list of addresses ("a@x.co, b@x.co"); invalid ones are dropped. */
export function cleanAddresses(v: string | undefined | null): string {
  return (v || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => EMAIL.test(x)).slice(0, 5).join(', ');
}

/** Where this escalation goes: the step's own address, else its type's, else the manager. */
export function escalationTo(input: { stepEmail?: string; type: EscalationType | null; routes?: Partial<Record<EscalationType, string>>; manager?: string }): string {
  return cleanAddresses(input.stepEmail) || (input.type ? cleanAddresses(input.routes?.[input.type]) : '') || cleanAddresses(input.manager);
}
