import nodemailer from 'nodemailer';
import { liveAllowed, sendingPaused } from './pause';
import type { CheckInMessage, InboxMail, QuizQuestion, QuizResult, RemedialQuiz } from '@/lib/types';
import { getState, log, mutate, publicUrl, pushMail, uid } from '@/lib/engine/store';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';

/* Mail out of the colleague via Nodemailer (SMTP) — per tenant workspace,
 * falling back to server .env.local SMTP when configured on default workspace. */

export interface MailInput {
  to: string; toName: string; subject: string; html: string; text: string;
  link: string | null; taskId: string; deliverableId: string | null;
  /** The department sending it (a department id, or a kind such as "admissions"). */
  dept?: string;
  /** Send with this exact From line (a preview sent later keeps the sender it was written with). */
  fromLine?: string;
  /** The Message-ID this answers, so the reply stays in their email thread. */
  inReplyTo?: string;
  /** The person it comes from ("Naledi"): shown as "Naledi · Melsoft Academy". */
  fromName?: string;
  /** Extra headers (List-Unsubscribe for marketing email). */
  headers?: Record<string, string>;
}

const clean = (v?: string) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();

function smtpConfig(override?: { host?: string; port?: number; user?: string; pass?: string; emailFrom?: string }) {
  const tid = currentTenantId();
  const ti = getTenantIntegrations(tid);
  const host = clean(override?.host ?? (ti.smtpHost || (tid === DEFAULT_TENANT_ID ? process.env.SMTP_HOST : '')));
  const port = Number(override?.port ?? ti.smtpPort ?? process.env.SMTP_PORT ?? 465) || 465;
  const user = clean(override?.user ?? (ti.smtpUser || (tid === DEFAULT_TENANT_ID ? process.env.SMTP_USER : '')));
  const rawPass = clean(override?.pass ?? (ti.smtpPass || (tid === DEFAULT_TENANT_ID ? process.env.SMTP_PASS : '')));
  const pass = /gmail\.com|googlemail\.com/i.test(host) ? rawPass.replace(/\s+/g, '') : rawPass;
  const emailFrom = clean(override?.emailFrom ?? (ti.emailFrom || process.env.EMAIL_FROM));
  return { host, port, user, pass, emailFrom };
}

/** A mail server is set (host, user and password), for the go-live checklist. */
export function smtpReady(): boolean {
  const c = smtpConfig();
  return Boolean(c.host && c.user && c.pass);
}

function buildTransport(cfg: ReturnType<typeof smtpConfig>) {
  if (!cfg.host || !cfg.user || !cfg.pass) return null;
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
  });
}

export function isLiveOutreachEnabled(tenantId = currentTenantId()): boolean {
  return liveAllowed(getTenantIntegrations(tenantId).liveOutreachEnabled);
}

export function emailMode(): InboxMail['delivery'] {
  if (!isLiveOutreachEnabled()) return 'simulated';
  const cfg = smtpConfig();
  return cfg.host && cfg.user && cfg.pass ? 'smtp' : 'simulated';
}

function senderAddress(cfg = smtpConfig()) {
  const ac = getAcademyContext(currentTenantId());
  const displayFrom = cfg.emailFrom || `${ac.senderName} · ${ac.academyName}`;
  if (displayFrom.includes('@')) return displayFrom;
  if (cfg.user) return `${displayFrom.replace(/["<>]/g, '')} <${cfg.user}>`;
  return `${displayFrom.replace(/["<>]/g, '')} <noreply@thuso.local>`;
}

