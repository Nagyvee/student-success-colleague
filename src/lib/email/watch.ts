import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { tenantDoc } from '@/lib/engine/tenantDoc';
import { getState, log } from '@/lib/engine/store';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import { findRecordsByEmail } from '@/lib/data/records';

/* Reading replies from the academy's mailbox.
 *
 * SMTP only sends. To hear back, Thuso reads the same mailbox over IMAP
 * (Gmail: imap.gmail.com with the same app password) once a minute. A new
 * email from a lead or a student is handed to the agents exactly as if it
 * came through the reply webhook: their follow-ups stop, and the agent whose
 * job is replies (Thabo, for leads) answers it in the same thread.
 *
 * Safe by design: the first check only notes where the inbox is (old mail is
 * never answered), mail from strangers, auto-replies, bounces and mailing
 * lists is ignored, nothing is marked read or moved, and one person gets at
 * most a few AI replies a day before a person takes over. */

interface Seen { ts: number; from: string; subject: string; action: string }

interface WatchState {
  enabled: boolean;
  uidValidity: string;
  lastUid: number;
  lastCheck: number | null;
  lastError: string | null;
  handled: number;
  ignored: number;
  recent: Seen[];
  /** email → times the agents answered in the last day */
  answered: Record<string, number[]>;
}

const doc = tenantDoc<WatchState>('mail-watch', () => ({ enabled: false, uidValidity: '', lastUid: 0, lastCheck: null, lastError: null, handled: 0, ignored: 0, recent: [], answered: {} }));
const MAX_PER_DAY = Math.max(1, Number(process.env.REPLIES_PER_PERSON_PER_DAY || 4));
const PER_CHECK = 25;

const clean = (v?: string) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();

export interface ImapSettings { host: string; port: number; user: string; pass: string }

/** The mailbox to read: IMAP_* when set, otherwise the sending account (smtp.gmail.com → imap.gmail.com). */
export function imapSettings(tenantId = currentTenantId()): ImapSettings | null {
  const ti = getTenantIntegrations(tenantId);
  const isDefault = tenantId === DEFAULT_TENANT_ID;
  const smtpHost = clean(ti.smtpHost || (isDefault ? process.env.SMTP_HOST : ''));
  const user = clean(process.env.IMAP_USER && isDefault ? process.env.IMAP_USER : ti.smtpUser || (isDefault ? process.env.SMTP_USER : ''));
  let pass = clean(process.env.IMAP_PASS && isDefault ? process.env.IMAP_PASS : ti.smtpPass || (isDefault ? process.env.SMTP_PASS : ''));
  let host = clean(isDefault ? process.env.IMAP_HOST : '') || derivedHost(smtpHost);
  if (!host || !user || !pass) return null;
  if (/gmail\.com|googlemail\.com/i.test(host)) pass = pass.replace(/\s+/g, '');
  host = host.toLowerCase();
  return { host, port: Number(isDefault ? process.env.IMAP_PORT : '') || 993, user, pass };
}

export function derivedHost(smtpHost: string): string {
  const h = smtpHost.toLowerCase();
  if (!h) return '';
  if (/(^|\.)gmail\.com$|googlemail/.test(h)) return 'imap.gmail.com';
  if (/office365|outlook|hotmail|live\.com/.test(h)) return 'outlook.office365.com';
  if (/zoho/.test(h)) return h.replace(/^smtp/, 'imap');
  if (h.startsWith('smtp.')) return `imap.${h.slice(5)}`;
  return h; // mail.example.com serves both
}

export function watchStatus(tenantId = currentTenantId()) {
  const st = doc.get(tenantId);
  const cfg = imapSettings(tenantId);
  return {
    configured: Boolean(cfg),
    enabled: st.enabled,
    mailbox: cfg ? `${cfg.user} (${cfg.host})` : null,
    lastCheck: st.lastCheck,
    lastError: st.lastError,
    handled: st.handled,
    ignored: st.ignored,
    recent: st.recent.slice(0, 8),
  };
}

