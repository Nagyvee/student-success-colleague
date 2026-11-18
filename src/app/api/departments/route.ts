import { NextResponse } from 'next/server';
import { liveAllowed, sendingPaused } from '@/lib/email/pause';
import type { AgentRun, CustomAgentDef, DataSourceKind, OutreachChannel, RecordField, WorkflowDef } from '@/lib/types';
import { MANAGER_ROLES, runWithSessionTenant } from '@/lib/auth/requestTenant';
import { getTenantIntegrations, tenantInboundToken, updateTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { bootReady } from '@/lib/engine/automation';
import { buildingModel, ensureDepartmentModel } from '@/lib/engine/departments';
import { deleteCustomAgent, deleteOffice, listCustomAgents, listOffices, saveCustomAgent, saveOffice } from '@/lib/engine/offices';
import { createWorkflow, deleteWorkflow, getWorkflow, updateWorkflow } from '@/lib/engine/workflows';
import { getAgentRun, listAgentRuns, resumeNow, startAgentRun, stopRun } from '@/lib/engine/agentRuns';
import { editRecord, previewMatches, scanMatches, toRunRecord } from '@/lib/engine/agentTriggers';
import { legacyTrigger, sanitizeSteps, sanitizeTrigger } from '@/lib/engine/stepSchema';
import { buildWorkflowFromWords } from '@/lib/ai/agentMind';
import { FIELD_LABEL, KIND_FIELDS, LEADS_SOURCE_ID, aiMap, autoMap, deleteSource, fetchSheet, getSource, listSources, liveFields, readSource, saveSource } from '@/lib/data/sources';
import { getRecord, listRecords } from '@/lib/data/records';
import { getState, log, setSettings } from '@/lib/engine/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* The building's API: departments (floors), their agents, each agent's
 * workflow of AI steps, the data sources they read, and their runs.
 *
 * GET                       everything the building and the builder show
 * GET ?run=<id>             one run in full
 * GET ?workflow=<id>        one agent's workflow, its runs and who it would pick up
 * GET ?records=<sourceId>   the records in a data source (&q= to search)
 * POST {action, ...}        see the handlers below */

const light = (r: AgentRun) => ({ ...r, steps: undefined, logs: r.logs.slice(-3) });

function overview(manager: boolean, role: string) {
  const runs = listAgentRuns({ limit: 150 });
  const floors = buildingModel().map(({ department, agents }) => ({
    ...department,
    agents: agents.map(({ agent, workflow }) => {
      const mine = runs.filter((r) => r.workflowId === workflow?.id);
      const latest = mine[0];
      return {
        ...agent,
        workflow,
        activeRuns: mine.filter((r) => ['running', 'waiting', 'awaiting_approval'].includes(r.status)).length,
        // Working right now (drafting, reviewing, sending) or in the last 45 seconds, not waiting for days.
        working: mine.some((r) => r.status === 'running' || (r.status !== 'failed' && r.updatedAt > Date.now() - 45_000)),
        // The latest run failed or hit a failed step in the last day: the floor shows red until a clean run.
        hasError: Boolean(latest && latest.updatedAt > Date.now() - 86_400_000 && (latest.status === 'failed' || latest.logs.some((l) => l.status === 'fail'))),
        lastRun: latest ? light(latest) : null,
      };
    }),
  }));
  const ti = getTenantIntegrations(currentTenantId());
  const s = getState().settings;
  return {
    role,
    canManage: manager,
    departments: floors,
    sources: listSources(),
    runs: runs.slice(0, 80).map(light),
    autopilot: Boolean(s.autoRunMode),
    requireApproval: s.requireApproval ?? ti.requireApproval !== false,
    liveOutreach: liveAllowed(ti.liveOutreachEnabled),
    sendingPaused: sendingPaused(),
    knowledge: { agentKnowledge: ti.agentKnowledge || '', applyUrl: ti.applyUrl || '' },
    leadsWebhook: { path: '/api/webhooks/leads', token: manager ? tenantInboundToken() : null },
    fieldLabels: FIELD_LABEL,
    kindFields: KIND_FIELDS,
  };
}

export async function GET(req: Request) {
  return runWithSessionTenant(req, async (session) => {
    await bootReady(currentTenantId());
    ensureDepartmentModel();
    const url = new URL(req.url);
    const manager = MANAGER_ROLES.includes(session.role);

    const runId = url.searchParams.get('run');
    if (runId) {
      const run = getAgentRun(runId);
      return run ? NextResponse.json({ run }) : NextResponse.json({ error: 'Run not found.' }, { status: 404 });
    }

    const wfId = url.searchParams.get('workflow');
    if (wfId) {
      const workflow = getWorkflow(wfId);
      if (!workflow) return NextResponse.json({ error: 'Workflow not found.' }, { status: 404 });
      const agent = listCustomAgents().find((a) => a.workflowId === wfId || a.id === workflow.agentId) || null;
      const department = listOffices().find((o) => o.id === (workflow.departmentId || agent?.officeId)) || null;
      const matchable = ['record.match', 'record.added', 'record.changed', 'lead.created'].includes(workflow.agentTrigger?.kind || '');
      const all = matchable ? previewMatches(workflow, 5000) : [];
      const matches = all.slice(0, 25);
      return NextResponse.json({
        workflow, agent, department,
        role: session.role,
        canManage: manager,
        matchCount: all.length,
        runs: listAgentRuns({ workflowId: wfId, limit: 60 }).map(light),
        matches: matches.map((r) => ({ key: r.key, sourceId: r.sourceId, name: r.name, email: r.email, phone: r.phone })),
        sources: listSources(),
        departments: listOffices(),
        fieldLabels: FIELD_LABEL,
        kindFields: KIND_FIELDS,
      });
    }

    const recordsOf = url.searchParams.get('records');
    if (recordsOf) {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const list = listRecords(recordsOf)
        .filter((r) => !q || `${r.name} ${r.email} ${r.phone}`.toLowerCase().includes(q))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 200)
        .map((r) => ({ key: r.key, sourceId: r.sourceId, name: r.name, email: r.email, phone: r.phone, fields: liveFields(r), updatedAt: r.updatedAt }));
      return NextResponse.json({ records: list, source: getSource(recordsOf) });
    }

    return NextResponse.json(overview(manager, session.role));
  });
}

