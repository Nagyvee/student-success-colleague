import { bankKnowledge } from '@/lib/nurture/bank';
import type { AgentStep, AgentTrigger, ConditionOp, CustomAgentDef, DataSource, MessageChannel, OfficeDef, StepKind } from '@/lib/types';
import { generateJSON, isStr, noEmoji, obj } from './llm';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';

/* What the department agents think with.
 *
 * Every function asks the model for a small JSON answer, validates it, and
 * falls back to a sensible deterministic answer when the model is off, slow
 * or wrong, so a run always finishes. The reviewer's rules for messages are
 * code (agentAudit.ts); here the agent only writes. */

export interface MindContext {
  agent: Pick<CustomAgentDef, 'name' | 'title' | 'persona' | 'instructions'>;
  department: Pick<OfficeDef, 'name' | 'kind'> | null;
  /** The record's live fields (name, email, amounts, dates, agent notes). */
  fields: Record<string, string>;
  /** What happened so far in this run, newest last. */
  history: string[];
  /** Other context: a data-source summary for scheduled jobs, the reply being answered. */
  extra?: string;
}

const JSON_ONLY = 'Reply with one JSON object only. No markdown, no code fences. Inside strings never use double quotes; use single quotes if you must quote. Use \\n\\n between paragraphs.';

function academy() {
  const ac = getAcademyContext();
  const ti = getTenantIntegrations(currentTenantId());
  const knowledge = [ti.academyFocus, ti.agentKnowledge, bankKnowledge()].filter((x) => x && x.trim()).join('\n').trim();
  return { ...ac, knowledge, applyUrl: (ti.applyUrl || '').trim() };
}

function who(ctx: MindContext) {
  const ac = academy();
  return `You are ${ctx.agent.name}, ${ctx.agent.title} in the ${ctx.department?.name || 'operations'} department at ${ac.academyName}. ${ctx.agent.persona || ''}
Voice: warm, clear, practical South African English. Never preachy, never pushy, never guilt-tripping. No emoji.
Facts: use only what is in the record and in what you know about the academy below. Never invent links, prices, dates, bank details, payment methods, portals, people or processes, and never make claims about other students, results, job outcomes or how a programme is designed unless it is written below. If something the person needs is not known, say a colleague will send it when they reply.
${ac.knowledge ? `What you know about ${ac.academyName} (use it, never invent beyond it):\n${ac.knowledge}\n` : ''}${ac.applyUrl ? `Application link: ${ac.applyUrl}\n` : ''}${ctx.agent.instructions ? `Standing instructions from your manager: ${ctx.agent.instructions}\n` : ''}`;
}

/** The record as the model sees it: useful fields only, no internal keys. */
function recordView(fields: Record<string, string>) {
  // Internal bookkeeping (link tracking, what was sent, the raw conversation, where the sales team keeps them) is not something to talk about.
  const skip = /^(id|key|row|agent_.*|replied_at_ms|conversation|nurture_seen|nurture_sent|nurture_res|nurture_last_sent_at|preview|opted_out_at|dialer_.*|sheet_tab|imported_quietly|whatsapp_(result|retry_at|last_at|nudge_at|video_at|test_at))$/;
  const lines = Object.entries(fields)
    .filter(([k, v]) => v && String(v).trim() && !skip.test(k) && String(v).length < 600)
    .slice(0, 40)
    .map(([k, v]) => `- ${k}: ${v}`);
  return lines.join('\n');
}

const first = (f: Record<string, string>) => (f.first_name || f.name || 'there').split(/\s+/)[0];

/* ── Messages ─────────────────────────────────────────────────────────────── */

export interface DraftMessage { subject: string; body: string; ask: string; viaAi: boolean }

