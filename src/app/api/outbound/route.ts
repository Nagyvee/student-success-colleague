import { NextResponse } from 'next/server';
import { MANAGER_ROLES, runWithSessionTenant } from '@/lib/auth/requestTenant';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { bootReady } from '@/lib/engine/automation';
import { liveAllowed } from '@/lib/email/pause';
import { safeReason } from '@/lib/engine/problems';
import { aiReady } from '@/lib/outbound/ask';
import { postTest } from '@/lib/outbound/discord';
import { approve, compose, draftFirst, draftProblems, mailer, mayNotWrite, notFit, officeHours, reject, sendMessage, sendingBlocked, stopFor } from '@/lib/outbound/outreach';
import { addIdeals, isRejectReason, learnIdeals } from '@/lib/outbound/research';
import { findNow, researchBlocked } from '@/lib/outbound/run';
import { PIPELINE, REJECT_REASONS, STAGE_LABEL, type Company, type Stage } from '@/lib/outbound/types';
import { blankCompany, blockedReason, companies, domainOf, getCompany, httpLink, ideals, log, missingForResearch, missingForSending, publicSettings, room, runState, sastDay, saveCompany, saveIdeals, saveSettings, setStage, settings, spend } from '@/lib/outbound/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

/* B2B outbound.
 *
 * GET                 the page: today's list, the pipeline, ideal companies, settings, spend
 * GET ?company=<id>   one company, with its whole conversation and what each draft would look like
 * GET ?export=csv     every company people said yes to, or that is on the list
 * POST {action, ...}  see below. Settings, ideal companies and sending need an owner or admin;
 *                     choosing companies, notes and stages are for everyone who is signed in. */

const row = (c: Company) => ({
  id: c.id, name: c.name, website: c.website, what: c.what, sector: c.sector, city: c.city, province: c.province, size: c.size, score: c.score, scoreWhy: c.scoreWhy, fit: c.fit, concerns: c.concerns, facts: c.facts, service: c.service, like: c.like,
  contact: c.contact, stage: c.stage, from: c.from, foundAt: c.foundAt, listedOn: c.listedOn, consent: c.consent, rejectReason: c.rejectReason || '', lostReason: c.lostReason || '', decidedBy: c.decidedBy || '', contactedAt: c.contactedAt || 0, lastAt: c.lastAt || 0, callAt: c.callAt || '', value: c.value || '', owner: c.owner || '', summary: c.summary, said: c.said,
  drafts: c.thread.filter((m) => m.status === 'draft').length, ready: c.thread.filter((m) => m.status === 'ready').length, failed: c.thread.find((m) => m.status === 'failed')?.error || '', answered: c.thread.some((m) => m.who === 'them'),
});
export type CompanyRow = ReturnType<typeof row>;

function overview(manager: boolean) {
  const s = settings();
  const run = runState();
  const all = companies();
  const r = room();
  const sp = spend();
  // Looked at and left out by Thuso itself: kept so they are not found again, not shown.
  const shown = all.filter((c) => !(c.stage === 'rejected' && c.decidedBy === 'Thuso'));
  return {
    canManage: manager, aiReady: aiReady(), today: sastDay(),
    settings: manager ? publicSettings() : { ...publicSettings(), smtpPass: '', discordWebhook: '', smtpUser: '' },
    missingForResearch: missingForResearch(s), missingForSending: missingForSending(s),
    research: { on: s.researchOn, blocked: researchBlocked(), doing: run.doing, researched: run.day === sastDay() ? run.researched : 0, kept: run.day === sastDay() ? run.kept : 0, extra: run.extra, lastError: run.lastError, lastErrorAt: run.lastErrorAt },
    sending: { on: s.sendingOn, blocked: sendingBlocked(), sentToday: run.sentDay === sastDay() ? run.sentToday : 0, perDay: s.sendPerDay, pausedUntil: run.pausedUntil && run.pausedUntil > Date.now() ? run.pausedUntil : 0, mailError: run.mail.lastError, hours: officeHours(), live: liveAllowed(getTenantIntegrations(currentTenantId()).liveOutreachEnabled) },
    spend: { usd: sp.usd, budget: s.budgetUsd, today: r.spentToday, searches: sp.searches, companies: sp.companies, month: sp.month },
    counts: Object.fromEntries(PIPELINE.map((p) => [p.id, all.filter((c) => c.stage === p.id).length])) as Record<Stage, number>,
    looked: all.length,
    companies: shown.sort((a, b) => (b.listedOn || '').localeCompare(a.listedOn || '') || b.score - a.score || b.foundAt - a.foundAt).slice(0, 1500).map(row),
    ideals: ideals().slice(0, 1000),
    rejectReasons: REJECT_REASONS,
  };
}
export type Overview = ReturnType<typeof overview>;

