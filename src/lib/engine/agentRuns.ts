import { sendingPaused } from '@/lib/email/pause';
import type {
  AgentRun,
  AgentRunLog,
  AgentStep,
  CheckInMessage,
  CustomAgentDef,
  Deliverable,
  MessageChannel,
  OfficeDef,
  WorkflowDef,
} from '@/lib/types';
import { tenantDoc } from './tenantDoc';
import { bump, enqueueOutreachApproval, getState, log, setSpotlight, uid, upsertDeliverable } from './store';
import { listCustomAgents, listOffices } from './offices';
import { getWorkflow, recordWorkflowRun } from './workflows';
import { auditAgentMessage } from './agentAudit';
import { appendConversation, getRecord, setRecordField } from '@/lib/data/records';
import { LEADS_SOURCE_ID, MOODLE_SOURCE_ID, getSource, liveFields, sourceSummary, writeBackField } from '@/lib/data/sources';
import { studentsSummary } from '@/lib/lms/students';
import { ESCALATION_LABEL, escalationTo, escalationType } from '@/lib/escalation';
import { bumpStat } from '@/lib/nurture/store';
import { conversationText, leadEmailExtras, liveOffersText } from '@/lib/nurture/library';
import { offersText } from '@/lib/nurture/vouchers';
import { describeCondition, evalRule, isoDate } from '@/lib/data/conditions';
import { briefTeam, doTask, fallbackMessage, judge, reviseMessage, writeMessage, type DraftMessage, type MindContext } from '@/lib/ai/agentMind';
import { personalEmail, sendMail, sendManyChat, sendWhatsApp, unsubscribeHeaders, workflowEmail } from '@/lib/email/send';
import { dialerReady, placeCall } from '@/lib/calls/dialer';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import { getLmsAdapter } from '@/lib/lms/lmsAdapter';

/* The agents at work.
 *
 * A run is one agent doing its job for one record: it walks the workflow's
 * steps top to bottom, branches on conditions, follows up in rounds, and
 * waits for real hours or days when a step says so. Runs are saved, so a
 * restart or a redeploy picks them up where they stopped. Messages are
 * reviewed by the rules in agentAudit before anything is sent, and in
 * Approval Mode the run pauses until a person approves the message. */

const doc = tenantDoc<AgentRun[]>('agent-runs', () => []);
const MAX_FINISHED = 300;
const WAIT_SCALE = Math.max(1, Number(process.env.AGENT_WAIT_SCALE || 1));
const ACTIVE: AgentRun['status'][] = ['running', 'waiting', 'awaiting_approval'];

export type RunRecord = AgentRun['record'];

export async function hydrateAgentRuns(tenantId = currentTenantId()) {
  await doc.hydrate(tenantId);
  // A run that was mid-step when the server stopped carries on from that step.
  let touched = false;
  for (const r of doc.get(tenantId)) {
    if (r.status === 'running') { r.status = 'waiting'; r.resumeAt = Date.now(); touched = true; }
  }
  if (touched) doc.save(tenantId);
}

export function listAgentRuns(filter: { workflowId?: string; departmentId?: string; active?: boolean; limit?: number } = {}): AgentRun[] {
  let list = doc.get();
  if (filter.workflowId) list = list.filter((r) => r.workflowId === filter.workflowId);
  if (filter.departmentId) list = list.filter((r) => r.departmentId === filter.departmentId);
  if (filter.active) list = list.filter((r) => ACTIVE.includes(r.status));
  return list.slice(0, filter.limit || 200);
}

export function getAgentRun(id: string): AgentRun | null {
  return doc.get().find((r) => r.id === id) || null;
}

function saveRun(run: AgentRun) {
  run.updatedAt = Date.now();
  const list = doc.get();
  const i = list.findIndex((r) => r.id === run.id);
  if (i >= 0) list[i] = run; else list.unshift(run);
  const finished = list.filter((r) => !ACTIVE.includes(r.status));
  if (finished.length > MAX_FINISHED) {
    const drop = new Set(finished.slice(MAX_FINISHED).map((r) => r.id));
    doc.set(list.filter((r) => !drop.has(r.id)));
  } else doc.save();
}

/* ── Who is who ───────────────────────────────────────────────────────────── */

function agentFor(wf: WorkflowDef): CustomAgentDef | null {
  const agents = listCustomAgents();
  return agents.find((a) => a.workflowId === wf.id) || agents.find((a) => a.id === wf.agentId) || null;
}

function departmentFor(wf: WorkflowDef): OfficeDef | null {
  const offices = listOffices();
  return offices.find((o) => o.id === (wf.departmentId || wf.officeId)) || null;
}

const tag = (run: AgentRun) => `[${run.departmentName} · ${run.agentName}]`;

function addLog(run: AgentRun, step: AgentStep | null, status: AgentRunLog['status'], detail: string, output?: string) {
  run.logs.push({ ts: Date.now(), stepId: step?.id || null, title: step?.title || 'Run', status, detail, ...(output ? { output } : {}) });
  if (run.logs.length > 120) run.logs = run.logs.slice(-120);
}

/* ── Steps as a tree ──────────────────────────────────────────────────────── */

type Where = { list: AgentStep[]; index: number; parent: AgentStep | null };

function indexSteps(steps: AgentStep[]): Map<string, Where> {
  const map = new Map<string, Where>();
  const walk = (list: AgentStep[], parent: AgentStep | null) => {
    list.forEach((s, index) => {
      map.set(s.id, { list, index, parent });
      if (s.kind === 'condition') { walk(s.yes || [], s); walk(s.no || [], s); }
      if (s.kind === 'repeat') walk(s.steps || [], s);
    });
  };
  walk(steps, null);
  return map;
}

/** The step after this one: the next sibling, or out of a branch, or the end of a repeat round. */
function nextAfter(idx: Map<string, Where>, stepId: string): string | null {
  const w = idx.get(stepId);
  if (!w) return null;
  if (w.index + 1 < w.list.length) return w.list[w.index + 1].id;
  if (!w.parent) return null;
  if (w.parent.kind === 'repeat') return `@round:${w.parent.id}`;
  return nextAfter(idx, w.parent.id);
}

/* ── Context for the agent's mind ─────────────────────────────────────────── */

function fieldsFor(run: AgentRun): Record<string, string> {
  const rec = run.record.sourceId ? getRecord(run.record.sourceId, run.record.key) : null;
  const base = rec
    ? liveFields(rec)
    : liveFields({ fields: run.record.fields || {}, name: run.record.name, email: run.record.email, phone: run.record.phone });
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(run.vars)) if (!k.startsWith('_')) vars[k] = v;
  const f = { ...base, ...vars };
  // A reply from before this run started is not a reply to this run.
  if (f.replied === 'yes' && Number(f.replied_at_ms || 0) < run.startedAt) f.replied = 'no';
  return f;
}

