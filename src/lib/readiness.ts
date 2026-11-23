import { getTenantIntegrations } from '@/lib/auth/accounts';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import { getState, publicUrl } from '@/lib/engine/store';
import { listWorkflows } from '@/lib/engine/workflows';
import { LEADS_SOURCE_ID, MOODLE_SOURCE_ID, getSource } from '@/lib/data/sources';
import { listRecords } from '@/lib/data/records';
import { TRACKER_SOURCE_ID } from '@/lib/engine/departments';
import { sendingPaused } from '@/lib/email/pause';
import { smtpReady } from '@/lib/email/send';
import { watchStatus } from '@/lib/email/watch';
import { listMessages } from '@/lib/nurture/library';
import { listOffers } from '@/lib/nurture/vouchers';
import { meta as nurtureMeta } from '@/lib/nurture/store';
import { listMedia } from '@/lib/nurture/media';
import { ttsProvider, voiceError } from '@/lib/media/tts';
import { ESCALATION_LABEL, ESCALATION_TYPES } from '@/lib/escalation';
import fs from 'node:fs';
import path from 'node:path';

const hasFileSecret = () => {
  try { return fs.readFileSync(path.join(process.cwd(), '.data', 'session-secret'), 'utf8').trim().length >= 32; } catch { return false; }
};

/* Go-live readiness: what is connected, what is missing, and where to fix it.
 *
 * One list for the whole building, grouped the way the team thinks about it
 * (the platform, then each department). Every item is read from the live
 * workspace, so the page is the checklist: when everything is green, the
 * agents can run on their own. Secrets are never shown, only whether they are set. */

export type CheckState = 'ok' | 'todo' | 'optional' | 'info';

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  /** What we see now. */
  detail: string;
  /** What to do about it (empty when nothing is needed). */
  fix: string;
  href?: string;
}

export interface CheckGroup { id: string; title: string; purpose: string; checks: Check[] }

const env = (k: string) => Boolean((process.env[k] || '').trim());

export interface DbState { configured: boolean; where: string; reachable: boolean; error: string | null }

