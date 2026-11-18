import type {
  CustomAgentDef,
  FlowEdge,
  FlowNode,
  FlowNodeType,
  OfficeDef,
  WorkflowDef,
  WorkflowDomain,
  WorkflowTrigger,
} from '@/lib/types';
import { complete } from '@/lib/ai/llm';

/* Visual DAG Flow Graph utilities & Prompt-to-Flow builder.
 *
 * Every workflow in Thuso can be viewed & edited as a zoomable node-and-edge
 * canvas (trigger -> AI steps -> branch conditions -> channels -> follow-ups). */

export const VALID_NODE_TYPES = new Set<FlowNodeType>([
  'trigger',
  'ai_task',
  'send_email',
  'send_whatsapp',
  'send_manychat',
  'ai_call',
  'followup',
  'wait',
  'condition',
  'audit',
  'http',
  'handoff',
  'tag',
  'end',
]);

export function computeLayers(nodes: FlowNode[], edges: FlowEdge[]) {
  const trigger = nodes.find((n) => n.type === 'trigger') || nodes[0];
  const levels = new Map<string, number>();
  const bias = new Map<string, number>();
  if (trigger) {
    const outMap = new Map<string, FlowEdge[]>();
    for (const e of edges) {
      const list = outMap.get(e.source) || [];
      list.push(e);
      outMap.set(e.source, list);
    }
    const q: string[] = [trigger.id];
    levels.set(trigger.id, 0);
    bias.set(trigger.id, 0);
    while (q.length) {
      const id = q.shift()!;
      const lv = levels.get(id) ?? 0;
      const b = bias.get(id) ?? 0;
      const outs = outMap.get(id) || [];
      outs.forEach((e, idx) => {
        if (!levels.has(e.target)) {
          levels.set(e.target, lv + 1);
          const h = (e.sourceHandle || '').toLowerCase();
          const d = outs.length > 1
            ? (h === 'yes' || h === 'pass' || h === 'replied' || idx === 0 ? -1 : 1)
            : 0;
          bias.set(e.target, b + d);
          q.push(e.target);
        }
      });
    }
  }
  let extra = Math.max(0, ...Array.from(levels.values())) + 1;
  for (const n of nodes) if (!levels.has(n.id)) levels.set(n.id, extra++);
  return { levels, bias };
}

export function autoLayoutNodes(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  const { levels, bias } = computeLayers(nodes, edges);
  const rows = new Map<number, FlowNode[]>();
  for (const n of nodes) {
    const lv = levels.get(n.id) ?? 0;
    const list = rows.get(lv) || [];
    list.push(n);
    rows.set(lv, list);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [lv, row] of rows.entries()) {
    row.sort((a, b) => (bias.get(a.id) ?? 0) - (bias.get(b.id) ?? 0));
    const totalW = (row.length - 1) * 300;
    row.forEach((n, idx) => {
      pos.set(n.id, { x: Math.round(440 - totalW / 2 + idx * 300), y: 50 + lv * 155 });
    });
  }
  return nodes.map((n) => ({ ...n, position: pos.get(n.id) || n.position }));
}

export function triggerLabel(trigger: WorkflowTrigger, threshold?: number): string {
  switch (trigger) {
    case 'quiz.failed': return `Quiz Score < ${threshold ?? 60}%`;
    case 'attendance.missed': return `Missed >= ${threshold ?? 2} Classes`;
    case 'assignment.missed': return `Overdue Assignments >= ${threshold ?? 1}`;
    case 'payment.overdue': return `Tuition Overdue >= ${threshold ?? 1}d`;
    case 'invoice.unpaid': return `Unpaid Invoice >= ${threshold ?? 3}d`;
    case 'login.gap': return `No Login >= ${threshold ?? 5} Days`;
    case 'whatsapp.inbound': return 'Inbound WhatsApp Message';
    case 'contact.created': return 'New Lead / Contact Added';
    case 'webhook.custom': return 'Inbound Webhook Event';
    case 'schedule': return 'Scheduled Recurring Run';
    default: return 'Manual / API Trigger';
  }
}

