import { NextResponse } from 'next/server';
import type {
  AgentId,
  Dept,
  FlowEdge,
  FlowNode,
  FollowUpCadence,
  OutreachChannel,
  WorkflowDomain,
  WorkflowTrigger,
} from '@/lib/types';
import { ensureAutomation, enqueue } from '@/lib/engine/automation';
import { log } from '@/lib/engine/store';
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  renderWorkflowGoal,
  updateWorkflow,
} from '@/lib/engine/workflows';
import {
  deleteCustomAgent,
  deleteOffice,
  listCustomAgents,
  listFlowRuns,
  listOffices,
  saveCustomAgent,
  saveOffice,
} from '@/lib/engine/offices';
import { generateFlowFromPrompt } from '@/lib/engine/flowGraph';
import { executeCanvasWorkflow, type FlowTarget } from '@/lib/engine/flowExecutor';
import { listFollowUps, processDueFollowUps, setFollowUpStatus } from '@/lib/engine/followups';
import { moodleConfigured, testMoodleConnection } from '@/lib/lms/moodleAdapter';
import { dbConfigured, syncFollowUpsToDb, syncWorkflowsToDb, testDbConnection } from '@/lib/db/postgres';
import { runWithSessionTenant } from '@/lib/auth/requestTenant';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { getCachedLearnersSnapshot } from '@/lib/engine/moodleSync';
import { getState } from '@/lib/engine/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  return runWithSessionTenant(req, async () => {
    ensureAutomation();
    const tid = currentTenantId();
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const ti = getTenantIntegrations(tid);
    const workflows = listWorkflows();
    const offices = listOffices();
    const agents = listCustomAgents();
    const runs = listFlowRuns();

    const snap = await getCachedLearnersSnapshot(tid);
    const targets: FlowTarget[] = snap.learners.map((l) => ({
      id: l.id,
      name: l.name,
      email: l.email,
      phone: l.phone || undefined,
      cohort: l.cohort,
      module: l.weakTopic || l.module || l.programme,
      score: l.avgScore ?? l.checkpoint ?? undefined,
      days: l.daysSinceLogin ?? undefined,
      payment_status: l.paymentStatus || (l.status === 'at_risk' ? 'overdue' : 'ok'),
      status: l.status || 'on_track',
      amount_due: l.paymentStatus === 'overdue' || l.status === 'at_risk' ? 'Overdue balance' : 'R 0',
    }));

    return NextResponse.json({
      workflow: id ? workflows.find((w) => w.id === id) || null : undefined,
      workflows,
      offices,
      agents,
      runs,
      targets,
      followUps: listFollowUps(),
      moodle: {
        configured: Boolean(ti.moodleUrl && ti.moodleToken) || moodleConfigured(),
        url: ti.moodleUrl || process.env.MOODLE_URL || null,
      },
      db: {
        configured: dbConfigured(),
      },
    });
  });
}

