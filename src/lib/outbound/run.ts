import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { derivedHost, isAutomatic, replyText } from '@/lib/email/watch';
import { safeReason } from '@/lib/engine/problems';
import { aiReady } from './ask';
import { postList } from './discord';
import { bounced, draftNext, handleReply, keepWarm, pumpSend } from './outreach';
import { discover, idealCandidates, research } from './research';
import type { Candidate, Company } from './types';
import { blockedReason, companies, countCompany, domainOf, isWeekday, log, missingForResearch, pool, room, runState, sastDay, sastHour, saveCompany, savePool, saveRun, settings, spend } from './store';

/* The day.
 *
 * Every weekday morning Thuso looks for companies, a small step at a time (a
 * search for new names, then one company after another), so a restart only
 * loses one step and the budget is checked before every cent. When the day's
 * companies are done it puts the best on the list and posts them in the B2B
 * channel. The rest of the pump sends what is due, reads the outreach
 * mailbox and keeps the interested warm. */

/** The most one step may cost: a step only starts when there is room for it. */
const DISCOVER_USD = 0.06;
const RESEARCH_USD = 0.06;
/** The most "Find 5 now" may cost for each one asked for. */
const ASKED_USD = 0.1;
/** Kept back from research, so answering someone who wrote never waits for next month. */
const reserve = (budget: number) => Math.min(1, budget * 0.05);

const busy = new Set<string>();

/** Why it is not looking for companies now, or ''. */
export function researchBlocked(tenantId = currentTenantId(), now = Date.now()): string {
  const s = settings(tenantId);
  const run = runState(tenantId);
  if (!aiReady()) return 'The AI is not connected on this server.';
  const missing = missingForResearch(s);
  if (missing.length) return `Tell Thuso ${missing.join(' and ')} first.`;
  const r = room(tenantId, now);
  if (r.month < RESEARCH_USD + reserve(s.budgetUsd)) return `This month's $${s.budgetUsd} is spent. It carries on next month, or when you raise the limit.`;
  if (run.extra > 0) return '';
  if (!s.researchOn) return 'Daily research is switched off.';
  if (!isWeekday(now)) return 'It looks for companies on weekdays.';
  if (run.day === sastDay(now) && run.done) return 'Done for today.';
  if (sastHour(now) < s.hour) return `It starts at ${String(s.hour).padStart(2, '0')}:00.`;
  if (r.today < RESEARCH_USD) return 'Today\'s share of the budget is spent.';
  return '';
}

/** One step of research. Returns what it did ('' when there is nothing to do). */
export async function researchStep(tenantId = currentTenantId(), now = Date.now()): Promise<string> {
  if (busy.has(tenantId)) return '';
  const s = settings(tenantId);
  const run = runState(tenantId);
  const today = sastDay(now);
  if (run.day !== today) { Object.assign(run, { day: today, researched: 0, kept: 0, done: false, dry: 0, posted: false }); saveRun(tenantId); }
  const stop = researchBlocked(tenantId, now);
  const ended = run.researched > 0 && !run.posted && (run.done || /spent|Done/.test(stop));
  if (stop) { if (ended) await finishDay(tenantId, now, /spent/.test(stop) ? 'budget reached' : ''); run.doing = ''; return ''; }
  // "Find 5 now" has its own limit, so a click never costs more than it said.
  if (run.extra > 0 && run.stopAt !== undefined && spend(tenantId, now).usd >= run.stopAt) {
    Object.assign(run, { extra: 0, looks: 0, stopAt: undefined, dry: 0, doing: '' }); saveRun(tenantId);
    return 'the limit for this search';
  }
  const extra = run.extra > 0;
  const r = room(tenantId, now);
  if (!extra && run.researched >= s.perDay) { run.done = true; saveRun(tenantId); await finishDay(tenantId, now); return 'done'; }
  busy.add(tenantId);
  try {
    let list = pool(tenantId).filter((x) => (x.from === 'ideal' || x.sign) && !blockedReason(x, tenantId));
    if (!list.length) list = idealCandidates(tenantId);
    if (!list.length) {
      const left = extra ? r.month : r.today;
      if (run.dry >= (extra ? 2 : 3) || left < DISCOVER_USD) {
        // Nobody new after a few different searches: enough for now (each one costs).
        if (extra) { run.extra = 0; run.looks = 0; } else { run.done = true; await finishDay(tenantId, now, run.dry >= 3 ? 'no more new names found' : 'budget reached'); }
        run.dry = 0; run.doing = ''; saveRun(tenantId);
        return 'nobody new';
      }
      run.doing = 'Looking for new companies'; saveRun(tenantId);
      const found = await discover(run.angle, tenantId);
      run.angle++;
      run.dry = found.length ? 0 : run.dry + 1;
      savePool(found, tenantId);
      run.doing = ''; run.lastError = ''; saveRun(tenantId);
      return `found ${found.length}`;
    }
    const cand: Candidate = list[0];
    savePool(list.slice(1).filter((x) => x.from === 'research'), tenantId);
    run.doing = `Reading about ${cand.name}`; saveRun(tenantId);
    const out = await research(cand, tenantId);
    countCompany(tenantId);
    run.researched++;
    run.dry = 0;
    const good = Boolean(out.company && out.company.score >= s.minScore);
    if (extra) {
      run.looks = (run.looks ?? run.extra) - 1;
      if (good) run.extra--;
      if (run.looks <= 0 || run.extra <= 0) { run.extra = 0; run.looks = 0; }
    }
    if (out.company) {
      out.company.foundAt = now;
      if (extra && good) out.company.listedOn = today;
      saveCompany(out.company, tenantId);
      if (good) run.kept++;
    } else {
      // Looked at and not for us: kept, so it is not found again tomorrow.
      saveCompany({ ...nothing(cand, out.why) }, tenantId);
    }
    run.doing = ''; run.lastError = ''; saveRun(tenantId);
    return !out.company ? `left out ${cand.name}: ${out.why}` : good ? `kept ${out.company.name}` : `not good enough: ${out.company.name}`;
  } catch (e) {
    run.doing = '';
    run.lastError = safeReason((e as Error).message);
    run.lastErrorAt = now;
    // An error is never a loop: three in a row end the day (and any extra ones).
    run.dry++;
    if (run.dry >= 3) { run.done = true; run.extra = 0; run.looks = 0; run.dry = 0; }
    saveRun(tenantId);
    log('system', 'error', `B2B research stopped on an error: ${run.lastError}`);
    return '';
  } finally {
    busy.delete(tenantId);
  }
}