const DOMAIN_RULES: Record<string, string> = {
  finance: 'This is about money. Be private, respectful and exact: state the amount and the due date exactly as they appear in the record (amount_due_display, due_date_display). Thank them for anything already paid. Offer a payment arrangement and how to reach the finance team. Only describe how to pay if it is in what you know; otherwise say the finance team will send the payment details on reply. Never threaten, never mention legal action, suspension, blacklisting or debt collectors, never call them a debtor or defaulter.',
  admissions: `This is a prospective student, and your job is to sell, the way the best admissions consultant does: by helping them say yes to something good for them.
- If they wrote to you, answer exactly what they asked first, in plain words.
- Know what they want (a first job in tech, a better career, their child's future) and connect the programme to it with one or two specific reasons from what you know, their interest and their quiz result.
- Handle what holds them back (the one they raised, or the most likely one): fees (payment options and any current offer, only if known), time (class times, part-time, only if known), doubt ("is tech for me?": the career-fit quiz, their video, support all the way), not knowing where to start.
- If a current offer is listed below, you may use it exactly as written, with its end date. Never make one up.
- Always ask for one concrete next step and make it easy: start the application (with the link if known), a 10-minute call (ask what time suits them today or tomorrow), or the quiz. End with a question that moves them forward.
- Sound like a person, not a brochure: short paragraphs, no hype, no emoji.
Never pressure, never invent fees, dates, discounts, salaries or promises, and never mention scores, link tracking, or that they are a lead.`,
  b2b_sales: 'This is a business prospect. Be concise and specific to their company: one observation about their context, one relevant way the academy can help their team (training, upskilling, learnerships, placements), and a low-friction ask (a 15-minute call). No buzzwords.',
  student_success: 'This is a current student. Notice what happened without labelling them (never say at risk, failing, flagged or behind). Ask what got in the way, offer one concrete form of help, and ask for one small thing they can do today.',
  learning: 'This is a current student working on their studies. Be encouraging and specific about the topic, offer help, and keep it short.',
  custom: 'Be helpful, specific and brief.',
};