export function workflowToDefaultGraph(wf: WorkflowDef): { nodes: FlowNode[]; edges: FlowEdge[] } {
  if (Array.isArray(wf.nodes) && wf.nodes.length > 0) {
    return { nodes: wf.nodes, edges: Array.isArray(wf.edges) ? wf.edges : [] };
  }

  const isFinance = wf.domain === 'finance' || wf.trigger === 'payment.overdue' || wf.trigger === 'invoice.unpaid';
  const defaultAgent = isFinance ? 'Kagiso' : wf.trigger === 'quiz.failed' ? 'Lindiwe' : 'Bongani';
  const channel = wf.channel || 'email';
  const sendType: FlowNodeType =
    channel === 'whatsapp' ? 'send_whatsapp'
      : channel === 'manychat' ? 'send_manychat'
        : 'send_email';

  const nodes: FlowNode[] = [
    {
      id: `${wf.id}_t1`,
      type: 'trigger',
      position: { x: 440, y: 50 },
      data: {
        label: triggerLabel(wf.trigger, wf.threshold),
        officeName: wf.officeName,
        config: { trigger: wf.trigger, threshold: wf.threshold },
      },
    },
    {
      id: `${wf.id}_ai`,
      type: 'ai_task',
      position: { x: 440, y: 205 },
      data: {
        label: isFinance ? 'Draft Finance Follow-up' : 'Diagnose & Draft Plan',
        agent: defaultAgent,
        officeName: wf.officeName,
        config: { instructions: wf.instructions || wf.goalTemplate },
      },
    },
    {
      id: `${wf.id}_cond`,
      type: 'condition',
      position: { x: 440, y: 360 },
      data: {
        label: isFinance ? 'Invoice Still Unpaid?' : 'Needs Outreach?',
        officeName: wf.officeName,
        config: isFinance
          ? { field: 'payment_status', op: 'eq', value: 'overdue' }
          : { field: 'status', op: 'neq', value: 'recovered' },
      },
    },
    {
      id: `${wf.id}_send`,
      type: sendType,
      position: { x: 240, y: 515 },
      data: {
        label: sendType === 'send_whatsapp'
          ? 'Send WhatsApp Message'
          : sendType === 'send_manychat'
            ? 'Trigger ManyChat Flow'
            : 'Send Academy / Office Email',
        agent: defaultAgent,
        officeName: wf.officeName,
        config: {
          subject: `${wf.officeName}: Action needed for {{name}}`,
          text: isFinance
            ? 'Hi {{first_name}}, friendly reminder from {{office}}: invoice/tuition balance for {{module}} ({{amount_due}}) is overdue by {{days}} days. Reply here if you need a flexible arrangement.'
            : 'Hi {{first_name}}, {{office}} noticed an update on {{module}} ({{detail}}). Let us help you stay on track!',
        },
      },
    },
    {
      id: `${wf.id}_fu`,
      type: 'followup',
      position: { x: 240, y: 670 },
      data: {
        label: `Follow-up Every ${wf.followUpCadence?.intervalHours || 48}h`,
        agent: defaultAgent,
        officeName: wf.officeName,
        config: {
          intervalHours: wf.followUpCadence?.intervalHours || 48,
          repeatForever: wf.followUpCadence?.repeatForever !== false,
          channel,
        },
      },
    },
    {
      id: `${wf.id}_end_ok`,
      type: 'end',
      position: { x: 640, y: 515 },
      data: { label: 'Already Resolved', officeName: wf.officeName, config: {} },
    },
  ];

  const edges: FlowEdge[] = [
    { id: `${wf.id}_e1`, source: `${wf.id}_t1`, target: `${wf.id}_ai`, sourceHandle: 'next' },
    { id: `${wf.id}_e2`, source: `${wf.id}_ai`, target: `${wf.id}_cond`, sourceHandle: 'next' },
    { id: `${wf.id}_e3`, source: `${wf.id}_cond`, target: `${wf.id}_send`, sourceHandle: 'yes', label: 'yes' },
    { id: `${wf.id}_e4`, source: `${wf.id}_cond`, target: `${wf.id}_end_ok`, sourceHandle: 'no', label: 'no' },
    { id: `${wf.id}_e5`, source: `${wf.id}_send`, target: `${wf.id}_fu`, sourceHandle: 'next' },
  ];

  if (wf.trigger === 'quiz.failed' || wf.domain === 'academy') {
    const auditId = `${wf.id}_audit`;
    nodes.push({
      id: auditId,
      type: 'audit',
      position: { x: 240, y: 515 },
      data: { label: 'Musa QA Audit', agent: 'Musa', officeName: 'Quality & Compliance Review', config: {} },
    });
    const sendNode = nodes.find((n) => n.id === `${wf.id}_send`)!;
    const fuNode = nodes.find((n) => n.id === `${wf.id}_fu`)!;
    sendNode.position.y = 670;
    fuNode.position.y = 825;
    const e3 = edges.find((e) => e.id === `${wf.id}_e3`)!;
    e3.target = auditId;
    edges.push({ id: `${wf.id}_e_aud`, source: auditId, target: sendNode.id, sourceHandle: 'pass', label: 'pass' });
  }

  return { nodes: autoLayoutNodes(nodes, edges), edges };
}