function detail(c: Company) {
  return {
    ...row(c), notes: c.notes, why: mayNotWrite(c, c.thread.some((m) => m.who === 'them') ? 'reply' : c.consent === 'yes' ? 'nurture' : 'first'),
    thread: c.thread.map((m) => ({ ...m, problems: m.status === 'draft' ? draftProblems(m.subject, m.text, m.kind) : [], full: m.who === 'us' ? compose(c, m).text : m.text })),
  };
}
export type CompanyDetail = ReturnType<typeof detail>;

const csvCell = (v: unknown) => { const t = String(v ?? '').replace(/\r?\n/g, ' '); const safe = /^[=+\-@\t]/.test(t) && !/^\+?[\d\s()-]+$/.test(t) ? `'${t}` : t; return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };

export async function GET(req: Request) {
  return runWithSessionTenant(req, async (session) => {
    await bootReady(currentTenantId());
    const url = new URL(req.url);
    const id = url.searchParams.get('company');
    if (id) {
      const c = getCompany(id);
      return c ? NextResponse.json({ company: detail(c) }) : NextResponse.json({ error: 'No such company.' }, { status: 404 });
    }
    if (url.searchParams.get('export')) {
      const list = companies().filter((c) => c.stage !== 'rejected');
      const head = ['Company', 'Website', 'Stage', 'Score', 'Sector', 'City', 'Province', 'Size', 'Contact', 'Role', 'Email', 'Phone', 'Service', 'Why it fits', 'Need', 'People', 'Timing', 'Budget', 'Call', 'Owner', 'Notes', 'Found'];
      const lines = list.map((c) => [c.name, c.website, STAGE_LABEL[c.stage], c.score, c.sector, c.city, c.province, c.size, c.contact.name, c.contact.role, c.contact.email, c.contact.phone, c.service, c.fit.join('; '), c.said.need, c.said.people, c.said.timing, c.said.budget, c.callAt, c.owner, c.notes, sastDay(c.foundAt)].map(csvCell).join(','));
      return new Response(`﻿${[head.join(','), ...lines].join('\r\n')}`, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="b2b-companies-${sastDay()}.csv"`, 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(overview(MANAGER_ROLES.includes(session.role)));
  });
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

const FOR_MANAGERS = new Set(['saveSettings', 'importIdeals', 'learnIdeals', 'idealUse', 'removeIdeal', 'findNow', 'testDiscord', 'testMailbox', 'sendOk', 'sendNow']);

export async function POST(req: Request) {
  return runWithSessionTenant(req, async (session) => {
    await bootReady(currentTenantId());
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = str(b.action, 40);
    if (FOR_MANAGERS.has(action) && !MANAGER_ROLES.includes(session.role)) return bad('Ask a workspace owner or admin.', 403);
    const by = session.name || session.email || 'someone';
    const pick = () => getCompany(str(b.id, 80));

    switch (action) {
      case 'saveSettings': {
        const next = saveSettings((b.settings || {}) as Record<string, unknown>);
        if (next.researchOn) { const m = missingForResearch(next); if (m.length) { saveSettings({ researchOn: false }); return bad(`Daily research stays off: tell Thuso ${m.join(' and ')} first.`); } }
        if (next.sendingOn) { const m = missingForSending(next); if (m.length) { saveSettings({ sendingOn: false }); return bad(`Saved, but sending stays off. Still missing: ${m.join(', ')}.`); } }
        return NextResponse.json({ ok: true, detail: 'Saved.' });
      }
      case 'importIdeals': {
        const r = addIdeals(str(b.text, 400_000));
        return r.added || r.total ? NextResponse.json({ ok: true, detail: `${r.added} added, ${r.total} in all. They are marked "learn from it only": Thuso never writes to them unless you change that.` }) : bad('No company names were found in that.');
      }
      case 'learnIdeals': {
        try { const r = await learnIdeals(); return r.ok ? NextResponse.json(r) : bad(r.detail); } catch (e) { return bad(safeReason((e as Error).message)); }
      }
      case 'idealUse': {
        const ids = new Set(Array.isArray(b.ids) ? b.ids.map(String) : [str(b.id, 80)]);
        const use = b.use === 'research' ? 'research' as const : 'pattern' as const;
        saveIdeals(ideals().map((x) => (ids.has(x.id) ? { ...x, use } : x)));
        return NextResponse.json({ ok: true, detail: use === 'research' ? 'Thuso may research and contact them too.' : 'Thuso only learns from them.' });
      }
      case 'removeIdeal': {
        const ids = new Set(Array.isArray(b.ids) ? b.ids.map(String) : [str(b.id, 80)]);
        saveIdeals(ideals().filter((x) => !ids.has(x.id)));
        return NextResponse.json({ ok: true });
      }
      case 'findNow': { const r = findNow(Number(b.n) || 5); return r.ok ? NextResponse.json(r) : bad(r.detail); }
      case 'testDiscord': return (await postTest()) ? NextResponse.json({ ok: true, detail: 'Posted. Check the B2B channel.' }) : bad('Discord did not take it. Save the right webhook address first (Server settings → Integrations → Webhooks).');
      case 'testMailbox': {
        const s = settings();
        if (!s.smtpHost || !s.smtpUser || !s.smtpPass) return bad('Save the mailbox first: server, address and password.');
        try {
          await (mailer.make({ host: s.smtpHost, port: s.smtpPort, secure: s.smtpPort === 465, auth: { user: s.smtpUser, pass: /gmail|google/i.test(s.smtpHost) ? s.smtpPass.replace(/\s+/g, '') : s.smtpPass }, connectionTimeout: 10_000, greetingTimeout: 10_000 }) as { verify: () => Promise<unknown> }).verify();
          return NextResponse.json({ ok: true, detail: 'The mailbox signs in. Nothing was sent.' });
        } catch (e) { return bad(`The mailbox said: ${safeReason((e as Error).message)}`); }
      }

      case 'decide': {
        // Yes or no to one or many companies.
        const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 100) : [str(b.id, 80)];
        const yes = b.yes === true;
        const reason = isRejectReason(b.reason) ? b.reason : 'Not a real fit';
        let n = 0;
        for (const id of ids) {
          const c = getCompany(id);
          if (!c || c.stage !== 'found') continue;
          if (yes) approve(c, by); else reject(c, reason, by);
          n++;
        }
        return NextResponse.json({ ok: true, detail: yes ? `${n} approved. Thuso is writing the first ${n === 1 ? 'email' : 'emails'}.` : `${n} left out (${reason}). Thuso looks for fewer like that.` });
      }
      case 'undo': {
        const c = pick();
        if (!c || !['rejected', 'approved'].includes(c.stage) || c.contactedAt) return bad('That cannot be undone.');
        c.thread = [];
        setStage(c, 'found', { rejectReason: undefined, decidedAt: undefined, decidedBy: undefined });
        return NextResponse.json({ ok: true, detail: `${c.name} is back on the list.` });
      }
      case 'stage': {
        const c = pick();
        const to = str(b.stage, 20) as Stage;
        if (!c || !PIPELINE.some((p) => p.id === to)) return bad('No such company or stage.');
        if (c.consent === 'no' && to !== 'lost') return bad('They asked us not to write, so they stay closed.');
        // Contacted is what sending does; it is never set by hand from before that.
        if (to === 'contacted' && !c.contactedAt) return bad('It moves to Contacted when the first email goes.');
        setStage(c, to, { ...(to === 'lost' ? { lostReason: str(b.reason, 120) || c.lostReason || 'Closed by the team' } : {}), ...(to === 'qualified' && !c.qualifiedAt ? { qualifiedAt: Date.now() } : {}) });
        log('system', 'info', `B2B: ${by} moved ${c.name} to ${STAGE_LABEL[to]}.`);
        return NextResponse.json({ ok: true });
      }
      case 'edit': {
        const c = pick();
        if (!c) return bad('No such company.', 404);
        if (b.notes !== undefined) c.notes = str(b.notes, 4000);
        if (b.owner !== undefined) c.owner = str(b.owner, 80);
        if (b.value !== undefined) c.value = str(b.value, 60);
        if (b.callAt !== undefined) c.callAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str(b.callAt, 20)) ? str(b.callAt, 20) : '';
        if (b.contact && typeof b.contact === 'object') {
          const x = b.contact as Record<string, unknown>;
          const email = str(x.email, 120).toLowerCase();
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('That is not an email address.');
          c.contact = { name: str(x.name, 80), role: str(x.role, 80), email, phone: str(x.phone, 40), source: email === c.contact.email ? c.contact.source : email ? `added by ${by}` : '' };
        }
        saveCompany(c);
        return NextResponse.json({ ok: true, detail: 'Saved.' });
      }
      case 'add': {
        const name = str(b.name, 120);
        const website = httpLink(b.website) || (domainOf(str(b.website)) ? `https://${domainOf(str(b.website))}/` : '');
        if (!name) return bad('Give the company a name.');
        const c = blankCompany({ name, website, domain: domainOf(website), from: 'manual', what: str(b.what, 300), listedOn: sastDay(), scoreWhy: `Added by ${by}` });
        const stop = blockedReason(c);
        if (stop) return bad(`Not added: it is ${stop}.`);
        saveCompany(c);
        return NextResponse.json({ ok: true, id: c.id, detail: `${name} is on the list.` });
      }
      case 'saveDraft': {
        const c = pick();
        const m = c?.thread.find((x) => x.id === str(b.message, 60));
        if (!c || !m || (m.status !== 'draft' && m.status !== 'ready')) return bad('That email has gone already.');
        m.subject = str(b.subject, 140) || m.subject;
        m.text = str(b.text, 4000) || m.text;
        if (Array.isArray(b.magnets)) { const ok = new Set([...settings().magnets.map((x) => x.id), 'booking']); m.magnets = b.magnets.map(String).filter((x) => ok.has(x)); }
        saveCompany(c);
        return NextResponse.json({ ok: true, detail: 'Saved.' });
      }
      case 'rewrite': {
        const c = pick();
        if (!c) return bad('No such company.', 404);
        const why = c.stage !== 'approved' ? 'the first email has gone' : mayNotWrite(c, 'first');
        if (why) return bad(`It cannot be written: ${why}.`);
        c.thread = c.thread.filter((m) => !(m.kind === 'first' && (m.status === 'draft' || m.status === 'ready')));
        await draftFirst(c, true);
        return NextResponse.json({ ok: true, detail: 'Written again.' });
      }
      case 'sendOk': {
        // Checked by a person: it goes when it is due (office hours, a few a day).
        const list = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 50).map((id) => getCompany(id)).filter((c): c is Company => Boolean(c)) : [pick()].filter((c): c is Company => Boolean(c));
        let n = 0;
        const not: string[] = [];
        for (const c of list) {
          for (const m of c.thread.filter((x) => x.status === 'draft' && (!b.message || x.id === str(b.message, 60)))) {
            const why = notFit(c, m) || draftProblems(m.subject, m.text, m.kind).join(', ');
            if (why) { not.push(`${c.name}: ${why}`); continue; }
            m.status = 'ready';
            m.error = undefined;
            n++;
          }
          saveCompany(c);
        }
        if (!n) return bad(not.length ? `Not sent: ${not.slice(0, 3).join('; ')}.` : 'Nothing was waiting.');
        const blocked = sendingBlocked();
        return NextResponse.json({ ok: true, detail: `${n === 1 ? 'It goes' : `${n} go`} out ${blocked ? `once sending can start: ${blocked}` : 'on weekdays between 08:30 and 16:30, a few a day'}${not.length ? `. Left: ${not.slice(0, 3).join('; ')}` : ''}.`.replace(/\.\.+$/, '.') });
      }
      case 'holdDraft': {
        const c = pick();
        const m = c?.thread.find((x) => x.id === str(b.message, 60) && x.status === 'ready');
        if (!c || !m) return bad('That email has gone already.');
        m.status = 'draft';
        saveCompany(c);
        return NextResponse.json({ ok: true, detail: 'Held. It does not go until you say so.' });
      }
      case 'discardDraft': {
        const c = pick();
        if (!c) return bad('No such company.', 404);
        c.thread = c.thread.filter((x) => !(x.id === str(b.message, 60) && (x.status === 'draft' || x.status === 'ready' || x.status === 'failed')));
        saveCompany(c);
        return NextResponse.json({ ok: true });
      }
      case 'sendNow': {
        const c = pick();
        const m = c?.thread.find((x) => x.id === str(b.message, 60) && (x.status === 'draft' || x.status === 'ready'));
        if (!c || !m) return bad('That email has gone already.');
        const wrong = draftProblems(m.subject, m.text, m.kind);
        if (wrong.length) return bad(`Fix first: ${wrong.join(', ')}.`);
        const r = await sendMessage(c, m);
        return r.ok ? NextResponse.json(r) : bad(r.detail);
      }
      case 'writeReply': {
        // A person answers in their own words.
        const c = pick();
        const text = str(b.text, 4000);
        if (!c || !text) return bad('Write the answer first.');
        const why = mayNotWrite(c, 'reply');
        if (why) return bad(`It cannot be sent: ${why}.`);
        c.thread = c.thread.filter((m) => !(m.status === 'draft' && m.kind === 'reply'));
        c.thread.push({ id: `m_${Date.now().toString(36)}`, who: 'us', kind: 'reply', subject: `Re: ${c.thread.find((m) => m.kind === 'first')?.subject || c.name}`, text, at: Date.now(), status: 'draft', by });
        saveCompany(c);
        return NextResponse.json({ ok: true, detail: 'Saved as a draft. Press "OK to send" when it is right.' });
      }
      case 'never': {
        const c = pick();
        if (!c) return bad('No such company.', 404);
        stopFor(c, `closed for good by ${by}`);
        return NextResponse.json({ ok: true, detail: `Thuso never writes to ${c.name} again.` });
      }
      default: return bad('Unknown action.');
    }
  });
}
