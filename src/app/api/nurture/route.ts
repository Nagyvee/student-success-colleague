import { NextResponse } from 'next/server';
import type { DataRecord, MessageChannel, StepCondition } from '@/lib/types';
import type { Audience, CtaTarget, NurtureMessage, NurtureStage } from '@/lib/nurture/types';
import { AUDIENCES, NURTURE_STAGES } from '@/lib/nurture/types';
import { MANAGER_ROLES, runWithSessionTenant } from '@/lib/auth/requestTenant';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { bootReady } from '@/lib/engine/automation';
import { ensureDepartmentModel } from '@/lib/engine/departments';
import { listAgentRuns } from '@/lib/engine/agentRuns';
import { editRecord } from '@/lib/engine/agentTriggers';
import { sanitizeCondition } from '@/lib/engine/stepSchema';
import { listCustomAgents } from '@/lib/engine/offices';
import { getWorkflow } from '@/lib/engine/workflows';
import { getState } from '@/lib/engine/store';
import { liveAllowed, sendingPaused } from '@/lib/email/pause';
import { LEADS_SOURCE_ID, getSource, liveFields, readSource, saveSource } from '@/lib/data/sources';
import { getRecord, listRecords, upsertRecord } from '@/lib/data/records';
import { meta, metaDoc } from '@/lib/nurture/store';
import { addLink, addNote, deleteResource, importWhatsApp, importYouTube, listResources, updateResource } from '@/lib/nurture/bank';
import { approveMessage, deleteMessage, getMessage, listMessages, previewMessage, resolveMessage, saveMessage, sendLibraryMessage, setMessageStatus, writeLibraryMessage, writeStarterSet } from '@/lib/nurture/library';
import { cancelCampaign, campaignSender, createCampaign, listCampaigns, segmentMembers } from '@/lib/nurture/campaigns';
import { buildFitQuiz, ensureFitQuiz } from '@/lib/nurture/fit';
import { buildMissingVideos, buildProgrammeVideo, listVideos } from '@/lib/nurture/video';
import { leadProgramme, programmeList } from '@/lib/nurture/programmes';
import { engagementFor, signTrack } from '@/lib/nurture/track';
import { checkReplies, setWatch, watchStatus } from '@/lib/email/watch';
import { buildSampleJourney } from '@/lib/nurture/sample';
import { deleteMedia, listMedia, mediaUrl, updateMedia } from '@/lib/nurture/media';
import { cancelVoucher, deleteOffer, listOffers, listVouchers, redeemVoucher, saveOffer, setOfferStatus } from '@/lib/nurture/vouchers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

/* Lead nurturing (the Admissions floor's marketing desk).
 *
 * GET                    the page: funnel, cost meter, library, bank, campaigns, quiz, videos
 * GET ?messages=1        the library, short (for the workflow builder)
 * GET ?leads=1&q=&stage= the leads with how engaged they are
 * GET ?lead=<key>        one lead: fields, what they got, what they did, their runs
 * GET ?preview=<msgId>   a message as a lead gets it (&lead=<key> for a real one)
 * POST {action, ...}     see below; changes need an owner or admin */

const DONE = /^(applied|enrolled|registered|student)$/i;

function leadRow(r: DataRecord) {
  const f = liveFields(r);
  const score = Number(f.engagement_score || 0);
  return {
    key: r.key, name: r.name, email: r.email, phone: r.phone,
    programme: leadProgramme(f), interest: f.interest || '', source: f.source || f.campaign || f.platform || '',
    status: f.status || 'new', engagement: (f.engagement as 'cold' | 'warm' | 'hot') || engagementFor(score), score,
    opens: Number(f.nurture_opens || 0), clicks: Number(f.nurture_clicks || 0), sent: Number(f.nurture_count || 0),
    lastClicked: f.last_clicked || '', fit: f.fit_track ? `${f.fit_track} → ${f.fit_programme}` : '', optedOut: f.opted_out === 'yes',
    firstSeenAt: r.firstSeenAt, lastEngagedAt: f.last_engaged_at || '',
  };
}

