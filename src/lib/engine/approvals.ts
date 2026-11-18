import type { CheckInMessage, Deliverable, RemedialQuiz } from '@/lib/types';
import {
  announce,
  bump,
  enqueueOutreachApproval,
  getDeliverable,
  getState,
  log,
  markOutreachApproval,
  patchTask,
  setLearner,
  uid,
  upsertDeliverable,
} from './store';
import { checkInEmail, quizEmail, sendMail, sendManyChat, sendWhatsApp } from '@/lib/email/send';
import { writeBack } from '@/lib/lms/sheet';
import { getLmsAdapter, type LmsAdapter } from '@/lib/lms/lmsAdapter';
import { registerFollowUp } from './followups';
import { recordIntervention } from '@/lib/db/postgres';
import { getWorkflow } from './workflows';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';

/* Approval & Dispatch Pipeline.
 *
 * When a workspace enables Approval Mode ("requireApproval"), drafted quizzes
 * and check-ins pause in pendingOutreach until an advisor clicks Approve.
 * Both auto-send and manual Approve reuse dispatchApprovedDeliverable(). */

/** Approval Mode is on (the default): nothing reaches a student or a lead until a person approves it. */
export function approvalOn(): boolean {
  const s = getState().settings.requireApproval;
  if (typeof s === 'boolean') return s;
  return getTenantIntegrations(currentTenantId()).requireApproval !== false;
}

