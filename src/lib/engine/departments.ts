import type { AgentStep, AgentTrigger, CustomAgentDef, DepartmentKind, OfficeDef, WorkflowDef } from '@/lib/types';
import { getModelVersion, listCustomAgents, listOffices, replaceDepartments, saveCustomAgent } from './offices';
import { sanitizeSteps } from './stepSchema';
import { createWorkflow, listWorkflows, updateWorkflow } from './workflows';
import { LEADS_SOURCE_ID, MOODLE_SOURCE_ID, listSources, saveSource } from '@/lib/data/sources';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { log } from './store';
import { listRecords } from '@/lib/data/records';
import { meta as nurtureMeta, metaDoc as nurtureMetaDoc } from '@/lib/nurture/store';
import { listMessages, seedStarterLibrary, seedUsefulMessage } from '@/lib/nurture/library';
import { seedStarterOffers } from '@/lib/nurture/vouchers';

/* The building: one floor per department, a few agents per floor, one job per agent.
 *
 *   5  Finance & Operations    invoicing and payment tracking, debtor follow-ups, reporting
 *   4  Learning & Assessment   personalised tutoring, assessment prep, learner feedback
 *   3  Student Success         engagement monitoring, support requests, placement
 *   2  B2B Sales               prospect research, outreach, CRM updates, sales follow-ups
 *   1  Admissions              lead qualification, enquiries, application follow-ups, enrolment
 *
 * These are the starting point a workspace gets; every agent and step can be
 * changed in the builder. Data sources the jobs read are created empty (the
 * tracker and prospects sheets) until someone pastes a link. */

export const MODEL_VERSION = 2;
export const TRACKER_SOURCE_ID = 'src_tracker';
export const PROSPECTS_SOURCE_ID = 'src_prospects';

const T0 = 1763251200000;

export const DEPARTMENTS: OfficeDef[] = [
  {
    id: 'dep_admissions', name: 'Admissions', short: 'Admissions', domain: 'admissions', kind: 'admissions', floor: 1, icon: 'chat',
    purpose: 'Turns leads from ads and enquiries into applications and enrolments.',
    responsibilities: ['Lead qualification', 'Student enquiries', 'Application follow-ups', 'Enrolment support'],
    slot: 'planning', color: '#7c3aed', enabled: true, createdAt: T0,
  },
  {
    id: 'dep_b2b', name: 'B2B Sales', short: 'B2B Sales', domain: 'custom', kind: 'b2b_sales', floor: 2, icon: 'send',
    purpose: 'Finds and warms up companies that train their teams with us.',
    responsibilities: ['Prospect research', 'Outreach preparation', 'CRM updates', 'Sales follow-ups'],
    slot: 'planning', color: '#0891b2', enabled: true, createdAt: T0 + 1,
  },
  {
    id: 'dep_success', name: 'Student Success', short: 'Student Success', domain: 'academy', kind: 'student_success', floor: 3, icon: 'users',
    purpose: 'Notices students who go quiet, finds out why, and gets them back on track.',
    responsibilities: ['Learner engagement monitoring', 'Flags students who need help', 'Support requests', 'Placement coordination'],
    slot: 'success', color: '#2563eb', enabled: true, createdAt: T0 + 2,
  },
  {
    id: 'dep_learning', name: 'Learning & Assessment', short: 'Learning', domain: 'academy', kind: 'learning', floor: 4, icon: 'book',
    purpose: 'Re-teaches exactly what a student got wrong, with a personal video lesson and a test.',
    responsibilities: ['Personalised tutoring', 'Assessment preparation', 'Learner feedback', 'Academic administration'],
    slot: 'learning', color: '#059669', enabled: true, createdAt: T0 + 3,
  },
  {
    id: 'dep_finance', name: 'Finance & Operations', short: 'Finance & Ops', domain: 'finance', kind: 'finance', floor: 5, icon: 'chart',
    purpose: 'Keeps fees on track from the student tracker, kindly and privately, and reports to management.',
    responsibilities: ['Invoicing and payment tracking', 'Debtor follow-ups', 'Reporting', 'Administrative workflows'],
    slot: 'review', color: '#d97706', enabled: true, createdAt: T0 + 4,
  },
];

type AgentSeed = Omit<CustomAgentDef, 'slot' | 'enabled' | 'createdAt' | 'channels'> & { channels?: CustomAgentDef['channels']; job: { name: string; description: string; trigger: AgentTrigger; steps: AgentStep[]; instructions?: string } };

let n = 0;
const s = (kind: AgentStep['kind'], title: string, extra: Partial<AgentStep> = {}): AgentStep => ({ id: `seed_${(n++).toString(36)}`, kind, title, ...extra });


const NALEDI_DESCRIPTION = 'Every new lead (the leads sheet, ads or forms) gets a welcome within minutes, then their video, proof and an invitation to apply, then keeps hearing from us (weekly, then every three weeks) with something new each time, until they apply or unsubscribe. Saved messages, picked for them: the library is written and approved once.';

/* Naledi's journey: saved messages chosen by rules (no AI per lead). */
export const NALEDI_STEPS = (): AgentStep[] => [
  s('send_library', 'Welcome + career-fit quiz', { stage: 'welcome', channel: 'email_whatsapp', personalLine: true }),
  s('update_record', 'Mark as contacted', { setField: 'status', setValue: 'contacted' }),
  s('wait', 'Give them 2 days', { hours: 48 }),
  s('condition', 'Opened or clicked anything?', {
    condition: { mode: 'rule', field: 'engagement_score', op: 'gte', value: '1' },
    yes: [s('send_library', 'Their programme video', { stage: 'learn' })],
    no: [s('send_library', 'How it really works', { stage: 'trust' })],
  }),
  s('wait', 'Give them 3 days', { hours: 72 }),
  s('send_library', 'Proof: how it works for people like them', { stage: 'trust' }),
  s('wait', 'Give them 4 days', { hours: 96 }),
  s('condition', 'Still cold?', {
    condition: { mode: 'rule', field: 'engagement', op: 'eq', value: 'cold' },
    yes: [s('repeat', 'Gentle check-ins', {
      hours: 24 * 10, maxTimes: 2,
      condition: { mode: 'rule', field: 'engagement', op: 'neq', value: 'cold' },
      steps: [s('send_library', 'Re-engage', { stage: 'reengage' })],
    })],
    no: [s('send_library', 'Invite them to apply', { stage: 'decide' })],
  }),
  ...KEEP_IN_TOUCH(),
];

/** After the first messages: weekly for two months, then every three weeks for as long as it takes.
 *  Each time the next thing they have not had; it pauses while they are talking with us. */
const KEEP_IN_TOUCH = (): AgentStep[] => [
  s('repeat', 'Keep in touch every week', {
    hours: 24 * 7, maxTimes: 8, stopOnReply: false,
    condition: { mode: 'rule', field: 'status', op: 'eq', value: 'applied' },
    steps: [s('send_library', 'Something new for them', { stage: 'ongoing' })],
  }),
  s('repeat', 'Stay in touch until they apply', {
    hours: 24 * 21, maxTimes: 20, stopOnReply: false,
    condition: { mode: 'rule', field: 'status', op: 'eq', value: 'applied' },
    steps: [s('send_library', 'Something new for them', { stage: 'ongoing' })],
  }),
];

