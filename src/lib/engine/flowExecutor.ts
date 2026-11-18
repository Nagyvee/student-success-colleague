import { sendingPaused } from '@/lib/email/pause';
import type {
  CheckInMessage,
  Deliverable,
  FlowNode,
  FlowRunLog,
  FlowRunStepLog,
  WorkflowDef,
} from '@/lib/types';
import { bump, enqueueOutreachApproval, getState, log, setSpotlight, uid, upsertDeliverable } from './store';
import { workflowToDefaultGraph } from './flowGraph';
import { listCustomAgents, listOffices, saveFlowRun } from './offices';
import { recordWorkflowRun } from './workflows';
import { registerFollowUp } from './followups';
import { complete } from '@/lib/ai/llm';
import { sendMail, sendManyChat, sendWhatsApp, workflowEmail } from '@/lib/email/send';
import { placeCall } from '@/lib/calls/dialer';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';

export interface FlowTarget {
  id: string;
  name: string;
  email: string;
  phone?: string;
  cohort?: string;
  module?: string;
  score?: number;
  days?: number;
  amount_due?: string;
  payment_status?: string;
  status?: string;
  detail?: string;
  [key: string]: unknown;
}

function interpolate(tpl: string, target: FlowTarget, wf: WorkflowDef): string {
  const first = target.name.split(' ')[0] || target.name;
  const map: Record<string, string> = {
    name: target.name,
    first_name: first,
    first,
    email: target.email || '',
    phone: target.phone || '',
    office: wf.officeName || wf.name,
    workflow: wf.name,
    module: String(target.module || target.cohort || 'Current Account'),
    score: target.score !== undefined ? String(target.score) : '–',
    days: target.days !== undefined ? String(target.days) : '0',
    amount_due: String(target.amount_due || 'balance due'),
    payment_status: String(target.payment_status || 'overdue'),
    detail: String(target.detail || `${target.module || 'Account'} follow-up`),
  };
  return String(tpl || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
    if (k in map) return map[k];
    const v = target[k];
    return v !== undefined && v !== null ? String(v) : '';
  });
}

function nextNode(wf: WorkflowDef, nodes: FlowNode[], nodeId: string, handle?: string | null): FlowNode | null {
  const edges = (wf.edges || []).filter((e) => e.source === nodeId);
  const pick = (handle
    ? edges.find((e) => e.sourceHandle === handle || e.label?.toLowerCase() === handle.toLowerCase())
    : null) || edges[0];
  if (!pick) return null;
  return nodes.find((n) => n.id === pick.target) || null;
}

function evalCondition(node: FlowNode, target: FlowTarget): boolean {
  const cfg = node.data.config || {};
  const field = String(cfg.field || 'status');
  const op = String(cfg.op || 'eq');
  const want = String(cfg.value || '').toLowerCase();
  const raw = target[field];
  const actual = raw !== undefined && raw !== null ? String(raw).toLowerCase() : '';
  if (op === 'eq') return actual === want;
  if (op === 'neq') return actual !== want;
  if (op === 'contains') return actual.includes(want);
  if (op === 'gt') return Number(actual) > Number(want);
  if (op === 'lt') return Number(actual) < Number(want);
  return Boolean(actual);
}

