import type { DataRecord } from '@/lib/types';
import type { NurtureMessage, NurtureStage } from './types';
import { libraryDoc } from './store';
import { renderForLead, writePersonalLine, leadEmailExtras, offerMessage } from './library';
import { issueVoucher, listOffers, offerLive } from './vouchers';
import { buildProgrammeVideo, videoFor } from './video';
import { programmeList } from './programmes';
import { signTrack } from './track';
import { getRecord, upsertRecord } from '@/lib/data/records';
import { LEADS_SOURCE_ID, liveFields } from '@/lib/data/sources';
import { personalEmail, sendMail } from '@/lib/email/send';
import { writeMessage } from '@/lib/ai/agentMind';
import { listCustomAgents } from '@/lib/engine/offices';
import { ZINHLE_STEPS } from '@/lib/engine/departments';
import { getState, log as storeLog } from '@/lib/engine/store';

/** Lead nurturing is Admissions' work: its activity shows on that floor. */
const log: typeof storeLog = (actor, level, text, extra = {}) => storeLog(actor, level, text, { dept: 'admissions', ...extra });
import { currentTenantId } from '@/lib/auth/tenantContext';

/* "See it as a lead": the whole journey, for the person looking.
 *
 * A hidden sample lead (never worked on by the agents, never counted) gets
 * every email the journey sends, in order, in the Inbox: the welcome with the
 * career-fit quiz, their programme video, proof, the invitation to apply, and
 * what a hot lead gets (Zinhle's personal note and a video made for them).
 * The buttons work: the quiz and the videos open as the lead would see them. */

const ORDER: { stage: NurtureStage; label: string }[] = [
  { stage: 'welcome', label: 'Welcome, within minutes' },
  { stage: 'learn', label: 'Day 2' },
  { stage: 'trust', label: 'Day 5' },
  { stage: 'decide', label: 'Day 9' },
];

/** The message a stage would send this lead: approved first, a draft if nothing is approved yet. */
function forStage(stage: NurtureStage, programme: string): NurtureMessage | null {
  const list = libraryDoc.get().filter((m) => m.stage === stage && m.status !== 'archived' && !m.repeatable && (!m.programme || m.programme.toLowerCase() === programme.toLowerCase()) && m.audience !== 'parents');
  return list.sort((a, b) => Number(b.status === 'approved') - Number(a.status === 'approved') || Number(Boolean(b.programme)) - Number(Boolean(a.programme)))[0] || null;
}