function historyFor(run: AgentRun): string[] {
  return run.logs
    .filter((l) => l.status !== 'skip')
    .map((l) => `${l.detail}${l.output ? ` | ${l.output.replace(/\s+/g, ' ').slice(0, 220)}` : ''}`)
    .slice(-14);
}

function mindFor(run: AgentRun, extra?: string): MindContext {
  const wf = getWorkflow(run.workflowId);
  const agent = (wf && agentFor(wf)) || null;
  const dept = (wf && departmentFor(wf)) || null;
  return {
    agent: {
      name: run.agentName,
      title: agent?.title || 'Agent',
      persona: agent?.persona || '',
      instructions: [agent?.instructions, wf?.instructions].filter(Boolean).join(' '),
    },
    department: dept ? { name: dept.name, kind: dept.kind } : { name: run.departmentName, kind: 'custom' },
    fields: fieldsFor(run),
    history: historyFor(run),
    extra: [run.vars._extra, extra, ...salesContext(run, dept?.kind)].filter(Boolean).join('\n\n') || undefined,
  };
}

/** For Admissions: the conversation so far and the offers that are live, so a reply sells with real facts. */
function salesContext(run: AgentRun, kind: string | undefined): string[] {
  const rec = run.record.sourceId ? getRecord(run.record.sourceId, run.record.key) : null;
  const out = [conversationText(rec)];
  if (kind === 'admissions') out.push(liveOffersText(), offersText());
  return out;
}

function approvalRequired(): boolean {
  const s = getState().settings.requireApproval;
  if (typeof s === 'boolean') return s;
  return getTenantIntegrations(currentTenantId()).requireApproval !== false;
}

/* ── Starting a run ───────────────────────────────────────────────────────── */

export async function startAgentRun(input: {
  workflow: WorkflowDef;
  record: RunRecord;
  trigger: string;
  vars?: Record<string, string>;
  /** Ignore the cooldown (someone pressed Run). */
  force?: boolean;
}): Promise<{ run: AgentRun | null; reason?: string }> {
  const wf = input.workflow;
  if (!wf.steps?.length) return { run: null, reason: 'This agent has no steps yet.' };
  const key = input.record.key;
  const runs = doc.get();
  const active = runs.find((r) => r.workflowId === wf.id && r.record.key === key && ACTIVE.includes(r.status));
  if (active) return { run: null, reason: `${input.record.name} already has a run in progress for this agent.` };
  if (!input.force) {
    const coolMs = (wf.agentTrigger?.cooldownHours ?? 72) * 3_600_000;
    const recent = runs.find((r) => r.workflowId === wf.id && r.record.key === key && r.startedAt > Date.now() - coolMs);
    if (recent) return { run: null, reason: `${input.record.name} was handled by this agent recently.` };
  }
  const agent = agentFor(wf);
  const dept = departmentFor(wf);
  const run: AgentRun = {
    id: uid('run'),
    workflowId: wf.id,
    workflowName: wf.name,
    agentId: agent?.id || null,
    agentName: agent?.name || wf.name,
    departmentId: dept?.id || null,
    departmentName: dept?.name || wf.officeName || 'Operations',
    record: input.record,
    trigger: input.trigger,
    status: 'running',
    cursor: wf.steps[0].id,
    rounds: {},
    resumeAt: null,
    steps: JSON.parse(JSON.stringify(wf.steps)) as AgentStep[],
    vars: { ...(input.vars || {}) },
    logs: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
    endedAt: null,
  };
  addLog(run, null, 'info', `Started by ${input.trigger} for ${run.record.name}.`);
  saveRun(run);
  recordWorkflowRun(wf.id);
  bump('processed');
  log('system', 'route', `${tag(run)} Picked up ${run.record.name} (${input.trigger}).`);
  void advance(run.id, currentTenantId());
  return { run };
}

/* ── Advancing ────────────────────────────────────────────────────────────── */

const locks = new Set<string>();

export async function advance(runId: string, tenantId = currentTenantId()): Promise<void> {
  if (locks.has(runId)) return;
  locks.add(runId);
  try {
    for (let guard = 0; guard < 40; guard++) {
      const run = getAgentRun(runId);
      if (!run || run.status !== 'running') return;
      if (!run.cursor) { finish(run, 'completed', 'Done.'); return; }
      const keepGoing = await stepOnce(run, tenantId);
      saveRun(run);
      if (!keepGoing) return;
    }
    // A very long chain: let the pump pick it up again shortly.
    const run = getAgentRun(runId);
    if (run && run.status === 'running') { run.status = 'waiting'; run.resumeAt = Date.now() + 5000; saveRun(run); }
  } catch (e) {
    const run = getAgentRun(runId);
    if (run) {
      addLog(run, null, 'fail', `Stopped by an error: ${(e as Error).message}`);
      finish(run, 'failed', 'Failed.');
    }
  } finally {
    locks.delete(runId);
  }
}

function finish(run: AgentRun, status: 'completed' | 'stopped' | 'failed', note: string) {
  run.status = status;
  run.cursor = null;
  run.resumeAt = null;
  run.endedAt = Date.now();
  addLog(run, null, status === 'failed' ? 'fail' : 'ok', note);
  saveRun(run);
  log('system', status === 'failed' ? 'error' : 'approve', `${tag(run)} ${status === 'completed' ? 'Finished' : status === 'stopped' ? 'Stopped' : 'Failed'} for ${run.record.name}.`);
}

function waitFor(run: AgentRun, hours: number, next: string | null, step: AgentStep, why: string) {
  const ms = Math.max(60_000 / WAIT_SCALE, (hours * 3_600_000) / WAIT_SCALE);
  run.status = 'waiting';
  run.resumeAt = Date.now() + ms;
  run.cursor = next;
  const when = new Date(run.resumeAt).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  addLog(run, step, 'wait', `${why} Carrying on ${when}.`);
}