function overview(manager: boolean, role: string) {
  const leads = listRecords(LEADS_SOURCE_ID).filter((r) => r.fields.preview !== 'yes');
  const rows = leads.map(leadRow);
  const funnel = {
    total: rows.length,
    contacted: rows.filter((r) => r.sent > 0).length,
    cold: rows.filter((r) => !r.optedOut && !DONE.test(r.status) && r.engagement === 'cold').length,
    warm: rows.filter((r) => !r.optedOut && !DONE.test(r.status) && r.engagement === 'warm').length,
    hot: rows.filter((r) => !r.optedOut && !DONE.test(r.status) && r.engagement === 'hot').length,
    applied: rows.filter((r) => /^applied$/i.test(r.status)).length,
    enrolled: rows.filter((r) => /^(enrolled|registered|student)$/i.test(r.status)).length,
    optedOut: rows.filter((r) => r.optedOut).length,
    quiz: rows.filter((r) => r.fit).length,
  };
  const m = meta();
  const src = getSource(LEADS_SOURCE_ID);
  const ti = getTenantIntegrations(currentTenantId());
  const agents = listCustomAgents().filter((a) => a.officeId === 'dep_admissions');
  const runs = listAgentRuns({ departmentId: 'dep_admissions', limit: 200 });
  return {
    role, canManage: manager,
    stats: m.stats,
    funnel,
    programmes: programmeList(),
    leadsSource: src ? { id: src.id, name: src.name, url: src.url, rows: src.rows, lastReadAt: src.lastReadAt, lastError: src.lastError, columns: src.columns || [] } : null,
    messages: listMessages(),
    resources: listResources().map((r) => ({ ...r, text: r.text ? r.text.slice(0, 1600) : undefined })),
    campaigns: listCampaigns().map(({ queue, ...c }) => ({ ...c, left: queue.length })),
    fit: ensureFitQuiz(),
    videos: listVideos().map(({ slides, ...v }) => ({ ...v, scenes: slides.length + 1 })),
    agents: agents.map((a) => {
      const wf = a.workflowId ? getWorkflow(a.workflowId) : null;
      const mine = runs.filter((r) => r.workflowId === a.workflowId);
      return {
        id: a.id, name: a.name, title: a.title, color: a.color, workflowId: a.workflowId || null,
        job: wf?.name || '', description: wf?.description || '', trigger: wf?.agentTrigger || null, enabled: wf?.enabled ?? false,
        steps: (wf?.steps || []).map((s) => ({ id: s.id, kind: s.kind, title: s.title, stage: s.stage })),
        active: mine.filter((r) => ['running', 'waiting', 'awaiting_approval'].includes(r.status)).length,
        done: mine.filter((r) => r.status === 'completed').length,
      };
    }),
    applyUrl: ti.applyUrl || '',
    autopilot: Boolean(getState().settings.autoRunMode),
    sendingPaused: sendingPaused(),
    liveOutreach: liveAllowed(ti.liveOutreachEnabled),
    recent: rows.sort((a, b) => b.firstSeenAt - a.firstSeenAt).slice(0, 8),
    replies: watchStatus(),
    offers: listOffers(),
    vouchers: listVouchers().slice(0, 300),
    media: listMedia().map((m) => ({ ...m, url: mediaUrl(m) })),
  };
}

const strArr = (x: unknown, max = 10) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim().slice(0, 120)).slice(0, max) : undefined);
const stage = (x: unknown): NurtureStage => (NURTURE_STAGES.includes(x as NurtureStage) ? (x as NurtureStage) : 'learn');
const audience = (x: unknown): Audience => (AUDIENCES.includes(x as Audience) ? (x as Audience) : 'everyone');
const channel = (x: unknown): MessageChannel => (x === 'whatsapp' || x === 'email_whatsapp' ? x : 'email');
const segmentOf = (x: unknown): StepCondition[] => (Array.isArray(x) ? x.map(sanitizeCondition).filter((c): c is StepCondition => Boolean(c && c.mode === 'rule')).slice(0, 6) : []);

