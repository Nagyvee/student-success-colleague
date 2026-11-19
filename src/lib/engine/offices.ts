import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentId,
  CustomAgentDef,
  Dept,
  FlowRunLog,
  OfficeDef,
  OutreachChannel,
  WorkflowDomain,
} from '@/lib/types';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import {
  loadTenantWorkspaceConfig,
  syncTenantWorkspaceConfig,
} from '@/lib/db/postgres';
import { confirmedAt, fileTime, localWins, markSynced } from '@/lib/db/syncState';

/* Multi-tenant Custom Offices, Agents & Flow Run Telemetry.
 *
 * Allows any workspace to define bespoke offices (e.g. Finance & Collections,
 * Late Payment Recovery, Admissions, Student Success, Partner Desk) and custom
 * AI agents operating inside them, backed by the 4 visual rooms on the floor. */

const DEFAULT_OFFICES: OfficeDef[] = [
  {
    id: 'of_success',
    name: 'Student Success Office',
    short: 'Success Desk',
    domain: 'academy',
    purpose: 'Detects disengaged learners, tracks logins/attendance, and launches empathetic check-ins.',
    slot: 'success',
    color: '#3b6fd8',
    enabled: true,
    createdAt: 1731600000000,
  },
  {
    id: 'of_learning',
    name: 'Learning & Assessment Office',
    short: 'Learning Lab',
    domain: 'academy',
    purpose: 'Diagnoses missed quiz questions, builds tailored lessons, and verifies mastery.',
    slot: 'learning',
    color: '#17a394',
    enabled: true,
    createdAt: 1731600000001,
  },
  {
    id: 'of_finance',
    name: 'Finance & Collections Office',
    short: 'Finance & Fees',
    domain: 'finance',
    purpose: 'Follows up automatically on unpaid tuition, overdue invoices, and payment arrangements.',
    slot: 'planning',
    color: '#ff7300',
    enabled: true,
    createdAt: 1731600000002,
  },
  {
    id: 'of_admissions',
    name: 'Admissions & Enrolment Desk',
    short: 'Admissions',
    domain: 'admissions',
    purpose: 'Qualifies new applicants via WhatsApp, ManyChat, Email, and AI voice check-ins.',
    slot: 'planning',
    color: '#7c3aed',
    enabled: true,
    createdAt: 1731600000003,
  },
  {
    id: 'of_review',
    name: 'Quality & Compliance Review',
    short: 'QA Audit',
    domain: 'support',
    purpose: 'Audits outgoing drafts against workspace policy before automated or approved send.',
    slot: 'review',
    color: '#0f172a',
    enabled: true,
    createdAt: 1731600000004,
  },
];

const DEFAULT_AGENTS: CustomAgentDef[] = [
  {
    id: 'ag_zanele',
    name: 'Zanele',
    title: 'Planning & Admissions Lead',
    officeId: 'of_admissions',
    slot: 'planner',
    persona: 'Warm, structured, fast responder for inbound applicants and scheduling.',
    channels: ['whatsapp', 'email', 'manychat'],
    instructions: 'Greet promptly, clarify applicant goals, and route ready prospects.',
    enabled: true,
    createdAt: 1731600000000,
  },
  {
    id: 'ag_bongani',
    name: 'Bongani',
    title: 'Student Success Coach',
    officeId: 'of_success',
    slot: 'success',
    persona: 'Empathetic coach who helps learners overcome attendance and engagement blockers.',
    channels: ['email', 'whatsapp'],
    instructions: 'Check in respectfully without shaming, uncover blockers, and propose one clear next step.',
    enabled: true,
    createdAt: 1731600000001,
  },
  {
    id: 'ag_lindiwe',
    name: 'Lindiwe',
    title: 'Academic & Quiz Specialist',
    officeId: 'of_learning',
    slot: 'learning',
    persona: 'Practical instructor who pinpoints missed quiz topics and crafts micro-lessons.',
    channels: ['email', 'whatsapp'],
    instructions: 'Focus exclusively on exact weak concepts from failed quiz questions.',
    enabled: true,
    createdAt: 1731600000002,
  },
  {
    id: 'ag_kagiso',
    name: 'Kagiso',
    title: 'Finance & Collections Specialist',
    officeId: 'of_finance',
    slot: 'planner',
    persona: 'Confidential, respectful accounts specialist who resolves overdue balances smoothly.',
    channels: ['email', 'whatsapp', 'manychat'],
    instructions: 'Follow up clearly on overdue invoices/tuition, offer flexible arrangement options, never threaten or shame.',
    enabled: true,
    createdAt: 1731600000003,
  },
  {
    id: 'ag_musa',
    name: 'Musa',
    title: 'Chief Operations Auditor',
    officeId: 'of_review',
    slot: 'coo',
    persona: 'Rigorous reviewer checking factual accuracy, tone, links, and compliance rules.',
    channels: ['email'],
    instructions: 'Reject vague drafts, ensure personalization variables resolved cleanly, and verify policy compliance.',
    enabled: true,
    createdAt: 1731600000004,
  },
];