/* Zinhle: the one place AI writes for a single lead, because they earned it. */
export const ZINHLE_STEPS = (): AgentStep[] => [
  s('ai_task', 'Read everything they did', { instructions: 'From the form answers, what they opened and clicked (last_clicked, engagement_score), their quiz result (fit_track, fit_programme) and anything they wrote, say in two lines what they most want and what is most likely holding them back.', saveAs: 'lead_brief' }),
  s('take_over', 'Take them over from Naledi'),
  s('ai_video', 'A video made for them', { instructions: 'Speak to their goal and answer what is holding them back.' }),
  s('ai_message', 'Personal note with their video', { channel: 'email_whatsapp', review: true, instructions: 'They have been reading our messages and are close to deciding. Write a short, personal note: say you made them a short video (it is attached below your message as a card), speak to what they want and what is holding them back (lead_brief), and ask for one next step: a 10-minute call (ask what time suits them today or tomorrow) or starting the application. Never mention scores or that we track clicks. No pressure.' }),
  s('notify_team', 'Hand to a consultant today', { instructions: 'This lead is very interested. Summarise what they looked at, their quiz result and what they want, and recommend calling them today.' }),
  s('wait', 'Give them 2 days', { hours: 48 }),
  s('condition', 'Applied yet?', {
    condition: { mode: 'rule', field: 'status', op: 'eq', value: 'applied' },
    yes: [s('stop', 'Done: Ayanda takes over')],
    no: [s('send_voucher', 'A thank-you voucher')],
  }),
  s('repeat', 'Keep converting', {
    hours: 72, maxTimes: 10, stopOnReply: false,
    condition: { mode: 'rule', field: 'status', op: 'eq', value: 'applied' },
    steps: [s('ai_message', 'A new reason to say yes', { channel: 'email_whatsapp', review: true, instructions: 'A short personal follow-up with a new reason to say yes this time: answer the thing most likely holding them back, remind them of their voucher (voucher_code, voucher_value, valid until voucher_expires) if they have one, share something useful about their programme, or invite them to a 10-minute call. Never repeat an earlier message, never pressure. One clear next step. Under 120 words.' })],
  }),
  s('repeat', 'Stay close until they apply', {
    hours: 24 * 14, maxTimes: 20, stopOnReply: false,
    condition: { mode: 'rule', field: 'status', op: 'eq', value: 'applied' },
    steps: [s('send_library', 'Something new for them', { stage: 'ongoing' })],
  }),
];

/* Thabo: every reply gets an answer that sells, the same minute. */
export const THABO_STEPS = (): AgentStep[] => [
  s('condition', 'Asked us to stop?', {
    condition: { mode: 'ai', question: 'Do they ask us to stop contacting them, to unsubscribe, or say clearly that they are not interested at all?' },
    yes: [
      s('update_record', 'Respect it', { setField: 'opted_out', setValue: 'yes' }),
      s('stop', 'No more messages'),
    ],
    no: [],
  }),
  s('condition', 'Needs a person?', {
    condition: { mode: 'ai', question: 'Does their message need a human: a complaint, a refund or payment dispute, a legal or special request, something we cannot answer from what we know, or do they ask for a person?' },
    yes: [
      s('ai_message', 'Tell them a person is on it', { channel: 'email', review: true, instructions: 'Thank them, say briefly that you have passed this to a consultant who will contact them today, and answer anything simple you can. Short and warm.' }),
      s('notify_team', 'Hand to a consultant', { instructions: 'Pass on their message, what they need, and a suggested reply. Recommend contacting them today.' }),
    ],
    no: [
      s('ai_message', 'Answer and move them forward', { channel: 'email', review: true, instructions: 'Answer exactly what they asked first. Then move them towards applying: connect the programme to what they want, handle what is holding them back with facts (and a current offer if one is listed), and ask for one concrete next step (start the application, a 10-minute call at a time that suits them, or the quiz). End with a question.' }),
    ],
  }),
  s('condition', 'Worried about cost?', {
    condition: { mode: 'ai', question: 'Do they ask about fees, discounts or payment, or say cost is holding them back?' },
    yes: [s('send_voucher', 'A voucher to help')],
    no: [],
  }),
  s('condition', 'Ready to sign up?', {
    condition: { mode: 'ai', question: 'Do they say they want to apply, enrol, pay or start, or ask how to do that?' },
    yes: [
      s('update_record', 'Mark as ready', { setField: 'status', setValue: 'ready to apply' }),
      s('notify_team', 'Close it today', { instructions: 'This lead says they want to sign up. Summarise what they want and recommend a consultant calls them today to help them finish.' }),
    ],
    no: [],
  }),
];

/* ── Student Success and Learning & Assessment (from Moodle) ── */

export const BONGANI_STEPS = (): AgentStep[] => [
  s('ai_message', 'Personal check-in', { channel: 'email_whatsapp', review: true, instructions: 'Say you noticed they have not been on the platform lately (days_since_login days), without labelling them. Ask what got in the way, offer one concrete form of help, and ask for one small thing today (open current_module, or finish one activity).' }),
  s('repeat', 'Keep checking in', {
    hours: 72, maxTimes: 2,
    condition: { mode: 'rule', field: 'days_since_login', op: 'lte', value: '1' },
    steps: [s('ai_message', 'Gentle second check-in', { channel: 'whatsapp', review: true, instructions: 'A very short, warm nudge with a different angle than before.' })],
  }),
  s('condition', 'Still quiet?', {
    condition: { mode: 'rule', field: 'replied', op: 'neq', value: 'yes' },
    yes: [s('notify_team', 'Ask a facilitator to call', { instructions: 'This student has not responded to check-ins. Summarise and ask a facilitator to call them.' })],
    no: [],
  }),
];

export const NOMSA_STEPS = (): AgentStep[] => [
  s('ai_message', 'Help with the overdue work', { channel: 'email', review: true, instructions: 'They have overdue work in Moodle (overdue_work; missed_assignments in total). Name the specific items, ask kindly what got in the way, offer one concrete form of help (a short catch-up session, a tip for the first step, or asking their facilitator about a new date), and ask them to submit one item this week. Never scold.' }),
  s('repeat', 'Check the work is in', {
    hours: 72, maxTimes: 2,
    condition: { mode: 'rule', field: 'missed_assignments', op: 'eq', value: '0' },
    steps: [s('ai_message', 'A short nudge', { channel: 'email_whatsapp', review: true, instructions: 'A short, kind nudge about the same overdue work (overdue_work), with a different angle than before and the offer of help. Under 80 words.' })],
  }),
  s('condition', 'Still overdue?', {
    condition: { mode: 'rule', field: 'missed_assignments', op: 'gte', value: '1' },
    yes: [s('notify_team', 'Ask the facilitator to step in', { instructions: 'This student still has overdue work after three messages. List the overdue items, what was sent, any reply, and recommend the facilitator calls them this week.' })],
    no: [s('ai_message', 'Well done for catching up', { channel: 'email', review: true, instructions: 'Their overdue work is in. Thank them warmly and specifically for catching up, and point to the next thing due (next_assessment_name on next_assessment_date) if there is one. Short.' })],
  }),
];