/** Runs one step. Returns false when the run pauses (waiting, approval) or ends. */
async function stepOnce(run: AgentRun, tenantId: string): Promise<boolean> {
  const idx = indexSteps(run.steps);
  const cursor = run.cursor as string;

  // The end of one round of a repeat: count it, then wait and check again.
  if (cursor.startsWith('@round:')) {
    const rid = cursor.slice(7);
    const rep = idx.get(rid)?.list[idx.get(rid)!.index];
    if (!rep) { run.cursor = null; return true; }
    run.rounds[rid] = (run.rounds[rid] || 0) + 1;
    const max = rep.maxTimes || 3;
    if (run.rounds[rid] >= max) {
      addLog(run, rep, 'info', `Follow-ups done: ${run.rounds[rid]} of ${max} rounds.`);
      run.cursor = nextAfter(idx, rid);
      return true;
    }
    waitFor(run, rep.hours || 48, rid, rep, `Round ${run.rounds[rid]} of ${max} done.`);
    return false;
  }

  const where = idx.get(cursor);
  if (!where) { run.cursor = null; return true; }
  const step = where.list[where.index];
  const next = () => nextAfter(idx, step.id);

  switch (step.kind) {
    case 'wait': {
      const h = step.hours || 24;
      waitFor(run, h, next(), step, `Waiting ${h >= 24 && h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hour${h === 1 ? '' : 's'}`}.`);
      return false;
    }

    case 'repeat': {
      const done = run.rounds[step.id] || 0;
      const f = fieldsFor(run);
      if (done > 0 && f.replied === 'yes' && Number(f.replied_at_ms || 0) > run.startedAt) {
        if (step.stopOnReply === false) {
          // Keep in touch for good: while they are talking with us, this loop waits a round.
          if (Number(f.replied_at_ms || 0) > Date.now() - 3 * 86_400_000) {
            waitFor(run, step.hours || 72, step.id, step, `${run.record.name.split(' ')[0]} is talking with us, so this round waits.`);
            return false;
          }
        } else {
          addLog(run, step, 'ok', `${run.record.name.split(' ')[0]} replied, so the follow-ups stop here and a person takes over.`);
          run.cursor = next();
          return true;
        }
      }
      if (step.condition) {
        const met = await testCondition(run, step.condition);
        if (met.answer) {
          addLog(run, step, 'ok', `No more follow-ups needed: ${describeCondition(step.condition)}${met.reason ? ` (${met.reason})` : ''}.`);
          run.cursor = next();
          return true;
        }
      }
      if (done >= (step.maxTimes || 3)) { run.cursor = next(); return true; }
      // The first round waits its interval too, so a follow-up never lands on top of the message before it.
      const armed = `${step.id}:armed`;
      if (done === 0 && !run.rounds[armed]) {
        run.rounds[armed] = 1;
        const h = step.hours || 48;
        waitFor(run, h, step.id, step, `First follow-up in ${h >= 24 && h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hour${h === 1 ? '' : 's'}`}${step.condition && step.condition.mode !== 'ai' ? ` (none if ${describeCondition(step.condition)} by then)` : ''}.`);
        return false;
      }
      const body = step.steps || [];
      addLog(run, step, 'info', `Follow-up round ${done + 1} of ${step.maxTimes || 3}.`);
      run.cursor = body[0]?.id || `@round:${step.id}`;
      return true;
    }

    case 'condition': {
      const c = step.condition || { mode: 'rule', field: 'status', op: 'not_empty' };
      const r = await testCondition(run, c);
      addLog(run, step, 'info', `${describeCondition(c)}? ${r.answer ? 'Yes' : 'No'}${r.reason ? `: ${r.reason}` : ''}.`);
      const branch = r.answer ? step.yes : step.no;
      run.cursor = branch?.[0]?.id || next();
      return true;
    }

    case 'ai_message': {
      await doMessage(run, step);
      if (run.status === 'awaiting_approval') { run.cursor = next(); return false; }
      run.cursor = next();
      return true;
    }

    case 'send_library': {
      const end = await doLibrary(run, step);
      if (end) { finish(run, 'completed', end); return false; }
      run.cursor = next();
      return run.status !== 'awaiting_approval';
    }

    case 'ai_task': {
      const mind = mindFor(run, run.record.key === '__report__' && run.record.sourceId ? `Data: ${reportData(run.record.sourceId)}` : undefined);
      const r = await doTask(mind, step.instructions || step.title);
      const field = step.saveAs || 'task_result';
      run.vars[field] = r.result;
      if (run.record.sourceId) setRecordField(run.record.sourceId, run.record.key, field, r.result);
      addLog(run, step, 'ok', `${step.title}: saved as ${field}${r.viaAi ? '' : ' (playbook)'}.`, r.result);
      run.cursor = next();
      return true;
    }

    case 'take_over': {
      const n = takeOver(run);
      addLog(run, step, 'ok', n ? `${run.agentName} takes ${run.record.name.split(/\s+/)[0]} over: ${n} other agent${n === 1 ? '' : 's'} in ${run.departmentName} stopped, so they hear from one person.` : `${run.agentName} takes ${run.record.name.split(/\s+/)[0]} over.`);
      run.cursor = next();
      return true;
    }

    case 'send_voucher': {
      await doVoucher(run, step);
      run.cursor = next();
      return run.status !== 'awaiting_approval';
    }

    case 'ai_video': {
      await doVideo(run, step);
      run.cursor = next();
      return true;
    }

    case 'ai_lesson': {
      await doLesson(run, step);
      run.cursor = next();
      return true;
    }

    case 'ai_call': {
      await doCall(run, step);
      run.cursor = next();
      return true;
    }

    case 'update_record': {
      const field = (step.setField || 'status').trim();
      const value = fill(step.setValue || '', fieldsFor(run));
      const src = getSource(run.record.sourceId);
      const rec = run.record.sourceId ? setRecordField(run.record.sourceId, run.record.key, field, value) : null;
      run.vars[field] = value;
      const wrote = rec ? await writeBackField(src, rec, field, value) : false;
      addLog(run, step, 'ok', `Set ${field} to "${value}"${wrote ? ' and wrote it to the sheet' : ''}.`);
      // A lead marked ready to sign up is qualified: the team hears on Discord and the dialer gets them.
      if (rec && run.record.sourceId && field === 'status' && /^ready to (apply|enrol|sign up)$/i.test(value)) {
        const { qualifyLead } = await import('@/lib/nurture/qualify');
        const q = await qualifyLead(run.record.sourceId, run.record.key, { reason: 'ready', note: (run.vars.last_reply || rec.fields.last_reply || '').slice(0, 400) || undefined, keepRunId: run.id }, tenantId);
        if (q && !q.alreadyQualified) addLog(run, step, 'ok', `Qualified and handed to the sales team (Discord: ${q.discord}; dialer: ${q.dialer}).`);
      }
      run.cursor = next();
      return true;
    }

    case 'notify_team': {
      await doNotify(run, step, tenantId);
      run.cursor = next();
      return true;
    }

    case 'webhook': {
      const url = (step.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        addLog(run, step, 'skip', 'No address set for this step.');
      } else if (sendingPaused()) {
        addLog(run, step, 'skip', `Paused (test phase): the record was not sent to ${url.replace(/^https?:\/\//, '').split('/')[0]}.`);
      } else {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'thuso.agent_step', workflow: run.workflowName, department: run.departmentName, agent: run.agentName, record: { ...run.record, fields: fieldsFor(run) }, at: new Date().toISOString() }),
            signal: AbortSignal.timeout(8000),
          });
          addLog(run, step, res.ok ? 'ok' : 'fail', `Sent the record to ${new URL(url).host}: HTTP ${res.status}.`);
        } catch (e) {
          addLog(run, step, 'fail', `Could not reach ${url}: ${(e as Error).message}`);
        }
      }
      run.cursor = next();
      return true;
    }

    case 'stop': {
      finish(run, 'completed', step.title || 'Stopped here.');
      return false;
    }

    default:
      run.cursor = next();
      return true;
  }
}