const nothing = (c: Candidate, why: string): Company => ({
  id: `co_${c.domain.replace(/[^a-z0-9]/g, '_')}`.slice(0, 80), name: c.name, domain: c.domain, website: c.website, what: '', sector: '', city: '', province: '', size: '', employees: null, facts: [], fit: [], concerns: why, service: '', magnetId: '', like: [],
  contact: { name: '', role: '', email: '', phone: '', source: '' }, score: 0, scoreWhy: why, stage: 'rejected', from: c.from, foundAt: Date.now(), listedOn: '', decidedBy: 'Thuso', consent: 'none', notes: '', said: {}, summary: '', nurtured: 0, thread: [], updatedAt: Date.now(),
});

/** The best of today's go on the list, and to the B2B channel. Yesterday's unanswered ones stay on the page. */
export async function finishDay(tenantId = currentTenantId(), now = Date.now(), note = ''): Promise<number> {
  const run = runState(tenantId);
  if (run.posted) return 0;
  const s = settings(tenantId);
  const today = sastDay(now);
  const best = companies(tenantId).filter((c) => c.stage === 'found' && sastDay(c.foundAt) === today && c.score >= s.minScore).sort((a, b) => b.score - a.score || Number(Boolean(b.contact.email)) - Number(Boolean(a.contact.email))).slice(0, s.showPerDay);
  for (const c of best) { c.listedOn = today; saveCompany(c, tenantId); }
  run.posted = true;
  saveRun(tenantId);
  const sp = spend(tenantId, now);
  log('system', 'info', `B2B: looked at ${run.researched} companies today; ${best.length} on the list${note ? ` (${note})` : ''}.`);
  if (best.length || note) await postList(best, { found: run.researched, spent: sp.usd, budget: s.budgetUsd, note }, tenantId);
  return best.length;
}

/** "Find 5 now": this many good ones on top of the daily ones (they go straight on the list), looking at six times as many at most. */
export function findNow(n: number, tenantId = currentTenantId(), now = Date.now()): { ok: boolean; detail: string } {
  const run = runState(tenantId);
  const before = run.extra;
  run.extra = Math.max(1, Math.min(20, Math.round(n) || 5));
  const stop = researchBlocked(tenantId, now);
  if (stop) { run.extra = before; saveRun(tenantId); return { ok: false, detail: stop }; }
  run.looks = Math.min(60, run.extra * 6);
  const most = run.extra * ASKED_USD;
  run.stopAt = spend(tenantId, now).usd + most;
  run.dry = 0;
  saveRun(tenantId);
  return { ok: true, detail: `Looking for ${run.extra} good ones now, in up to ${run.looks} companies, for about $${most.toFixed(2)} at most. They appear here one by one.` };
}

/* ── The outreach mailbox ─────────────────────────────────────────────────── */

const FREE = /(^|\.)(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|webmail|mweb|telkomsa|vodamail|absamail)\./;