function detectDomainAndTrigger(prompt: string): {
  domain: WorkflowDomain;
  trigger: WorkflowTrigger;
  defaultOffice: string;
  defaultAgent: string;
} {
  const lower = prompt.toLowerCase();
  if (/unpaid|late payment|overdue|invoice|tuition|billing|finance|debt|arrears|collection/.test(lower)) {
    return {
      domain: 'finance',
      trigger: /invoice|billing/.test(lower) ? 'invoice.unpaid' : 'payment.overdue',
      defaultOffice: 'Finance & Collections Office',
      defaultAgent: 'Kagiso',
    };
  }
  if (/lead|admiss|enrol|prospect|applic|signup|meta|crm/.test(lower)) {
    return {
      domain: 'admissions',
      trigger: /whatsapp/.test(lower) ? 'whatsapp.inbound' : 'contact.created',
      defaultOffice: 'Admissions & Enrolment Desk',
      defaultAgent: 'Zanele',
    };
  }
  if (/quiz|fail|mark|grade|assessment/.test(lower)) {
    return {
      domain: 'academy',
      trigger: 'quiz.failed',
      defaultOffice: 'Learning & Assessment Office',
      defaultAgent: 'Lindiwe',
    };
  }
  if (/attend|class|absent/.test(lower)) {
    return {
      domain: 'academy',
      trigger: 'attendance.missed',
      defaultOffice: 'Student Success Office',
      defaultAgent: 'Bongani',
    };
  }
  if (/login|inactive|silent|quiet|disengag/.test(lower)) {
    return {
      domain: 'academy',
      trigger: 'login.gap',
      defaultOffice: 'Student Success Office',
      defaultAgent: 'Bongani',
    };
  }
  if (/webhook|api/.test(lower)) {
    return {
      domain: 'custom',
      trigger: 'webhook.custom',
      defaultOffice: 'Custom Operations Office',
      defaultAgent: 'Zanele',
    };
  }
  return {
    domain: 'custom',
    trigger: 'manual',
    defaultOffice: 'Custom Automation Office',
    defaultAgent: 'Bongani',
  };
}