interface WorkspaceStore {
  offices: OfficeDef[];
  customAgents: CustomAgentDef[];
  flowRuns: FlowRunLog[];
  /** 2 = departments as floors, agents with step workflows. */
  modelVersion?: number;
}

const g = globalThis as unknown as { __thusoOfficesByTenant?: Map<string, WorkspaceStore> };

function storeMap(): Map<string, WorkspaceStore> {
  if (!g.__thusoOfficesByTenant) g.__thusoOfficesByTenant = new Map();
  return g.__thusoOfficesByTenant;
}

function fileFor(tenantId = currentTenantId()): string {
  return tenantId === DEFAULT_TENANT_ID
    ? path.join(process.cwd(), '.data', 'offices.json')
    : path.join(process.cwd(), '.data', 'tenants', tenantId, 'offices.json');
}

function loadStore(tenantId = currentTenantId()): WorkspaceStore {
  const m = storeMap();
  if (!m.has(tenantId)) {
    let parsed: Partial<WorkspaceStore> | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(fileFor(tenantId), 'utf8')) as Partial<WorkspaceStore>;
    } catch { /* seed defaults below */ }
    const offices = Array.isArray(parsed?.offices) && parsed.offices.length
      ? parsed.offices
      : DEFAULT_OFFICES.map((o) => ({ ...o }));
    const customAgents = Array.isArray(parsed?.customAgents) && parsed.customAgents.length
      ? parsed.customAgents
      : DEFAULT_AGENTS.map((a) => ({ ...a, channels: [...a.channels] }));
    const flowRuns = Array.isArray(parsed?.flowRuns) ? parsed.flowRuns.slice(0, 50) : [];
    m.set(tenantId, { offices, customAgents, flowRuns, modelVersion: parsed?.modelVersion || 1 });
  }
  return m.get(tenantId)!;
}

function persistStore(tenantId = currentTenantId()) {
  const st = loadStore(tenantId);
  const f = fileFor(tenantId);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(st, null, 2), 'utf8');
  } catch { /* ignore read-only fs */ }
  void syncTenantWorkspaceConfig(
    { offices: st.offices, customAgents: st.customAgents, flowRuns: st.flowRuns.slice(0, 30), modelVersion: st.modelVersion },
    tenantId,
  ).then((ok) => { if (ok) markSynced('offices', tenantId); });
}