const MANAGER_ACTIONS = new Set(['saveDepartment', 'deleteDepartment', 'saveAgent', 'deleteAgent', 'saveWorkflow', 'saveSource', 'deleteSource', 'setAutopilot', 'saveKnowledge']);

export async function POST(req: Request) {
  return runWithSessionTenant(req, async (session) => {
    await bootReady(currentTenantId());
    ensureDepartmentModel();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    if (MANAGER_ACTIONS.has(action) && !MANAGER_ROLES.includes(session.role)) {
      return NextResponse.json({ error: 'Only a workspace owner or admin can change departments, agents and data sources.' }, { status: 403 });
    }
    const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
    const strArr = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim().slice(0, 120)).slice(0, 10) : undefined);

    switch (action) {
      /* ── Departments ── */
      case 'saveDepartment': {
        const name = String(body.name || '').trim();
        if (!name) return bad('Give the department a name.');
        const d = saveOffice({
          id: body.id ? String(body.id) : undefined,
          name, short: String(body.short || name).slice(0, 22),
          purpose: body.purpose !== undefined ? String(body.purpose) : undefined,
          color: body.color ? String(body.color) : undefined,
          icon: body.icon ? String(body.icon) : undefined,
          floor: typeof body.floor === 'number' ? body.floor : undefined,
          responsibilities: strArr(body.responsibilities),
          domain: 'custom', slot: 'planning',
        });
        log('system', 'system', `Department "${d.name}" saved.`);
        return NextResponse.json({ ok: true, department: d });
      }
      case 'deleteDepartment': {
        const id = String(body.id || '');
        if (listCustomAgents().some((a) => a.officeId === id)) return bad('Move or delete this department\'s agents first.');
        return NextResponse.json({ ok: deleteOffice(id) });
      }

      /* ── Agents (each gets its own workflow) ── */
      case 'saveAgent': {
        const name = String(body.name || '').trim();
        const officeId = String(body.officeId || '');
        if (!name) return bad('Give the agent a name.');
        const dept = listOffices().find((o) => o.id === officeId);
        if (!dept) return bad('Pick the department this agent works in.');
        const existing = body.id ? listCustomAgents().find((a) => a.id === body.id) : null;
        const agent: CustomAgentDef = saveCustomAgent({
          id: existing?.id,
          name, officeId,
          title: body.title !== undefined ? String(body.title) : undefined,
          persona: body.persona !== undefined ? String(body.persona) : undefined,
          instructions: body.instructions !== undefined ? String(body.instructions) : undefined,
          responsibilities: strArr(body.responsibilities),
          color: body.color ? String(body.color) : undefined,
          channels: Array.isArray(body.channels) ? (body.channels as OutreachChannel[]) : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        });
        let wf = agent.workflowId ? getWorkflow(agent.workflowId) : null;
        if (!wf) {
          wf = createWorkflow({
            name: String(body.jobName || `${agent.name}'s job`), officeName: dept.name, officeId: dept.id, agentId: agent.id, domain: dept.domain,
            description: String(body.jobDescription || agent.title || ''), trigger: 'manual',
            version: 2, departmentId: dept.id, agentTrigger: { kind: 'manual' }, steps: [],
          });
          saveCustomAgent({ id: agent.id, name: agent.name, officeId: agent.officeId, workflowId: wf.id });
        } else if (wf.departmentId !== dept.id) {
          updateWorkflow(wf.id, { departmentId: dept.id, officeId: dept.id, officeName: dept.name });
        }
        return NextResponse.json({ ok: true, agent: { ...agent, workflowId: wf.id }, workflow: getWorkflow(wf.id) });
      }
      case 'deleteAgent': {
        const a = listCustomAgents().find((x) => x.id === body.id);
        if (!a) return bad('Agent not found.', 404);
        for (const r of listAgentRuns({ workflowId: a.workflowId, active: true })) stopRun(r.id);
        if (a.workflowId) deleteWorkflow(a.workflowId);
        return NextResponse.json({ ok: deleteCustomAgent(a.id) });
      }

      /* ── Workflows ── */
      case 'saveWorkflow': {
        const id = String(body.id || '');
        const cur = getWorkflow(id);
        if (!cur) return bad('Workflow not found.', 404);
        const patch: Partial<WorkflowDef> = { version: 2 };
        if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
        if (typeof body.description === 'string') patch.description = body.description.slice(0, 500);
        if (typeof body.instructions === 'string') patch.instructions = body.instructions.slice(0, 2000);
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (body.agentTrigger !== undefined) { patch.agentTrigger = sanitizeTrigger(body.agentTrigger); patch.trigger = legacyTrigger(patch.agentTrigger); }
        if (body.steps !== undefined) patch.steps = sanitizeSteps(body.steps);
        const wf = updateWorkflow(id, patch);
        log('system', 'system', `Workflow "${wf?.name}" saved (${wf?.steps?.length || 0} steps).`);
        return NextResponse.json({ ok: true, workflow: wf });
      }
      case 'buildFromWords': {
        const description = String(body.description || '').trim();
        if (description.length < 10) return bad('Describe the agent\'s job in a sentence or two.');
        const wf = body.workflowId ? getWorkflow(String(body.workflowId)) : null;
        const dept = listOffices().find((o) => o.id === (wf?.departmentId || body.departmentId)) || null;
        const built = await buildWorkflowFromWords({ description, department: dept ? { name: dept.name, kind: dept.kind } : null, sources: listSources() });
        if (!built) return bad('The AI model is not connected (set ANTHROPIC_API_KEY), so describe-to-build is unavailable. Add the steps by hand.', 503);
        return NextResponse.json({ ok: true, draft: { name: built.name, agentTrigger: sanitizeTrigger(built.trigger), steps: sanitizeSteps(built.steps) } });
      }

      /* ── Running ── */
      case 'runAgent': {
        const wf = getWorkflow(String(body.workflowId || ''));
        if (!wf || wf.version !== 2) return bad('Workflow not found.', 404);
        if (!wf.steps?.length) return bad('Add at least one step first.');
        if (body.allMatching) {
          const r = await scanMatches(wf, 'Run for everyone matching (manual)');
          return NextResponse.json({ ok: true, started: r.started, matched: r.matched, more: r.more });
        }
        const custom = body.custom as { name?: string; email?: string; phone?: string; fields?: Record<string, string> } | undefined;
        let record;
        if (custom && (custom.email || custom.phone || custom.name)) {
          const email = String(custom.email || '').trim().toLowerCase();
          record = { key: email || `test:${Date.now()}`, sourceId: null, name: String(custom.name || email || 'Test contact').trim(), email, phone: String(custom.phone || '').trim(), fields: Object.fromEntries(Object.entries(custom.fields || {}).map(([k, v]) => [k, String(v)])) };
        } else if (wf.agentTrigger?.kind === 'schedule') {
          record = { key: '__report__', sourceId: wf.agentTrigger.sourceId || null, name: 'Team report', email: '', phone: '' };
        } else {
          const rec = getRecord(body.sourceId ? String(body.sourceId) : null, String(body.recordKey || ''));
          if (!rec) return bad('Pick a record, or enter a test contact.');
          record = toRunRecord(rec);
        }
        const r = await startAgentRun({ workflow: wf, record, trigger: `Run pressed by ${session.name}`, force: true });
        if (!r.run) return bad(r.reason || 'Could not start.');
        return NextResponse.json({ ok: true, run: r.run });
      }
      case 'updateRecord': {
        // e.g. admissions marks a lead "applied"; agents waiting on that field react.
        const field = String(body.field || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
        if (!field) return bad('Which field?');
        const r = await editRecord(String(body.sourceId || ''), String(body.key || ''), field, String(body.value ?? '').slice(0, 500));
        if (!r.record) return bad('Record not found.', 404);
        return NextResponse.json({ ok: true, agentsStarted: r.started, record: { ...r.record, fields: liveFields(r.record) } });
      }
      case 'sampleStudyPack': {
        // A sample of what a learner receives (video lesson + test), for a sample student; it lands in the Inbox only.
        const { buildSampleStudyPack } = await import('@/lib/engine/sample');
        const r = await buildSampleStudyPack({
          name: typeof body.name === 'string' && body.name.trim() ? body.name : `${session.name.split(' ')[0] || 'Sample'} Sample`,
          moduleCode: typeof body.moduleCode === 'string' ? body.moduleCode : undefined,
          questionCount: typeof body.questionCount === 'number' ? body.questionCount : undefined,
        });
        return NextResponse.json({ ok: true, ...r });
      }
      case 'resumeRun': return NextResponse.json({ ok: resumeNow(String(body.runId || '')) });
      case 'stopRun': return NextResponse.json({ ok: stopRun(String(body.runId || '')) });
      case 'setAutopilot': {
        const on = Boolean(body.on);
        setSettings({ autoRunMode: on, scheduleEnabled: on });
        updateTenantIntegrations(currentTenantId(), { autoRunMode: on });
        log('person', 'info', on ? `${session.name} switched the agents to autopilot: they now start by themselves.` : `${session.name} paused autopilot: agents only run when someone presses Run.`);
        return NextResponse.json({ ok: true, autopilot: on });
      }
      case 'saveKnowledge': {
        updateTenantIntegrations(currentTenantId(), {
          agentKnowledge: typeof body.agentKnowledge === 'string' ? body.agentKnowledge : undefined,
          applyUrl: typeof body.applyUrl === 'string' ? body.applyUrl : undefined,
        });
        return NextResponse.json({ ok: true });
      }

      /* ── Data sources ── */
      case 'testSource': {
        const url = String(body.url || '').trim();
        const kind = (String(body.kind || 'custom') as DataSourceKind);
        try {
          const { headers, rows } = await fetchSheet(url);
          const mapping = await aiMap(headers, rows, kind, autoMap(headers));
          return NextResponse.json({ ok: true, headers, sample: rows.slice(0, 5), rows: rows.length, mapping });
        } catch (e) {
          return NextResponse.json({ ok: false, error: (e as Error).message });
        }
      }
      case 'saveSource': {
        const src = (body.source || {}) as Record<string, unknown>;
        const name = String(src.name || '').trim();
        if (!name) return bad('Give the sheet a name.');
        try {
          const saved = saveSource({
            id: src.id ? String(src.id) : undefined,
            name,
            kind: (String(src.kind || 'custom') as DataSourceKind),
            url: src.url !== undefined ? String(src.url) : undefined,
            departmentId: src.departmentId ? String(src.departmentId) : undefined,
            mapping: src.mapping && typeof src.mapping === 'object' ? (src.mapping as Partial<Record<RecordField, string>>) : undefined,
            tabs: Array.isArray(src.tabs) ? (src.tabs as { url: string; label?: string; mapping?: Partial<Record<RecordField, string>> }[]) : undefined,
            enabled: typeof src.enabled === 'boolean' ? src.enabled : undefined,
          });
          // Read it straight away (the first read is the baseline, so nobody is messaged for existing rows).
          if (saved.url) await readSource(saved);
          return NextResponse.json({ ok: true, source: getSource(saved.id) });
        } catch (e) {
          return bad((e as Error).message);
        }
      }
      case 'deleteSource': {
        const id = String(body.id || '');
        if (id === LEADS_SOURCE_ID) return bad('The leads list is built in.');
        return NextResponse.json({ ok: deleteSource(id) });
      }
      case 'syncSource': {
        const src = getSource(String(body.id || ''));
        if (!src?.url) return bad('This source has no sheet link.');
        const events = await readSource(src);
        return NextResponse.json({ ok: true, source: getSource(src.id), changes: events.length });
      }

      default:
        return bad(`Unknown action "${action}".`);
    }
  });
}