export async function buildSampleJourney(input: { userId: string; name: string; email: string; programme?: string }): Promise<{ mails: { id: string; subject: string }[]; quizUrl: string; videoUrl: string; voucherUrl: string | null; personal: boolean }> {
  const tid = currentTenantId();
  const programme = (input.programme || programmeList()[0] || 'Software Development').trim();
  const first = (input.name || 'there').split(/\s+/)[0];
  const key = `preview:${input.userId}`;

  // A fresh sample lead each time: what they told us on the form, nothing done yet.
  upsertRecord(LEADS_SOURCE_ID, {
    key, name: input.name || 'Sample Lead', email: (input.email || '').toLowerCase(), phone: '',
    fields: {
      first_name: first, interest: programme, source: 'Facebook lead form (sample)', preview: 'yes',
      message: 'I work full time and want to move into tech. Can I study in the evenings, and how does paying work?',
      fit_programme: '', fit_track: '', fit_done: '', engagement: '', engagement_score: '', nurture_seen: '', last_clicked: '', conversation: '',
    },
  });
  const rec = getRecord(LEADS_SOURCE_ID, key) as DataRecord;

  // Their programme's video (made once; made now if it is the first time).
  if (!videoFor(programme)) await buildProgrammeVideo(programme);

  const naledi = listCustomAgents().find((a) => a.id === 'ag_naledi');
  const zinhle = listCustomAgents().find((a) => a.id === 'ag_zinhle');
  const sender = { name: naledi?.name || 'Naledi', office: 'Admissions' };
  const mails: { id: string; subject: string }[] = [];
  // The voucher a hot lead gets (an active offer, else the first draft, so the team can see it before making it active).
  const offer = listOffers().find((o) => offerLive(o)) || listOffers()[0] || null;
  const total = ORDER.length + 1 + (offer ? 1 : 0);

  // 1–4: the saved messages, as the journey sends them.
  for (const [i, step] of ORDER.entries()) {
    const msg = forStage(step.stage, programme);
    if (!msg) continue;
    const line = step.stage === 'welcome' ? await writePersonalLine(rec) : null;
    const r = renderForLead(msg, rec, sender, { personalLine: line || undefined, tenantId: tid });
    const m = await sendMail({ dept: 'admissions', to: input.email, toName: input.name, subject: `[Sample ${i + 1}/${total} · ${step.label}] ${r.subject}`, html: r.html, text: r.text, link: r.ctaHref, taskId: `sample_journey_${key}`, deliverableId: null });
    mails.push({ id: m.id, subject: m.subject });
  }

  // 5: when they turn hot, Zinhle makes them a video and writes to them herself.
  const scenes = null; // videos are reused: the greeting comes from their record, no AI scenes per lead
  const noteStep = ZINHLE_STEPS().find((x) => x.kind === 'ai_message')!;
  const draft = await writeMessage({
    agent: { name: zinhle?.name || 'Zinhle', title: zinhle?.title || 'Admissions Consultant', persona: zinhle?.persona || '', instructions: zinhle?.instructions || '' },
    department: { name: 'Admissions', kind: 'admissions' },
    fields: { ...liveFields(rec), lead_brief: [`Interested in ${rec.fields.programme || 'tech'}`, rec.fields.fit_track ? `quiz result: ${rec.fields.fit_track}` : ''].filter(Boolean).join('; ') },
    history: [],
  }, noteStep);
  const extras = leadEmailExtras(rec, 'sample', { video: true });
  const mail = personalEmail({ recipientName: rec.name, subject: draft.subject, body: draft.body, ask: draft.ask, agentName: zinhle?.name || 'Zinhle', officeName: 'Admissions', extraHtml: extras.cardsHtml, extra: { footer: extras.footer } });
  const m = await sendMail({ dept: 'admissions', to: input.email, toName: input.name, fromName: zinhle?.name || 'Zinhle', subject: `[Sample ${ORDER.length + 1}/${total} · When they turn hot] ${mail.subject}`, html: mail.html, text: mail.text, link: null, taskId: `sample_journey_${key}`, deliverableId: null });
  mails.push({ id: m.id, subject: m.subject });

  // Then their voucher: a real code for the sample lead (never counted), so the pass-it-on page works.
  let voucherUrl: string | null = null;
  if (offer) {
    const v = issueVoucher(offer, rec, { preview: true });
    const r = renderForLead(offerMessage(offer), rec, { name: zinhle?.name || 'Zinhle', office: 'Admissions' }, { tenantId: tid, voucher: { code: v.code, expiresAt: v.expiresAt, offer } });
    const vm = await sendMail({ dept: 'admissions', to: input.email, toName: input.name, fromName: zinhle?.name || 'Zinhle', subject: `[Sample ${total}/${total} · Their voucher${offer.status === 'active' ? '' : ' (draft offer)'}] ${r.subject}`, html: r.html, text: r.text, link: r.ctaHref, taskId: `sample_journey_${key}`, deliverableId: null });
    mails.push({ id: vm.id, subject: vm.subject });
    voucherUrl = `${getState().caps.baseUrl.replace(/\/$/, '')}/v/${v.code}`;
  }

  const base = getState().caps.baseUrl;
  const tok = (x: 'quiz' | 'video') => signTrack({ t: tid, s: LEADS_SOURCE_ID, k: key, m: 'sample', x });
  log('system', 'email', `A sample lead journey (${programme}) is in the Inbox: ${mails.length} emails, as a lead gets them.`);
  return { mails, quizUrl: `${base}/fit/${tok('quiz')}`, videoUrl: `${base}/watch/${tok('video')}`, voucherUrl, personal: Boolean(scenes) };
}