const ZODWA_DESCRIPTION = 'When a student emails us, Zodwa answers the same minute from what we know about the academy and their own progress in Moodle (what is overdue, what is due next, where they are in the course). Complaints, money, emergencies, appeals and anything we cannot answer go to a person, with the student told who will help.';
export const ZODWA_STEPS = (): AgentStep[] => [
  s('condition', 'Needs a person?', {
    condition: { mode: 'ai', question: 'Does their message need a person on the team: a complaint, money or a refund, a medical or family emergency, an appeal or dispute about marks, cancelling or deferring their studies, or something we cannot answer from what we know?' },
    yes: [
      s('ai_message', 'Tell them a person will help', { channel: 'email', review: true, instructions: 'Thank them for writing, say their message has gone to a person on the team who will get back to them within one working day, and answer anything simple you can. Never promise what we do not know. Short and warm.' }),
      s('notify_team', 'Hand to the support team', { instructions: 'A student wrote in and needs a person. Pass on what they asked, what we replied, their Moodle progress, and recommend who should respond and how soon.' }),
      s('stop', 'A person takes it from here'),
    ],
    no: [],
  }),
  s('ai_message', 'Answer their question', { channel: 'email', review: true, instructions: 'Answer exactly what they asked first, using what we know about the academy and their own Moodle progress (overdue_work, next_assessment_name and next_assessment_date, current_module, completion). If something is not in what we know, say their facilitator will confirm. End with one helpful next step.' }),
  s('update_record', 'Note the request', { setField: 'last_support_request', setValue: '{{today}}' }),
];

const MPHO_DESCRIPTION = 'When Moodle shows a student has finished their course, Mpho congratulates them, explains how placement works, asks for their CV and preferred roles, tells the placement team, and reminds them once if they have not replied.';
export const MPHO_STEPS = (): AgentStep[] => [
  s('ai_message', 'Congratulations and next steps', { channel: 'email', review: true, instructions: 'Congratulate them on completing their programme. Explain how placement works and ask them to send their updated CV and the roles they would like.' }),
  s('notify_team', 'Tell the placement team', { instructions: 'A student completed and is ready for placement. Summarise them (programme, results, completion) for the placement team.' }),
  s('wait', 'Give them 5 days', { hours: 120 }),
  s('condition', 'Sent their CV?', {
    condition: { mode: 'rule', field: 'replied', op: 'eq', value: 'yes' },
    yes: [],
    no: [s('ai_message', 'A friendly reminder', { channel: 'email', review: true, instructions: 'A short, friendly reminder to send their CV and preferred roles so the placement team can start. Under 70 words.' })],
  }),
];

export const KARABO_STEPS = (): AgentStep[] => [
  s('ai_task', 'Read the week in Moodle', { instructions: 'From the student data, write the weekly Student Success report: how many are studying, who is at risk and why, who went quiet, who has overdue work, and three recommended actions for the facilitators this week. Names and numbers only from the data.', saveAs: 'weekly_success' }),
  s('notify_team', 'Send the report', { instructions: 'Send the Student Success team the weekly at-risk report.' }),
];

const TUMI_DESCRIPTION = 'Every morning, students with an assessment due in Moodle in the next 5 days get a short, personal revision plan for it.';
const TUMI_TRIGGER = (): AgentTrigger => ({ kind: 'record.match', sourceId: MOODLE_SOURCE_ID, schedule: { every: 'day', hour: 8 }, match: [{ mode: 'rule', field: 'status', op: 'eq', value: 'active' }, { mode: 'rule', field: 'next_assessment_date', op: 'days_until_lte', value: '5' }], cooldownHours: 24 * 6 });
export const TUMI_STEPS = (): AgentStep[] => [
  s('ai_message', 'Revision plan', { channel: 'email', review: true, instructions: 'Their next assessment is next_assessment_name (next_assessment_course), due on next_assessment_date. Give them a short, specific revision plan for it, based on their current module, weak topic and recent results, and wish them well.' }),
];

export const THANDI_STEPS = (): AgentStep[] => [
  s('ai_task', 'Academic report', { instructions: 'From the student data, write the weekly academic report for the learning team: results below the pass mark and the topics behind them, overdue work, assessments due this week, and students who finished. Recommend three actions (tutor sessions, deadline reminders, marking to catch up). Names and numbers only from the data.', saveAs: 'weekly_academic' }),
  s('notify_team', 'Send the report', { instructions: 'Send the learning team the weekly academic report.' }),
];

/** Agents that are paused because another system does their work (B2B sales). */
export const PAUSED_WORKFLOWS = ['wf_sipho', 'wf_lerato'];

const OLD_NALEDI_TITLES = ['Qualify the lead', 'Personal welcome', 'Mark as contacted', 'Follow up until they apply', 'Did they reply?'];
const ZINHLE_DESCRIPTION = 'When a lead turns hot (opening, clicking, taking the quiz, watching their video), Zinhle takes them over from Naledi, makes them a short video of their own, sends it with a personal note, asks a consultant to call today, gives a thank-you voucher, and keeps giving them new reasons to say yes until they apply.';
const PREV_NALEDI_TITLES = ['Welcome + career-fit quiz', 'Mark as contacted', 'Give them 2 days', 'Opened or clicked anything?', 'Give them 3 days', 'Proof: how it works for people like them', 'Give them 4 days', 'Still cold?'];
const PREV_ZINHLE_TITLES = ['Read everything they did', 'A video made for them', 'Personal note with their video', 'Hand to a consultant today', 'Give them 2 days', 'Applied yet?'];
const PREV_THABO_TITLES = ['Asked us to stop?', 'Needs a person?', 'Ready to sign up?'];
const OLD_ZINHLE_TITLES = ['Read everything they did', 'Personal note', 'Hand to a consultant today', 'Give them 2 days', 'Applied yet?'];
const OLD_THABO_TITLES = ['Needs a person?'];
const THABO_DESCRIPTION = 'When a lead replies (by email, WhatsApp or the reply webhook), Thabo answers what they asked the same minute and moves them towards applying: he handles what is holding them back, uses only real offers, and asks for a next step. Anything sensitive goes to a person; anyone ready to sign up is flagged for a call today.';