/** Whose answer is this: the one it replies to, the same address, or a colleague at the same company. */
export function companyFor(o: { from: string; refs: string[] }, tenantId = currentTenantId()): Company | null {
  const asked = companies(tenantId).filter((c) => c.contactedAt);
  const from = o.from.toLowerCase();
  const domain = domainOf(from.split('@')[1]);
  return asked.find((c) => c.thread.some((m) => m.messageId && o.refs.includes(m.messageId)))
    || asked.find((c) => c.contact.email === from)
    || (domain && !FREE.test(`${domain}.`) ? asked.find((c) => c.domain === domain) || null : null);
}

const mailBusy = new Set<string>();

/** Reads new mail in the outreach mailbox (never the Admissions one). The first look only notes where it is. */
export async function readMailbox(tenantId = currentTenantId(), now = Date.now()): Promise<number> {
  const s = settings(tenantId);
  const st = runState(tenantId).mail;
  const host = s.imapHost || derivedHost(s.smtpHost);
  if (!host || !s.smtpUser || !s.smtpPass || mailBusy.has(tenantId) || !companies(tenantId).some((c) => c.contactedAt)) return 0;
  mailBusy.add(tenantId);
  const client = new ImapFlow({ host, port: 993, secure: true, auth: { user: s.smtpUser, pass: /gmail|google/i.test(host) ? s.smtpPass.replace(/\s+/g, '') : s.smtpPass }, logger: false, socketTimeout: 30_000, greetingTimeout: 15_000 });
  let n = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const box = client.mailbox && typeof client.mailbox === 'object' ? client.mailbox : null;
      const validity = String(box?.uidValidity ?? '');
      const next = Number(box?.uidNext ?? 1);
      if (!st.lastUid || st.uidValidity !== validity) { st.uidValidity = validity; st.lastUid = Math.max(0, next - 1); }
      else if (next - 1 > st.lastUid) {
        for await (const msg of client.fetch(`${st.lastUid + 1}:${Math.min(next - 1, st.lastUid + 20)}`, { uid: true, source: true }, { uid: true })) {
          if (!msg.uid || msg.uid <= st.lastUid) continue;
          st.lastUid = msg.uid;
          if (!msg.source) continue;
          const mail = await simpleParser(msg.source);
          const from = (mail.from?.value?.[0]?.address || '').toLowerCase();
          if (!from || from === s.smtpUser.toLowerCase()) continue;
          const body = mail.text || (typeof mail.html === 'string' ? mail.html.replace(/<[^>]+>/g, ' ') : '');
          if (isAutomatic(mail)) {
            // Our email came back: they were never reached.
            if (/mailer-daemon|postmaster/i.test(from) && /undeliver|failure|failed|not found|does ?n.t exist|550|5\.1\.1/i.test(`${mail.subject} ${body.slice(0, 2000)}`)) {
              const gone = companies(tenantId).find((c) => c.stage === 'contacted' && c.contact.email && body.toLowerCase().includes(c.contact.email));
              if (gone) bounced(gone);
            }
            continue;
          }
          const refs = [mail.inReplyTo, ...(Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [])].filter((x): x is string => Boolean(x));
          const c = companyFor({ from, refs }, tenantId);
          const text = replyText(body);
          if (!c || !text) continue;
          await handleReply(c, { text, subject: String(mail.subject || '').slice(0, 160), from, messageId: mail.messageId, at: mail.date?.getTime() }, tenantId);
          n++;
        }
      }
    } finally { lock.release(); }
    await client.logout().catch(() => {});
    st.lastError = '';
  } catch (e) {
    st.lastError = safeReason((e as Error & { responseText?: string }).responseText || (e as Error).message);
    try { client.close(); } catch { /* already closed */ }
  } finally {
    st.lastCheck = now;
    saveRun(tenantId);
    mailBusy.delete(tenantId);
  }
  return n;
}

/* ── The pump ─────────────────────────────────────────────────────────────── */

const last = new Map<string, { research: number; draft: number; send: number; mail: number; warm: number }>();

/** Called every few seconds by the always-on pump; does nothing until someone switched something on. */
export async function pumpOutbound(tenantId = currentTenantId(), now = Date.now()): Promise<void> {
  const t = last.get(tenantId) || { research: 0, draft: 0, send: 0, mail: 0, warm: 0 };
  last.set(tenantId, t);
  const s = settings(tenantId);
  const run = runState(tenantId);
  if ((s.researchOn || run.extra > 0) && now - t.research >= 10_000) { t.research = now; void researchStep(tenantId, now).catch(() => { /* on the page */ }); }
  if (now - t.draft >= 8_000) { t.draft = now; void draftNext(tenantId).catch(() => null); }
  if (s.sendingOn && now - t.send >= 60_000) { t.send = now; await pumpSend(tenantId, now).catch(() => 0); }
  // Someone asked may answer long after sending was switched off.
  if (now - t.mail >= 60_000) { t.mail = now; await readMailbox(tenantId, now).catch(() => 0); }
  if (s.sendingOn && now - t.warm >= 3_600_000) { t.warm = now; await keepWarm(tenantId, now).catch(() => 0); }
}