export async function hydrateOfficesFromDb(tenantId = currentTenantId()): Promise<void> {
  const cfg = await loadTenantWorkspaceConfig(tenantId);
  const st = loadStore(tenantId);
  // Departments and agents changed here while the database was unreachable: send them up instead of loading the older copy.
  if (cfg && localWins(fileTime(fileFor(tenantId)), confirmedAt('offices', tenantId), null)) {
    persistStore(tenantId);
    return;
  }
  if (cfg) {
    let changed = false;
    if (Array.isArray(cfg.offices) && cfg.offices.length) {
      st.offices = cfg.offices;
      changed = true;
    }
    if (Array.isArray(cfg.customAgents) && cfg.customAgents.length) {
      st.customAgents = cfg.customAgents;
      changed = true;
    }
    if (Array.isArray(cfg.flowRuns)) {
      st.flowRuns = cfg.flowRuns;
      changed = true;
    }
    if (typeof cfg.modelVersion === 'number') st.modelVersion = Math.max(st.modelVersion || 1, cfg.modelVersion);
    else if (changed) st.modelVersion = 1;
    if (!changed) {
      void syncTenantWorkspaceConfig(
        { offices: st.offices, customAgents: st.customAgents, flowRuns: st.flowRuns.slice(0, 30), modelVersion: st.modelVersion },
        tenantId,
      ).then((ok) => { if (ok) markSynced('offices', tenantId); });
    } else {
      persistStore(tenantId);
    }
  }
}

export function listOffices(): OfficeDef[] {
  return loadStore().offices;
}

export function saveOffice(input: {
  id?: string;
  name: string;
  short?: string;
  domain?: WorkflowDomain;
  purpose?: string;
  slot?: Dept;
  color?: string;
  enabled?: boolean;
  kind?: OfficeDef['kind'];
  floor?: number;
  icon?: string;
  responsibilities?: string[];
}): OfficeDef {
  const st = loadStore();
  const name = input.name.trim() || 'Custom Office';
  const idx = input.id ? st.offices.findIndex((o) => o.id === input.id) : -1;
  const office: OfficeDef = idx >= 0
    ? {
        ...st.offices[idx],
        name,
        short: (input.short || name).trim().slice(0, 22),
        domain: input.domain || st.offices[idx].domain,
        purpose: input.purpose !== undefined ? input.purpose.trim() : st.offices[idx].purpose,
        slot: input.slot || st.offices[idx].slot,
        color: input.color || st.offices[idx].color,
        enabled: input.enabled !== undefined ? input.enabled : st.offices[idx].enabled,
        kind: input.kind || st.offices[idx].kind,
        floor: input.floor ?? st.offices[idx].floor,
        icon: input.icon || st.offices[idx].icon,
        responsibilities: input.responsibilities ?? st.offices[idx].responsibilities,
      }
    : {
        id: `of_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
        name,
        short: (input.short || name).trim().slice(0, 22),
        domain: input.domain || 'custom',
        purpose: (input.purpose || `Runs automated workflows for ${name}.`).trim(),
        slot: input.slot || 'planning',
        color: input.color || '#3b6fd8',
        enabled: input.enabled !== false,
        createdAt: Date.now(),
        kind: input.kind || 'custom',
        floor: input.floor ?? (Math.max(0, ...st.offices.map((o) => o.floor || 0)) + 1),
        icon: input.icon || 'building',
        responsibilities: input.responsibilities || [],
      };
  if (idx >= 0) st.offices[idx] = office;
  else st.offices.push(office);
  persistStore();
  return office;
}

export function deleteOffice(id: string): boolean {
  const st = loadStore();
  const before = st.offices.length;
  st.offices = st.offices.filter((o) => o.id !== id);
  if (st.offices.length === before) return false;
  persistStore();
  return true;
}

export function listCustomAgents(): CustomAgentDef[] {
  return loadStore().customAgents;
}

export function saveCustomAgent(input: {
  id?: string;
  name: string;
  title?: string;
  officeId?: string;
  slot?: AgentId;
  persona?: string;
  channels?: OutreachChannel[];
  instructions?: string;
  enabled?: boolean;
  workflowId?: string;
  responsibilities?: string[];
  color?: string;
}): CustomAgentDef {
  const st = loadStore();
  const name = input.name.trim() || 'Agent';
  const officeId = input.officeId || st.offices[0]?.id || 'of_success';
  const office = st.offices.find((o) => o.id === officeId);
  const slotMap: Record<Dept, AgentId> = {
    planning: 'planner',
    success: 'success',
    learning: 'learning',
    review: 'coo',
  };
  const slot = input.slot || (office ? slotMap[office.slot] : 'planner');
  const idx = input.id ? st.customAgents.findIndex((a) => a.id === input.id) : -1;
  const agent: CustomAgentDef = idx >= 0
    ? {
        ...st.customAgents[idx],
        name,
        title: input.title !== undefined ? input.title.trim() : st.customAgents[idx].title,
        officeId,
        slot,
        persona: input.persona !== undefined ? input.persona.trim() : st.customAgents[idx].persona,
        channels: input.channels?.length ? input.channels : st.customAgents[idx].channels,
        instructions: input.instructions !== undefined ? input.instructions.trim() : st.customAgents[idx].instructions,
        enabled: input.enabled !== undefined ? input.enabled : st.customAgents[idx].enabled,
        workflowId: input.workflowId ?? st.customAgents[idx].workflowId,
        responsibilities: input.responsibilities ?? st.customAgents[idx].responsibilities,
        color: input.color || st.customAgents[idx].color,
      }
    : {
        // A fixed id only for agents the system seeds (ag_<name>); people get a random one.
        id: input.id && /^ag_[a-z]{3,20}$/.test(input.id) && !st.customAgents.some((a) => a.id === input.id) ? input.id : `ag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
        name,
        title: (input.title || `${office?.short || 'Automation'} Specialist`).trim(),
        officeId,
        slot,
        persona: (input.persona || `Helpful, professional specialist in ${office?.name || 'operations'}.`).trim(),
        channels: input.channels?.length ? input.channels : ['email', 'whatsapp'],
        instructions: (input.instructions || '').trim(),
        enabled: input.enabled !== false,
        createdAt: Date.now(),
        workflowId: input.workflowId,
        responsibilities: input.responsibilities || [],
        color: input.color || office?.color,
      };
  if (idx >= 0) st.customAgents[idx] = agent;
  else st.customAgents.push(agent);
  persistStore();
  return agent;
}