function seeds(): AgentSeed[] {
  n = 0;
  return [
    /* ── Admissions ── */
    {
      id: 'ag_naledi', name: 'Naledi', title: 'Lead Nurturer', officeId: 'dep_admissions', color: '#7c3aed',
      persona: 'Warm, curious and quick. Treats every lead as a person deciding about their future, not a sale.',
      instructions: 'Personalise to the course they asked about and where they found us. One clear next step every time.',
      responsibilities: ['Welcomes every new lead within minutes', 'Sends saved, approved messages from the library', 'Shares guides, videos and the career-fit quiz'],
      channels: ['email', 'whatsapp'],
      job: {
        name: 'Nurture new leads to apply',
        description: NALEDI_DESCRIPTION,
        trigger: { kind: 'lead.created', sourceId: LEADS_SOURCE_ID, cooldownHours: 24 * 30 },
        steps: NALEDI_STEPS(),
      },
    },
    {
      id: 'ag_zinhle', name: 'Zinhle', title: 'Admissions Consultant', officeId: 'dep_admissions', color: '#6d28d9',
      persona: 'Attentive and personal. Notices what someone has been reading and speaks to exactly that.',
      instructions: 'Only for leads who are clearly interested. Be personal, specific and brief; offer a short call.',
      responsibilities: ['Personal attention for hot leads', 'Hands them to a consultant the same day'],
      channels: ['email', 'whatsapp'],
      job: {
        name: 'Personal attention for hot leads',
        description: ZINHLE_DESCRIPTION,
        trigger: { kind: 'record.changed', sourceId: LEADS_SOURCE_ID, field: 'engagement', match: [{ mode: 'rule', field: 'engagement', op: 'eq', value: 'hot' }], cooldownHours: 24 * 30 },
        steps: ZINHLE_STEPS(),
      },
    },
    {
      id: 'ag_thabo', name: 'Thabo', title: 'Admissions Advisor', officeId: 'dep_admissions', color: '#8b5cf6',
      persona: 'Patient, precise and quietly persuasive. Answers the actual question first, then helps them decide.',
      instructions: 'Only state facts from what you know about the academy. If unsure, say a consultant will confirm. Every reply moves them one step closer to applying.',
      responsibilities: ['Answers every reply the same minute', 'Handles doubts and objections with facts', 'Flags anyone ready to sign up'],
      channels: ['email', 'whatsapp'],
      job: {
        name: 'Answer every reply and guide them to apply',
        description: THABO_DESCRIPTION,
        trigger: { kind: 'reply.received', sourceId: LEADS_SOURCE_ID, cooldownHours: 0 },
        steps: THABO_STEPS(),
      },
    },
    {
      id: 'ag_ayanda', name: 'Ayanda', title: 'Applications & Enrolment', officeId: 'dep_admissions', color: '#a78bfa',
      persona: 'Organised and encouraging. Makes enrolment feel easy.',
      instructions: 'Be specific about what is still needed. Celebrate progress.',
      responsibilities: ['Application follow-ups', 'Enrolment support', 'Welcome packs'],
      channels: ['email', 'whatsapp'],
      job: {
        name: 'Finish applications and welcome new students',
        description: 'When a lead is marked as applied, help them finish enrolment and welcome them properly.',
        trigger: { kind: 'record.changed', sourceId: LEADS_SOURCE_ID, field: 'status', match: [{ mode: 'rule', field: 'status', op: 'eq', value: 'applied' }], cooldownHours: 24 * 14 },
        steps: [
          s('ai_message', 'Congratulate and guide', { channel: 'email', review: true, instructions: 'Congratulate them on applying. Explain clearly what happens next and anything they still need to send or do to enrol.' }),
          s('wait', 'Give them 3 days', { hours: 72 }),
          s('condition', 'Enrolled yet?', {
            condition: { mode: 'rule', field: 'status', op: 'eq', value: 'enrolled' },
            yes: [s('ai_message', 'Welcome to the academy', { channel: 'email_whatsapp', review: true, instructions: 'Welcome them as a new student: first day, how to log in, where to get help, and who their student success contact is.' })],
            no: [
              s('ai_message', 'Help finish enrolment', { channel: 'email_whatsapp', review: true, instructions: 'Kindly check whether anything is stopping them from completing enrolment and offer help with documents, payment options or questions.' }),
              s('notify_team', 'Flag a stuck application', { instructions: 'This applicant has not enrolled 3 days after applying. Summarise and suggest a call.' }),
            ],
          }),
        ],
      },
    },

    /* ── B2B Sales ── */
    {
      id: 'ag_sipho', name: 'Sipho', title: 'Prospect Researcher', officeId: 'dep_b2b', color: '#0891b2',
      persona: 'Sharp, concise, commercially minded.',
      instructions: 'Never invent facts about a company; say what is unknown.',
      responsibilities: ['Researches new prospects', 'Writes an account brief for sales'],
      channels: ['email'],
      job: {
        name: 'Research new prospects',
        description: 'Every new company on the prospects sheet gets a short research brief and a suggested angle, sent to the sales owner.',
        trigger: { kind: 'record.added', sourceId: PROSPECTS_SOURCE_ID, cooldownHours: 24 * 30 },
        steps: [
          s('ai_task', 'Write the account brief', { instructions: 'From what we know about this company and contact, write a short brief: who they are, likely training needs (tech skills, learnerships, upskilling), the best angle for us, and questions to ask on a first call.', saveAs: 'research_brief' }),
          s('ai_task', 'Score the fit', { instructions: 'Score how good a fit this company is for corporate training, 1 to 10, with one line why.', saveAs: 'fit_score' }),
          s('notify_team', 'Send the brief to sales', { instructions: 'Send the sales owner the research brief and fit score, and recommend whether to reach out this week.' }),
        ],
      },
    },
    {
      id: 'ag_lerato', name: 'Lerato', title: 'Outreach & Follow-ups', officeId: 'dep_b2b', color: '#06b6d4',
      persona: 'Professional, warm, brief. Writes like a person, not a brochure.',
      instructions: 'Short emails. One specific observation, one relevant offer, one easy ask.',
      responsibilities: ['Prepares personalised outreach', 'Follows up until there is an answer', 'Keeps the CRM status current'],
      channels: ['email'],
      job: {
        name: 'Reach out and follow up',
        description: 'When a prospect is marked ready, write the first personal email, then follow up twice, and keep the status current.',
        trigger: { kind: 'record.changed', sourceId: PROSPECTS_SOURCE_ID, field: 'status', match: [{ mode: 'rule', field: 'status', op: 'eq', value: 'ready' }], cooldownHours: 24 * 30 },
        steps: [
          s('ai_message', 'First personal email', { channel: 'email', review: true, instructions: 'Use the research brief. One observation about their business, one relevant way we help teams like theirs, and ask for a 15-minute call.' }),
          s('update_record', 'Mark as contacted', { setField: 'status', setValue: 'contacted' }),
          s('repeat', 'Follow up twice', {
            hours: 96, maxTimes: 2,
            condition: { mode: 'rule', field: 'replied', op: 'eq', value: 'yes' },
            steps: [s('ai_message', 'Short follow-up', { channel: 'email', review: true, instructions: 'A two to three sentence follow-up that adds one new, useful point. No guilt.' })],
          }),
          s('notify_team', 'Update the sales owner', { instructions: 'Summarise the outreach and any reply, and recommend the next move.' }),
        ],
      },
    },

    /* ── Student Success ── */
    {
      id: 'ag_bongani', name: 'Bongani', title: 'Engagement Coach', officeId: 'dep_success', color: '#2563eb',
      persona: 'Empathetic coach who helps students past whatever got in the way.',
      instructions: 'Never send a quiz to someone whose marks are fine; reach out as a person.',
      responsibilities: ['Notices students who go quiet in Moodle', 'Personal check-ins', 'Keeps checking in until they are back'],
      channels: ['email', 'whatsapp'],
      job: {
        name: 'Check in when a student goes quiet',
        description: 'When a student has not been active in Moodle for 5 days or more, check in personally, then gently again until they are back; if they stay quiet, a facilitator is asked to call.',
        trigger: { kind: 'lms.event', lmsEvent: 'login.gap', match: [{ mode: 'rule', field: 'days_since_login', op: 'gte', value: '5' }], cooldownHours: 24 * 7 },
        steps: BONGANI_STEPS(),
      },
    },
    {
      id: 'ag_nomsa', name: 'Nomsa', title: 'Coursework Coach', officeId: 'dep_success', color: '#1d4ed8',
      persona: 'Practical and encouraging. Turns a pile of overdue work into one next step.',
      instructions: 'Name the exact overdue items from Moodle. Never scold; make the first step small.',
      responsibilities: ['Follows up overdue assignments', 'Helps students plan the catch-up', 'Flags students who stay behind'],
      channels: ['email', 'whatsapp'],
      job: {
        name: 'Help with overdue work',
        description: 'When Moodle shows new overdue work, Nomsa names the exact items, offers help and a small first step, checks again every 3 days, and asks a facilitator to step in if the work is still not in.',
        trigger: { kind: 'lms.event', lmsEvent: 'assignment.missed', match: [{ mode: 'rule', field: 'missed_assignments', op: 'gte', value: '1' }], cooldownHours: 24 * 7 },
        steps: NOMSA_STEPS(),
      },
    },
    {
      id: 'ag_zodwa', name: 'Zodwa', title: 'Student Support', officeId: 'dep_success', color: '#3b82f6',
      persona: 'Kind and practical. Answers the real question and makes the next step easy.',
      instructions: 'Answer from what we know about the academy and their own Moodle progress. Anything sensitive goes to a person.',
      responsibilities: ['Answers student emails the same minute', 'Uses their real progress in Moodle', 'Hands anything sensitive to a person'],
      channels: ['email', 'whatsapp'],
      job: {
        name: 'Answer student support requests',
        description: ZODWA_DESCRIPTION,
        trigger: { kind: 'reply.received', sourceId: MOODLE_SOURCE_ID, cooldownHours: 0 },
        steps: ZODWA_STEPS(),
      },
    },
    {
      id: 'ag_mpho', name: 'Mpho', title: 'Placement Coordinator', officeId: 'dep_success', color: '#60a5fa',
      persona: 'Upbeat and connected. Gets graduates ready for work.',
      instructions: 'Be concrete about the next step towards a placement.',
      responsibilities: ['Placement coordination', 'CV and interview readiness'],
      channels: ['email'],
      job: {
        name: 'Prepare students for placement',
        description: MPHO_DESCRIPTION,
        trigger: { kind: 'record.changed', sourceId: MOODLE_SOURCE_ID, field: 'course_completed', match: [{ mode: 'rule', field: 'course_completed', op: 'eq', value: 'yes' }], cooldownHours: 24 * 60 },
        steps: MPHO_STEPS(),
      },
    },
    {
      id: 'ag_karabo', name: 'Karabo', title: 'Success Analyst', officeId: 'dep_success', color: '#93c5fd',
      persona: 'Calm and exact. Turns the week in Moodle into a short list of who needs what.',
      instructions: 'Names and numbers only from the data. No guesses.',
      responsibilities: ['Weekly at-risk report', 'Flags students who need a person'],
      channels: ['email'],
      job: {
        name: 'Weekly at-risk report',
        description: 'Every Monday at 07:00, a short report for the Student Success team from Moodle: who is at risk and why, who went quiet, who has overdue work, and three actions for the week.',
        trigger: { kind: 'schedule', sourceId: MOODLE_SOURCE_ID, schedule: { every: 'week', weekday: 1, hour: 7 } },
        steps: KARABO_STEPS(),
      },
    },

    /* ── Learning & Assessment ── */
    {
      id: 'ag_lindiwe', name: 'Lindiwe', title: 'Personal Tutor', officeId: 'dep_learning', color: '#059669',
      persona: 'Practical instructor who pinpoints exactly what was missed and re-teaches it.',
      instructions: 'Focus only on the questions the student got wrong.',
      responsibilities: ['Personal video lessons', '10-question mastery tests', 'Follows up on the result'],
      channels: ['email', 'whatsapp'],
      job: {
        name: 'Re-teach after a failed assessment',
        description: 'When a student fails a quiz in Moodle, build them a personal video lesson that greets them by name and a 10-question test on exactly what they missed, then follow up on the result.',
        trigger: { kind: 'lms.event', lmsEvent: 'quiz.failed', cooldownHours: 48 },
        steps: [
          s('ai_lesson', 'Personal video lesson + test', { questionCount: 10, passMark: 70, instructions: 'Re-teach exactly the questions they missed, with clear examples.' }),
          s('wait', 'Give them 2 days', { hours: 48 }),
          s('condition', 'Passed the test?', {
            condition: { mode: 'rule', field: 'quiz_passed', op: 'eq', value: 'yes' },
            yes: [s('ai_message', 'Celebrate', { channel: 'whatsapp', review: true, instructions: 'Congratulate them warmly and specifically on passing, and encourage the next module.' })],
            no: [
              s('ai_message', 'Offer a tutor session', { channel: 'email', review: true, instructions: 'Encourage them, point to the lesson again, and offer a short one-on-one tutor session this week.' }),
              s('notify_team', 'Book a tutor', { instructions: 'This student has not passed the catch-up test yet. Ask a tutor to book a session.' }),
            ],
          }),
        ],
      },
    },
    {
      id: 'ag_tumi', name: 'Tumi', title: 'Assessment Prep Coach', officeId: 'dep_learning', color: '#10b981',
      persona: 'Calm and confident. Turns exam nerves into a plan.',
      instructions: 'Give a short, specific revision plan.',
      responsibilities: ['Assessment preparation', 'Learner feedback'],
      channels: ['email'],
      job: {
        name: 'Prepare students for upcoming assessments',
        description: TUMI_DESCRIPTION,
        trigger: TUMI_TRIGGER(),
        steps: TUMI_STEPS(),
      },
    },
    {
      id: 'ag_thandi', name: 'Thandi', title: 'Academic Administrator', officeId: 'dep_learning', color: '#047857',
      persona: 'Organised and precise. Keeps the learning team ahead of the week.',
      instructions: 'Names and numbers only from the data. No guesses.',
      responsibilities: ['Weekly academic report', 'Results, deadlines and completions', 'Academic administration'],
      channels: ['email'],
      job: {
        name: 'Weekly academic report',
        description: 'Every Monday at 07:00, a short report for the learning team from Moodle: results below the pass mark and the topics behind them, overdue work, assessments due this week, and students who finished.',
        trigger: { kind: 'schedule', sourceId: MOODLE_SOURCE_ID, schedule: { every: 'week', weekday: 1, hour: 7 } },
        steps: THANDI_STEPS(),
      },
    },

    /* ── Finance & Operations ── */
    {
      id: 'ag_kagiso', name: 'Kagiso', title: 'Payment Reminders', officeId: 'dep_finance', color: '#d97706',
      persona: 'Confidential, respectful accounts specialist.',
      instructions: 'Exact amounts and dates from the tracker. Always offer a way to talk to us.',
      responsibilities: ['Reminds students before fees are due', 'Confirms payments received'],
      channels: ['email', 'whatsapp'],
      job: {
        name: 'Remind before fees are due',
        description: 'Every morning, students with a balance due in the next 3 days get a friendly reminder with the exact amount and date.',
        trigger: { kind: 'record.match', sourceId: TRACKER_SOURCE_ID, schedule: { every: 'day', hour: 8 }, match: [{ mode: 'rule', field: 'payment_state', op: 'eq', value: 'due' }, { mode: 'rule', field: 'due_date', op: 'days_until_lte', value: '3' }], cooldownHours: 24 * 5 },
        steps: [
          s('ai_message', 'Friendly reminder', { channel: 'email_whatsapp', review: true, instructions: 'A friendly heads-up that a payment is coming up: the exact amount and due date, how to pay, and that they can reply if they need an arrangement.' }),
        ],
      },
    },
    {
      id: 'ag_refilwe', name: 'Refilwe', title: 'Accounts & Arrangements', officeId: 'dep_finance', color: '#f59e0b',
      persona: 'Firm but kind. Solves the problem with the student, never against them.',
      instructions: 'Never threaten. Offer an arrangement every time. Escalate to a person, not to pressure.',
      responsibilities: ['Follows up overdue accounts', 'Offers payment arrangements', 'Escalates to the finance manager'],
      channels: ['email', 'whatsapp'],
      job: {
        name: 'Follow up overdue accounts',
        description: 'Every morning, overdue accounts get a respectful reminder, then follow-ups every 3 days until paid, an arrangement is made, or they reply; then finance takes over.',
        trigger: { kind: 'record.match', sourceId: TRACKER_SOURCE_ID, schedule: { every: 'day', hour: 9 }, match: [{ mode: 'rule', field: 'payment_state', op: 'eq', value: 'overdue' }], cooldownHours: 24 * 14 },
        steps: [
          s('ai_message', 'Respectful reminder', { channel: 'email_whatsapp', review: true, instructions: 'The account is overdue: state the exact amount and the due date that passed. Ask if anything is wrong, offer a payment arrangement, and how to reply with proof of payment.' }),
          s('repeat', 'Follow up until settled', {
            hours: 72, maxTimes: 3,
            condition: { mode: 'rule', field: 'payment_state', op: 'eq', value: 'paid' },
            steps: [s('ai_message', 'Follow-up', { channel: 'email_whatsapp', review: true, instructions: 'A short follow-up on the same overdue amount, a little more direct each time but always kind, always offering an arrangement.' })],
          }),
          s('condition', 'Settled?', {
            condition: { mode: 'rule', field: 'payment_state', op: 'eq', value: 'paid' },
            yes: [s('ai_message', 'Thank you', { channel: 'email', review: true, instructions: 'Thank them for settling the account. Short and warm.' })],
            no: [s('notify_team', 'Escalate to the finance manager', { instructions: 'This account is still overdue after follow-ups, or they replied. Summarise the account, what was sent, any reply, and recommend the next step.' })],
          }),
        ],
      },
    },
    {
      id: 'ag_musa', name: 'Musa', title: 'Reports & Operations', officeId: 'dep_finance', color: '#b45309',
      persona: 'Rigorous, clear, numbers first.',
      instructions: 'Report what the numbers say; no estimates.',
      responsibilities: ['Weekly collections report', 'Operations reporting'],
      channels: ['email'],
      job: {
        name: 'Weekly collections report',
        description: 'Every Monday at 08:00, a short report on fees: what is due, what is overdue, the largest balances, and recommended actions.',
        trigger: { kind: 'schedule', sourceId: TRACKER_SOURCE_ID, schedule: { every: 'week', weekday: 1, hour: 8 } },
        steps: [
          s('ai_task', 'Analyse the tracker', { instructions: 'From the data, summarise this week: totals due and overdue, the largest overdue accounts, and three recommended actions for the finance team.', saveAs: 'weekly_summary' }),
          s('notify_team', 'Send the report', { instructions: 'Send management the weekly collections report.' }),
        ],
      },
    },
  ];
}