export async function POST(req: Request) {
  return runWithSessionTenant(req, async () => {
    ensureAutomation();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');

  if (action === 'create') {
    const name = String(body.name || '').trim() || 'Custom Automation Flow';
    const trigger = (body.trigger as WorkflowTrigger) || 'manual';
    const domain = (body.domain as WorkflowDomain) || 'custom';
    const createDedicated = Boolean(body.createDedicatedOffice);
    let officeId = body.officeId ? String(body.officeId).trim() : undefined;
    let officeName = body.officeName ? String(body.officeName).trim() : undefined;

    if (createDedicated || (!officeId && officeName && !listOffices().some((o) => o.name.toLowerCase() === officeName!.toLowerCase()))) {
      const dedicatedName = officeName && createDedicated ? `${name} Office` : (officeName || `${name} Office`);
      const savedOffice = saveOffice({
        name: dedicatedName,
        short: name.slice(0, 18),
        domain,
        purpose: body.description ? String(body.description).trim() : `Dedicated workflow office for ${name}.`,
        slot: domain === 'finance' || domain === 'admissions' ? 'planning' : domain === 'academy' ? 'success' : 'review',
      });
      officeId = savedOffice.id;
      officeName = savedOffice.name;
    }

    const wf = createWorkflow({
      name,
      officeName,
      officeId,
      agentId: body.agentId ? String(body.agentId).trim() : undefined,
      domain,
      description: body.description ? String(body.description).trim() : undefined,
      trigger,
      threshold: typeof body.threshold === 'number' ? body.threshold : Number(body.threshold) || undefined,
      channel: (body.channel as OutreachChannel) || 'email',
      goalTemplate: body.goalTemplate ? String(body.goalTemplate).trim() : undefined,
      instructions: body.instructions ? String(body.instructions).trim() : undefined,
      followUpCadence: (body.followUpCadence as Partial<FollowUpCadence>) || undefined,
      nodes: Array.isArray(body.nodes) ? (body.nodes as FlowNode[]) : undefined,
      edges: Array.isArray(body.edges) ? (body.edges as FlowEdge[]) : undefined,
    });
    log('system', 'system', `Created workflow office "${wf.officeName || wf.name}" (${wf.trigger}).`);
    return NextResponse.json({ ok: true, workflow: wf });
  }

  if (action === 'generateGraph') {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) {
      return NextResponse.json({ error: 'Describe the workflow you want to build.' }, { status: 400 });
    }
    const gen = await generateFlowFromPrompt(prompt, listOffices(), listCustomAgents());
    if (body.create === false) {
      return NextResponse.json({ ok: true, generated: gen, viaAi: gen.viaAi });
    }
    const existingOffices = listOffices();
    let matchedOffice = existingOffices.find((o) => o.name.toLowerCase() === gen.officeName.toLowerCase());
    if (!matchedOffice) {
      matchedOffice = saveOffice({
        name: gen.officeName,
        short: gen.officeName.slice(0, 18),
        domain: gen.domain,
        purpose: gen.description,
        slot: gen.domain === 'finance' || gen.domain === 'admissions' ? 'planning' : 'success',
      });
    }
    const wf = createWorkflow({
      name: gen.name,
      officeName: matchedOffice.name,
      officeId: matchedOffice.id,
      domain: gen.domain,
      description: gen.description,
      trigger: gen.trigger,
      goalTemplate: `{{office}}: Run "${gen.name}" for {{name}} ({{detail}}).`,
      instructions: prompt,
      nodes: gen.nodes,
      edges: gen.edges,
    });
    log('system', 'system', `Generated visual workflow "${wf.name}" for ${wf.officeName}.`);
    return NextResponse.json({ ok: true, workflow: wf, viaAi: gen.viaAi });
  }

  if (action === 'update') {
    const id = String(body.id || '');
    const wf = updateWorkflow(id, (body.patch as Record<string, unknown>) || {});
    if (!wf) return NextResponse.json({ error: 'Workflow not found.' }, { status: 404 });
    log('system', 'system', `Updated workflow "${wf.name}" (${wf.officeName}).`);
    return NextResponse.json({ ok: true, workflow: wf });
  }

  if (action === 'toggle') {
    const id = String(body.id || '');
    const existing = getWorkflow(id);
    if (!existing) return NextResponse.json({ error: 'Workflow not found.' }, { status: 404 });
    const wf = updateWorkflow(id, { enabled: !existing.enabled });
    log('system', 'system', `${wf?.enabled ? 'Enabled' : 'Paused'} workflow "${existing.name}".`);
    return NextResponse.json({ ok: true, workflow: wf });
  }

  if (action === 'delete') {
    const id = String(body.id || '');
    const ok = deleteWorkflow(id);
    if (!ok) return NextResponse.json({ error: 'Workflow not found.' }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  if (action === 'runGraph') {
    const id = String(body.id || '');
    const wf = getWorkflow(id);
    if (!wf) return NextResponse.json({ error: 'Workflow not found.' }, { status: 404 });

    let target: FlowTarget | null = null;
    const custom = body.customTarget as Partial<FlowTarget> | undefined;
    if (custom && (custom.name || custom.email)) {
      target = {
        id: custom.id ? String(custom.id) : `rec_${Date.now().toString(36)}`,
        name: String(custom.name || custom.email || 'Recipient'),
        email: String(custom.email || ''),
        phone: custom.phone ? String(custom.phone) : undefined,
        module: custom.module ? String(custom.module) : wf.officeName,
        amount_due: custom.amount_due ? String(custom.amount_due) : 'Overdue balance',
        days: typeof custom.days === 'number' ? custom.days : Number(custom.days) || 7,
        payment_status: custom.payment_status ? String(custom.payment_status) : 'overdue',
        status: custom.status ? String(custom.status) : 'at_risk',
        detail: custom.detail ? String(custom.detail) : `${wf.officeName} trigger`,
      };
    } else {
      const snap = await getCachedLearnersSnapshot(currentTenantId());
      const picked = body.targetId
        ? snap.learners.find((x) => x.id === body.targetId)
        : snap.learners[0];
      if (picked) {
        target = {
          id: picked.id,
          name: picked.name,
          email: picked.email,
          phone: picked.phone || undefined,
          cohort: picked.cohort,
          module: picked.weakTopic || picked.module || picked.programme,
          score: picked.avgScore ?? picked.checkpoint ?? undefined,
          days: picked.daysSinceLogin ?? undefined,
          payment_status: picked.paymentStatus || 'ok',
          status: picked.status || 'on_track',
          amount_due: picked.paymentStatus === 'overdue' ? 'Overdue tuition' : 'R 0',
          detail: `${picked.programme} (${picked.cohort})`,
        };
      }
    }

    if (!target) {
      return NextResponse.json(
        { error: 'Select a target record or enter recipient details (name/email) to run this flow.' },
        { status: 400 },
      );
    }

    const run = await executeCanvasWorkflow(wf, target);
    return NextResponse.json({ ok: true, run });
  }

  if (action === 'saveOffice') {
    const o = saveOffice({
      id: body.id ? String(body.id) : undefined,
      name: String(body.name || ''),
      short: body.short ? String(body.short) : undefined,
      domain: body.domain as WorkflowDomain | undefined,
      purpose: body.purpose ? String(body.purpose) : undefined,
      slot: body.slot as Dept | undefined,
      color: body.color ? String(body.color) : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    });
    log('system', 'system', `Saved office "${o.name}" (${o.domain}).`);
    return NextResponse.json({ ok: true, office: o, offices: listOffices() });
  }

  if (action === 'deleteOffice') {
    const ok = deleteOffice(String(body.id || ''));
    return NextResponse.json({ ok, offices: listOffices() });
  }

  if (action === 'saveAgent') {
    const a = saveCustomAgent({
      id: body.id ? String(body.id) : undefined,
      name: String(body.name || ''),
      title: body.title ? String(body.title) : undefined,
      officeId: body.officeId ? String(body.officeId) : undefined,
      slot: body.slot as AgentId | undefined,
      persona: body.persona ? String(body.persona) : undefined,
      channels: Array.isArray(body.channels) ? (body.channels as OutreachChannel[]) : undefined,
      instructions: body.instructions ? String(body.instructions) : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    });
    log('system', 'system', `Saved agent "${a.name}" (${a.title}).`);
    return NextResponse.json({ ok: true, agent: a, agents: listCustomAgents() });
  }

  if (action === 'deleteAgent') {
    const ok = deleteCustomAgent(String(body.id || ''));
    return NextResponse.json({ ok, agents: listCustomAgents() });
  }

  if (action === 'testRun') {
    const id = String(body.id || '');
    const wf = getWorkflow(id);
    if (!wf) return NextResponse.json({ error: 'Workflow not found.' }, { status: 404 });
    const { getLmsAdapter } = await import('@/lib/lms/lmsAdapter');
    const { getState } = await import('@/lib/engine/store');
    const lms = getLmsAdapter(getState().settings.lmsMode);
    const roster = await lms.listStudents().catch(() => []);
    const picked = body.learnerId ? roster.find((x) => x.id === body.learnerId) : roster[0];
    if (!picked && !body.learnerName) {
      return NextResponse.json(
        { error: 'No students synced in this workspace yet. Sync Moodle or add/import a student first before running a workflow.' },
        { status: 400 },
      );
    }
    const learnerName = String(body.learnerName || picked?.name || 'Active Cohort');
    const goal = renderWorkflowGoal(wf, {
      name: learnerName,
      first: learnerName.split(' ')[0],
      module: String(body.module || picked?.cohort || 'Current Module'),
      score: typeof body.score === 'number' ? body.score : 50,
      days: typeof body.days === 'number' ? body.days : 5,
      detail: 'live workflow run',
    });
    const r = enqueue({
      goal,
      trigger: { kind: 'workflow', label: `${wf.officeName || wf.name} · run` },
      focus: picked ? [picked.id] : (body.learnerId ? [String(body.learnerId)] : undefined),
      workflowId: wf.id,
      workflowInstructions: wf.instructions,
    });
    log('system', 'system', `Queued workflow "${wf.officeName || wf.name}" for ${learnerName}: ${goal}`);
    return NextResponse.json({ ok: true, queued: r.queued, goal });
  }

  if (action === 'followUpStatus') {
    const id = String(body.id || '');
    const status = body.status as 'active' | 'paused' | 'resolved';
    if (!['active', 'paused', 'resolved'].includes(status)) {
      return NextResponse.json({ error: 'Invalid follow-up status.' }, { status: 400 });
    }
    const item = setFollowUpStatus(id, status);
    if (!item) return NextResponse.json({ error: 'Follow-up case not found.' }, { status: 404 });
    return NextResponse.json({ ok: true, followUp: item });
  }

  if (action === 'runFollowUpsNow') {
    const id = body.id ? String(body.id) : undefined;
    const sent = await processDueFollowUps({
      forceId: id,
      forceAll: !id && Boolean(body.forceAll),
    });
    return NextResponse.json({ ok: true, sent, followUps: listFollowUps() });
  }

  if (action === 'testMoodle') {
    const ti = getTenantIntegrations(currentTenantId());
    const result = await testMoodleConnection({
      url: ti.moodleUrl,
      token: ti.moodleToken,
      courseIds: ti.moodleCourseIds,
    });
    return NextResponse.json(result);
  }

  if (action === 'testDb') {
    const result = await testDbConnection();
    if (result.ok) {
      await Promise.all([syncWorkflowsToDb(listWorkflows()), syncFollowUpsToDb(listFollowUps())]);
    }
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  });
}