function deterministicPromptGraph(
  prompt: string,
  offices: OfficeDef[],
  agents: CustomAgentDef[],
): {
  name: string;
  description: string;
  domain: WorkflowDomain;
  officeName: string;
  trigger: WorkflowTrigger;
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  const clean = prompt.trim();
  const lower = clean.toLowerCase();
  const meta = detectDomainAndTrigger(clean);
  const matchedOffice = offices.find((o) => lower.includes(o.name.toLowerCase()) || o.domain === meta.domain);
  const officeName = matchedOffice?.name || meta.defaultOffice;
  const matchedAgent = agents.find((a) => lower.includes(a.name.toLowerCase()) || a.officeId === matchedOffice?.id);
  const agentName = matchedAgent?.name || meta.defaultAgent;

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let seq = 1;
  const uid = (p: string) => `${p}_${Date.now().toString(36).slice(-3)}_${seq++}`;
  const link = (source: string, target: string, sourceHandle = 'next', label?: string) => {
    edges.push({ id: `e_${source}_${target}_${seq++}`, source, target, sourceHandle, ...(label ? { label } : {}) });
  };

  const tId = uid('t');
  nodes.push({
    id: tId,
    type: 'trigger',
    position: { x: 440, y: 50 },
    data: { label: triggerLabel(meta.trigger), officeName, config: { trigger: meta.trigger } },
  });

  const aiId = uid('ai');
  nodes.push({
    id: aiId,
    type: 'ai_task',
    position: { x: 440, y: 205 },
    data: {
      label: meta.domain === 'finance' ? 'Analyze Balance & Draft Notice' : 'AI Diagnose & Personalize Draft',
      agent: agentName,
      officeName,
      config: { instructions: clean },
    },
  });
  link(tId, aiId);

  let tail = aiId;
  const hasBranch = /if|unpaid|overdue|escalat|qualif|condition|branch|still/.test(lower);
  const wantsAudit = /audit|review|coo|musa|check/.test(lower);
  const wantsEmail = /email|smtp|mail/.test(lower) || !(/whatsapp|manychat|call/.test(lower));
  const wantsWa = /whatsapp|wa\b/.test(lower);
  const wantsMc = /manychat/.test(lower);
  const wantsCall = /call|dialer|phone|ring|voice/.test(lower);
  const wantsFollowup = /follow[-\s]?up|every|repeat|cadence|48h|24h|remind/.test(lower);
  const wantsWebhook = /webhook|crm|post\b|sync|slack|erp/.test(lower);

  if (wantsAudit) {
    const audId = uid('aud');
    nodes.push({
      id: audId,
      type: 'audit',
      position: { x: 440, y: 360 },
      data: { label: 'QA Policy Audit', agent: 'Musa', officeName: 'Quality & Compliance Review', config: {} },
    });
    link(tail, audId, 'next');
    tail = audId;
  }

  let noTargetParent: string | null = null;
  if (hasBranch) {
    const condId = uid('cond');
    nodes.push({
      id: condId,
      type: 'condition',
      position: { x: 440, y: 515 },
      data: {
        label: meta.domain === 'finance' ? 'Payment Still Unpaid?' : 'Condition Matched?',
        officeName,
        config: meta.domain === 'finance'
          ? { field: 'payment_status', op: 'eq', value: 'overdue' }
          : { field: 'status', op: 'neq', value: 'recovered' },
      },
    });
    link(tail, condId, tail.startsWith('aud') ? 'pass' : 'next');
    tail = condId;
    noTargetParent = condId;
  }

  let firstYes = true;
  const attachYes = (nodeId: string) => {
    if (firstYes && noTargetParent) {
      link(tail, nodeId, 'yes', 'yes');
      firstYes = false;
    } else {
      link(tail, nodeId, tail.startsWith('aud') ? 'pass' : 'next');
    }
    tail = nodeId;
  };

  if (wantsWa) {
    const n = uid('wa');
    nodes.push({
      id: n,
      type: 'send_whatsapp',
      position: { x: 240, y: 670 },
      data: {
        label: 'Send WhatsApp Message',
        agent: agentName,
        officeName,
        config: {
          text: meta.domain === 'finance'
            ? 'Hi {{first_name}}, quick reminder from {{office}}: invoice/fee {{amount_due}} is overdue ({{days}}d). Reply if you need assistance.'
            : 'Hi {{first_name}}, reaching out from {{office}} regarding {{module}} ({{detail}}).',
        },
      },
    });
    attachYes(n);
  }

  if (wantsMc) {
    const n = uid('mc');
    nodes.push({
      id: n,
      type: 'send_manychat',
      position: { x: 240, y: 670 },
      data: {
        label: 'Send ManyChat DM / Flow',
        agent: agentName,
        officeName,
        config: {
          text: 'Hi {{first_name}}, {{office}} sent you an important update on {{module}}.',
        },
      },
    });
    attachYes(n);
  }

  if (wantsEmail) {
    const n = uid('em');
    nodes.push({
      id: n,
      type: 'send_email',
      position: { x: 240, y: 825 },
      data: {
        label: 'Send Office Email (SMTP)',
        agent: agentName,
        officeName,
        config: {
          subject: meta.domain === 'finance'
            ? 'Payment Reminder: Account {{name}} ({{amount_due}})'
            : `${officeName}: Update for {{name}}`,
          text: meta.domain === 'finance'
            ? 'Hello {{first_name}},\n\nThis is a kind reminder from Finance & Collections regarding your overdue balance ({{amount_due}}, {{days}} days overdue). Please reply to arrange settlement or a flexible payment plan.'
            : 'Hello {{first_name}},\n\nHere is a personalized update from {{office}}: {{detail}}.',
        },
      },
    });
    attachYes(n);
  }

  if (wantsCall) {
    const n = uid('call');
    nodes.push({
      id: n,
      type: 'ai_call',
      position: { x: 240, y: 980 },
      data: {
        label: 'Place AI Voice Call (Dialer)',
        agent: agentName,
        officeName,
        config: {
          goal: meta.domain === 'finance'
            ? 'Confirm overdue balance respectfully and agree on a payment date.'
            : 'Check in politely and confirm next step.',
        },
      },
    });
    attachYes(n);
  }

  if (wantsFollowup) {
    const n = uid('fu');
    nodes.push({
      id: n,
      type: 'followup',
      position: { x: 240, y: 1135 },
      data: {
        label: 'Persistent Follow-up Loop',
        agent: agentName,
        officeName,
        config: { intervalHours: 48, repeatForever: true, channel: wantsWa ? 'whatsapp' : 'email' },
      },
    });
    attachYes(n);
  }

  if (wantsWebhook) {
    const n = uid('http');
    nodes.push({
      id: n,
      type: 'http',
      position: { x: 240, y: 1290 },
      data: {
        label: 'Notify External Webhook / ERP',
        agent: agentName,
        officeName,
        config: { url: '' },
      },
    });
    attachYes(n);
  }

  const endYes = uid('end');
  nodes.push({
    id: endYes,
    type: 'end',
    position: { x: 240, y: 1445 },
    data: { label: 'Workflow Complete', officeName, config: {} },
  });
  attachYes(endYes);

  if (noTargetParent) {
    const tagOk = uid('tag');
    nodes.push({
      id: tagOk,
      type: 'tag',
      position: { x: 640, y: 670 },
      data: { label: 'Mark Paid / Clear', officeName, config: { tag: 'resolved' } },
    });
    link(noTargetParent, tagOk, 'no', 'no');
    const endNo = uid('end');
    nodes.push({
      id: endNo,
      type: 'end',
      position: { x: 640, y: 825 },
      data: { label: 'Closed', officeName, config: {} },
    });
    link(tagOk, endNo);
  }

  const title = clean.replace(/\s+/g, ' ').slice(0, 48);
  return {
    name: title.length < clean.length ? `${title}…` : title || 'Custom Flow',
    description: `Automated flow for ${officeName}: ${clean.slice(0, 140)}`,
    domain: meta.domain,
    officeName,
    trigger: meta.trigger,
    nodes: autoLayoutNodes(nodes, edges),
    edges,
  };
}