export async function GET(req: Request) {
  return runWithSessionTenant(req, async (session) => {
    await bootReady(currentTenantId());
    ensureDepartmentModel();
    const url = new URL(req.url);
    const manager = MANAGER_ROLES.includes(session.role);

    if (url.searchParams.get('offers')) {
      return NextResponse.json({ offers: listOffers().map((o) => ({ id: o.id, name: o.name, status: o.status, value: o.value, kind: o.kind })) });
    }
    if (url.searchParams.get('messages')) {
      return NextResponse.json({ messages: listMessages().filter((m) => m.status !== 'archived').map((m) => ({ id: m.id, name: m.name, stage: m.stage, status: m.status })) });
    }

    if (url.searchParams.get('leads')) {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const want = url.searchParams.get('stage') || '';
      const rows = listRecords(LEADS_SOURCE_ID).filter((r) => r.fields.preview !== 'yes').map(leadRow)
        .filter((r) => !q || `${r.name} ${r.email} ${r.phone} ${r.programme} ${r.source}`.toLowerCase().includes(q))
        .filter((r) => !want || (want === 'opted_out' ? r.optedOut : want === 'applied' ? DONE.test(r.status) : r.engagement === want && !r.optedOut && !DONE.test(r.status)))
        .sort((a, b) => b.score - a.score || b.firstSeenAt - a.firstSeenAt)
        .slice(0, 300);
      return NextResponse.json({ leads: rows });
    }

    const leadKey = url.searchParams.get('lead');
    const previewId = url.searchParams.get('preview');
    if (previewId) {
      const msg = resolveMessage(previewId);
      if (!msg) return NextResponse.json({ error: 'No such message.' }, { status: 404 });
      const r = previewMessage(msg, leadKey || undefined, LEADS_SOURCE_ID);
      return NextResponse.json({ subject: r.subject, html: r.html, whatsapp: r.whatsapp, resources: r.resources.map((x) => x.title) });
    }
    if (leadKey) {
      const rec = getRecord(LEADS_SOURCE_ID, leadKey);
      if (!rec) return NextResponse.json({ error: 'No such lead.' }, { status: 404 });
      const f = liveFields(rec);
      const got = (f.nurture_sent || '').split('|').filter(Boolean).map((id) => getMessage(id)?.name || 'A message that was deleted');
      const runs = listAgentRuns({ limit: 300 }).filter((r) => r.record.key === rec.key).slice(0, 10)
        .map((r) => ({ id: r.id, agentName: r.agentName, workflowName: r.workflowName, status: r.status, startedAt: r.startedAt, resumeAt: r.resumeAt, logs: r.logs.slice(-12) }));
      return NextResponse.json({ lead: leadRow(rec), fields: f, got, runs });
    }

    return NextResponse.json(overview(manager, session.role));
  });
}

// Anyone signed in may look; changing things needs an owner or admin.
const READ_ACTIONS = new Set(['previewSegment', 'sampleJourney', 'previewLink']);