export function setWatch(enabled: boolean, tenantId = currentTenantId()) {
  const st = doc.get(tenantId);
  // Switching on always starts from now: mail that arrived while it was off is never answered.
  if (enabled && !st.enabled) st.lastUid = 0;
  st.enabled = enabled;
  if (!enabled) st.lastError = null;
  doc.save(tenantId);
}

export async function hydrateMailWatch(tenantId = currentTenantId()) {
  await doc.hydrate(tenantId);
}

/* ── Reading a message ────────────────────────────────────────────────────── */

const AUTO_SUBJECT = /^(auto(matic)?[ -]?(reply|response)|out of (the )?office|away from|undeliver|delivery (status|failure|has failed)|mail delivery|returned mail|failure notice|read:|accepted:|declined:)/i;
const ROBOT_FROM = /(mailer-daemon|postmaster|no-?reply|do-?not-?reply|notifications?@|bounce)/i;

/** Mail that must never get an answer: auto-replies, bounces, lists, calendar responses. */
export function isAutomatic(m: Pick<ParsedMail, 'subject' | 'headers' | 'from'>): boolean {
  const h = (k: string) => String(m.headers?.get(k) ?? '').toLowerCase();
  const auto = h('auto-submitted');
  if (auto && auto !== 'no') return true;
  if (h('x-autoreply') || h('x-autorespond') || h('x-auto-response-suppress').includes('all')) return true;
  if (/^(bulk|list|junk|auto_reply)$/.test(h('precedence'))) return true;
  if (h('list-id') || h('list-unsubscribe')) return true;
  if (AUTO_SUBJECT.test(String(m.subject || '').trim())) return true;
  const from = m.from?.value?.[0]?.address || '';
  return ROBOT_FROM.test(from);
}

/** Only what they wrote now: the quoted earlier email and the signature are cut off. */
export function replyText(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const joined = `${l} ${lines[i + 1] || ''}`;
    if (/^On .{4,200}wrote:\s*$/i.test(l.trim()) || /^On .{4,200}wrote:\s*$/i.test(joined.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim()) || /^_{5,}$/.test(l.trim())) break;
    if (/^From:\s.+/i.test(l.trim()) && out.length) break;
    if (/^Sent from my (iPhone|Android|Samsung|mobile)/i.test(l.trim())) break;
    if (/^--\s*$/.test(l)) break;
    if (/^>/.test(l.trim())) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);
}

/* ── Checking the inbox ───────────────────────────────────────────────────── */

const g = globalThis as unknown as { __thusoMailWatch?: Set<string> };
const busy = (g.__thusoMailWatch ??= new Set());

function note(st: WatchState, s: Seen) {
  st.recent = [s, ...st.recent].slice(0, 20);
}