export async function generateFlowFromPrompt(
  prompt: string,
  offices: OfficeDef[],
  agents: CustomAgentDef[],
): Promise<{
  name: string;
  description: string;
  domain: WorkflowDomain;
  officeName: string;
  trigger: WorkflowTrigger;
  nodes: FlowNode[];
  edges: FlowEdge[];
  viaAi: boolean;
}> {
  const clean = prompt.trim();
  const officeNames = offices.map((o) => `${o.name} (${o.domain})`).join(', ');
  const agentNames = agents.map((a) => `${a.name} (${a.title})`).join(', ');
  const sys = `Generate an automation workflow graph as STRICT JSON ONLY (no markdown).
Allowed node types: trigger, ai_task, send_email, send_whatsapp, send_manychat, ai_call, followup, wait, condition, audit, http, handoff, tag, end.
Available offices: ${officeNames}. Available agents: ${agentNames}.
Return JSON: { "name": string, "description": string, "domain": "academy"|"finance"|"admissions"|"support"|"custom", "officeName": string, "trigger": "quiz.failed"|"attendance.missed"|"assignment.missed"|"payment.overdue"|"invoice.unpaid"|"login.gap"|"webhook.custom"|"whatsapp.inbound"|"contact.created"|"schedule"|"manual", "nodes": [{ "id": string, "type": NodeType, "data": { "label": string, "agent"?: string, "officeName"?: string, "config": object } }], "edges": [{ "id": string, "source": string, "sourceHandle"?: "next"|"yes"|"no"|"pass"|"fail", "target": string, "label"?: string }] }.`;

  const res = await complete({ system: sys, prompt: `Build an automation graph for:\n"${clean}"`, maxTokens: 4000, json: true });
  if (res) {
    try {
      const jsonStr = res.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(jsonStr) as {
        name?: string;
        description?: string;
        domain?: WorkflowDomain;
        officeName?: string;
        trigger?: WorkflowTrigger;
        nodes?: { id: string; type: FlowNodeType; data?: { label?: string; agent?: string; officeName?: string; config?: Record<string, unknown> } }[];
        edges?: FlowEdge[];
      };
      if (Array.isArray(parsed.nodes) && parsed.nodes.length >= 2 && Array.isArray(parsed.edges)) {
        const nodes: FlowNode[] = parsed.nodes
          .filter((n) => n && n.id && VALID_NODE_TYPES.has(n.type))
          .map((n, idx) => ({
            id: String(n.id),
            type: n.type,
            position: { x: 440, y: 50 + idx * 155 },
            data: {
              label: String(n.data?.label || n.type),
              ...(n.data?.agent ? { agent: n.data.agent } : {}),
              ...(n.data?.officeName ? { officeName: n.data.officeName } : {}),
              config: (n.data?.config as Record<string, unknown>) || {},
            },
          }));
        const ids = new Set(nodes.map((n) => n.id));
        const edges: FlowEdge[] = parsed.edges
          .filter((e) => e && ids.has(e.source) && ids.has(e.target))
          .map((e, i) => ({
            id: String(e.id || `eg_${i + 1}`),
            source: e.source,
            target: e.target,
            ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : { sourceHandle: 'next' }),
            ...(e.label ? { label: e.label } : {}),
          }));
        if (nodes.length >= 2 && edges.length >= 1) {
          return {
            name: String(parsed.name || clean.slice(0, 48)),
            description: String(parsed.description || clean.slice(0, 140)),
            domain: parsed.domain || 'custom',
            officeName: String(parsed.officeName || offices[0]?.name || 'Custom Office'),
            trigger: parsed.trigger || 'manual',
            nodes: autoLayoutNodes(nodes, edges),
            edges,
            viaAi: true,
          };
        }
      }
    } catch { /* fall back to deterministic builder */ }
  }

  return { ...deterministicPromptGraph(clean, offices, agents), viaAi: false };
}