export function readiness(tenantId = currentTenantId(), db: DbState = { configured: env('DATABASE_URL'), where: '', reachable: env('DATABASE_URL'), error: null }): { groups: CheckGroup[]; summary: { ok: number; todo: number; optional: number }; testPhase: boolean } {
  const ti = getTenantIntegrations(tenantId);
  const st = getState();
  const isDefault = tenantId === DEFAULT_TENANT_ID;
  const base = publicUrl(tenantId);
  const localBase = /localhost|127\.0\.0\.1/.test(base);
  const approval = st.settings.requireApproval !== false;
  const autopilot = Boolean(st.settings.autoRunMode);
  const paused = sendingPaused();
  const live = Boolean(ti.liveOutreachEnabled);
  const wfs = listWorkflows();
  const routed = ESCALATION_TYPES.filter((k) => (ti.escalations?.[k] || '').trim());
  const unrouted = ESCALATION_TYPES.filter((k) => !routed.includes(k));
  const on = (id: string) => Boolean(wfs.find((w) => w.id === id)?.enabled);

  /* ── The platform ── */
  const platform: Check[] = [
    {
      id: 'address', label: 'A public web address',
      state: localBase ? 'todo' : 'ok',
      detail: localBase ? `Links in emails point to ${base}, which only works on this computer.` : `Links in emails point to ${base}.`,
      fix: localBase ? 'Host it on the VPS behind a domain (e.g. https://thuso.melsoft.org) and set PUBLIC_BASE_URL to that address in .env.local on the VPS (deploy/windows/README.md). Quiz, video, voucher and unsubscribe links depend on it.' : '',
    },
    {
      id: 'database', label: 'Where the data is kept',
      state: !db.configured ? 'info' : db.reachable ? 'ok' : 'todo',
      detail: !db.configured
        ? 'In the .data folder on this machine. On the VPS that is enough: the disk keeps it across restarts.'
        : db.reachable
          ? `Postgres at ${db.where} answers, plus a copy in the .data folder.`
          : `Postgres is set (${db.where}${/^127\.0\.0\.1:5433$/.test(db.where) ? ', the SSH tunnel to the VPS' : ''}) but does not answer (${db.error || 'no reply'}). Changes are kept in .data and sent up when it is back; the newer copy wins.`,
      fix: !db.configured
        ? 'Back the .data folder up every night (deploy/windows/backup.ps1 does it). Postgres is optional.'
        : db.reachable ? '' : 'Restart the SSH tunnel to the VPS (port 5433). Once the app runs on the VPS itself, set PGHOST=127.0.0.1 and PGPORT=5432 there: no tunnel needed.',
    },
    {
      id: 'secret', label: 'Sign-in and link key',
      state: env('SESSION_SECRET') || hasFileSecret() ? 'ok' : 'todo',
      detail: env('SESSION_SECRET') ? 'SESSION_SECRET is set.' : hasFileSecret() ? 'Made automatically and kept in .data/session-secret; it stays the same across restarts.' : 'Not made yet: it is created on the first start.',
      fix: 'Nothing to do on the VPS: it is created on the first start. Keep .data in the nightly backup (lose it and everyone signs in again, and links in emails already sent stop working).',
    },
    {
      id: 'ai', label: 'AI (Claude)',
      state: env('ANTHROPIC_API_KEY') ? 'ok' : 'todo',
      detail: env('ANTHROPIC_API_KEY') ? 'ANTHROPIC_API_KEY is set.' : 'No ANTHROPIC_API_KEY: agents fall back to playbook messages.',
      fix: env('ANTHROPIC_API_KEY') ? '' : 'Set ANTHROPIC_API_KEY.',
    },
    {
      id: 'smtp', label: 'Email sending (SMTP)',
      state: smtpReady() ? 'ok' : 'todo',
      detail: smtpReady() ? 'The mail server is set.' : 'No mail server: emails are kept in the Inbox only.',
      fix: smtpReady() ? '' : 'Channels & API → Email: the Gmail address and an app password (or SMTP_HOST, SMTP_USER, SMTP_PASS).',
      href: '/workspace',
    },
    {
      id: 'replies', label: 'Reading replies (IMAP)',
      state: (() => { const w = watchStatus(tenantId); return w.enabled && !w.lastError ? 'ok' : 'todo'; })(),
      detail: (() => { const w = watchStatus(tenantId); return w.enabled ? (w.lastError ? `Switched on, but: ${w.lastError}` : `Watching ${w.mailbox}.`) : w.configured ? `Ready (${w.mailbox}) but switched off.` : 'Not set up.'; })(),
      fix: 'Lead Nurturing → Journey → Replies: switch on reading replies, so Thabo answers leads and Zodwa answers students.',
      href: '/nurture',
    },
    {
      id: 'manager', label: 'Who gets hand-offs and reports',
      state: (ti.managerEmail || (isDefault && env('MANAGER_EMAIL'))) ? (routed.length === ESCALATION_TYPES.length ? 'ok' : 'todo') : 'todo',
      detail: !(ti.managerEmail || (isDefault && env('MANAGER_EMAIL')))
        ? 'No manager email: hand-offs ("call this lead today") and weekly reports stay in the app.'
        : routed.length
          ? `Routed: ${routed.map((k) => ESCALATION_LABEL[k].title).join(', ')}. The rest goes to the manager email.`
          : 'Everything goes to the manager email.',
      fix: `Channels & API → Email → Escalations: a person for each kind${unrouted.length ? ` (still to set: ${unrouted.map((k) => ESCALATION_LABEL[k].title).join(', ')})` : ''}.`,
      href: '/workspace',
    },
    {
      id: 'knowledge', label: 'What every agent knows about the academy',
      state: (ti.agentKnowledge || '').trim().length >= 200 ? 'ok' : 'todo',
      detail: (ti.agentKnowledge || '').trim() ? `${(ti.agentKnowledge || '').trim().length} characters of facts.` : 'Empty: agents only know the academy name.',
      fix: 'Channels & API → What the agents know: programmes, fees, intakes, how to apply, payment options, support hours, policies. Agents never state facts that are not here.',
      href: '/workspace#data-sources',
    },
    {
      id: 'voice', label: 'Voice for videos (Deepgram)',
      state: !ttsProvider() || voiceError() ? 'todo' : 'ok',
      detail: !ttsProvider() ? 'Not set: the presenter is silent on many phones (they only get captions).' : voiceError() ? `Set, but the last try failed: ${voiceError()}.` : 'Set.',
      fix: ttsProvider() ? 'Check the Deepgram key and its credit.' : 'Set DEEPGRAM_API_KEY on the server and restart Thuso.',
    },
    {
      id: 'whatsapp', label: 'WhatsApp',
      state: ti.whatsappUrl || ti.manychatApiKey ? 'ok' : 'optional',
      detail: ti.whatsappUrl || ti.manychatApiKey ? 'Connected.' : 'Not connected: agents use email only.',
      fix: 'Channels & API → WhatsApp (your WhatsApp API or ManyChat).',
      href: '/workspace',
    },
  ];

  /* ── Safety: how much runs on its own ── */
  const safety: Check[] = [
    {
      id: 'approval', label: 'Approval Mode',
      state: approval ? 'ok' : 'info',
      detail: approval ? 'On: every message to a student or lead waits in the Inbox until a person approves it.' : 'Off: approved agents send by themselves.',
      fix: approval ? 'Keep it on while testing. Turn it off per workspace when the team is happy with what the agents write.' : '',
      href: '/settings',
    },
    {
      id: 'autopilot', label: 'Autopilot (agents start by themselves)',
      state: autopilot ? 'ok' : 'todo',
      detail: autopilot ? 'On: new leads, Moodle changes, replies and schedules start the agents.' : 'Off: agents only run when someone presses Run.',
      fix: autopilot ? '' : 'Settings → Autopilot on. With Approval Mode on, nothing is sent without a person.',
      href: '/settings',
    },
    {
      id: 'lock', label: 'Sending lock (test phase)',
      state: 'info',
      detail: paused ? 'Locked: even approved emails are kept in the Inbox, nothing leaves the server.' : live ? 'Open: approved emails are really sent.' : 'Open on the server, but Live Outreach is off for this workspace (emails stay in the Inbox).',
      fix: paused ? 'When ready: set SENDING_PAUSED=false on the server and switch Live Outreach on (Channels & API). Until then, test with your own addresses.' : '',
    },
    {
      id: 'redirect', label: 'Safe demo inbox',
      state: (ti.testRecipientEmail || '').trim() ? 'ok' : 'optional',
      detail: (ti.testRecipientEmail || '').trim() ? `Every email goes to ${(ti.testRecipientEmail || '').trim()} instead of the real student or lead.` : 'Not set: once sending is unlocked, approved emails go to the real person.',
      fix: 'For a demo with real emails: Channels & API → Test Redirect Inbox = your own address, then unlock sending. Every approved email lands with you, never with a student.',
      href: '/workspace',
    },
  ];

  /* ── Admissions ── */
  const leads = listRecords(LEADS_SOURCE_ID).filter((r) => r.fields.preview !== 'yes');
  const leadsSheet = getSource(LEADS_SOURCE_ID);
  const msgs = listMessages();
  const approved = msgs.filter((x) => x.status === 'approved');
  const drafts = msgs.filter((x) => x.status === 'draft');
  const nm = nurtureMeta(tenantId);
  const activeOffers = listOffers().filter((o) => o.status === 'active');
  const admissions: Check[] = [
    {
      id: 'leads', label: 'Leads coming in (Facebook, TikTok, forms)',
      state: leads.length ? 'ok' : 'todo',
      detail: leads.length ? `${leads.length} lead${leads.length === 1 ? '' : 's'}${leadsSheet?.provider === 'dialer' ? ', read from the dialer (the people it holds for Thuso)' : leadsSheet?.url ? ', read from the leads sheet' : ''}.` : 'No leads yet.',
      fix: leads.length ? '' : 'Lead Nurturing → Leads: paste the Google Sheet your ad leads land in (shared "Anyone with the link: Viewer"), or point Zapier/Make at the leads webhook (Channels & API). To test, add yourselves as rows.',
      href: '/nurture',
    },
    {
      id: 'library', label: 'Saved messages approved',
      state: approved.length >= 5 ? 'ok' : 'todo',
      detail: `${approved.length} approved, ${drafts.length} draft${drafts.length === 1 ? '' : 's'}.`,
      fix: approved.length >= 5 ? '' : 'Lead Nurturing → Messages: read each starter message and approve it once (or rewrite it). Naledi only sends approved messages.',
      href: '/nurture',
    },
    {
      id: 'apply', label: 'The application link',
      state: (ti.applyUrl || '').trim() ? 'ok' : 'todo',
      detail: (ti.applyUrl || '').trim() ? 'Set.' : 'Not set: "Apply" buttons fall back to "reply to this email".',
      fix: 'Channels & API → What the agents know → application link.',
      href: '/workspace#data-sources',
    },
    {
      id: 'quiz', label: 'Career-fit quiz and programme videos',
      state: nm.fit && nm.videos.length ? 'ok' : 'todo',
      detail: `${nm.fit ? 'Quiz ready' : 'No quiz yet'}; ${nm.videos.length} programme video${nm.videos.length === 1 ? '' : 's'}.`,
      fix: 'Lead Nurturing → Quiz & videos: build the quiz and one video per programme (once).',
      href: '/nurture',
    },
    {
      id: 'offers', label: 'Vouchers',
      state: activeOffers.length ? 'ok' : 'optional',
      detail: activeOffers.length ? `${activeOffers.length} active: ${activeOffers.map((o) => o.name).join(', ')}.` : 'None active (Zinhle and Thabo give none until one is).',
      fix: 'Lead Nurturing → Vouchers: check the amount and dates, then make it active.',
      href: '/nurture',
    },
    {
      id: 'footage', label: 'Your own footage for the videos',
      state: listMedia().some((x) => x.enabled && x.kind !== 'music') ? 'ok' : 'optional',
      detail: `${listMedia().filter((x) => x.kind !== 'music').length} clip${listMedia().filter((x) => x.kind !== 'music').length === 1 ? '' : 's'}/photo${listMedia().length === 1 ? '' : 's'}.`,
      fix: 'Lead Nurturing → Content bank → Footage: short clips of the team, students and campus.',
      href: '/nurture',
    },
    {
      id: 'admissions_agents', label: 'Admissions agents on',
      state: ['wf_naledi', 'wf_zinhle', 'wf_thabo', 'wf_ayanda'].every(on) ? 'ok' : 'todo',
      detail: `${['wf_naledi', 'wf_zinhle', 'wf_thabo', 'wf_ayanda'].filter(on).length} of 4 on (Naledi, Zinhle, Thabo, Ayanda).`,
      fix: 'Agents & Workflows: switch them on.',
      href: '/workflows',
    },
  ];

  /* ── Student Success and Learning & Assessment (Moodle) ── */
  const moodleOn = ti.lmsProvider === 'moodle' && Boolean((ti.moodleUrl || (isDefault && process.env.MOODLE_URL)) && (ti.moodleToken || (isDefault && process.env.MOODLE_TOKEN)));
  const students = listRecords(MOODLE_SOURCE_ID);
  const studying = students.filter((r) => r.fields.status === 'active');
  const withDue = studying.filter((r) => r.fields.next_assessment_date);
  const courseFilter = (ti.moodleCourseIds || (isDefault ? process.env.MOODLE_COURSE_IDS : '') || '').trim();
  const success: Check[] = [
    {
      id: 'moodle', label: 'Moodle connected',
      state: moodleOn ? 'ok' : 'todo',
      detail: moodleOn ? `Connected. ${students.length} student${students.length === 1 ? '' : 's'} on the list (${studying.length} studying, ${students.length - studying.length} finished or inactive).` : 'Not connected.',
      fix: moodleOn ? (students.length ? '' : 'Students → Sync Moodle once: the first sync is the baseline and contacts nobody.') : 'Channels & API → LMS: Moodle address and a web-service token (read access to users, courses, completion, grades, assignments).',
      href: moodleOn ? '/learners' : '/workspace',
    },
    {
      id: 'courses', label: 'Only current courses are synced',
      state: courseFilter ? 'ok' : 'todo',
      detail: courseFilter ? `Course filter: ${courseFilter}.` : 'Every course in Moodle is synced, including finished intakes.',
      fix: 'Channels & API → LMS → course IDs (and groups) of the intakes that are studying now, so past students are never contacted. Finished students are skipped either way.',
      href: '/workspace',
    },
    {
      id: 'due', label: 'Assessment due dates (for Tumi)',
      state: withDue.length ? 'ok' : studying.length ? 'todo' : 'info',
      detail: withDue.length ? `${withDue.length} student${withDue.length === 1 ? '' : 's'} have a next assessment date from Moodle.` : 'No upcoming due dates seen yet.',
      fix: withDue.length ? '' : 'Give assignments a due date in Moodle. Tumi sends a revision plan 5 days before.',
    },
    {
      id: 'attendance', label: 'Class attendance',
      state: 'optional',
      detail: 'Moodle does not send attendance by default.',
      fix: 'If you track attendance (Moodle Attendance plugin or a sheet), send it to the LMS webhook as attendance.missed and an agent can follow up.',
    },
    {
      id: 'success_agents', label: 'Student Success and Learning agents on',
      state: ['wf_bongani', 'wf_nomsa', 'wf_zodwa', 'wf_mpho', 'wf_karabo', 'wf_lindiwe', 'wf_tumi', 'wf_thandi'].every(on) ? 'ok' : 'todo',
      detail: `${['wf_bongani', 'wf_nomsa', 'wf_zodwa', 'wf_mpho', 'wf_karabo', 'wf_lindiwe', 'wf_tumi', 'wf_thandi'].filter(on).length} of 8 on.`,
      fix: 'Agents & Workflows: switch them on.',
      href: '/workflows',
    },
  ];

  /* ── Finance (payment reminders) ── */
  const tracker = getSource(TRACKER_SOURCE_ID);
  const finance: Check[] = [
    {
      id: 'tracker', label: 'Student fees tracker (Google Sheet)',
      state: tracker?.url ? (tracker.lastError ? 'todo' : 'ok') : 'todo',
      detail: tracker?.url ? (tracker.lastError ? tracker.lastError : `${tracker.rows ?? 0} rows read.`) : 'Not connected.',
      fix: tracker?.url ? '' : 'Channels & API → Student tracker: paste the fees sheet (amount due, due date, payment status per student). Kagiso reminds 3 days before; Refilwe follows up overdue accounts.',
      href: '/workspace#data-sources',
    },
  ];

  const groups: CheckGroup[] = [
    { id: 'platform', title: 'The platform', purpose: 'Hosting, data, AI, email: needed by every department.', checks: platform },
    { id: 'safety', title: 'How much runs on its own', purpose: 'For the test phase: agents work, a person approves every message.', checks: safety },
    { id: 'admissions', title: 'Admissions', purpose: 'Leads from ads to applications: Naledi, Zinhle, Thabo, Ayanda.', checks: admissions },
    { id: 'success', title: 'Student Success and Learning & Assessment', purpose: 'From Moodle: Bongani, Nomsa, Zodwa, Mpho, Karabo; Lindiwe, Tumi, Thandi.', checks: success },
    { id: 'finance', title: 'Finance (payment reminders)', purpose: 'Kagiso and Refilwe, from the fees tracker. B2B Sales is paused (another system does it).', checks: finance },
  ];
  const all = groups.flatMap((g) => g.checks);
  return {
    groups,
    summary: { ok: all.filter((c) => c.state === 'ok').length, todo: all.filter((c) => c.state === 'todo').length, optional: all.filter((c) => c.state === 'optional').length },
    testPhase: approval || paused,
  };
}