export async function testSmtpConnection(
  override?: { host?: string; port?: number; user?: string; pass?: string; emailFrom?: string },
  testRecipient?: string,
): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  const cfg = smtpConfig(override);
  const t = buildTransport(cfg);
  if (!t) return { ok: false, error: 'SMTP host, user, and password are required.' };
  try {
    await t.verify();
    if (testRecipient && testRecipient.includes('@')) {
      await t.sendMail({
        from: senderAddress(cfg),
        to: testRecipient.trim(),
        subject: 'Thuso · Nodemailer SMTP Connection Verified',
        text: 'Your Nodemailer SMTP configuration is connected and ready to send learner follow-ups.',
      });
      return { ok: true, detail: `SMTP verified (${cfg.host}:${cfg.port}) and test email sent to ${testRecipient.trim()}.` };
    }
    return { ok: true, detail: `SMTP handshake succeeded (${cfg.host}:${cfg.port} as ${cfg.user}).` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function sendWhatsApp(input: { toPhone?: string | null; learnerName: string; text: string }): Promise<{ ok: boolean; detail: string }> {
  const ti = getTenantIntegrations(currentTenantId());
  if (!liveAllowed(ti.liveOutreachEnabled)) {
    return { ok: true, detail: sendingPaused() ? 'Paused (test phase): kept in the app, not sent' : 'Simulated in-app only (Safe Test Mode — Live Outreach OFF)' };
  }
  const url = clean(ti.whatsappUrl || process.env.WHATSAPP_API_URL);
  const token = clean(ti.whatsappToken || process.env.WHATSAPP_API_TOKEN);
  if (!url) return { ok: false, detail: 'WhatsApp bridge URL not configured.' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        to: input.toPhone || undefined,
        from: clean(ti.whatsappFrom || process.env.WHATSAPP_FROM) || undefined,
        learnerName: input.learnerName,
        message: input.text,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok ? { ok: true, detail: 'Delivered via WhatsApp webhook' } : { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export async function testWhatsAppConnection(override?: { url?: string; token?: string }): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  const ti = getTenantIntegrations(currentTenantId());
  const url = clean(override?.url ?? ti.whatsappUrl ?? process.env.WHATSAPP_API_URL);
  const token = clean(override?.token ?? ti.whatsappToken ?? process.env.WHATSAPP_API_TOKEN);
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Enter a valid WhatsApp webhook/API URL starting with http:// or https://.' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ping: true, source: 'thuso-connection-test' }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { ok: false, error: `Endpoint responded with HTTP ${res.status}.` };
    return { ok: true, detail: `WhatsApp endpoint reachable (HTTP ${res.status}).` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function testManyChatConnection(override?: { apiKey?: string }): Promise<{ ok: true; pageName?: string; detail: string } | { ok: false; error: string }> {
  const ti = getTenantIntegrations(currentTenantId());
  const apiKey = clean(override?.apiKey ?? ti.manychatApiKey);
  if (!apiKey) return { ok: false, error: 'ManyChat API key is required.' };
  try {
    const res = await fetch('https://api.manychat.com/fb/page/getInfo', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: string; message?: string; data?: { name?: string } };
    if (!res.ok || json.status === 'error') {
      return { ok: false, error: json.message || `ManyChat API HTTP ${res.status}` };
    }
    const pageName = json.data?.name || 'Connected';
    return { ok: true, pageName, detail: `ManyChat connected (${pageName})` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function sendManyChat(input: {
  email?: string | null;
  phone?: string | null;
  learnerName: string;
  text: string;
}): Promise<{ ok: boolean; detail: string }> {
  const ti = getTenantIntegrations(currentTenantId());
  if (!liveAllowed(ti.liveOutreachEnabled)) {
    return { ok: true, detail: sendingPaused() ? 'Paused (test phase): kept in the app, not sent' : 'Simulated in-app only (Safe Test Mode — Live Outreach OFF)' };
  }
  const apiKey = clean(ti.manychatApiKey);
  if (!apiKey) return { ok: false, detail: 'ManyChat API key not configured.' };
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  try {
    let subscriberId: string | number | null = null;
    if (input.email) {
      const r = await fetch(`https://api.manychat.com/fb/subscriber/findBySystemField?email=${encodeURIComponent(input.email)}`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      const j = (await r.json().catch(() => ({}))) as { data?: { id?: string | number } };
      if (j.data?.id) subscriberId = j.data.id;
    }
    if (!subscriberId && input.phone) {
      const r = await fetch(`https://api.manychat.com/fb/subscriber/findBySystemField?phone=${encodeURIComponent(input.phone)}`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      const j = (await r.json().catch(() => ({}))) as { data?: { id?: string | number } };
      if (j.data?.id) subscriberId = j.data.id;
    }
    if (!subscriberId) {
      const parts = input.learnerName.trim().split(/\s+/);
      const createRes = await fetch('https://api.manychat.com/fb/subscriber/createSubscriber', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          first_name: parts[0] || input.learnerName,
          last_name: parts.slice(1).join(' ') || 'Learner',
          ...(input.phone ? { phone: input.phone, whatsapp_phone: input.phone } : {}),
          ...(input.email ? { email: input.email } : {}),
          has_opt_in_sms: Boolean(input.phone),
          has_opt_in_email: Boolean(input.email),
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const cj = (await createRes.json().catch(() => ({}))) as { data?: { id?: string | number }; message?: string };
      subscriberId = cj.data?.id || null;
    }
    if (!subscriberId) return { ok: false, detail: 'Could not locate or create ManyChat subscriber.' };

    if (ti.manychatFlowNs) {
      const flowRes = await fetch('https://api.manychat.com/fb/sending/sendFlow', {
        method: 'POST',
        headers,
        body: JSON.stringify({ subscriber_id: subscriberId, flow_ns: ti.manychatFlowNs }),
        signal: AbortSignal.timeout(8_000),
      });
      return flowRes.ok ? { ok: true, detail: `Triggered ManyChat flow ${ti.manychatFlowNs}` } : { ok: false, detail: `ManyChat flow HTTP ${flowRes.status}` };
    }

    const sendRes = await fetch('https://api.manychat.com/fb/sending/sendContent', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        subscriber_id: subscriberId,
        data: {
          version: 'v2',
          content: {
            type: ti.manychatChannel || 'whatsapp',
            messages: [{ type: 'text', text: input.text }],
          },
        },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    return sendRes.ok ? { ok: true, detail: 'Delivered via ManyChat API' } : { ok: false, detail: `ManyChat send HTTP ${sendRes.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export async function sendMail(input: MailInput): Promise<InboxMail> {
  const tid = currentTenantId();
  const ti = getTenantIntegrations(tid);
  const live = liveAllowed(ti.liveOutreachEnabled);
  const cfg = smtpConfig();
  const ac = getAcademyContext(tid);
  const from = input.fromLine || (input.fromName ? personalFrom(senderAddress(cfg), input.fromName, ac.academyName) : senderAddress(cfg));
  const replyTo = ac.replyTo || cfg.user || undefined;
  const safeRedirect = clean(ti.testRecipientEmail) || (tid === DEFAULT_TENANT_ID ? clean(process.env.DEMO_RECIPIENT_EMAIL) : '');
  const to = safeRedirect || input.to;
  let delivery: InboxMail['delivery'] = 'simulated';
  let providerId: string | null = null;
  let error: string | null = null;
  if (live) {
    const t = buildTransport(cfg);
    if (t) {
      try {
        const info = await t.sendMail({
          from,
          ...(replyTo ? { replyTo } : {}),
          to,
          subject: input.subject,
          html: input.html,
          text: input.text,
          ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references: input.inReplyTo } : {}),
          ...(input.headers ? { headers: input.headers } : {}),
        });
        delivery = 'smtp'; providerId = info.messageId || null;
      } catch (e) {
        const err = e as Error & { code?: string; responseCode?: number };
        error = `${err.code ? `${err.code}: ` : ''}${err.message}`;
        const blocked = /ETIMEDOUT|ECONNREFUSED|ESOCKET|EHOSTUNREACH|ENETUNREACH|Greeting never received|Connection timeout/i.test(error);
        log('system', 'error', `Email to ${to} was not sent: ${error}${blocked ? ` · the server cannot reach ${cfg.host}:${cfg.port}. Some hosts block outbound SMTP ports; check firewall or use port 2525/587.` : ''}`);
        console.warn('[thuso] SMTP send failed:', error);
      }
    }
  } else {
    log('system', 'info', sendingPaused()
      ? `[Paused] Email for ${input.toName} (${input.to}) kept in the Inbox: sending is paused on this server.`
      : `[Safe Test Mode] Email for ${input.toName} (${input.to}) saved to Inbox preview only — Live Outreach is OFF.`);
  }
  const mail: InboxMail = {
    id: uid('m'), ts: Date.now(), to, toName: input.toName, from, subject: input.subject, html: input.html, text: input.text,
    link: input.link, delivery, providerId, taskId: input.taskId, deliverableId: input.deliverableId, error, ...(input.dept ? { dept: input.dept } : {}),
  };
  pushMail(mail);
  return mail;
}

/** Emails approved while sending was paused (or Live Outreach was off) stay in the Inbox as previews.
 *  Once sending is live, these send them as they were written (samples and tests are never sent),
 *  skipping anyone who has since asked us to stop. The preview is replaced by the sent email. */
export async function sendHeldPreviews(ids?: string[]): Promise<{ sent: number; failed: number; skipped: number; error?: string }> {
  const tid = currentTenantId();
  if (!liveAllowed(getTenantIntegrations(tid).liveOutreachEnabled)) {
    return { sent: 0, failed: 0, skipped: 0, error: sendingPaused() ? 'Sending is still paused on the server (SENDING_PAUSED).' : 'Live Outreach is off (Settings).' };
  }
  const { findRecordsByEmail } = await import('@/lib/data/records');
  const want = ids?.length ? new Set(ids) : null;
  const held = getState().inbox.filter((m) => m.delivery === 'simulated' && !m.error && (!want || want.has(m.id)) && !/^\[(sample|test)/i.test(m.subject) && !/@(example\.com|local)$/i.test(m.to));
  let sent = 0, failed = 0, skipped = 0;
  for (const m of held) {
    if (findRecordsByEmail(m.to).some((r) => r.fields.opted_out === 'yes')) { skipped++; continue; }
    const out = await sendMail({ to: m.to, toName: m.toName, subject: m.subject, html: m.html, text: m.text, link: m.link, taskId: m.taskId, deliverableId: m.deliverableId, dept: m.dept, fromLine: m.from });
    if (out.delivery === 'smtp') sent++; else failed++;
    // The sent copy (or the failed attempt, with its reason) takes the preview's place.
    mutate((s) => { s.inbox = s.inbox.filter((x) => x.id !== m.id); });
  }
  return { sent, failed, skipped };
}

/* ── Templates ────────────────────────────────────────────────────────────── */

export const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Split plain text into clean, generously spaced HTML paragraphs and bullet lists. */
export const formatHtmlParagraphs = (raw: string) => {
  const blocks = raw
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      const isList = lines.length > 1 && lines.every((l) => /^[-•*]\s+/.test(l));
      if (isList) {
        const items = lines
          .map((l) => `<li style="margin:0 0 8px;line-height:1.65">${esc(l.replace(/^[-•*]\s+/, ''))}</li>`)
          .join('');
        return `<ul style="margin:0 0 18px;padding-left:20px;font-size:15px;color:#1b253b">${items}</ul>`;
      }
      return `<p style="font-size:15px;line-height:1.72;margin:0 0 16px;color:#1b253b">${lines.map(esc).join('<br/>')}</p>`;
    })
    .join('');
};

export interface EmailSenderMeta {
  agentName?: string;
  agentTitle?: string;
  officeName?: string;
}

export const signatureBlock = (agentName: string, roleOrOffice: string, academyName: string) =>
  `<div style="margin:22px 0 6px;padding-top:16px;border-top:1px solid #e7ecf5;font-size:14px;line-height:1.65;color:#1b253b">
<p style="margin:0 0 4px">Warm regards,</p>
<p style="margin:0;font-weight:700;color:#0a1733">${esc(agentName)}</p>
<p style="margin:0;font-size:13px;color:#5b6478">${esc(roleOrOffice)} · ${esc(academyName)}</p>
</div>`;

export const emailShell = (
  title: string,
  body: string,
  cta: { href: string; label: string } | null,
  meta?: EmailSenderMeta,
  /** Marketing messages: an unsubscribe line in the footer and the open pixel. */
  extra?: { footer?: string; pixel?: string; preheader?: string },
) => {
  const ac = getAcademyContext(currentTenantId());
  const sender = meta?.agentName?.trim() || ac.senderName;
  const subLabel = meta?.officeName?.trim() || meta?.agentTitle?.trim() || ac.senderTitle;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f7fc;font-family:Inter,Segoe UI,Arial,sans-serif;color:#101628">${extra?.preheader ? preheaderHtml(extra.preheader) : ''}
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fc;padding:32px 14px"><tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e9f2">
<tr><td style="background:#0a1733;padding:22px 32px;color:#fff">
  <div style="font-weight:800;font-size:18px;letter-spacing:-.01em">${esc(ac.academyName)}</div>
  <div style="font-weight:600;font-size:12px;opacity:.82;letter-spacing:.05em;text-transform:uppercase;margin-top:4px">${esc(subLabel)} · ${esc(sender)}</div>
</td></tr>
<tr><td style="padding:32px 32px 14px"><h1 style="margin:0 0 20px;font-size:21px;line-height:1.35;letter-spacing:-.02em;color:#0a1733">${esc(title)}</h1>${body}</td></tr>
${cta ? `<tr><td style="padding:8px 32px 28px"><a href="${cta.href}" style="display:inline-block;background:#ff7300;color:#ffffff;font-weight:800;text-decoration:none;padding:13px 24px;border-radius:10px;font-size:15px">${esc(cta.label)}</a><p style="margin:12px 0 0;font-size:12px;color:#62687a">Or copy this link: <a href="${cta.href}" style="color:#0a1733">${esc(cta.href)}</a></p></td></tr>` : ''}
<tr><td style="padding:18px 32px 24px;background:#f9fbff;border-top:1px solid #eef1f8;font-size:12px;line-height:1.6;color:#6f7890">Sent by <b>${esc(sender)}</b> (${esc(subLabel)}) · ${esc(ac.academyName)}. Reply directly to this email anytime to continue the conversation.${extra?.footer ? `<br/>${extra.footer}` : ''}</td></tr>
</table></td></tr></table>${extra?.pixel ? `<img src="${extra.pixel}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px" />` : ''}</body></html>`;
};

/** Hidden text that inboxes show next to the subject (instead of the first words of the layout). */
const preheaderHtml = (t: string) => `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;opacity:0">${esc(t)}${'&#8204;&nbsp;'.repeat(40)}</div>`;

/** "Naledi · Melsoft Academy" <the sending address>. */
function personalFrom(sender: string, name: string, academy: string): string {
  const addr = sender.match(/<([^>]+)>/)?.[1] || (sender.includes('@') ? sender.trim() : '');
  if (!addr) return sender;
  return `"${`${name} · ${academy}`.replace(/["<>]/g, '')}" <${addr}>`;
}

/** One-click unsubscribe (Gmail and Yahoo expect it from anyone sending marketing email). */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/** A personal email: what one person writes to another. No banner, no big heading, a simple
 *  signature. One-to-one notes land in the main inbox more often and read as human. */
export function personalEmail(input: {
  recipientName: string;
  subject: string;
  body: string;
  ask?: string | null;
  agentName?: string;
  officeName?: string;
  /** Cards after the message (their video, a guide). */
  extraHtml?: string;
  extra?: { footer?: string; pixel?: string };
}) {
  const s = ensureStructuredMessage(input);
  const paras = s.paragraphsText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br/>')}</p>`).join('');
  const ask = input.ask ? `<p style="margin:0 0 14px">${esc(input.ask)}</p>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#ffffff">${preheaderHtml(s.paragraphsText.split(/\n{2,}/)[1] || input.subject)}
<div style="max-width:600px;margin:0 auto;padding:22px 18px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#1b253b">
${paras}${input.extraHtml || ''}${ask}
<p style="margin:18px 0 0">Warm regards,<br/><b>${esc(s.senderName)}</b><br/><span style="color:#5b6478;font-size:13px">${esc(s.officeLabel)} &middot; ${esc(s.academyName)}</span></p>
${input.extra?.footer ? `<p style="margin:26px 0 0;font-size:11.5px;color:#8a93a6">${input.extra.footer}</p>` : ''}
</div>${input.extra?.pixel ? `<img src="${input.extra.pixel}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px" />` : ''}</body></html>`;
  const text = `${s.paragraphsText}${input.ask ? `\n\n${input.ask}` : ''}\n\nWarm regards,\n${s.senderName}\n${s.officeLabel} · ${s.academyName}`;
  return { subject: input.subject, html, text };
}

/** Ensure clean greeting, clear sender/academy introduction, spaced paragraphs, and sign-off. */
export function ensureStructuredMessage(input: {
  recipientName: string;
  body: string;
  agentName?: string;
  officeName?: string;
}): { paragraphsText: string; senderName: string; officeLabel: string; academyName: string } {
  const ac = getAcademyContext(currentTenantId());
  const first = input.recipientName.trim().split(/\s+/)[0] || 'there';
  const senderName = (input.agentName || ac.senderName || 'Student Success Team').trim();
  const officeLabel = (input.officeName || ac.senderTitle || 'Operations').trim();
  let text = String(input.body || '').replace(/\r\n/g, '\n').trim();

  // If the AI returned one long unspaced block, split cleanly between sentences (~2 sentences per paragraph).
  if (!text.includes('\n\n') && text.length > 180) {
    const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
    if (sentences.length >= 3) {
      const chunks: string[] = [];
      for (let i = 0; i < sentences.length; i += 2) {
        chunks.push(sentences.slice(i, i + 2).join(' '));
      }
      text = chunks.join('\n\n');
    }
  }

  // Remove any trailing duplicated sign-off so we append one clean unified signature.
  text = text.replace(/\n+(?:warm regards|kind regards|best regards|regards|sincerely|cheers)[,\s]*[\s\S]*$/i, '').trim();
  // A bare name (or "Name, Admissions") as the last line is a sign-off too.
  const paras = text.split(/\n\s*\n/);
  const last = (paras[paras.length - 1] || '').trim();
  if (paras.length > 1 && last.length <= 80 && last.toLowerCase().startsWith(senderName.toLowerCase())) text = paras.slice(0, -1).join('\n\n').trim();

  const hasGreeting = /^(hi|hello|dear|good\s+(?:morning|afternoon|evening)|hey)\b/i.test(text);
  const introducesSender =
    text.toLowerCase().includes(senderName.toLowerCase()) ||
    text.toLowerCase().includes(ac.academyName.toLowerCase());

  // Greeting first, then (if the message does not say who is writing) one line of introduction, then the message.
  const intro = introducesSender ? '' : `This is ${senderName} from ${officeLabel} at ${ac.academyName}.`;
  const parts: string[] = [];
  if (!hasGreeting) {
    parts.push(`Hi ${first},`);
    if (intro) parts.push(intro);
    if (text) parts.push(text);
  } else {
    const [hello, ...rest] = text.split(/\n\s*\n/);
    // "Hi Thandi," on its own line, or "Hi Thandi, thank you…" as the opening sentence.
    const m = hello.match(/^((?:hi|hello|dear|hey|good\s+(?:morning|afternoon|evening))\b[^,\n]*,)\s*([\s\S]*)$/i);
    const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
    if (m) parts.push(m[1], ...(intro ? [intro] : []), ...[cap(m[2].trim()), ...rest].filter((x) => x && x.trim()));
    else parts.push(...(intro ? [intro] : []), text);
  }

  return {
    paragraphsText: parts.join('\n\n'),
    senderName,
    officeLabel,
    academyName: ac.academyName,
  };
}

export function workflowEmail(input: {
  recipientName: string;
  subject: string;
  body: string;
  ask?: string | null;
  agentName?: string;
  officeName?: string;
  /** HTML after the message (resource cards). */
  extraHtml?: string;
  /** Marketing extras: unsubscribe line, open pixel. */
  extra?: { footer?: string; pixel?: string };
}) {
  const s = ensureStructuredMessage(input);
  const askBox = input.ask
    ? `<p style="font-size:14px;line-height:1.68;margin:18px 0 0;color:#0a1733;background:#f4f7fc;border-radius:10px;padding:15px 18px;border:1px solid #e2e8f4"><b>Next step:</b> ${esc(input.ask)}</p>`
    : '';
  const htmlBody = `${formatHtmlParagraphs(s.paragraphsText)}${input.extraHtml || ''}${askBox}${signatureBlock(s.senderName, s.officeLabel, s.academyName)}`;
  const text = `${s.paragraphsText}${input.ask ? `\n\nNext step: ${input.ask}` : ''}\n\nWarm regards,\n${s.senderName}\n${s.officeLabel} · ${s.academyName}`;
  return {
    subject: input.subject,
    html: emailShell(input.subject, htmlBody, null, { agentName: s.senderName, officeName: s.officeLabel }, input.extra),
    text,
  };
}

/** The personal video lesson as a big, tappable video card. Plain HTML and
 *  inline styles (no images), so it shows in Gmail, Outlook and phone mail apps. */
function videoCard(v: { href: string; first: string; mins: number; code: string; topic: string }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 8px;border-collapse:separate">
<tr><td bgcolor="#0a1733" style="border-radius:16px;background:#0a1733;background-image:linear-gradient(135deg,#8a3a12 0%,#0a1733 52%,#3a1d72 100%)">
<a href="${v.href}" style="display:block;text-decoration:none;color:#ffffff;padding:34px 22px 26px;text-align:center;font-family:Inter,Segoe UI,Arial,sans-serif">
<span style="display:inline-block;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#fde7d6;border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:5px 12px">Your personal video · ${esc(v.code)}</span>
<span style="display:block;font-size:34px;font-weight:900;line-height:1.15;margin:16px 0 8px;color:#ffffff">Hey ${esc(v.first)}</span>
<span style="display:block;font-size:15px;line-height:1.55;color:#dbe4ff;margin:0 0 20px">A ${v.mins}-minute lesson made just for you on <b style="color:#ffffff">${esc(v.topic)}</b></span>
<span style="display:inline-block;width:68px;height:68px;line-height:68px;border-radius:50%;background:#ff7300;color:#ffffff;font-size:28px;text-align:center">&#9654;</span>
<span style="display:block;font-size:13px;color:#c7d2fe;margin-top:12px">Tap to watch &middot; sound on</span>
</a></td></tr></table>
<p style="font-size:12px;color:#62687a;margin:0 0 10px;text-align:center">Video not opening? <a href="${v.href}" style="color:#0a1733;font-weight:700">Open your lesson here</a>.</p>`;
}

export function quizEmail(quiz: RemedialQuiz, link: string) {
  const ac = getAcademyContext(currentTenantId());
  const first = quiz.learner.name.split(' ')[0];
  const watch = link.replace('/quiz/', '/learn/');
  const mins = quiz.lesson ? Math.max(2, Math.round(quiz.lesson.slides.reduce((n, s) => n + s.say.split(/\s+/).length, 0) / 150)) : 3;
  const subject = `${first}, your personal lesson for ${quiz.module.code}: ${quiz.topic}`;
  const res = quiz.resources || [];
  const n = quiz.questions.length;
  const needed = Math.ceil((quiz.passMark / 100) * n);
  const testMins = Math.max(3, Math.round(n * 0.75));
  const body = `
<p style="font-size:15px;line-height:1.72;margin:0 0 16px">Hi ${esc(first)},</p>
<p style="font-size:15px;line-height:1.72;margin:0 0 16px">This is ${esc(ac.senderName)} from ${esc(ac.academyName)}. ${typeof quiz.evidence?.scorePct === 'number' ? `You scored ${Math.round(quiz.evidence.scorePct)}% on your last ${esc(quiz.module.code)} assessment, and` : `Your last ${esc(quiz.module.code)} checkpoint showed`} one topic is holding you back: <b>${esc(quiz.topic)}</b>. That's normal, and it clicks fast once you walk through it step by step, so we made you a short personal video lesson and a study pack.</p>
${quiz.lesson ? videoCard({ href: watch, first, mins, code: quiz.module.code, topic: quiz.topic }) : ''}
<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:20px 0 8px">1 · The key points</p>
<p style="font-size:14px;line-height:1.7;margin:0;color:#24345a;background:#f4f7fc;border-radius:10px;padding:14px 16px">${quiz.keyPoints.slice(0, 4).map((k) => `• ${esc(k)}`).join('<br>')}</p>
${res.length ? `<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:20px 0 8px">2 · Watch and read</p>
<p style="font-size:14px;line-height:1.9;margin:0">${res.map((r) => `${r.kind === 'watch' ? 'Watch:' : 'Read:'} <a href="${r.url}" style="color:#0a1733;font-weight:600">${esc(r.label)}</a>`).join('<br>')}</p>` : ''}
<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:20px 0 8px">${res.length ? '3' : '2'} · Prove it: ${n} questions</p>
<p style="font-size:15px;line-height:1.72;margin:0 0 12px">Score ${quiz.passMark}% or more (${needed} of ${n}) and your learner record updates to On Track automatically. It takes about ${testMins} minutes.</p>
${signatureBlock(ac.senderName, ac.senderTitle, ac.academyName)}`;
  const text = `Hi ${first},\n\nThis is ${ac.senderName} from ${ac.academyName}. Here is your study pack for ${quiz.module.code}: ${quiz.topic}.\n\n${quiz.lesson ? `Watch your ${mins}-minute video lesson: ${watch}\n\n` : ''}${quiz.keyPoints.slice(0, 4).map((k) => `- ${k}`).join('\n')}\n\n${res.map((r) => `${r.label}: ${r.url}`).join('\n')}\n\nTake the ${n}-question test (pass mark ${quiz.passMark}%): ${link}\n\nWarm regards,\n${ac.senderName}\n${ac.senderTitle} · ${ac.academyName}`;
  return { subject, html: emailShell(`Your ${quiz.module.code} study pack is ready`, body, { href: link, label: `Take the ${n}-question test` }), text };
}

export function checkInEmail(m: CheckInMessage) {
  return workflowEmail({
    recipientName: m.learner.name,
    subject: m.subject,
    body: m.body,
    ask: m.ask,
    agentName: m.agentName,
    officeName: m.officeName,
  });
}

/** After the quiz: well done, or the next steps with what was missed. */
export function resultEmail(quiz: RemedialQuiz, result: QuizResult, missed: QuizQuestion[]) {
  const ac = getAcademyContext(currentTenantId());
  const first = quiz.learner.name.split(' ')[0];
  const base = publicUrl();
  if (result.passed) {
    const subject = `Well done, ${first}: ${quiz.module.code} cleared`;
    const body = `<p style="font-size:15px;line-height:1.72;margin:0 0 16px">Hi ${esc(first)},</p><p style="font-size:15px;line-height:1.72;margin:0 0 16px">You scored <b>${result.score} out of ${result.total} (${result.pct}%)</b> on ${esc(quiz.topic)}. Your record at ${esc(ac.academyName)} is updated and you're back on track. Keep the momentum going into the rest of ${esc(quiz.module.code)}.</p>${signatureBlock(ac.senderName, ac.senderTitle, ac.academyName)}`;
    return {
      subject,
      html: emailShell(`You're back on track`, body, null),
      text: `Hi ${first},\n\nYou scored ${result.score}/${result.total} (${result.pct}%) on ${quiz.topic}. Your record is updated and you're back on track.\n\nWarm regards,\n${ac.senderName}\n${ac.senderTitle} · ${ac.academyName}`,
    };
  }
  const subject = `${first}, your next steps on ${quiz.module.code}`;
  const items = missed.map((q) => `<div style="margin:0 0 12px;padding:14px 16px;border-radius:10px;background:#f4f7fc"><b style="font-size:14px">${esc(q.prompt)}</b><p style="font-size:14px;margin:8px 0 0">Answer: <b>${esc(q.options[q.answerIndex] || '')}</b></p><p style="font-size:13px;color:#444a5c;margin:6px 0 0;line-height:1.6">${esc(q.explanation)}</p></div>`).join('');
  const lesson = base && quiz.lesson ? `<p style="margin:14px 0 4px"><a href="${base}/learn/${quiz.quizId}" style="display:inline-block;background:#0a1733;color:#fff;font-weight:800;text-decoration:none;padding:12px 18px;border-radius:10px;font-size:14px">▶ Watch the lesson again</a></p>` : '';
  const body = `<p style="font-size:15px;line-height:1.72;margin:0 0 16px">Hi ${esc(first)},</p>
<p style="font-size:15px;line-height:1.72;margin:0 0 16px">Thanks for taking the ${result.total}-question test. You scored ${result.score} out of ${result.total} (${result.pct}%). That's not a failure — it shows us exactly where to help. Here is what happens next:</p>
<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:18px 0 8px">1 · What you missed, explained</p>${items}
<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:18px 0 6px">2 · The lesson again</p>${lesson || '<p style="font-size:14px;margin:0;line-height:1.65">Rewatch the lesson from your study pack email.</p>'}
<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:18px 0 6px">3 · A 20-minute catch-up</p><p style="font-size:14px;line-height:1.7;margin:0">Your tutor will be in touch to set up a short session on ${esc(quiz.topic)}. Reply to this email with a time that suits you.</p>
${signatureBlock(ac.senderName, ac.senderTitle, ac.academyName)}`;
  const text = `Hi ${first},\n\nYou scored ${result.score}/${result.total} (${result.pct}%).\n\nNext steps: the answers you missed are explained above, rewatch the lesson, and your tutor will set up a 20-minute catch-up on ${quiz.topic}.\n\nWarm regards,\n${ac.senderName}\n${ac.senderTitle} · ${ac.academyName}`;
  return { subject, html: emailShell('Your next steps', body, null), text };
}

export function followUpEmail(input: { learnerName: string; attempt: number; subject: string; body: string; ask: string; link: string | null }) {
  const s = ensureStructuredMessage({ recipientName: input.learnerName, body: input.body });
  const first = input.learnerName.split(' ')[0];
  const body = `
<p style="font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:0 0 14px">Follow-up #${input.attempt}</p>
${formatHtmlParagraphs(s.paragraphsText)}
<p style="font-size:14px;line-height:1.68;margin:18px 0 0;color:#0a1733;background:#f4f7fc;border-radius:10px;padding:15px 18px;border:1px solid #e2e8f4"><b>Next small step:</b> ${esc(input.ask)}</p>
${signatureBlock(s.senderName, s.officeLabel, s.academyName)}`;
  const cta = input.link ? { href: input.link, label: `Open your catch-up pack, ${first}` } : null;
  const text = `${s.paragraphsText}\n\nNext small step: ${input.ask}${input.link ? `\n\nOpen here: ${input.link}` : ''}\n\nWarm regards,\n${s.senderName}\n${s.officeLabel} · ${s.academyName}`;
  return { subject: input.subject, html: emailShell(input.subject, body, cta), text };
}
