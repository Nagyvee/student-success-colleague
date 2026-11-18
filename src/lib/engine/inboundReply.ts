import type { CheckInMessage, Deliverable } from '@/lib/types';
import {
  announce,
  appendMailReply,
  enqueueOutreachApproval,
  getState,
  log,
  setAgent,
  setLearner,
  setRoom,
  uid,
  upsertDeliverable,
  upsertTask,
} from './store';
import { findSyncedLearnerByEmailOrId, getLearnerMemories, recordLmsEvent } from '@/lib/db/postgres';
import { draftInboundReplyContinuation } from '@/lib/ai/agents';
import { checkInEmail, sendMail } from '@/lib/email/send';
import { listFollowUps, markFollowUpRecovered, setFollowUpStatus } from './followups';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { getAcademyContext } from '@/lib/auth/accounts';

export interface InboundReplyInput {
  fromEmail: string;
  fromName?: string;
  subject?: string;
  text: string;
  tenantId?: string;
}

export async function handleInboundStudentReply(input: InboundReplyInput) {
  const tid = input.tenantId || currentTenantId();
  const fromEmail = (input.fromEmail || '').trim().toLowerCase();
  const replyText = (input.text || '').trim();
  if (!fromEmail || !replyText) {
    return { ok: false, error: 'Missing student email or reply text.' };
  }

  // 1. Find learner in memory or Postgres DB
  const state = getState();
  const card = state.learners.find((l) => l.email.toLowerCase() === fromEmail);
  const dbRow = await findSyncedLearnerByEmailOrId(fromEmail, undefined, tid);
  const learnerId = card?.id || dbRow?.id || `reply_${fromEmail.replace(/[^a-z0-9]/g, '_')}`;
  const learnerName = card?.name || dbRow?.name || input.fromName || fromEmail.split('@')[0];
  const cohort = card?.cohort || dbRow?.cohort || 'Current Cohort';

  // 2. Append reply to the Inbox mail thread & record LMS event in Postgres memory
  appendMailReply(fromEmail, {
    from: `${learnerName} <${fromEmail}>`,
    text: replyText,
    ts: Date.now(),
  });

  await recordLmsEvent({
    tenantId: tid,
    learnerId,
    eventType: 'student.email_reply',
    source: 'email_reply',
    detail: `Student replied: "${replyText.slice(0, 220)}"`,
    rawPayload: { subject: input.subject, replyText, learnerName, learnerEmail: fromEmail, cohort },
  });

  // 3. Find any active follow-up case for this student
  const activeCases = listFollowUps().filter(
    (c) => (c.learnerId === learnerId || c.learnerEmail.toLowerCase() === fromEmail) && c.status === 'active',
  );
  const primaryCase = activeCases[0] || null;
  const previousSubject =
    input.subject ||
    primaryCase?.history[primaryCase.history.length - 1]?.subject ||
    state.inbox.find((m) => m.to.toLowerCase() === fromEmail)?.subject ||
    'Checking in on your progress';

  const taskId = uid('task_reply');
  const workflowId = primaryCase?.workflowId || 'wf_checkin_gap';

  upsertTask({
    id: taskId,
    workflowId,
    scenario: 'goal',
    title: `Inbound Reply · ${learnerName}`,
    subject: learnerName,
    goal: `Process student email reply from ${learnerName} and continue their support journey`,
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    step: 1,
    totalSteps: 2,
    stepLabel: 'Reading student reply & deciding next step',
    deliverableIds: [],
    corrections: 0,
  });

  setRoom('success', 'busy', `Reading reply from ${learnerName}`);
  setAgent('success', { status: 'working', thought: `Reading reply from ${learnerName}` });

  log('success', 'think', `Received inbound email reply from ${learnerName} (${fromEmail}): "${replyText.slice(0, 140)}"`, {
    taskId,
  });

  // 4. Draft AI continuation response
  const memories = await getLearnerMemories([learnerId], tid);
  const memorySummary = memories.get(learnerId) || '';
  const aiRes = await draftInboundReplyContinuation({
    learnerName,
    cohort,
    previousContext: previousSubject,
    replyText,
    memory: memorySummary,
  });
  const continuation = aiRes.value;

  const ctx = getAcademyContext(tid);
  const checkInContent: CheckInMessage = {
    learner: {
      id: learnerId,
      name: learnerName,
      email: fromEmail,
    },
    subject: continuation.subject,
    body: continuation.body,
    ask:
      continuation.ask ||
      (continuation.outcome === 'resolved'
        ? `Keep going with your coursework on Moodle — reply anytime if you need anything from ${ctx.academyName}.`
        : `Reply to this email to confirm what works best for you so ${ctx.senderName} at ${ctx.academyName} can lock it in.`),
  };

  const delivId = uid('deliv_reply');
  const requireApproval = Boolean(getState().settings.requireApproval);

  const deliverable: Deliverable<CheckInMessage> = {
    id: delivId,
    taskId,
    kind: 'checkin_message',
    title: `Reply Continuation — ${learnerName}`,
    subject: learnerName,
    owner: 'success',
    dept: 'success',
    version: 1,
    status: requireApproval ? 'awaiting_approval' : 'dispatched',
    content: checkInContent,
    previous: null,
    audit: [
      {
        ts: Date.now() - 800,
        by: 'success',
        verdict: 'submitted',
        version: 1,
        notes: [`Student replied: "${replyText.slice(0, 120)}". ${continuation.summary}`],
      },
      {
        ts: Date.now(),
        by: 'coo',
        verdict: 'pass',
        version: 1,
        notes: [
          requireApproval
            ? 'Queued for advisor review before sending reply continuation.'
            : 'Approved and dispatched to continue student conversation.',
        ],
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  upsertDeliverable(deliverable);

  // 5. Update follow-up case status if resolved
  if (continuation.outcome === 'resolved') {
    markFollowUpRecovered(learnerId);
    if (primaryCase) setFollowUpStatus(primaryCase.id, 'resolved');
    if (card) {
      setLearner(learnerId, {
        status: 'recovered',
        lastEvent: `Replied & resolved: "${replyText.slice(0, 50)}"`,
      });
    }
  } else if (card) {
    setLearner(learnerId, {
      status: 'intervention',
      lastEvent: `Replied: "${replyText.slice(0, 50)}"`,
    });
  }

  // 6. Either queue for human review or send immediately
  let delivery: string = 'queued_for_approval';
  if (requireApproval) {
    enqueueOutreachApproval({
      id: uid('appr'),
      createdAt: Date.now(),
      taskId,
      deliverableId: delivId,
      kind: 'checkin',
      learnerId,
      learnerName,
      learnerEmail: fromEmail,
      cohort,
      subject: continuation.subject,
      previewText: continuation.body.slice(0, 220),
      link: null,
      moduleCode: primaryCase?.moduleCode || null,
      topic: primaryCase?.topic || null,
      workflowId,
      workflowName: primaryCase?.workflowName || 'Student Reply Continuation',
      triggerKind: 'student.email_reply',
      intervalHours: primaryCase?.intervalHours || 48,
      repeatForever: primaryCase?.repeatForever ?? true,
      maxAttempts: primaryCase?.maxAttempts ?? null,
      status: 'pending',
    });
    announce('success', `${learnerName} replied — continuation draft ready for approval`, 'info');
    log(
      'coo',
      'audit',
      `Drafted reply continuation for ${learnerName} ("${continuation.subject}") — awaiting advisor approval in Inbox.`,
      { taskId, deliverableId: delivId },
    );
  } else {
    const emailPayload = checkInEmail(checkInContent);
    const sent = await sendMail({
      to: fromEmail,
      toName: learnerName,
      subject: emailPayload.subject,
      text: emailPayload.text,
      html: emailPayload.html,
      link: null,
      taskId,
      deliverableId: delivId,
    });
    delivery = sent.delivery;
    announce('success', `Replied to ${learnerName} (${continuation.outcome})`, 'good');
    log(
      'coo',
      'dispatch',
      `Sent reply continuation to ${learnerName} · "${continuation.subject}" (${continuation.outcome}).`,
      { taskId, deliverableId: delivId },
    );
  }

  upsertTask({
    id: taskId,
    workflowId,
    scenario: 'goal',
    title: `Inbound Reply · ${learnerName}`,
    subject: learnerName,
    goal: `Process student email reply from ${learnerName} and continue their support journey`,
    startedAt: Date.now() - 1200,
    endedAt: Date.now(),
    status: 'done',
    step: 2,
    totalSteps: 2,
    stepLabel:
      continuation.outcome === 'resolved'
        ? 'Student reply resolved case'
        : requireApproval
          ? 'Continuation drafted · awaiting approval'
          : 'Continuation sent',
    deliverableIds: [delivId],
    corrections: 0,
  });

  setRoom('success', 'calm', null);
  setAgent('success', { status: 'idle', thought: null });

  return {
    ok: true,
    learnerId,
    learnerName,
    outcome: continuation.outcome,
    internalNote: continuation.summary,
    continuationSubject: continuation.subject,
    continuationBody: continuation.body,
    deliverableId: delivId,
    delivery,
  };
}