const SLOT_FOR: Record<DepartmentKind, CustomAgentDef['slot']> = {
  admissions: 'planner', b2b_sales: 'planner', student_success: 'success', learning: 'learning', finance: 'coo', custom: 'planner',
};

/** Make sure the workspace runs on departments-as-floors. Safe to call often. */
export function ensureDepartmentModel(tenantId = currentTenantId()): boolean {
  if (getModelVersion(tenantId) >= MODEL_VERSION) {
    applySeedFixups();
    return false;
  }

  // Data sources the default jobs read (empty until a sheet link is pasted).
  const have = new Set(listSources(tenantId).map((x) => x.id));
  const ti = getTenantIntegrations(tenantId);
  if (!have.has(TRACKER_SOURCE_ID)) {
    saveSource({ id: TRACKER_SOURCE_ID, name: 'Student tracker', kind: 'finance', url: ti.googleSheetUrl || '', departmentId: 'dep_finance', mapping: {} }, tenantId);
  }
  if (!have.has(PROSPECTS_SOURCE_ID)) {
    saveSource({ id: PROSPECTS_SOURCE_ID, name: 'B2B prospects', kind: 'prospects', url: '', departmentId: 'dep_b2b', mapping: {} }, tenantId);
  }

  // Older custom offices stay (as extra floors) unless they were the old defaults.
  const OLD_DEFAULTS = new Set(['of_success', 'of_learning', 'of_finance', 'of_admissions', 'of_review']);
  const keptOffices = listOffices().filter((o) => !OLD_DEFAULTS.has(o.id) && !DEPARTMENTS.some((d) => d.id === o.id));
  const offices = [...DEPARTMENTS.map((d) => ({ ...d })), ...keptOffices.map((o, i) => ({ ...o, kind: o.kind || 'custom' as const, floor: DEPARTMENTS.length + i + 1 }))];

  // Agents and their jobs.
  const existingWfs = new Map(listWorkflows().map((w) => [w.id, w]));
  const agents: CustomAgentDef[] = [];
  for (const seed of seeds()) {
    const dept = DEPARTMENTS.find((d) => d.id === seed.officeId)!;
    const wfId = `wf_${seed.id.slice(3)}`;
    if (!existingWfs.has(wfId)) {
      createWorkflow({
        name: seed.job.name,
        officeName: dept.name,
        officeId: dept.id,
        agentId: seed.id,
        domain: dept.domain,
        description: seed.job.description,
        trigger: seed.job.trigger.kind === 'lms.event' && seed.job.trigger.lmsEvent ? seed.job.trigger.lmsEvent : 'manual',
        instructions: seed.job.instructions || '',
        version: 2,
        departmentId: dept.id,
        agentTrigger: seed.job.trigger,
        steps: seed.job.steps,
      }, wfId);
    }
    const { job: _job, ...a } = seed;
    agents.push({ ...a, channels: seed.channels || ['email'], slot: SLOT_FOR[dept.kind || 'custom'], enabled: true, createdAt: T0, workflowId: wfId });
  }
  // Agents someone created themselves stay, on their office's floor.
  const OLD_AGENTS = new Set(['ag_zanele', 'ag_bongani', 'ag_lindiwe', 'ag_kagiso', 'ag_musa']);
  for (const a of listCustomAgents()) {
    if (OLD_AGENTS.has(a.id) || agents.some((x) => x.id === a.id)) continue;
    agents.push({ ...a, officeId: offices.some((o) => o.id === a.officeId) ? a.officeId : 'dep_success' });
  }

  // The old single-step workflows are kept for history but paused: the agents above replace them.
  for (const w of listWorkflows()) {
    if (w.version !== 2 && ['wf_quiz_recovery', 'wf_attendance', 'wf_quiet_rescue', 'wf_payments_assignments', 'wf_late_payment_recovery'].includes(w.id)) {
      updateWorkflow(w.id, { enabled: false });
    }
  }

  replaceDepartments(offices, agents, MODEL_VERSION, tenantId);
  // B2B sales runs on its own system: its agents start paused.
  for (const id of PAUSED_WORKFLOWS) if (listWorkflows().some((w) => w.id === id)) updateWorkflow(id, { enabled: false });
  // A fresh workspace already has the new journey and Zinhle from the seeds.
  const nm = nurtureMeta(tenantId);
  nm.seeded.naledi ||= Date.now();
  nm.seeded.zinhle ||= Date.now();
  nm.seeded.sales ||= Date.now();
  nm.seeded.ongoing ||= Date.now();
  nm.seeded.focus ||= Date.now();
  seedStarterOffers();
  if (!listMessages().length) seedStarterLibrary();
  // After the starters (an empty library is what tells it to add them).
  seedUsefulMessage();
  nm.seeded.starter ||= Date.now();
  nurtureMetaDoc.save(tenantId);
  log('system', 'system', 'The building now has a floor per department (Admissions, B2B Sales, Student Success, Learning & Assessment, Finance & Operations), each with its own agents.');
  return true;
}