export function deleteCustomAgent(id: string): boolean {
  const st = loadStore();
  const before = st.customAgents.length;
  st.customAgents = st.customAgents.filter((a) => a.id !== id);
  if (st.customAgents.length === before) return false;
  persistStore();
  return true;
}

export function listFlowRuns(): FlowRunLog[] {
  return loadStore().flowRuns;
}

export function saveFlowRun(run: FlowRunLog): void {
  const st = loadStore();
  const idx = st.flowRuns.findIndex((r) => r.id === run.id);
  if (idx >= 0) st.flowRuns[idx] = run;
  else st.flowRuns.unshift(run);
  st.flowRuns = st.flowRuns.slice(0, 40);
  persistStore();
}


/* ── Model version (departments as floors) ────────────────────────────────── */

export function getModelVersion(tenantId = currentTenantId()): number {
  return loadStore(tenantId).modelVersion || 1;
}

/** Replace departments and agents wholesale (used by the department migration). */
export function replaceDepartments(offices: OfficeDef[], agents: CustomAgentDef[], version: number, tenantId = currentTenantId()) {
  const st = loadStore(tenantId);
  st.offices = offices;
  st.customAgents = agents;
  st.modelVersion = version;
  persistStore(tenantId);
}

/** Link an agent to its workflow. */
export function setAgentWorkflow(agentId: string, workflowId: string) {
  const st = loadStore();
  const a = st.customAgents.find((x) => x.id === agentId);
  if (!a) return;
  a.workflowId = workflowId;
  persistStore();
}