/** Read new mail since the last check and hand replies to the agents. */
export async function checkReplies(tenantId = currentTenantId(), opts: { force?: boolean } = {}): Promise<{ handled: number; ignored: number; error?: string }> {
  const st = doc.get(tenantId);
  if (!st.enabled && !opts.force) return { handled: 0, ignored: 0 };
  const cfg = imapSettings(tenantId);
  if (!cfg) return { handled: 0, ignored: 0, error: 'No mailbox: set up the sending email (SMTP) first.' };
  if (busy.has(tenantId)) return { handled: 0, ignored: 0 };
  busy.add(tenantId);
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.port === 993, auth: { user: cfg.user, pass: cfg.pass }, logger: false, socketTimeout: 30_000, greetingTimeout: 15_000 });
  let handled = 0;
  let ignored = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const box = client.mailbox && typeof client.mailbox === 'object' ? client.mailbox : null;
      const validity = String(box?.uidValidity ?? '');
      const next = Number(box?.uidNext ?? 1);
      if (!st.lastUid || st.uidValidity !== validity) {
        // First look (or the mailbox was rebuilt): start from now, never answer old mail.
        st.uidValidity = validity;
        st.lastUid = Math.max(0, next - 1);
        log('system', 'info', `Now reading replies sent to ${cfg.user}. Emails from leads and students from now on are answered by the agents.`);
      } else if (next - 1 > st.lastUid) {
        const ours = new Set([cfg.user.toLowerCase(), clean(process.env.EMAIL_FROM).toLowerCase()].filter(Boolean));
        const from = st.lastUid + 1;
        const to = Math.min(next - 1, st.lastUid + PER_CHECK);
        for await (const msg of client.fetch(`${from}:${to}`, { uid: true, source: true }, { uid: true })) {
          if (!msg.uid || msg.uid <= st.lastUid) continue;
          st.lastUid = Math.max(st.lastUid, msg.uid);
          if (!msg.source) continue;
          const mail = await simpleParser(msg.source);
          const sender = mail.from?.value?.[0];
          const email = (sender?.address || '').toLowerCase();
          const subject = String(mail.subject || '').slice(0, 160);
          const name = sender?.name || '';
          if (!email || ours.has(email)) continue;
          if (isAutomatic(mail)) { ignored++; note(st, { ts: Date.now(), from: email, subject, action: 'ignored: an automatic email' }); continue; }
          const known = findRecordsByEmail(email).length > 0 || getState().learners.some((l) => l.email.toLowerCase() === email);
          if (!known) { ignored++; continue; }
          const text = replyText(mail.text || (typeof mail.html === 'string' ? mail.html.replace(/<[^>]+>/g, ' ') : ''));
          if (!text) { ignored++; continue; }
          // A few AI answers a day per person, then a person takes over.
          const day = Date.now() - 86_400_000;
          const times = (st.answered[email] || []).filter((t) => t > day);
          const { dispatchReply } = await import('@/lib/engine/agentTriggers');
          if (times.length >= MAX_PER_DAY) {
            // Their reply is still on record (their follow-ups stop); nobody is started.
            const { noteReply } = await import('@/lib/engine/agentRuns');
            const { setRecordField } = await import('@/lib/data/records');
            noteReply(email, text, (f, v) => { for (const r of findRecordsByEmail(email)) setRecordField(r.sourceId, r.key, f, v); });
            note(st, { ts: Date.now(), from: name || email, subject, action: 'kept for a person (many replies today)' });
            log('system', 'info', `${name || email} has written ${times.length + 1} times today: the agents leave this one for a person.`);
            continue;
          }
          const started = await dispatchReply(email, text, name || undefined, { messageId: mail.messageId, subject });
          let action = started ? 'answered by the agents' : 'noted (no agent for replies is on, or autopilot is off)';
          if (!started && getState().learners.some((l) => l.email.toLowerCase() === email)) {
            const { handleInboundStudentReply } = await import('@/lib/engine/inboundReply');
            const r = await handleInboundStudentReply({ fromEmail: email, fromName: name || undefined, subject, text, tenantId }).catch(() => null);
            if (r?.ok) action = 'passed to Student Success';
          }
          if (started) st.answered[email] = [...times, Date.now()];
          handled++;
          note(st, { ts: Date.now(), from: name || email, subject, action });
          log('system', 'lms', `Reply from ${name || email}: "${text.replace(/\s+/g, ' ').slice(0, 90)}" (${action}).`);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout().catch(() => {});
    st.lastError = null;
  } catch (e) {
    const err = e as Error & { responseText?: string; authenticationFailed?: boolean };
    st.lastError = err.authenticationFailed
      ? `The mailbox refused the sign-in for ${cfg.user}. For Gmail, use an app password and make sure IMAP is on (Gmail → Settings → Forwarding and POP/IMAP).`
      : `${err.responseText || err.message}`.slice(0, 300);
    try { client.close(); } catch { /* already closed */ }
  } finally {
    // Old counters go.
    const day = Date.now() - 86_400_000;
    for (const [k, v] of Object.entries(st.answered)) { const keep = v.filter((t) => t > day); if (keep.length) st.answered[k] = keep; else delete st.answered[k]; }
    st.lastCheck = Date.now();
    st.handled += handled;
    st.ignored += ignored;
    doc.save(tenantId);
    busy.delete(tenantId);
  }
  return { handled, ignored, ...(st.lastError ? { error: st.lastError } : {}) };
}