export async function writeMessage(ctx: MindContext, step: AgentStep): Promise<DraftMessage> {
  const f = ctx.fields;
  const fallback = fallbackMessage(ctx, step);
  const channel: MessageChannel = step.channel || 'email';
  const wa = channel === 'whatsapp';
  const kind = ctx.department?.kind || 'custom';
  const res = await generateJSON<DraftMessage>({
    system: `${who(ctx)}\n${DOMAIN_RULES[kind] || DOMAIN_RULES.custom}\n${JSON_ONLY}`,
    prompt: `Write a message to ${f.name || 'this person'}.
Your task: ${step.instructions || step.title}
${step.subject ? `Subject idea: ${step.subject}\n` : ''}Channel: ${wa ? 'WhatsApp (40 to 90 words, no subject needed, friendly, no emoji)' : channel === 'email_whatsapp' ? 'email (90 to 170 words); a short WhatsApp version is made from it' : 'email (90 to 170 words)'}.
Start with "Hi ${first(f)}," on its own line. Use their first name. Do not sign off: your name and signature are added under the message.

What we know about them:
${recordView(f) || '- (only their name)'}
${ctx.history.length ? `\nWhat has happened so far (newest last):\n${ctx.history.slice(-8).map((h) => `- ${h}`).join('\n')}\nDo not repeat an earlier message; move the conversation forward.` : ''}
${ctx.extra ? `\n${ctx.extra}` : ''}

JSON: {"subject": "short, human subject line", "body": "the message, paragraphs separated by \\n\\n, with no sign-off", "ask": "the next step, one sentence written to them in the second person (e.g. Reply with a time that suits you for a 10-minute call.)"}`,
    maxTokens: 6000,
    timeoutMs: 30000,
    validate: (x) => {
      const o = obj(x); if (!o || !isStr(o.body)) return null;
      return {
        subject: isStr(o.subject) ? noEmoji(o.subject).slice(0, 140) : fallback.subject,
        body: noEmoji(o.body.replace(/\r\n/g, '\n')),
        // The next step is written to them; an instruction meant for a colleague ("Ask Thandi…") is replaced.
        ask: isStr(o.ask) && !new RegExp(`^(ask|tell|remind|invite|offer|check with|call|email)\\s+${first(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(o.ask.trim()) && !/\b(him|her|his|he|she)\b/i.test(o.ask) ? noEmoji(o.ask) : fallback.ask,
        viaAi: true,
      };
    },
  });
  return res || fallback;
}

/** Revise a draft the reviewer sent back. */
export async function reviseMessage(ctx: MindContext, step: AgentStep, draft: DraftMessage, notes: string[]): Promise<DraftMessage | null> {
  const kind = ctx.department?.kind || 'custom';
  return generateJSON<DraftMessage>({
    system: `${who(ctx)}\n${DOMAIN_RULES[kind] || DOMAIN_RULES.custom}\nThe reviewer sent your draft back. Fix exactly what they flagged and keep what was good. ${JSON_ONLY}`,
    prompt: `Reviewer notes:\n- ${notes.join('\n- ')}\n\nYour draft:\nSubject: ${draft.subject}\n${draft.body}\n\nNext step: ${draft.ask}\n\nWhat we know about them:\n${recordView(ctx.fields)}\n\nJSON: {"subject": "...", "body": "...", "ask": "..."}`,
    maxTokens: 6000,
    timeoutMs: 25000,
    validate: (x) => {
      const o = obj(x); if (!o || !isStr(o.body)) return null;
      return { subject: isStr(o.subject) ? noEmoji(o.subject) : draft.subject, body: noEmoji(o.body), ask: isStr(o.ask) ? noEmoji(o.ask) : draft.ask, viaAi: true };
    },
  });
}

/** A message that always passes the reviewer: used when the model is off or cannot fix a draft. */
export function fallbackMessage(ctx: MindContext, step: AgentStep): DraftMessage {
  const f = ctx.fields;
  const ac = academy();
  const name = first(f);
  const kind = ctx.department?.kind || 'custom';
  const sign = `Warm regards,\n${ctx.agent.name}\n${ctx.agent.title} · ${ac.academyName}`;
  const round = ctx.history.filter((h) => /^Sent/.test(h)).length;
  if (kind === 'finance') {
    const amount = f.amount_due_display || 'your outstanding balance';
    const when = f.due_date_display ? (f.payment_state === 'overdue' ? `which was due on ${f.due_date_display}` : `which is due on ${f.due_date_display}`) : '';
    return {
      subject: f.payment_state === 'overdue' ? `Your ${ac.academyName} account: ${amount}` : `A friendly reminder: ${amount} ${f.due_date_display ? `due ${f.due_date_display}` : ''}`.trim(),
      body: `Hi ${name},\n\nI hope your studies are going well. ${round ? 'Following up on my last message: ' : ''}This is a friendly note from the finance team about ${amount} on your account${when ? `, ${when}` : ''}.\n\nIf you have already paid, thank you, and please reply with the proof of payment so we can update your account. If now is a difficult time, reply and we will gladly set up a payment arrangement that works for you.\n\n${sign}`,
      ask: 'Reply with your proof of payment, or tell us what arrangement would work for you.',
      viaAi: false,
    };
  }
  if (kind === 'admissions') {
    const interest = f.interest || f.programme || 'our programmes';
    return {
      subject: round ? `Still thinking about ${interest}, ${name}?` : `${name}, here is what ${interest} at ${ac.academyName} looks like`,
      body: `Hi ${name},\n\nThank you for your interest in ${interest} at ${ac.academyName}. ${round ? 'I wanted to check in again in case you had any questions.' : 'I am here to help you decide whether it is the right fit for you.'}\n\nOur programmes are practical and taught live by industry practitioners, with support from our student success team all the way through. ${ac.applyUrl ? `You can apply in a few minutes here: ${ac.applyUrl}` : 'Reply to this message and I will send you the application details.'}\n\n${sign}`,
      ask: ac.applyUrl ? 'Start your application, or reply with any question.' : 'Reply with any question, or tell me a good time for a quick call.',
      viaAi: false,
    };
  }
  if (kind === 'b2b_sales') {
    const company = f.company || 'your team';
    return {
      subject: `Upskilling at ${company}`,
      body: `Hi ${name},\n\nI am reaching out from ${ac.academyName}. We help organisations like ${company} build practical tech skills in their teams through live, instructor-led programmes and learnerships.\n\nWould a 15-minute call next week be useful to see whether there is a fit?\n\n${sign}`,
      ask: 'Reply with a time that suits you for a 15-minute call.',
      viaAi: false,
    };
  }
  return {
    subject: step.subject || `Checking in, ${name}`,
    body: `Hi ${name},\n\nI wanted to check in personally and see how things are going. If anything is getting in the way, we are here to help, and a quick reply is all it takes.\n\n${sign}`,
    ask: 'Reply with one line on how things are going.',
    viaAi: false,
  };
}

/* ── Judgement ────────────────────────────────────────────────────────────── */

export async function judge(ctx: MindContext, question: string): Promise<{ answer: boolean; reason: string; viaAi: boolean }> {
  const res = await generateJSON<{ answer: boolean; reason: string }>({
    system: `${who(ctx)}\nAnswer a yes/no question about one person from the facts given. If the facts do not show it, answer no. ${JSON_ONLY}`,
    prompt: `Question: ${question}\n\nFacts:\n${recordView(ctx.fields)}\n${ctx.history.length ? `\nWhat has happened:\n${ctx.history.slice(-10).map((h) => `- ${h}`).join('\n')}` : ''}${ctx.extra ? `\n${ctx.extra}` : ''}\n\nJSON: {"answer": true or false, "reason": "one short sentence citing the facts"}`,
    maxTokens: 3000,
    timeoutMs: 20000,
    validate: (x) => {
      const o = obj(x); if (!o || typeof o.answer !== 'boolean') return null;
      return { answer: o.answer, reason: isStr(o.reason) ? o.reason.trim() : '' };
    },
  });
  if (res) return { ...res, viaAi: true };
  return { answer: false, reason: 'No model available to judge; taking the safe path (no).', viaAi: false };
}

/* ── Tasks (qualify, research, summarise) ─────────────────────────────────── */

export async function doTask(ctx: MindContext, instructions: string): Promise<{ result: string; viaAi: boolean }> {
  const res = await generateJSON<{ result: string }>({
    system: `${who(ctx)}\nDo the task below and give a short, factual result a colleague can use. Do not invent facts you were not given; say what is unknown. ${JSON_ONLY}`,
    prompt: `Task: ${instructions}\n\nAbout this ${ctx.fields.company ? 'organisation' : 'person'}:\n${recordView(ctx.fields)}\n${ctx.history.length ? `\nWhat has happened:\n${ctx.history.slice(-8).map((h) => `- ${h}`).join('\n')}` : ''}${ctx.extra ? `\n\n${ctx.extra}` : ''}\n\nJSON: {"result": "the result, at most 120 words (a score task starts with the score, e.g. '8/10: ...')"}`,
    maxTokens: 4000,
    timeoutMs: 25000,
    validate: (x) => { const o = obj(x); return o && isStr(o.result) ? { result: o.result.trim().slice(0, 1200) } : null; },
  });
  if (res) return { ...res, viaAi: true };
  const f = ctx.fields;
  if (/score|qualif/i.test(instructions)) {
    const signals = [f.email && 'email given', f.phone && 'phone given', (f.interest || f.programme) && `interested in ${f.interest || f.programme}`].filter(Boolean);
    const score = Math.min(9, 3 + signals.length * 2);
    return { result: `${score}/10: ${signals.length ? signals.join(', ') : 'little information yet'}.`, viaAi: false };
  }
  return { result: ctx.extra ? ctx.extra.slice(0, 600) : `Noted for ${f.name || 'this record'}.`, viaAi: false };
}

/** A short brief for a person on the team: what happened and what they should do. */
export async function briefTeam(ctx: MindContext, instructions: string): Promise<{ subject: string; body: string }> {
  const f = ctx.fields;
  const res = await generateJSON<{ subject: string; body: string }>({
    system: `${who(ctx)}\nYou are briefing a colleague on your team (not the customer). Be direct: who, what happened, what you recommend they do next. ${JSON_ONLY}`,
    prompt: `Why you are writing: ${instructions}\n\nAbout ${f.name || 'the record'}:\n${recordView(f)}\n${ctx.history.length ? `\nWhat you did so far:\n${ctx.history.slice(-12).map((h) => `- ${h}`).join('\n')}` : ''}${ctx.extra ? `\n\n${ctx.extra}` : ''}\n\nJSON: {"subject": "short subject", "body": "60 to 160 words, paragraphs separated by \\n\\n"}`,
    maxTokens: 4000,
    timeoutMs: 25000,
    validate: (x) => { const o = obj(x); return o && isStr(o.body) ? { subject: isStr(o.subject) ? o.subject.trim() : `${ctx.agent.name}: ${f.name || 'update'}`, body: o.body.trim() } : null; },
  });
  if (res) return res;
  return {
    subject: `${ctx.agent.name} · ${f.name || 'update'}: ${instructions.slice(0, 60)}`,
    body: `${instructions}\n\n${f.name ? `Record: ${f.name}${f.email ? ` (${f.email})` : ''}${f.phone ? `, ${f.phone}` : ''}.` : ''}\n\n${ctx.history.length ? `What I did:\n${ctx.history.slice(-8).map((h) => `- ${h}`).join('\n')}` : ''}${ctx.extra ? `\n\n${ctx.extra}` : ''}`.trim(),
  };
}

/* ── Build a workflow from words ──────────────────────────────────────────── */

const STEP_KINDS: StepKind[] = ['ai_message', 'send_library', 'ai_video', 'send_voucher', 'take_over', 'ai_lesson', 'ai_task', 'condition', 'wait', 'repeat', 'ai_call', 'update_record', 'notify_team', 'webhook', 'stop'];

let seq = 0;
export const stepId = () => `st_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function cleanSteps(x: unknown, depth = 0): AgentStep[] {
  if (!Array.isArray(x) || depth > 3) return [];
  const out: AgentStep[] = [];
  for (const raw of x.slice(0, 20)) {
    const o = obj(raw);
    if (!o || !STEP_KINDS.includes(o.kind as StepKind)) continue;
    const s: AgentStep = { id: stepId(), kind: o.kind as StepKind, title: isStr(o.title) ? o.title.trim().slice(0, 80) : String(o.kind) };
    if (isStr(o.instructions)) s.instructions = o.instructions.trim().slice(0, 1500);
    if (o.channel === 'email' || o.channel === 'whatsapp' || o.channel === 'email_whatsapp') s.channel = o.channel;
    if (isStr(o.subject)) s.subject = o.subject.trim();
    if (typeof o.review === 'boolean') s.review = o.review;
    if (typeof o.questionCount === 'number') s.questionCount = Math.max(3, Math.min(15, Math.round(o.questionCount)));
    if (typeof o.passMark === 'number') s.passMark = Math.max(30, Math.min(100, Math.round(o.passMark)));
    if (isStr(o.saveAs)) s.saveAs = o.saveAs.trim().replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    if (typeof o.hours === 'number') s.hours = Math.max(0.05, Math.min(24 * 60, o.hours));
    if (typeof o.maxTimes === 'number') s.maxTimes = Math.max(1, Math.min(20, Math.round(o.maxTimes)));
    const c = obj(o.condition);
    if (c && (c.mode === 'rule' || c.mode === 'ai')) {
      s.condition = { mode: c.mode, field: isStr(c.field) ? c.field : undefined, op: isStr(c.op) ? (c.op as ConditionOp) : undefined, value: c.value !== undefined ? String(c.value) : undefined, question: isStr(c.question) ? c.question : undefined };
    }
    if (s.kind === 'condition') { s.yes = cleanSteps(o.yes, depth + 1); s.no = cleanSteps(o.no, depth + 1); }
    if (s.kind === 'repeat') s.steps = cleanSteps(o.steps, depth + 1);
    if (isStr(o.setField)) s.setField = o.setField.trim();
    if (o.setValue !== undefined) s.setValue = String(o.setValue);
    if (isStr(o.notifyEmail)) s.notifyEmail = o.notifyEmail.trim();
    if (isStr(o.url)) s.url = o.url.trim();
    out.push(s);
  }
  return out;
}

export async function buildWorkflowFromWords(input: {
  description: string;
  department: Pick<OfficeDef, 'name' | 'kind'> | null;
  sources: DataSource[];
}): Promise<{ name: string; trigger: AgentTrigger; steps: AgentStep[]; viaAi: boolean } | null> {
  const ac = academy();
  const res = await generateJSON<{ name: string; trigger: AgentTrigger; steps: AgentStep[] }>({
    system: `You design the job of an AI agent in the ${input.department?.name || 'operations'} department of ${ac.academyName}. Every step is done by the AI agent itself. ${JSON_ONLY}`,
    prompt: `The manager describes the agent's job: "${input.description}"

Data sources available (use their ids): ${input.sources.map((s) => `${s.id} = ${s.name} (${s.kind}; columns: ${(s.columns || Object.values(s.mapping)).slice(0, 25).join(', ') || 'unknown'})`).join('; ') || 'none'}.
Record fields agents understand: name, first_name, email, phone, status, programme, interest, source, company, amount_due, amount_paid, total_fee, due_date, payment_state (paid|due|overdue|arrangement|unknown), days_until_due, days_overdue, plus any column in snake_case.

Trigger kinds: record.added, record.changed (field), record.match (checked on schedule, with match rules), lead.created, lms.event (lmsEvent: quiz.failed | login.gap | attendance.missed | assignment.missed), reply.received, schedule ({"every":"day"|"week","hour":8,"weekday":1}), manual.
Step kinds: ai_message {channel: email|whatsapp|email_whatsapp, instructions, review}, send_library {stage: welcome|learn|trust|offer|decide|reengage, channel} (a saved, approved message from the library: use it for leads and for messages many people get, it costs no AI), ai_video {instructions} (a personal video for one lead, for hot leads; the next ai_message links to it), send_voucher {} (gives an approved voucher, the code is made by the system), take_over {} (this agent takes the person over from the others in the department), send_library stage ongoing (keep in touch: the next thing they have not had), ai_lesson {questionCount, passMark}, ai_task {instructions, saveAs}, condition {condition: {mode: rule, field, op: eq|neq|gt|gte|lt|lte|contains|empty|not_empty|days_until_lte|days_since_gte, value} or {mode: ai, question}, yes: [steps], no: [steps]}, wait {hours}, repeat {hours, maxTimes, condition (stop when true), steps: [steps]}, ai_call {instructions}, update_record {setField, setValue}, notify_team {instructions}, webhook {url}, stop.
Every step has a short "title" (3 to 6 words). Keep it to 3 to 8 top-level steps.

JSON: {"name": "agent job name", "trigger": {"kind": "...", "sourceId": "...", "match": [{"mode":"rule","field":"...","op":"...","value":"..."}], "schedule": {...}, "lmsEvent": "..."}, "steps": [ ... ]}`,
    maxTokens: 9000,
    timeoutMs: 40000,
    validate: (x) => {
      const o = obj(x); if (!o || !isStr(o.name)) return null;
      const t = obj(o.trigger);
      if (!t || !isStr(t.kind)) return null;
      const steps = cleanSteps(o.steps);
      if (!steps.length) return null;
      return { name: o.name.trim().slice(0, 60), trigger: t as unknown as AgentTrigger, steps };
    },
  });
  if (!res) return null;
  const t = res.trigger;
  const kinds: AgentTrigger['kind'][] = ['record.added', 'record.changed', 'record.match', 'lead.created', 'lms.event', 'reply.received', 'schedule', 'manual'];
  const trigger: AgentTrigger = {
    kind: kinds.includes(t.kind) ? t.kind : 'manual',
    sourceId: input.sources.some((s) => s.id === t.sourceId) ? t.sourceId : undefined,
    field: typeof t.field === 'string' ? t.field : undefined,
    match: Array.isArray(t.match) ? t.match.filter((m) => m && m.mode === 'rule' && m.field).slice(0, 4) : undefined,
    lmsEvent: t.lmsEvent,
    schedule: t.schedule && ['hour', 'day', 'week'].includes(t.schedule.every) ? t.schedule : (t.kind === 'record.match' || t.kind === 'schedule' ? { every: 'day', hour: 8 } : undefined),
  };
  return { name: res.name, trigger, steps: res.steps, viaAi: true };
}