async function testCondition(run: AgentRun, c: NonNullable<AgentStep['condition']>): Promise<{ answer: boolean; reason: string }> {
  if (c.mode === 'ai') {
    const r = await judge(mindFor(run), c.question || 'Should we carry on?');
    return { answer: r.answer, reason: r.reason };
  }
  return { answer: evalRule(c, fieldsFor(run)) === true, reason: '' };
}

/** What a weekly report reads: the students from Moodle, or a sheet's totals. */
function reportData(sourceId: string): string {
  if (sourceId === MOODLE_SOURCE_ID) return studentsSummary() || 'No students yet: Moodle has not synced.';
  return sourceSummary(sourceId);
}

/** {{field}} placeholders, plus {{today}}. */
function fill(t: string, f: Record<string, string>) {
  return t.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k: string) => (k === 'today' ? isoDate(new Date()) : f[k] ?? ''));
}

/* ── Messages ─────────────────────────────────────────────────────────────── */

async function doMessage(run: AgentRun, step: AgentStep) {
  const channel: MessageChannel = step.channel || 'email';
  const f = fieldsFor(run);
  if (f.opted_out === 'yes') {
    addLog(run, step, 'skip', `${run.record.name.split(' ')[0]} asked not to get marketing messages, so nothing was written or sent.`);
    return;
  }
  const needsEmail = channel !== 'whatsapp';
  if (needsEmail && !run.record.email && !(channel === 'email_whatsapp' && run.record.phone)) {
    addLog(run, step, 'fail', 'No email address on the record, so nothing was sent.');
    return;
  }
  if (channel === 'whatsapp' && !run.record.phone) {
    addLog(run, step, 'fail', 'No phone number on the record, so no WhatsApp was sent.');
    return;
  }
  const mind = mindFor(run);
  let draft = await writeMessage(mind, step);
  const first = (f.first_name || run.record.name).split(/\s+/)[0];
  const dept = mind.department?.kind;

  if (step.review !== false) {
    const verdict = auditAgentMessage({ body: draft.body, subject: draft.subject, firstName: first, channel, department: dept, fields: f });
    if (!verdict.pass) {
      addLog(run, step, 'info', `Reviewer sent the draft back: ${verdict.notes.join(' ')}`);
      log('coo', 'audit', `${tag(run)} Reviewer caught a problem in the message to ${run.record.name}: ${verdict.notes[0]}`);
      const revised = draft.viaAi ? await reviseMessage(mind, step, draft, verdict.notes) : null;
      const again = revised ? auditAgentMessage({ body: revised.body, subject: revised.subject, firstName: first, channel, department: dept, fields: f }) : null;
      const fixed: DraftMessage = revised && again?.pass ? revised : fallbackMessage(mind, step);
      const final = auditAgentMessage({ body: fixed.body, subject: fixed.subject, firstName: first, channel, department: dept, fields: f });
      if (!final.pass) {
        // Never send something that still breaks the rules: a person decides.
        run.vars._hold = final.notes.join(' ');
      }
      setSpotlight({
        id: uid('sp'), ts: Date.now(), kind: 'caught', owner: 'coo',
        title: 'Mistake caught', subject: `${run.agentName} → ${run.record.name}`,
        rule: verdict.notes[0], problem: verdict.notes.join(' '),
        before: draft.body.slice(0, 260), after: fixed.body.slice(0, 260), holdMs: 7000,
      });
      addLog(run, step, 'ok', revised && again?.pass ? 'Rewritten and re-checked: passes.' : 'Replaced with the reviewed playbook message.');
      draft = fixed;
    } else {
      addLog(run, step, 'ok', 'Reviewer checked the draft: passes.');
    }
  }

  run.vars.last_subject = draft.subject;
  run.vars.last_message = draft.body;

  const held = run.vars._hold;
  delete run.vars._hold;
  if (approvalRequired() || held) {
    if (held) addLog(run, step, 'info', `The reviewer could not get this message right by itself (${held}), so it waits for a person.`);
    holdForApproval(run, { subject: draft.subject, body: draft.body, ask: draft.ask }, channel, 'Reviewed. Waiting for a person to approve (Approval Mode is on).');
    addLog(run, step, 'wait', `Drafted "${draft.subject}". Waiting for approval in the Inbox before it goes.`, draft.body);
    log('system', 'draft', `${tag(run)} Drafted a message for ${run.record.name}; waiting for approval.`);
    return;
  }

  await deliver(run, step, draft, channel, null);
}