/** New, unique ids for steps added to an existing job. */
function freshIds(steps: AgentStep[]): AgentStep[] {
  const stamp = Date.now().toString(36);
  let k = 0;
  const walk = (list: AgentStep[]): AgentStep[] => list.map((x) => ({
    ...x, id: `st_${stamp}${(k++).toString(36)}`,
    ...(x.yes ? { yes: walk(x.yes) } : {}), ...(x.no ? { no: walk(x.no) } : {}), ...(x.steps ? { steps: walk(x.steps) } : {}),
  }));
  return walk(steps);
}

/** A job whose steps share an id cannot be followed reliably: give the repeats new ids (once, whenever found). */
function repairStepIds() {
  for (const w of listWorkflows()) {
    if (w.version !== 2 || !w.steps?.length) continue;
    const ids: string[] = [];
    const walk = (list: AgentStep[]) => { for (const x of list) { ids.push(x.id); walk(x.yes || []); walk(x.no || []); walk(x.steps || []); } };
    walk(w.steps);
    if (new Set(ids).size !== ids.length) updateWorkflow(w.id, { steps: sanitizeSteps(w.steps) });
  }
}

/** Corrections to seeded agents in workspaces that migrated before the fix. */
function applySeedFixups() {
  repairStepIds();
  const refilwe = listCustomAgents().find((a) => a.id === 'ag_refilwe');
  // Agent titles appear in email signatures: never a label the reviewer would reject.
  if (refilwe && /debtor/i.test(refilwe.title)) {
    saveCustomAgent({ id: refilwe.id, name: refilwe.name, officeId: refilwe.officeId, title: 'Accounts & Arrangements' });
  }
  applyNurtureSetup();
}