/** Keep a finished email (a quiz result, a notice) in the Inbox for approval; it is sent exactly as it is when approved. */
export function holdMail(input: {
  to: string; toName: string; subject: string; html: string; text: string; link?: string | null; fromName?: string;
  taskId: string; learnerId: string; label: string; agentName?: string; officeName?: string;
}): string {
  const delivId = uid('deliv_mail');
  const content: CheckInMessage = {
    learner: { id: input.learnerId, name: input.toName, email: input.to },
    subject: input.subject, body: input.text, ask: '', html: input.html,
    agentName: input.agentName, officeName: input.officeName,
    mail: { to: input.to, toName: input.toName, subject: input.subject, html: input.html, text: input.text, link: input.link ?? null, ...(input.fromName ? { fromName: input.fromName } : {}) },
  };
  upsertDeliverable({
    id: delivId, taskId: input.taskId, kind: 'agent_message', title: `${input.label} → ${input.toName}`, subject: input.toName,
    owner: 'coo', dept: 'success', version: 1, status: 'awaiting_approval', content, previous: null,
    audit: [{ ts: Date.now(), by: 'coo', verdict: 'pass', version: 1, notes: ['Ready. Waiting for a person to approve (Approval Mode is on).'] }],
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  enqueueOutreachApproval({
    id: uid('appr'), taskId: input.taskId, deliverableId: delivId, channel: 'email',
    learnerId: input.learnerId, learnerName: input.toName, learnerEmail: input.to,
    cohort: input.officeName || 'Student Success', kind: 'agent_message', subject: input.subject,
    previewText: input.text.replace(/\s+/g, ' ').slice(0, 240), link: input.link ?? null, moduleCode: null, topic: null,
    workflowId: null, workflowName: input.label, triggerKind: 'result',
    intervalHours: 0, repeatForever: false, maxAttempts: null, createdAt: Date.now(), status: 'pending',
  });
  log('system', 'draft', `${input.label}: "${input.subject}" for ${input.toName} is waiting for approval in the Inbox.`);
  return delivId;
}

function resolveChannel(workflowId: string | null) {
  const wf = workflowId ? getWorkflow(workflowId) : null;
  const ti = getTenantIntegrations(currentTenantId());
  return wf?.channel || ti.defaultChannel || 'email';
}

export async function dispatchApprovedDeliverable(input: {
  deliverable: Deliverable;
  adapter?: LmsAdapter;
  cohort: string;
  workflowId: string | null;
  workflowName: string;
  triggerKind: string;
  triggerLabel: string;
  intervalHours: number;
  repeatForever: boolean;
  maxAttempts: number | null;
  scoreBefore?: number | null;
}) {
  const adapter = input.adapter || getLmsAdapter(getState().settings.lmsMode);
  const d = input.deliverable;
  const channel = resolveChannel(input.workflowId);
  const sendWa = channel === 'whatsapp' || channel === 'all';
  const sendMc = channel === 'manychat' || channel === 'all';
  const sendEmail = channel === 'email' || channel === 'all' || (!sendWa && !sendMc);

  if (d.kind === 'remedial_quiz') {
    const q = d.content as RemedialQuiz;
    const link = `${getState().caps.baseUrl}/quiz/${q.quizId}`;
    const emailPayload = quizEmail(q, link);
    const mail = sendEmail
      ? await sendMail({
          to: q.learner.email,
          toName: q.learner.name,
          ...emailPayload,
          link,
          taskId: d.taskId,
          deliverableId: d.id,
        })
      : { delivery: 'simulated' as const };
    const st = await adapter.getStudent(q.learner.id).catch(() => null);
    const shortMsg = `Hi ${q.learner.name.split(' ')[0]}, we made you a personal video lesson on ${q.module.code} (${q.topic}) and a ${q.questions.length}-question test: ${link}`;
    if (sendWa) {
      void sendWhatsApp({ toPhone: st?.phone, learnerName: q.learner.name, text: shortMsg });
    }
    if (sendMc) {
      void sendManyChat({ email: q.learner.email, phone: st?.phone, learnerName: q.learner.name, text: shortMsg });
    }

    upsertDeliverable({ ...d, status: 'dispatched' });
    bump('dispatched');
    try { await adapter.updateStudentStatus(q.learner.id, 'intervention', `Catch-up quiz ${q.quizId} sent`); } catch { /* ignore */ }
    setLearner(q.learner.id, { status: 'intervention', lastEvent: `Quiz ${q.quizId} sent · waiting` });

    registerFollowUp({
      learnerId: q.learner.id,
      learnerName: q.learner.name,
      learnerEmail: q.learner.email,
      cohort: input.cohort,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      triggerKind: input.triggerKind,
      reason: `${q.module.code} · ${q.topic} catch-up quiz sent (${q.quizId})`,
      link,
      moduleCode: q.module.code,
      topic: q.topic,
      intervalHours: input.intervalHours,
      repeatForever: input.repeatForever,
      maxAttempts: input.maxAttempts,
      initialSubject: emailPayload.subject,
    });
    void recordIntervention({
      deliverable: d,
      learnerId: q.learner.id,
      workflowId: input.workflowId,
      moduleCode: q.module.code,
      weakTopic: q.topic,
      scoreBefore: input.scoreBefore ?? null,
      quizId: q.quizId,
    });
    void writeBack(q.learner.id, 'being helped', `Study pack and quiz sent ${new Date().toLocaleString('en-ZA')}`);
    log('coo', 'dispatch', `Sent: catch-up quiz for ${q.learner.name}. Link: ${link}`, {
      taskId: d.taskId,
      deliverableId: d.id,
      toolCall: { tool: 'comms.send_quiz', payload: { quizId: q.quizId, learner: q.learner.id, link, delivery: mail.delivery } },
    });
    return mail;
  }

  if (d.kind === 'checkin_message') {
    const m = d.content as CheckInMessage;
    const mail = sendEmail
      ? await sendMail({
          to: m.learner.email,
          toName: m.learner.name,
          ...checkInEmail(m),
          link: null,
          taskId: d.taskId,
          deliverableId: d.id,
        })
      : { delivery: 'simulated' as const };
    const st = await adapter.getStudent(m.learner.id).catch(() => null);
    const shortMsg = `${m.body}\n\n${m.ask}`;
    if (sendWa) {
      void sendWhatsApp({ toPhone: st?.phone, learnerName: m.learner.name, text: shortMsg });
    }
    if (sendMc) {
      void sendManyChat({ email: m.learner.email, phone: st?.phone, learnerName: m.learner.name, text: shortMsg });
    }

    upsertDeliverable({ ...d, status: 'dispatched' });
    bump('dispatched');
    try { await adapter.updateStudentStatus(m.learner.id, 'intervention', 'Personal check-in sent'); } catch { /* ignore */ }
    setLearner(m.learner.id, { status: 'intervention', lastEvent: 'Check-in sent · waiting for a reply' });

    registerFollowUp({
      learnerId: m.learner.id,
      learnerName: m.learner.name,
      learnerEmail: m.learner.email,
      cohort: input.cohort,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      triggerKind: input.triggerKind,
      reason: input.triggerLabel || m.subject,
      link: null,
      moduleCode: null,
      topic: null,
      intervalHours: input.intervalHours,
      repeatForever: input.repeatForever,
      maxAttempts: input.maxAttempts,
      initialSubject: m.subject,
    });
    void recordIntervention({
      deliverable: d,
      learnerId: m.learner.id,
      workflowId: input.workflowId,
    });
    void writeBack(m.learner.id, 'being helped', `Check-in sent ${new Date().toLocaleString('en-ZA')}`);
    log('coo', 'dispatch', `Sent: check-in to ${m.learner.name} · "${m.subject}".`, {
      taskId: d.taskId,
      deliverableId: d.id,
      toolCall: { tool: 'comms.send_checkin', payload: { learner: m.learner.id, delivery: mail.delivery } },
    });
    return mail;
  }

  return null;
}

export async function approveOutreachById(id: string) {
  const item = (getState().pendingOutreach || []).find((x) => x.id === id);
  if (!item || item.status !== 'pending') return null;
  const deliverable = getDeliverable(item.deliverableId);
  if (!deliverable) return null;

  // A finished email kept for approval (a quiz result): send it exactly as it is.
  const held = item.kind === 'agent_message' && !item.runId ? (deliverable.content as CheckInMessage).mail : undefined;
  if (held) {
    const resolvedMail = markOutreachApproval(id, 'approved');
    const mail = await sendMail({ ...held, link: held.link, taskId: deliverable.taskId, deliverableId: deliverable.id });
    upsertDeliverable({ ...deliverable, status: mail.error ? deliverable.status : 'dispatched' });
    bump('dispatched');
    log('coo', 'dispatch', `Approved: "${held.subject}" → ${held.toName}${mail.error ? ` (not sent: ${mail.error})` : ''}.`, { taskId: deliverable.taskId, deliverableId: deliverable.id });
    announce('coo', `Approved & sent to ${item.learnerName}`, 'good');
    return { item: resolvedMail, delivery: mail.delivery || 'simulated' };
  }

  // A department agent's message: send it and let the agent's run carry on.
  if (item.kind === 'agent_message' && item.runId) {
    const resolvedFirst = markOutreachApproval(id, 'approved');
    const { onAgentApproval } = await import('./agentRuns');
    await onAgentApproval(item.runId, true, deliverable, item.channel);
    announce('coo', `Approved & sent to ${item.learnerName}`, 'good');
    return { item: resolvedFirst, delivery: getTenantIntegrations(currentTenantId()).liveOutreachEnabled ? 'smtp' : 'simulated' };
  }

  const mail = await dispatchApprovedDeliverable({
    deliverable,
    cohort: item.cohort,
    workflowId: item.workflowId,
    workflowName: item.workflowName,
    triggerKind: item.triggerKind,
    triggerLabel: item.subject,
    intervalHours: item.intervalHours,
    repeatForever: item.repeatForever,
    maxAttempts: item.maxAttempts,
  });

  const resolved = markOutreachApproval(id, 'approved');
  announce('coo', `Approved & sent to ${item.learnerName}`, 'good');

  const remaining = (getState().pendingOutreach || []).filter((x) => x.taskId === item.taskId && x.status === 'pending').length;
  const task = getState().tasks.find((t) => t.id === item.taskId);
  if (task?.plan && remaining === 0) {
    const steps = task.plan.steps.map((s) =>
      s.key === 'deliver' ? { ...s, status: 'done' as const, result: 'Approved and sent by manager' } : s,
    );
    patchTask(task.id, { plan: { ...task.plan, steps } });
  }
  return { item: resolved, delivery: mail?.delivery || 'simulated' };
}

export function rejectOutreachById(id: string) {
  const item = (getState().pendingOutreach || []).find((x) => x.id === id);
  if (!item || item.status !== 'pending') return null;
  const d = getDeliverable(item.deliverableId);
  if (d) upsertDeliverable({ ...d, status: 'rejected' });
  const resolved = markOutreachApproval(id, 'rejected');
  if (item.kind === 'agent_message' && item.runId) {
    const runId = item.runId;
    void import('./agentRuns').then((m) => m.onAgentApproval(runId, false, d || null, item.channel));
  }
  setLearner(item.learnerId, { lastEvent: 'Outreach held / skipped by manager' });
  log('person', 'info', `Manager paused sending "${item.subject}" to ${item.learnerName}.`, {
    taskId: item.taskId,
    deliverableId: item.deliverableId,
  });
  return resolved;
}