export async function POST(req: Request) {
  return runWithSessionTenant(req, async (session) => {
    await bootReady(currentTenantId());
    ensureDepartmentModel();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
    if (!READ_ACTIONS.has(action) && !MANAGER_ROLES.includes(session.role)) {
      return bad('Only a workspace owner or admin can change lead nurturing.', 403);
    }
    try {
      switch (action) {
        /* ── Messages ── */
        case 'saveMessage': {
          const m = (body.message || {}) as Partial<NurtureMessage>;
          if (!String(m.subject || '').trim() || !String(m.body || '').trim()) return bad('A message needs a subject and a body.');
          const saved = saveMessage({
            id: typeof m.id === 'string' ? m.id : undefined,
            name: String(m.name || m.subject || 'Message'),
            subject: String(m.subject), body: String(m.body), waBody: typeof m.waBody === 'string' ? m.waBody : undefined,
            stage: stage(m.stage), audience: audience(m.audience), programme: typeof m.programme === 'string' ? m.programme : '',
            channel: channel(m.channel), cta: m.cta, resourceIds: strArr(m.resourceIds, 3) || [],
            expiresAt: typeof m.expiresAt === 'number' ? m.expiresAt : null,
            funding: Array.isArray(m.funding) ? m.funding : undefined,
          });
          return NextResponse.json({ ok: true, message: saved });
        }
        case 'approveMessage': {
          const r = approveMessage(String(body.id || ''), session.name || session.email);
          return r.error ? bad(r.error) : NextResponse.json({ ok: true, message: r.message });
        }
        case 'archiveMessage': return NextResponse.json({ ok: Boolean(setMessageStatus(String(body.id || ''), 'archived')) });
        case 'restoreMessage': return NextResponse.json({ ok: Boolean(setMessageStatus(String(body.id || ''), 'draft')) });
        case 'deleteMessage': return NextResponse.json({ ok: deleteMessage(String(body.id || '')) });
        case 'writeMessage': {
          const brief = String(body.brief || '').trim();
          if (brief.length < 8) return bad('Tell the writer what the message is for, in a sentence.');
          const exp = typeof body.expiresAt === 'number' && body.expiresAt > Date.now() ? body.expiresAt : null;
          const cta = typeof body.cta === 'string' && ['apply', 'quiz', 'video', 'resource', 'reply', 'url'].includes(body.cta) ? (body.cta as CtaTarget) : undefined;
          const m = await writeLibraryMessage({ brief, stage: stage(body.stage), audience: audience(body.audience), programme: typeof body.programme === 'string' ? body.programme : '', channel: channel(body.channel), cta, expiresAt: exp });
          return NextResponse.json({ ok: true, message: m });
        }
        case 'writeStarterSet': {
          const list = await writeStarterSet();
          return NextResponse.json({ ok: true, count: list.length });
        }
        case 'testSend': {
          const msg = resolveMessage(String(body.id || ''));
          if (!msg) return bad('No such message.');
          const to = String(body.to || session.email || '').trim();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return bad('Give an email address for the test.');
          const sample = listRecords(LEADS_SOURCE_ID).find((r) => r.fields.preview !== 'yes');
          const rec: DataRecord = sample || { key: 'sample', sourceId: LEADS_SOURCE_ID, name: session.name || 'Thandi Mokoena', email: to, phone: '', fields: { first_name: (session.name || 'Thandi').split(' ')[0], interest: msg.programme || programmeList()[0] || '' }, firstSeenAt: Date.now(), updatedAt: Date.now() };
          const r = await sendLibraryMessage({ rec, msg, sender: campaignSender(), test: { to } });
          return NextResponse.json({ ok: r.ok, detail: r.detail, mailId: r.mailId });
        }

        /* ── Vouchers ── */
        case 'saveOffer': {
          const o = (body.offer || {}) as Record<string, unknown>;
          if (!String(o.name || '').trim()) return bad('Give the voucher a name.');
          const expiry = (o.expiry && typeof o.expiry === 'object' ? o.expiry : {}) as Record<string, unknown>;
          const saved = saveOffer({
            id: typeof o.id === 'string' ? o.id : undefined,
            name: String(o.name), kind: o.kind === 'percent' ? 'percent' : 'amount', value: Number(o.value),
            appliesTo: typeof o.appliesTo === 'string' ? o.appliesTo : undefined,
            expiry: expiry.kind === 'date' ? { kind: 'date', date: Number(expiry.date) } : { kind: 'days', days: Number(expiry.days) },
            shareable: o.shareable !== false, prefix: typeof o.prefix === 'string' ? o.prefix : undefined,
            subject: typeof o.subject === 'string' ? o.subject : undefined, body: typeof o.body === 'string' ? o.body : undefined,
            maxIssued: o.maxIssued === null || o.maxIssued === '' ? null : Number(o.maxIssued) || null,
          });
          return NextResponse.json({ ok: true, offer: saved });
        }
        case 'setOfferStatus': {
          const st = body.status === 'active' ? 'active' : body.status === 'paused' ? 'paused' : 'draft';
          const o = setOfferStatus(String(body.id || ''), st, session.name || session.email);
          return o ? NextResponse.json({ ok: true, offer: o }) : bad('No such voucher.', 404);
        }
        case 'deleteOffer': return NextResponse.json({ ok: deleteOffer(String(body.id || '')) });
        case 'redeemVoucher': {
          const r = redeemVoucher(String(body.code || ''), session.name || session.email);
          return r.error ? bad(r.error) : NextResponse.json({ ok: true, voucher: r.voucher });
        }
        case 'cancelVoucher': return NextResponse.json({ ok: cancelVoucher(String(body.code || '')) });

        /* ── Footage and music ── */
        case 'updateMedia': {
          const p = (body.patch || {}) as Record<string, unknown>;
          const m = updateMedia(String(body.id || ''), { title: typeof p.title === 'string' ? p.title : undefined, tags: Array.isArray(p.tags) ? p.tags.map(String) : undefined, enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined });
          return m ? NextResponse.json({ ok: true, media: m }) : bad('No such clip.', 404);
        }
        case 'deleteMedia': return NextResponse.json({ ok: await deleteMedia(String(body.id || '')) });

        /* ── The content bank ── */
        case 'addLink': return NextResponse.json({ ok: true, resource: await addLink(String(body.url || ''), typeof body.title === 'string' ? body.title : undefined) });
        case 'addNote': return NextResponse.json({ ok: true, resource: await addNote(String(body.title || ''), String(body.text || '')) });
        case 'importYouTube': {
          const r = await importYouTube(String(body.url || ''));
          return NextResponse.json({ ok: true, added: r.added.length, skipped: r.skipped });
        }
        case 'importWhatsApp': {
          const text = String(body.text || '');
          if (text.length > 2_000_000) return bad('That chat is too long; export a shorter period.');
          const r = await importWhatsApp(text);
          return NextResponse.json({ ok: true, faqs: r.faqs, resource: r.resource });
        }
        case 'updateResource': {
          const p = (body.patch || {}) as Record<string, unknown>;
          const r = updateResource(String(body.id || ''), {
            title: typeof p.title === 'string' ? p.title : undefined,
            summary: typeof p.summary === 'string' ? p.summary : undefined,
            hook: typeof p.hook === 'string' ? p.hook : undefined,
            text: typeof p.text === 'string' ? p.text : undefined,
            audience: (strArr(p.audience) as Audience[] | undefined),
            programmes: strArr(p.programmes),
            stage: typeof p.stage === 'string' ? (p.stage as NurtureStage | 'any') : undefined,
            enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined,
          });
          return r ? NextResponse.json({ ok: true, resource: r }) : bad('No such resource.', 404);
        }
        case 'deleteResource': return NextResponse.json({ ok: await deleteResource(String(body.id || '')) });

        /* ── Campaigns ── */
        case 'previewSegment': {
          const seg = segmentOf(body.segment);
          const { members, skipped } = segmentMembers(LEADS_SOURCE_ID, seg, typeof body.messageId === 'string' ? body.messageId : undefined);
          return NextResponse.json({ count: members.length, skipped, sample: members.slice(0, 6).map((r) => r.name) });
        }
        case 'createCampaign': {
          const c = createCampaign({
            name: typeof body.name === 'string' ? body.name : undefined,
            messageId: String(body.messageId || ''),
            segment: segmentOf(body.segment),
            sendAt: typeof body.sendAt === 'number' ? body.sendAt : undefined,
            by: session.name || session.email,
          });
          const { queue, ...rest } = c;
          return NextResponse.json({ ok: true, campaign: { ...rest, left: queue.length } });
        }
        case 'cancelCampaign': return NextResponse.json({ ok: cancelCampaign(String(body.id || '')) });

        /* ── Made once: the quiz and the videos ── */
        case 'buildFitQuiz': return NextResponse.json({ ok: true, fit: await buildFitQuiz() });
        case 'buildVideo': {
          const p = String(body.programme || '').trim();
          if (!p) return bad('Choose a programme.');
          const v = await buildProgrammeVideo(p);
          return NextResponse.json({ ok: true, video: { ...v, slides: undefined } });
        }
        case 'buildMissingVideos': {
          const list = await buildMissingVideos();
          return NextResponse.json({ ok: true, made: list.length });
        }
        case 'deleteVideo': {
          const m = meta();
          m.videos = m.videos.filter((v) => v.id !== String(body.id || ''));
          metaDoc.save();
          return NextResponse.json({ ok: true });
        }

        /* ── Leads ── */
        case 'previewLink': {
          // A hidden preview lead for the person looking, so trying the quiz or video never touches a real lead.
          const kind = body.kind === 'video' ? 'video' : 'quiz';
          const key = `preview:${session.userId}`;
          const first = (session.name || 'Preview').split(/\s+/)[0];
          const programme = typeof body.programme === 'string' ? body.programme.trim().slice(0, 80) : '';
          const prev = getRecord(LEADS_SOURCE_ID, key);
          upsertRecord(LEADS_SOURCE_ID, {
            key, name: session.name || 'Preview', email: '', phone: '',
            fields: { ...(prev?.fields || {}), first_name: first, interest: programme || prev?.fields.interest || programmeList()[0] || '', preview: 'yes', source: 'a preview', ...(programme ? { fit_programme: '' } : {}) },
          });
          const token = signTrack({ t: currentTenantId(), s: LEADS_SOURCE_ID, k: key, m: 'preview', x: kind });
          return NextResponse.json({ ok: true, url: `${getState().caps.baseUrl}/${kind === 'video' ? 'watch' : 'fit'}/${token}` });
        }
        case 'sampleJourney': {
          const r = await buildSampleJourney({ userId: session.userId, name: session.name || 'Sample Lead', email: session.email, programme: typeof body.programme === 'string' ? body.programme : undefined });
          return NextResponse.json({ ok: true, ...r });
        }
        case 'setWatch': {
          setWatch(body.on === true);
          const r = body.on === true ? await checkReplies(currentTenantId(), { force: true }) : null;
          return r?.error ? bad(r.error) : NextResponse.json({ ok: true, replies: watchStatus() });
        }
        case 'checkReplies': {
          const r = await checkReplies(currentTenantId(), { force: true });
          return r.error ? bad(r.error) : NextResponse.json({ ok: true, handled: r.handled, ignored: r.ignored, replies: watchStatus() });
        }
        case 'saveLeadsSheet': {
          const url = String(body.url || '').trim();
          const src = saveSource({ id: LEADS_SOURCE_ID, name: 'Leads from ads & forms', kind: 'leads', url, departmentId: 'dep_admissions' });
          // The first read is the baseline: leads already on the sheet are imported, nobody is messaged.
          if (src.url) await readSource(getSource(LEADS_SOURCE_ID)!);
          const after = getSource(LEADS_SOURCE_ID);
          if (after?.lastError) return bad(after.lastError);
          return NextResponse.json({ ok: true, rows: after?.rows || 0 });
        }
        case 'setLeadField': {
          const field = String(body.field || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
          if (!['status', 'opted_out', 'owner', 'notes'].includes(field)) return bad('That field cannot be changed here.');
          const r = await editRecord(LEADS_SOURCE_ID, String(body.key || ''), field, String(body.value ?? '').slice(0, 200));
          return r.record ? NextResponse.json({ ok: true, started: r.started }) : bad('No such lead.', 404);
        }

        default: return bad(`Unknown action "${action}".`);
      }
    } catch (e) {
      return bad((e as Error).message || 'That did not work.');
    }
  });
}