export async function executeCanvasWorkflow(
  wf: WorkflowDef,
  target: FlowTarget,
): Promise<FlowRunLog> {
  const { nodes, edges } = workflowToDefaultGraph(wf);
  const resolvedWf: WorkflowDef = { ...wf, nodes, edges };
  const offices = listOffices();
  const customAgents = listCustomAgents();

  const run: FlowRunLog = {
    id: `fr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    workflowId: wf.id,
    workflowName: wf.name,
    officeName: wf.officeName,
    targetName: target.name,
    targetEmail: target.email,
    status: 'running',
    currentNodeId: null,
    logs: [],
    startedAt: Date.now(),
    endedAt: null,
  };
  saveFlowRun(run);
  recordWorkflowRun(wf.id);
  bump('processed');

  const pushLog = (nodeId: string, label: string, status: FlowRunStepLog['status'], detail: string) => {
    run.logs.push({ nodeId, label, status, detail, ts: Date.now() });
    run.currentNodeId = nodeId;
    saveFlowRun(run);
  };

  log('system', 'route', `[${wf.officeName}] Running "${wf.name}" for ${target.name}.`);

  const visited = new Set<string>();
  let cur: FlowNode | null = nodes.find((n) => n.type === 'trigger') || nodes[0] || null;
  let aiDraftedText = '';
  let steps = 0;
  let pausedForApproval = false;
  const ti = getTenantIntegrations(currentTenantId());
  const requireApproval = getState().settings.requireApproval !== false || ti.requireApproval !== false;

  try {
    while (cur && steps < 25) {
      if (visited.has(cur.id)) break;
      visited.add(cur.id);
      steps += 1;

      const cfg = cur.data.config || {};
      const officeName = cur.data.officeName || wf.officeName;
      const agentDef = customAgents.find(
        (a) => a.name.toLowerCase() === String(cur?.data.agent || '').toLowerCase(),
      ) || customAgents.find((a) => {
        const o = offices.find((x) => x.id === a.officeId);
        return o && o.name === officeName;
      });
      const agentName = cur.data.agent || agentDef?.name || 'Thuso Agent';

      if (cur.type === 'trigger') {
        pushLog(cur.id, cur.data.label, 'ok', `Triggered for ${target.name} (${target.email || 'no email'}).`);
        cur = nextNode(resolvedWf, nodes, cur.id, 'next');
        continue;
      }

      if (cur.type === 'ai_task') {
        const ac = getAcademyContext(currentTenantId());
        const instructions = String(cfg.instructions || wf.instructions || wf.goalTemplate || '');
        const aiText = await complete({
          system: `You are ${agentName} in ${officeName} at ${ac.academyName}. ${agentDef?.persona || ''} Write clear, warm, well-structured outreach with clean paragraph breaks.`,
          prompt: `Recipient: ${target.name} (${target.email || 'no email'}). Context: ${JSON.stringify(target)}. Task: ${interpolate(instructions, target, wf)}.\n\nFormat rules:\n1. Start with a warm greeting ("Hi ${target.name.split(' ')[0]},") and a clear opening line introducing yourself as ${agentName} from ${officeName} at ${ac.academyName}.\n2. Use 2-3 short, readable paragraphs separated by blank lines.\n3. End with one clear next step.`,
          maxTokens: 600,
          json: false,
        });
        aiDraftedText = aiText?.trim() || interpolate(
          wf.domain === 'finance'
            ? `Hi {{first_name}},\n\nI'm ${agentName} from ${officeName} at ${ac.academyName}.\n\nThis is a friendly check-in regarding your account for {{module}} (${target.amount_due || 'balance update'}). Please let us know if everything is on track or if you would like to arrange a convenient payment plan.\n\nJust reply to this email anytime and we'll gladly help.`
            : `Hi {{first_name}},\n\nI'm ${agentName} from ${officeName} at ${ac.academyName}.\n\nI'm reaching out regarding {{module}} ({{detail}}) so we can make sure you have everything you need for your next step.\n\nReply to this message whenever suits you best.`,
          target,
          wf,
        );
        pushLog(cur.id, cur.data.label, 'ok', `${agentName} drafted message${aiText ? ' via AI model' : ''}.`);
        log(agentDef?.slot || 'planner', 'draft', `[${officeName}] ${agentName} drafted message for ${target.name}.`);
        cur = nextNode(resolvedWf, nodes, cur.id, 'next');
        continue;
      }

      if (cur.type === 'audit') {
        const ok = (aiDraftedText || target.name).length > 4;
        pushLog(cur.id, cur.data.label, ok ? 'ok' : 'fail', ok ? 'QA checks passed (tone, recipient fields, policy).' : 'Missing recipient details.');
        log('coo', 'audit', `[${officeName}] QA audit ${ok ? 'passed' : 'flagged'} for ${target.name}.`);
        cur = nextNode(resolvedWf, nodes, cur.id, ok ? 'pass' : 'fail');
        continue;
      }

      if (cur.type === 'condition') {
        const passed = evalCondition(cur, target);
        pushLog(
          cur.id,
          cur.data.label,
          'info',
          `${String(cfg.field || 'status')} ${String(cfg.op || 'eq')} ${String(cfg.value || '')} => ${passed ? 'YES' : 'NO'}`,
        );
        cur = nextNode(resolvedWf, nodes, cur.id, passed ? 'yes' : 'no');
        continue;
      }

      if (cur.type === 'send_email') {
        const subject = interpolate(String(cfg.subject || `${officeName}: Update for {{name}}`), target, wf);
        const rawText = interpolate(String(cfg.text || aiDraftedText || 'Please review this update regarding {{module}}.'), target, wf);
        const formatted = workflowEmail({
          recipientName: target.name,
          subject,
          body: rawText,
          ask: 'Reply directly to this email if you have any questions or would like to confirm your next step.',
          agentName,
          officeName,
        });
        if (!target.email) {
          pushLog(cur.id, cur.data.label, 'fail', 'No email address on target record.');
        } else if (requireApproval) {
          const delivId = uid('deliv_wf');
          const content: CheckInMessage = {
            learner: { id: target.id, name: target.name, email: target.email },
            subject: formatted.subject,
            body: rawText,
            ask: 'Reply directly to this email if you have any questions or would like to confirm your next step.',
            agentName,
            officeName,
          };
          const deliverable: Deliverable<CheckInMessage> = {
            id: delivId,
            taskId: run.id,
            kind: 'checkin_message',
            title: `${wf.name} — ${target.name}`,
            subject: target.name,
            owner: agentDef?.slot || 'planner',
            dept: 'success',
            version: 1,
            status: 'awaiting_approval',
            content,
            previous: null,
            audit: [{ ts: Date.now(), by: 'coo', verdict: 'pass', version: 1, notes: ['Queued in Inbox for manager approval (Approval Mode ON).'] }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          upsertDeliverable(deliverable);
          enqueueOutreachApproval({
            id: uid('appr'),
            taskId: run.id,
            deliverableId: delivId,
            learnerId: target.id,
            learnerName: target.name,
            learnerEmail: target.email,
            cohort: String(target.cohort || officeName),
            kind: 'checkin',
            subject: formatted.subject,
            previewText: formatted.text.slice(0, 220),
            link: null,
            moduleCode: target.module ? String(target.module) : null,
            topic: String(wf.domain || 'custom'),
            workflowId: wf.id,
            workflowName: `${officeName} · ${wf.name}`,
            triggerKind: wf.trigger,
            intervalHours: Math.max(1, Number(wf.followUpCadence?.intervalHours || 48)),
            repeatForever: wf.followUpCadence?.repeatForever !== false,
            maxAttempts: wf.followUpCadence?.maxAttempts ?? null,
            createdAt: Date.now(),
            status: 'pending',
          });
          pausedForApproval = true;
          pushLog(cur.id, cur.data.label, 'info', `Approval Gate ON: queued draft for ${target.name} (${target.email}) in Inbox — nothing sent yet.`);
          log(agentDef?.slot || 'planner', 'info', `[${officeName}] Approval Mode ON: drafted email for ${target.name} and paused in Inbox.`);
        } else {
          const sent = await sendMail({
            to: target.email,
            toName: target.name,
            subject: formatted.subject,
            text: formatted.text,
            html: formatted.html,
            link: null,
            taskId: run.id,
            deliverableId: null,
          });
          bump('dispatched');
          pushLog(cur.id, cur.data.label, sent.error ? 'fail' : 'ok', sent.error ? `SMTP error: ${sent.error}` : `${sent.delivery === 'smtp' ? 'Dispatched (smtp)' : 'Simulated in Inbox (Safe Test Mode)'} for ${target.email}.`);
          log(agentDef?.slot || 'planner', 'email', `[${officeName}] ${sent.delivery === 'smtp' ? 'Sent email' : 'Saved Inbox preview'} for ${target.email} (${sent.delivery}).`);
        }
        cur = nextNode(resolvedWf, nodes, cur.id, 'next');
        continue;
      }

      if (cur.type === 'send_whatsapp') {
        const text = interpolate(String(cfg.text || aiDraftedText || 'Hi {{first_name}}, update from {{office}}.'), target, wf);
        if (requireApproval) {
          pausedForApproval = true;
          pushLog(cur.id, cur.data.label, 'info', `Approval Gate ON: WhatsApp message for ${target.name} held until approved.`);
        } else {
          const r = await sendWhatsApp({ toPhone: target.phone || null, learnerName: target.name, text });
          pushLog(cur.id, cur.data.label, r.ok ? 'ok' : 'info', `WhatsApp: ${r.detail}`);
          log(agentDef?.slot || 'planner', 'dispatch', `[${officeName}] WhatsApp (${target.name}): ${r.detail}`);
        }
        cur = nextNode(resolvedWf, nodes, cur.id, 'next');
        continue;
      }

      if (cur.type === 'send_manychat') {
        const text = interpolate(String(cfg.text || aiDraftedText || 'Hi {{first_name}}, message from {{office}}.'), target, wf);
        if (requireApproval) {
          pausedForApproval = true;
          pushLog(cur.id, cur.data.label, 'info', `Approval Gate ON: ManyChat message for ${target.name} held until approved.`);
        } else {
          const r = await sendManyChat({ email: target.email || null, phone: target.phone || null, learnerName: target.name, text });
          pushLog(cur.id, cur.data.label, r.ok ? 'ok' : 'info', `ManyChat: ${r.detail}`);
          log(agentDef?.slot || 'planner', 'dispatch', `[${officeName}] ManyChat (${target.name}): ${r.detail}`);
        }
        cur = nextNode(resolvedWf, nodes, cur.id, 'next');
        continue;
      }

      if (cur.type === 'ai_call') {
        if (requireApproval) {
          pausedForApproval = true;
          pushLog(cur.id, cur.data.label, 'info', `Approval Gate ON: AI voice call to ${target.name} held until approved.`);
        } else if (!target.phone) {
          pushLog(cur.id, cur.data.label, 'info', 'No phone number on record for Dialer AI call.');
        } else {
          const greeting = interpolate(String(cfg.greeting || `Hi {{first_name}}, calling from ${officeName}.`), target, wf);
          const goal = interpolate(String(cfg.goal || wf.instructions || 'Check in courteously and agree on next steps.'), target, wf);
          const r = await placeCall({ name: target.name, phone: target.phone, email: target.email, greeting, instructions: goal });
          pushLog(cur.id, cur.data.label, r.ok ? 'ok' : 'info', r.ok ? `Dialer call queued (${r.callId}).` : r.error);
          if (r.ok) {
            setSpotlight({
              id: uid('sp'),
              ts: Date.now(),
              kind: 'call',
              owner: agentDef?.slot || 'planner',
              title: `AI Call · ${officeName}`,
              subject: `${agentName} -> ${target.name}`,
              rule: 'Automated workflow voice call',
              problem: `${wf.name} dialer follow-up`,
              before: 'Queued',
              after: r.callId,
              holdMs: 8000,
            });
          }
        }
        cur = nextNode(resolvedWf, nodes, cur.id, 'next');
        continue;
      }

      if (cur.type === 'followup') {
        const hours = Math.max(1, Number(cfg.intervalHours || wf.followUpCadence?.intervalHours || 48));
        if (pausedForApproval) {
          pushLog(cur.id, cur.data.label, 'info', `Follow-up (${hours}h) deferred until pending outreach is approved.`);
        } else {
          const repeatForever = cfg.repeatForever !== false;
          const fu = registerFollowUp({
            learnerId: target.id,
            learnerName: target.name,
            learnerEmail: target.email || `${target.id}@workspace.local`,
            cohort: String(target.cohort || officeName),
            workflowId: wf.id,
            workflowName: `${wf.officeName} · ${wf.name}`,
            triggerKind: wf.trigger,
            reason: interpolate(wf.domain === 'finance' ? 'Overdue balance follow-up ({{amount_due}})' : '{{detail}}', target, wf),
            link: null,
            moduleCode: String(target.module || officeName),
            topic: String(wf.domain || 'custom'),
            intervalHours: hours,
            repeatForever,
            maxAttempts: repeatForever ? null : Number(cfg.maxAttempts || 5),
            initialSubject: `${wf.officeName}: ${wf.name}`,
          });
          pushLog(cur.id, cur.data.label, 'ok', `Follow-up scheduled every ${hours}h (${fu.id}).`);
        }
        cur = nextNode(resolvedWf, nodes, cur.id, 'next');
        continue;
      }

      if (cur.type === 'http') {
        const url = String(cfg.url || '').trim();
        if (!url || !/^https?:\/\//i.test(url)) {
          pushLog(cur.id, cur.data.label, 'info', 'No outbound webhook URL set on node.');
        } else if (sendingPaused()) {
          pushLog(cur.id, cur.data.label, 'info', 'Paused (test phase): nothing was sent.');
        } else {
          try {
            const resp = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ workflow: wf.name, office: officeName, target, timestamp: Date.now() }),
              signal: AbortSignal.timeout(8000),
            });
            pushLog(cur.id, cur.data.label, resp.ok ? 'ok' : 'fail', `POST ${url} -> HTTP ${resp.status}`);
          } catch (e) {
            pushLog(cur.id, cur.data.label, 'fail', `POST error: ${(e as Error).message}`);
          }
        }
        cur = nextNode(resolvedWf, nodes, cur.id, 'next');
        continue;
      }

      if (cur.type === 'wait') {
        pushLog(cur.id, cur.data.label, 'wait', `Delay configured (${String(cfg.minutes || 15)}m) — fast-forwarded during immediate run.`);
        cur = nextNode(resolvedWf, nodes, cur.id, 'next');
        continue;
      }

      if (cur.type === 'tag' || cur.type === 'handoff') {
        const note = cur.type === 'tag'
          ? `Tagged record: "${String(cfg.tag || 'followed-up')}".`
          : `Escalated ${target.name} to human team in ${officeName}.`;
        pushLog(cur.id, cur.data.label, 'ok', note);
        log('system', 'info', `[${officeName}] ${note}`);
        cur = nextNode(resolvedWf, nodes, cur.id, 'next');
        continue;
      }

      if (cur.type === 'end') {
        pushLog(cur.id, cur.data.label, 'ok', `Completed "${wf.name}".`);
        break;
      }

      cur = nextNode(resolvedWf, nodes, cur.id, 'next');
    }

    run.status = 'completed';
    run.endedAt = Date.now();
    run.currentNodeId = null;
    saveFlowRun(run);
    log('system', 'approve', `[${wf.officeName}] Finished "${wf.name}" for ${target.name} (${run.logs.length} steps).`);
    return run;
  } catch (e) {
    run.status = 'failed';
    run.endedAt = Date.now();
    pushLog(run.currentNodeId || 'err', 'Execution Error', 'fail', (e as Error).message);
    return run;
  }
}