/** Lead nurturing (once per workspace): Naledi moves to the message library,
 *  Zinhle joins Admissions for hot leads, and the library gets its starter drafts. */
function applyNurtureSetup() {
  const m = nurtureMeta();
  let changed = false;
  if (!m.seeded.naledi) {
    const wf = listWorkflows().find((w) => w.id === 'wf_naledi');
    // Only a journey nobody edited is replaced.
    if (wf && JSON.stringify((wf.steps || []).map((x) => x.title)) === JSON.stringify(OLD_NALEDI_TITLES)) {
      updateWorkflow(wf.id, { steps: NALEDI_STEPS(), description: NALEDI_DESCRIPTION });
      const naledi = listCustomAgents().find((a) => a.id === 'ag_naledi');
      if (naledi) saveCustomAgent({ id: naledi.id, name: naledi.name, officeId: naledi.officeId, responsibilities: ['Welcomes every new lead within minutes', 'Sends saved, approved messages from the library', 'Shares guides, videos and the career-fit quiz'] });
    }
    m.seeded.naledi = Date.now(); changed = true;
  }
  if (!m.seeded.zinhle) {
    const dept = listOffices().find((o) => o.id === 'dep_admissions');
    if (dept && !listCustomAgents().some((a) => a.id === 'ag_zinhle')) {
      const seed = seeds().find((x) => x.id === 'ag_zinhle')!;
      if (!listWorkflows().some((w) => w.id === 'wf_zinhle')) {
        createWorkflow({
          name: seed.job.name, officeName: dept.name, officeId: dept.id, agentId: seed.id, domain: dept.domain,
          description: seed.job.description, trigger: 'manual', instructions: '', version: 2, departmentId: dept.id,
          agentTrigger: seed.job.trigger, steps: seed.job.steps,
        }, 'wf_zinhle');
      }
      saveCustomAgent({ id: seed.id, name: seed.name, title: seed.title, officeId: dept.id, slot: 'planner', persona: seed.persona, channels: seed.channels, instructions: seed.instructions, workflowId: 'wf_zinhle', responsibilities: seed.responsibilities, color: seed.color });
    }
    m.seeded.zinhle = Date.now(); changed = true;
  }
  if (!m.seeded.starter) {
    if (!listMessages().length) seedStarterLibrary();
    m.seeded.starter = Date.now(); changed = true;
  }
  if (!m.seeded.sales) {
    // AI that sells: Thabo answers every reply, Zinhle makes hot leads a personal video, Naledi's welcome gets a personal line.
    // Only jobs nobody edited are replaced.
    const titles = (id: string) => JSON.stringify((listWorkflows().find((w) => w.id === id)?.steps || []).map((x) => x.title));
    if (titles('wf_thabo') === JSON.stringify(OLD_THABO_TITLES)) {
      updateWorkflow('wf_thabo', { name: 'Answer every reply and guide them to apply', description: THABO_DESCRIPTION, steps: THABO_STEPS(), agentTrigger: { kind: 'reply.received', sourceId: LEADS_SOURCE_ID, cooldownHours: 0 } });
      const thabo = listCustomAgents().find((a) => a.id === 'ag_thabo');
      if (thabo) saveCustomAgent({ id: thabo.id, name: thabo.name, officeId: thabo.officeId, title: 'Admissions Advisor', channels: ['email', 'whatsapp'], persona: 'Patient, precise and quietly persuasive. Answers the actual question first, then helps them decide.', instructions: 'Only state facts from what you know about the academy. If unsure, say a consultant will confirm. Every reply moves them one step closer to applying.', responsibilities: ['Answers every reply the same minute', 'Handles doubts and objections with facts', 'Flags anyone ready to sign up'] });
    }
    if (titles('wf_zinhle') === JSON.stringify(OLD_ZINHLE_TITLES)) updateWorkflow('wf_zinhle', { steps: ZINHLE_STEPS() });
    const naledi = listWorkflows().find((w) => w.id === 'wf_naledi');
    if (naledi && titles('wf_naledi') === JSON.stringify(NALEDI_STEPS().map((x) => x.title)) && naledi.steps?.[0]?.kind === 'send_library' && !naledi.steps[0].personalLine) {
      updateWorkflow('wf_naledi', { steps: naledi.steps.map((x, i) => (i === 0 ? { ...x, personalLine: true } : x)) });
    }
    m.seeded.sales = Date.now(); changed = true;
  }
  const zw = listWorkflows().find((w) => w.id === 'wf_zinhle');
  if (zw && /The only place AI writes for one lead|tells a consultant to call today\.$/.test(zw.description || '')) updateWorkflow('wf_zinhle', { description: ZINHLE_DESCRIPTION });
  if (!m.seeded.ongoing) {
    const titles = (id: string) => JSON.stringify((listWorkflows().find((w) => w.id === id)?.steps || []).map((x) => x.title));
    const naledi = listWorkflows().find((w) => w.id === 'wf_naledi');
    if (naledi && titles('wf_naledi') === JSON.stringify(PREV_NALEDI_TITLES)) updateWorkflow('wf_naledi', { steps: [...(naledi.steps || []), ...freshIds(KEEP_IN_TOUCH())] });
    if (titles('wf_zinhle') === JSON.stringify(PREV_ZINHLE_TITLES)) updateWorkflow('wf_zinhle', { steps: ZINHLE_STEPS() });
    if (titles('wf_thabo') === JSON.stringify(PREV_THABO_TITLES)) updateWorkflow('wf_thabo', { steps: THABO_STEPS() });
    seedStarterOffers();
    seedUsefulMessage();
    m.seeded.ongoing = Date.now(); changed = true;
  }
  if (!m.seeded.focus) {
    applyFocusSetup();
    m.seeded.focus = Date.now(); changed = true;
  }
  if (!m.seeded.costFix) {
    // Samples used to count as AI messages to leads; with no real leads yet, every one of them was a sample.
    if (!listRecords(LEADS_SOURCE_ID).some((r) => r.fields.preview !== 'yes')) m.stats.aiSends = 0;
    m.seeded.costFix = Date.now(); changed = true;
  }
  if (changed) nurtureMetaDoc.save();
}