/** The approval preview must not count as the lead opening or clicking (no pixel, tracked links disabled). */
const previewSafe = (html: string) => html
  .replace(/<img[^>]+\/go\/[^>]*>/g, '')
  .replace(/href="[^"]*\/go\/[^"]*"/g, 'href="#"')
  .replace(/https?:\/\/[^\s"<]*\/go\/[A-Za-z0-9_.-]+(\?[a-z]=1)?/g, '(their personal link)');

/** Approval Mode: the message waits in the Inbox (exactly as it will look) and the run pauses until a person decides. */
function holdForApproval(run: AgentRun, msg: Pick<CheckInMessage, 'subject' | 'body' | 'ask' | 'html' | 'library'>, channel: MessageChannel, note: string) {
  const delivId = uid('deliv_ag');
  const content: CheckInMessage = {
    learner: { id: run.record.key, name: run.record.name, email: run.record.email },
    subject: msg.subject, body: msg.body, ask: msg.ask,
    agentName: run.agentName, officeName: run.departmentName,
    ...(msg.html ? { html: previewSafe(msg.html) } : {}), ...(msg.library ? { library: msg.library } : {}),
  };
  const d: Deliverable<CheckInMessage> = {
    id: delivId, taskId: run.id, kind: 'agent_message', title: `${run.agentName} → ${run.record.name}`, subject: run.record.name,
    owner: 'coo', dept: 'success', version: 1, status: 'awaiting_approval', content, previous: null,
    audit: [{ ts: Date.now(), by: 'coo', verdict: 'pass', version: 1, notes: [note] }],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  upsertDeliverable(d);
  enqueueOutreachApproval({
    id: uid('appr'), taskId: run.id, deliverableId: delivId, runId: run.id, channel,
    learnerId: run.record.key, learnerName: run.record.name, learnerEmail: run.record.email || run.record.phone,
    cohort: run.departmentName, kind: 'agent_message', subject: msg.subject,
    previewText: msg.body.replace(/\s+/g, ' ').slice(0, 240), link: null, moduleCode: null, topic: null,
    workflowId: run.workflowId, workflowName: `${run.departmentName} · ${run.agentName}`, triggerKind: run.trigger,
    intervalHours: 0, repeatForever: false, maxAttempts: null, createdAt: Date.now(), status: 'pending',
  });
  run.status = 'awaiting_approval';
}

/** Short WhatsApp text from an email draft: the first paragraph after the greeting, plus the ask. */
function whatsappText(draft: DraftMessage, first: string, agent: string) {
  const paras = draft.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const content = paras.filter((p) => !/^(hi|hello|hey)\b/i.test(p) && !/regards|cheers|thanks,?$/i.test(p)).slice(0, 2).join('\n\n');
  return `Hi ${first}, ${agent} here. ${content}\n\n${draft.ask}`.slice(0, 900);
}

async function deliver(run: AgentRun, step: AgentStep | null, draft: DraftMessage, channel: MessageChannel, deliverableId: string | null) {
  const first = run.record.name.split(/\s+/)[0];
  const sent: string[] = [];
  let delivered = 0;
  // A lead from the leads list: a resource that fits them, tracked links, and a way to stop marketing emails.
  const leadRec = run.record.sourceId === LEADS_SOURCE_ID ? getRecord(run.record.sourceId, run.record.key) : null;
  const extras = leadRec ? leadEmailExtras(leadRec, run.id, { video: run.vars._video === 'yes' }) : null;
  // A reply to their email stays in the same thread.
  const replyTo = run.vars._reply_msgid || '';
  const threadSubject = replyTo && run.vars._reply_subject ? (/^re:/i.test(run.vars._reply_subject) ? run.vars._reply_subject : `Re: ${run.vars._reply_subject}`) : '';
  if (channel !== 'whatsapp' && run.record.email) {
    const mailInput = { recipientName: run.record.name, subject: draft.subject, body: draft.body, ask: draft.ask, agentName: run.agentName, officeName: run.departmentName, extraHtml: extras?.cardsHtml, extra: extras ? { footer: extras.footer, pixel: extras.pixel } : undefined };
    // To a lead it is a note from one person (lands in the main inbox, reads as human); to a student, the academy's letterhead.
    const mail = extras ? personalEmail(mailInput) : workflowEmail(mailInput);
    const m = await sendMail({ dept: run.departmentId || undefined, to: run.record.email, toName: run.record.name, subject: threadSubject || mail.subject, html: mail.html, text: mail.text, link: null, taskId: run.id, deliverableId, ...(replyTo ? { inReplyTo: replyTo } : {}), ...(extras ? { fromName: run.agentName, headers: unsubscribeHeaders(extras.unsub) } : {}) });
    sent.push(m.error ? `email failed (${m.error})` : m.delivery === 'smtp' ? 'email sent' : 'email saved to the Inbox (Safe Test Mode)');
    if (!m.error) delivered++;
  }
  if ((channel === 'whatsapp' || channel === 'email_whatsapp') && run.record.phone) {
    const ti = getTenantIntegrations(currentTenantId());
    const text = channel === 'whatsapp' ? `${draft.body}\n\n${draft.ask}` : whatsappText(draft, first, run.agentName);
    const r = ti.whatsappUrl || (currentTenantId() === DEFAULT_TENANT_ID && process.env.WHATSAPP_API_URL)
      ? await sendWhatsApp({ toPhone: run.record.phone, learnerName: run.record.name, text })
      : ti.manychatApiKey
        ? await sendManyChat({ email: run.record.email, phone: run.record.phone, learnerName: run.record.name, text })
        : { ok: false, detail: 'WhatsApp is not connected (Channels & API)' };
    sent.push(`WhatsApp: ${r.detail}`);
    if (r.ok) delivered++;
  }
  if (!sent.length) sent.push('nothing sent: no email or phone for this channel');
  bump('dispatched');
  if (delivered && run.departmentId === 'dep_admissions') bumpStat('aiSends');
  if (delivered && leadRec && extras?.resourceIds.length) {
    setRecordField(leadRec.sourceId, leadRec.key, 'nurture_res', [...(leadRec.fields.nurture_res || '').split('|').filter(Boolean), ...extras.resourceIds].slice(-50).join('|'));
  }
  if (run.record.sourceId) {
    setRecordField(run.record.sourceId, run.record.key, 'last_contacted', isoDate(new Date()));
    setRecordField(run.record.sourceId, run.record.key, 'last_contacted_by', run.agentName);
    if (delivered) appendConversation(run.record.sourceId, run.record.key, 'us', `${draft.body}${draft.ask ? ` ${draft.ask}` : ''}`, run.agentName);
  }
  // Failed only when no channel delivered (an unconnected WhatsApp next to a sent email is a note, not a failure).
  addLog(run, step, delivered ? 'ok' : 'fail', `${delivered ? 'Sent' : 'Could not send'} "${draft.subject}": ${sent.join('; ')}.`, draft.body);
  log('system', 'email', `${tag(run)} ${draft.subject} → ${run.record.name}: ${sent.join('; ')}.`);
}

/** A person approved (or rejected) a held message: send it and carry on, or stop. */
export async function onAgentApproval(runId: string, approved: boolean, deliverable: Deliverable | null, channel: MessageChannel | undefined) {
  const run = getAgentRun(runId);
  if (!run || run.status !== 'awaiting_approval') return;
  const c = deliverable?.content as CheckInMessage | undefined;
  if (c?.library) {
    // A saved message or voucher: rejected, it is skipped and the journey carries on; approved, it goes from the library.
    if (approved) {
      await sendHeldLibrary(run, c.library, deliverable);
    } else {
      addLog(run, null, 'info', `A person decided not to send "${c.subject}". It was skipped; the journey carries on.`);
      if (deliverable) upsertDeliverable({ ...deliverable, status: 'rejected' });
    }
    run.status = 'running';
    saveRun(run);
    void advance(run.id, currentTenantId());
    return;
  }
  if (!approved) {
    addLog(run, null, 'info', 'A person decided not to send the message. The run stops here.');
    finish(run, 'stopped', 'Stopped by a person.');
    return;
  }
  const draft: DraftMessage = { subject: c?.subject || run.vars.last_subject || 'A note from us', body: c?.body || run.vars.last_message || '', ask: c?.ask || '', viaAi: true };
  if (deliverable) upsertDeliverable({ ...deliverable, status: 'dispatched' });
  await deliver(run, null, draft, channel || 'email', deliverable?.id || null);
  run.status = 'running';
  saveRun(run);
  void advance(run.id, currentTenantId());
}

/* ── Saved messages (the library) ─────────────────────────────────────────── */

/** Sends a saved message. Returns a reason when the journey should end here (the lead applied or unsubscribed). */
async function doLibrary(run: AgentRun, step: AgentStep): Promise<string | null> {
  const rec = run.record.sourceId ? getRecord(run.record.sourceId, run.record.key) : null;
  const first = run.record.name.split(/\s+/)[0];
  if (!rec) {
    addLog(run, step, 'fail', 'Saved messages go to people on a list (leads, prospects, the tracker); this run is not about one.');
    return null;
  }
  // A lead who applied or unsubscribed is not nurtured any further.
  if (rec.sourceId === LEADS_SOURCE_ID) {
    if (rec.fields.opted_out === 'yes') return `${first} unsubscribed, so the nurturing ends here.`;
    if (/^(applied|enrolled|registered|student)$/i.test((rec.fields.status || '').trim())) return `${first} has already ${/applied/i.test(rec.fields.status) ? 'applied' : 'enrolled'}, so the nurturing ends here.`;
  }
  const { freshResource, getMessage, isLive, pickMessage, pickOngoing, renderForLead, sendLibraryMessage, writePersonalLine } = await import('@/lib/nurture/library');
  const stage = step.stage || 'learn';
  const f = fieldsFor(run);
  if (stage === 'ongoing' && f.replied === 'yes' && Number(f.replied_at_ms || 0) > Date.now() - 3 * 86_400_000) {
    addLog(run, step, 'skip', `${first} is talking with us right now, so nothing extra goes this time.`);
    return null;
  }
  const msg = step.messageId ? getMessage(step.messageId) : stage === 'ongoing' ? pickOngoing(f) : pickMessage(f, stage as Exclude<typeof stage, 'ongoing'>);
  if (!msg && stage === 'ongoing') {
    // Nothing new in the library for them: a short personal check-in instead, so the nurturing never goes quiet.
    await doMessage(run, { id: `${step.id}_ci`, kind: 'ai_message', title: 'A personal check-in', channel: 'email', review: true, instructions: KEEP_IN_TOUCH });
    return null;
  }
  if (!msg) {
    addLog(run, step, 'skip', step.messageId ? 'The saved message this step sends was deleted.' : `No approved "${stage}" message left that fits ${first}. Approve or write one in Lead Nurturing → Messages.`);
    return null;
  }
  if (!isLive(msg)) {
    addLog(run, step, 'skip', `"${msg.name}" is ${msg.status === 'approved' ? 'an offer that has ended' : 'not approved yet'}, so it was not sent.`);
    return null;
  }
  if (msg.repeatable && !freshResource(rec.fields)) {
    addLog(run, step, 'skip', `${first} has had every guide and video that fits them.`);
    return null;
  }
  const line = step.personalLine ? await writePersonalLine(rec) : null;
  if (approvalRequired()) {
    // Approval Mode: the lead's email waits in the Inbox exactly as it will look; it is sent from the library when approved.
    const r = renderForLead(msg, rec, { name: run.agentName, office: run.departmentName }, { personalLine: line || undefined });
    holdForApproval(run, { subject: r.subject, body: r.text, ask: '', html: r.html, library: { messageId: msg.id, ...(line ? { personalLine: line } : {}), ...(step.channel ? { channel: step.channel } : {}) } }, step.channel || msg.channel, `Saved message "${msg.name}" (approved in the library). Waiting for a person to approve sending it to ${first} (Approval Mode is on).`);
    addLog(run, step, 'wait', `"${msg.name}" is ready for ${first}${line ? ' with a personal line' : ''}. Waiting for approval in the Inbox before it goes.`, r.text);
    log('system', 'draft', `${tag(run)} "${msg.name}" for ${run.record.name} is waiting for approval.`);
    return null;
  }
  const r = await sendLibraryMessage({ rec, msg, sender: { name: run.agentName, office: run.departmentName }, channel: step.channel, personalLine: line || undefined, taskId: run.id });
  run.vars.last_subject = msg.subject;
  run.vars.last_library = msg.id;
  addLog(run, step, r.skipped ? 'skip' : r.ok ? 'ok' : 'fail', `${r.ok ? 'Sent' : r.skipped ? 'Skipped' : 'Could not send'} the saved message "${msg.name}"${line ? ' with a personal line' : ''} (no AI${line ? ' except that line' : ''}): ${r.detail}`);
  log('system', 'email', `${tag(run)} "${msg.name}" → ${run.record.name}: ${r.detail}`);
  return null;
}

const KEEP_IN_TOUCH = 'A short, warm check-in with something new: one useful thing about their programme or how studying with us works, or a fresh angle on what is likely holding them back (from the conversation and what they looked at). Never repeat an earlier message. End with one easy next step. Under 110 words.';

/** This agent takes the person over: other active runs about them in the same department stop. */
function takeOver(run: AgentRun): number {
  let n = 0;
  for (const r of doc.get()) {
    if (r.id === run.id || !ACTIVE.includes(r.status) || r.departmentId !== run.departmentId) continue;
    if (r.record.key !== run.record.key || r.record.sourceId !== run.record.sourceId) continue;
    addLog(r, null, 'info', `${run.agentName} took ${run.record.name.split(/\s+/)[0]} over.`);
    finish(r, 'stopped', `Handed to ${run.agentName}.`);
    n++;
  }
  return n;
}

/* ── Vouchers (codes made by code, from offers the team approved) ────────── */

async function doVoucher(run: AgentRun, step: AgentStep) {
  const rec = run.record.sourceId ? getRecord(run.record.sourceId, run.record.key) : null;
  const first = run.record.name.split(/\s+/)[0];
  if (!rec) { addLog(run, step, 'fail', 'A voucher goes to a person on a list (a lead).'); return; }
  if (rec.fields.opted_out === 'yes') { addLog(run, step, 'skip', `${first} unsubscribed.`); return; }
  const { bestOfferFor } = await import('@/lib/nurture/vouchers');
  const { offerMessage, sendLibraryMessage } = await import('@/lib/nurture/library');
  const offer = bestOfferFor(rec, step.voucherOfferId);
  if (!offer) { addLog(run, step, 'skip', step.voucherOfferId ? `That voucher is not active, or ${first} already has it.` : `No active voucher to give ${first} (Lead Nurturing → Vouchers).`); return; }
  if (approvalRequired()) {
    // The code is made only when a person approves, so a rejected voucher never exists.
    const { renderForLead } = await import('@/lib/nurture/library');
    const { expiresFor } = await import('@/lib/nurture/vouchers');
    const r = renderForLead(offerMessage(offer), rec, { name: run.agentName, office: run.departmentName }, { voucher: { code: 'CODE-ON-APPROVAL', expiresAt: expiresFor(offer), offer } });
    holdForApproval(run, { subject: r.subject, body: r.text, ask: '', html: r.html, library: { voucherOfferId: offer.id, ...(step.channel ? { channel: step.channel } : {}) } }, step.channel || 'email', `The "${offer.name}" voucher for ${first}. Its code is made when a person approves (Approval Mode is on).`);
    addLog(run, step, 'wait', `The "${offer.name}" voucher for ${first} is ready. Waiting for approval in the Inbox; the code is made when it is approved.`, r.text);
    log('system', 'draft', `${tag(run)} Voucher "${offer.name}" for ${run.record.name} is waiting for approval.`);
    return;
  }
  const r = await sendLibraryMessage({ rec, msg: offerMessage(offer), sender: { name: run.agentName, office: run.departmentName }, channel: step.channel, taskId: run.id });
  const code = getRecord(rec.sourceId, rec.key)?.fields.voucher_code || '';
  run.vars.voucher_code = code;
  addLog(run, step, r.ok ? 'ok' : r.skipped ? 'skip' : 'fail', r.ok ? `Gave ${first} the "${offer.name}" voucher ${code}: ${r.detail}` : `Voucher not sent: ${r.detail}`);
  log('system', 'approve', `${tag(run)} Voucher "${offer.name}" → ${run.record.name}: ${r.detail}`);
}

/** A held saved message or voucher was approved: send it now, from the library (a voucher's code is made here). */
async function sendHeldLibrary(run: AgentRun, held: NonNullable<CheckInMessage['library']>, deliverable: Deliverable | null) {
  const rec = run.record.sourceId ? getRecord(run.record.sourceId, run.record.key) : null;
  const first = run.record.name.split(/\s+/)[0];
  if (!rec) { addLog(run, null, 'fail', 'The person is no longer on the list, so nothing was sent.'); return; }
  const { offerMessage, resolveMessage, sendLibraryMessage } = await import('@/lib/nurture/library');
  const sender = { name: run.agentName, office: run.departmentName };
  let msg = held.messageId ? resolveMessage(held.messageId) : null;
  if (held.voucherOfferId) {
    const { bestOfferFor } = await import('@/lib/nurture/vouchers');
    const offer = bestOfferFor(rec, held.voucherOfferId);
    if (!offer) { addLog(run, null, 'skip', `The voucher is no longer active, or ${first} already has it, so nothing was sent.`); return; }
    msg = offerMessage(offer);
  }
  if (!msg) { addLog(run, null, 'skip', 'The saved message was deleted before it was approved, so nothing was sent.'); return; }
  const r = await sendLibraryMessage({ rec, msg, sender, channel: held.channel, personalLine: held.personalLine, taskId: run.id });
  if (deliverable) upsertDeliverable({ ...deliverable, status: r.ok ? 'dispatched' : deliverable.status });
  const code = held.voucherOfferId ? getRecord(rec.sourceId, rec.key)?.fields.voucher_code || '' : '';
  if (code) run.vars.voucher_code = code;
  run.vars.last_subject = msg.subject;
  addLog(run, null, r.ok ? 'ok' : r.skipped ? 'skip' : 'fail', `Approved by a person. ${r.ok ? 'Sent' : r.skipped ? 'Skipped' : 'Could not send'} "${msg.name}"${code ? ` with voucher ${code}` : ''}: ${r.detail}`);
  log('system', 'email', `${tag(run)} Approved: "${msg.name}" → ${run.record.name}: ${r.detail}`);
}

/* ── A personal video for one lead ──────────────────────────────────────── */

async function doVideo(run: AgentRun, step: AgentStep) {
  const rec = run.record.sourceId ? getRecord(run.record.sourceId, run.record.key) : null;
  if (!rec) { addLog(run, step, 'fail', 'A personal video is for a person on a list (a lead).'); return; }
  // The programme video, reused: their greeting (name, programme, quiz result, how they pay) comes from their record.
  // No AI scenes per lead: nothing to pay for, and nothing it could get wrong about them.
  const { videoFor } = await import('@/lib/nurture/video');
  const { leadProgramme } = await import('@/lib/nurture/programmes');
  const base = videoFor(leadProgramme(rec.fields) || 'general');
  if (!base) { addLog(run, step, 'skip', 'No video this time: there is no programme video yet (Lead Nurturing → Quiz & videos), so the next message goes without one.'); return; }
  run.vars._video = 'yes';
  addLog(run, step, 'ok', `${run.record.name.split(/\s+/)[0]} gets "${base.title}" with a greeting made from their record. The next message links to it.`);
}

/* ── Lessons, calls, the team ─────────────────────────────────────────────── */

async function doLesson(run: AgentRun, step: AgentStep) {
  const adapter = getLmsAdapter(getState().settings.lmsMode);
  const students = await adapter.listStudents().catch(() => []);
  const email = run.record.email.toLowerCase();
  const plainId = run.record.fields?.id || (run.record.key.startsWith('id:') ? run.record.key.slice(3) : run.record.key);
  const learner = students.find((s) => (email && s.email.toLowerCase() === email) || s.id === plainId);
  if (!learner) {
    addLog(run, step, 'fail', `${run.record.name} is not on the LMS roster, so the tutoring team cannot build a lesson. Connect Moodle or add the learner.`);
    return;
  }
  const n = Math.max(3, Math.min(15, step.questionCount || 10));
  const pass = Math.max(30, Math.min(100, step.passMark || 70));
  const { enqueue } = await import('./automation');
  enqueue({
    goal: `${run.agentName} (${run.departmentName}): build ${learner.name.split(' ')[0]} a personal video lesson and a ${n}-question test on what they got wrong, check it, and send it.`,
    trigger: { kind: 'workflow', label: `${run.departmentName} · ${run.agentName}` },
    focus: [learner.id],
    workflowId: run.workflowId,
    workflowInstructions: step.instructions,
    quizQuestions: n,
    passMark: pass,
    agentRunId: run.id,
  });
  run.vars.lesson_requested_at = new Date().toISOString();
  addLog(run, step, 'ok', `Handed to the tutoring team: a personal video lesson and a ${n}-question test (pass mark ${pass}%).`);
}

async function doCall(run: AgentRun, step: AgentStep) {
  if (!run.record.phone) { addLog(run, step, 'skip', 'No phone number on the record.'); return; }
  if (approvalRequired()) { addLog(run, step, 'skip', 'Approval Mode is on: calls are only placed automatically when it is off.'); return; }
  if (!dialerReady()) { addLog(run, step, 'skip', 'The dialer is not connected or Live Outreach is off, so no call was placed.'); return; }
  const ac = getAcademyContext();
  const first = run.record.name.split(/\s+/)[0];
  const f = fieldsFor(run);
  const r = await placeCall({
    name: run.record.name,
    phone: run.record.phone,
    email: run.record.email,
    greeting: `Hi ${first}, it's ${run.agentName} from ${ac.academyName}. Just so you know, this call is recorded.`,
    instructions: `${step.instructions || step.title}\nFacts you may use: ${Object.entries(f).filter(([k, v]) => v && /name|programme|interest|amount_due_display|due_date_display|status|last_subject/.test(k)).map(([k, v]) => `${k}: ${v}`).join('; ')}. Keep it under a minute, be kind, never label or threaten.`,
    maxSeconds: 90,
  });
  addLog(run, step, r.ok ? 'ok' : 'fail', r.ok ? `Call placed (${r.callId}).` : `Call not placed: ${r.error}`);
}

async function doNotify(run: AgentRun, step: AgentStep, tenantId: string) {
  const ti = getTenantIntegrations(tenantId);
  // Each kind of escalation goes to its own person (Channels & API → Escalations); the manager gets the rest.
  const kind = escalationType(run);
  const to = escalationTo({ stepEmail: step.notifyEmail, type: kind, routes: ti.escalations, manager: ti.managerEmail || (tenantId === DEFAULT_TENANT_ID ? process.env.MANAGER_EMAIL : '') });
  const extra = run.record.key === '__report__' && run.record.sourceId ? `Data: ${reportData(run.record.sourceId)}` : undefined;
  const brief = await briefTeam(mindFor(run, extra), step.instructions || step.title);
  if (!to) {
    addLog(run, step, 'info', `No one is set to receive ${kind ? `"${ESCALATION_LABEL[kind].title}"` : 'this'} (Channels & API → Escalations), so the brief is kept here only.`, brief.body);
    return;
  }
  const mail = workflowEmail({ recipientName: 'team', subject: brief.subject, body: brief.body, agentName: run.agentName, officeName: run.departmentName });
  const m = await sendMail({ dept: run.departmentId || undefined, to, toName: 'Team', subject: mail.subject, html: mail.html, text: mail.text, link: null, taskId: run.id, deliverableId: null });
  addLog(run, step, m.error ? 'fail' : 'ok', `Briefed ${to}${m.delivery === 'smtp' ? '' : ' (saved to the Inbox, Safe Test Mode)'}: ${brief.subject}.`, brief.body);
}

/* ── The pump ─────────────────────────────────────────────────────────────── */

/** Continue every run whose wait is over. */
export function resumeDueRuns(tenantId = currentTenantId()) {
  const now = Date.now();
  for (const r of doc.get(tenantId)) {
    if (r.status === 'waiting' && r.resumeAt !== null && r.resumeAt <= now && !locks.has(r.id)) {
      r.status = 'running';
      r.resumeAt = null;
      void advance(r.id, tenantId);
    }
  }
}

/** Someone pressed "Continue now" on a waiting run. */
export function resumeNow(runId: string): boolean {
  const run = getAgentRun(runId);
  if (!run || run.status !== 'waiting') return false;
  run.status = 'running';
  run.resumeAt = null;
  addLog(run, null, 'info', 'A person skipped the wait.');
  saveRun(run);
  void advance(run.id, currentTenantId());
  return true;
}

export function stopRun(runId: string): boolean {
  const run = getAgentRun(runId);
  if (!run || !ACTIVE.includes(run.status)) return false;
  finish(run, 'stopped', 'Stopped by a person.');
  return true;
}

/** Stop every active run about one person (they unsubscribed, or a person said so). */
export function stopRunsFor(email: string, key: string, why: string, exceptRunId?: string): number {
  const e = email.trim().toLowerCase();
  let n = 0;
  for (const r of doc.get()) {
    if (!ACTIVE.includes(r.status) || r.id === exceptRunId) continue;
    if (!((e && r.record.email.toLowerCase() === e) || r.record.key === key)) continue;
    addLog(r, null, 'info', why);
    finish(r, 'stopped', 'Stopped.');
    n++;
  }
  return n;
}

/** A contact replied: their follow-up loops stop at the next check, and the reply is on the record. */
export function noteReply(email: string, text: string, recordUpdates: (field: string, value: string) => void) {
  const e = email.trim().toLowerCase();
  recordUpdates('replied', 'yes');
  recordUpdates('replied_at_ms', String(Date.now()));
  recordUpdates('last_reply', text.slice(0, 600));
  for (const r of doc.get()) {
    if (ACTIVE.includes(r.status) && r.record.email.toLowerCase() === e) {
      r.vars.replied = 'yes';
      r.vars.replied_at_ms = String(Date.now());
      r.vars.last_reply = text.slice(0, 600);
      addLog(r, null, 'info', `${r.record.name.split(' ')[0]} replied: "${text.replace(/\s+/g, ' ').slice(0, 140)}"`);
      saveRun(r);
    }
  }
}

/** New facts about a person (an LMS event, a sheet change): active runs see them at their next check. */
export function noteFacts(email: string, facts: Record<string, string>) {
  const e = email.trim().toLowerCase();
  if (!e) return;
  for (const r of doc.get()) {
    if (!ACTIVE.includes(r.status) || r.record.email.toLowerCase() !== e) continue;
    Object.assign(r.vars, facts);
    saveRun(r);
  }
}

/** Was a run started for this workflow and record within the last hours? (scheduled checks use it) */
export function ranRecently(workflowId: string, key: string, hours: number): boolean {
  const since = Date.now() - hours * 3_600_000;
  return doc.get().some((r) => r.workflowId === workflowId && r.record.key === key && (r.startedAt > since || ACTIVE.includes(r.status)));
}

/** The tutoring team finished (or could not finish) the study pack an agent asked for. */
export function noteLessonOutcome(runId: string, detail: string, ok: boolean) {
  const run = getAgentRun(runId);
  if (!run) return;
  addLog(run, null, ok ? 'ok' : 'fail', detail);
  saveRun(run);
}

/** A learner finished their test: record the result on every active run about them. */
export function noteQuizResult(email: string, pct: number, passed: boolean) {
  const e = email.trim().toLowerCase();
  for (const r of doc.get()) {
    if (r.record.email.toLowerCase() !== e) continue;
    if (!ACTIVE.includes(r.status) && (r.endedAt || 0) < Date.now() - 14 * 86_400_000) continue;
    r.vars.quiz_score = String(pct);
    r.vars.quiz_passed = passed ? 'yes' : 'no';
    addLog(r, null, passed ? 'ok' : 'info', `${r.record.name.split(' ')[0]} took the test: ${pct}% (${passed ? 'passed' : 'below the pass mark'}).`);
    saveRun(r);
  }
}