/** The three departments that go live first (Admissions, Student Success, Learning & Assessment) work from Moodle,
 *  Finance sends payment reminders, B2B is paused. Once per workspace; jobs someone edited are left alone. */
function applyFocusSetup() {
  const titles = (id: string) => JSON.stringify((listWorkflows().find((w) => w.id === id)?.steps || []).map((x) => x.title));
  const all = seeds();
  for (const id of PAUSED_WORKFLOWS) if (listWorkflows().some((w) => w.id === id)) updateWorkflow(id, { enabled: false });
  // New agents on their floors.
  for (const id of ['ag_nomsa', 'ag_karabo', 'ag_thandi']) addSeedAgent(all.find((x) => x.id === id)!);
  // Zodwa answers students' emails (Moodle has no attendance to follow up).
  if (titles('wf_zodwa') === JSON.stringify(['Recap and catch-up offer', 'Give them 2 days', 'Did they respond?'])) {
    const z = all.find((x) => x.id === 'ag_zodwa')!;
    updateWorkflow('wf_zodwa', { name: z.job.name, description: z.job.description, agentTrigger: z.job.trigger, steps: z.job.steps, trigger: 'manual' });
    saveCustomAgent({ id: z.id, name: z.name, officeId: z.officeId, title: z.title, persona: z.persona, instructions: z.instructions, responsibilities: z.responsibilities });
  }
  // Mpho starts when Moodle shows a finished course.
  if (titles('wf_mpho') === JSON.stringify(['Congratulations and next steps', 'Tell the placement team'])) {
    updateWorkflow('wf_mpho', { description: MPHO_DESCRIPTION, agentTrigger: all.find((x) => x.id === 'ag_mpho')!.job.trigger, steps: MPHO_STEPS() });
  }
  // Tumi reads assessment dates from Moodle.
  const tumi = listWorkflows().find((w) => w.id === 'wf_tumi');
  if (tumi && tumi.agentTrigger?.sourceId === TRACKER_SOURCE_ID && titles('wf_tumi') === JSON.stringify(['Revision plan'])) {
    updateWorkflow('wf_tumi', { description: TUMI_DESCRIPTION, agentTrigger: TUMI_TRIGGER(), steps: TUMI_STEPS() });
  }
  const bongani = listWorkflows().find((w) => w.id === 'wf_bongani');
  if (bongani && titles('wf_bongani') === JSON.stringify(BONGANI_STEPS().map((x) => x.title))) {
    updateWorkflow('wf_bongani', { description: all.find((x) => x.id === 'ag_bongani')!.job.description, steps: BONGANI_STEPS() });
  }
  log('system', 'system', 'Student Success and Learning & Assessment now work from Moodle (new: Nomsa for overdue work, Karabo and Thandi for weekly reports; Zodwa answers student emails). B2B Sales is paused.');
}

/** Add a seeded agent and its job to an existing workspace (if it is not there yet). */
function addSeedAgent(seed: AgentSeed) {
  const dept = listOffices().find((o) => o.id === seed.officeId);
  if (!dept || listCustomAgents().some((a) => a.id === seed.id)) return;
  const wfId = `wf_${seed.id.slice(3)}`;
  if (!listWorkflows().some((w) => w.id === wfId)) {
    createWorkflow({
      name: seed.job.name, officeName: dept.name, officeId: dept.id, agentId: seed.id, domain: dept.domain,
      description: seed.job.description, trigger: seed.job.trigger.kind === 'lms.event' && seed.job.trigger.lmsEvent ? seed.job.trigger.lmsEvent : 'manual',
      instructions: seed.job.instructions || '', version: 2, departmentId: dept.id, agentTrigger: seed.job.trigger, steps: freshIds(seed.job.steps),
    }, wfId);
  }
  saveCustomAgent({ id: seed.id, name: seed.name, title: seed.title, officeId: dept.id, slot: SLOT_FOR[dept.kind || 'custom'], persona: seed.persona, channels: seed.channels, instructions: seed.instructions, workflowId: wfId, responsibilities: seed.responsibilities, color: seed.color });
}

/** Floors in order, with their agents and each agent's workflow. */
export function buildingModel() {
  const offices = [...listOffices()].sort((a, b) => (a.floor ?? 99) - (b.floor ?? 99));
  const agents = listCustomAgents();
  const wfs = listWorkflows();
  return offices.map((o) => ({
    department: o,
    agents: agents.filter((a) => a.officeId === o.id).map((a) => ({ agent: a, workflow: wfs.find((w) => w.id === a.workflowId) || null })),
  }));
}

export type WorkflowSeedSummary = Pick<WorkflowDef, 'id' | 'name'>;
