import nodemailer from 'nodemailer';
import type { CheckInMessage, InboxMail, QuizQuestion, QuizResult, RemedialQuiz } from '@/lib/types';
import { log, publicUrl, pushMail, uid } from '@/lib/engine/store';

/* Mail out of the colleague via Nodemailer (SMTP).
 *
 * Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (for Gmail: smtp.gmail.com,
 * 465, your address and an App Password). Otherwise the message lands in the
 * Inbox tab, exactly as it would have been sent. DEMO_RECIPIENT_EMAIL, if set,
 * redirects every message to one inbox. Every message is logged either way. */

export interface MailInput {
  to: string; toName: string; subject: string; html: string; text: string;
  link: string | null; taskId: string; deliverableId: string | null;
}

/** Values pasted into a host's settings can carry quotes, spaces or a stray line break. */
const clean = (v?: string) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
/** Gmail shows app passwords as four groups of four; the spaces are only for reading. */
function smtpPass() {
  const p = clean(process.env.SMTP_PASS);
  return /gmail\.com|googlemail\.com/i.test(String(process.env.SMTP_HOST || '')) ? p.replace(/\s+/g, '') : p;
}

let transport: nodemailer.Transporter | null = null;
function smtp() {
  if (!clean(process.env.SMTP_HOST) || !clean(process.env.SMTP_USER) || !clean(process.env.SMTP_PASS)) return null;
  if (!transport) {
    const port = Number(clean(process.env.SMTP_PORT) || 465) || 465;
    transport = nodemailer.createTransport({
      host: clean(process.env.SMTP_HOST), port, secure: port === 465,
      auth: { user: clean(process.env.SMTP_USER), pass: smtpPass() },
      connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 15_000,
    });
  }
  return transport;
}

export function emailMode(): InboxMail['delivery'] {
  return smtp() ? 'smtp' : 'simulated';
}

function senderAddress() {
  const user = clean(process.env.SMTP_USER);
  const rawFrom = clean(process.env.EMAIL_FROM);
  if (rawFrom) {
    if (rawFrom.includes('@')) return rawFrom;
    if (user) return `${rawFrom} <${user}>`;
  }
  return user ? `Thuso Student Success <${user}>` : 'Thuso Student Success <noreply@thuso.local>';
}

export async function sendMail(input: MailInput): Promise<InboxMail> {
  const from = senderAddress();
  const to = clean(process.env.DEMO_RECIPIENT_EMAIL) || input.to;
  let delivery: InboxMail['delivery'] = 'simulated';
  let providerId: string | null = null;
  let error: string | null = null;
  const t = smtp();
  if (t) {
    try {
      const info = await t.sendMail({ from, to, subject: input.subject, html: input.html, text: input.text });
      delivery = 'smtp'; providerId = info.messageId || null;
    } catch (e) {
      const err = e as Error & { code?: string; responseCode?: number };
      error = `${err.code ? `${err.code}: ` : ''}${err.message}`;
      // A connection that never opens is what a host that blocks mail ports looks like.
      const blocked = /ETIMEDOUT|ECONNREFUSED|ESOCKET|EHOSTUNREACH|ENETUNREACH|Greeting never received|Connection timeout/i.test(error);
      log('system', 'error', `Email to ${to} was not sent: ${error}${blocked ? ` · the server cannot reach ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 465}. Some hosts (Render's free plan among them) block mail ports; use a paid instance, or an SMTP provider on port 2525 (e.g. Brevo).` : ''}`);
      console.warn('[thuso] SMTP send failed:', error);
    }
  }
  const mail: InboxMail = {
    id: uid('m'), ts: Date.now(), to, toName: input.toName, from, subject: input.subject, html: input.html, text: input.text,
    link: input.link, delivery, providerId, taskId: input.taskId, deliverableId: input.deliverableId, error,
  };
  pushMail(mail);
  return mail;
}

/* ── Templates ────────────────────────────────────────────────────────────── */

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const shell = (title: string, body: string, cta: { href: string; label: string } | null) => `<!doctype html><html><body style="margin:0;background:#f4f7fc;font-family:Inter,Segoe UI,Arial,sans-serif;color:#101628">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fc;padding:28px 12px"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e9f2">
<tr><td style="background:#0a1733;padding:20px 28px;color:#fff;font-weight:800;font-size:18px;letter-spacing:-.01em">Thuso <span style="font-weight:500;font-size:12px;opacity:.75;letter-spacing:.06em">STUDENT SUCCESS</span></td></tr>
<tr><td style="padding:28px 28px 8px"><h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;letter-spacing:-.02em">${title}</h1>${body}</td></tr>
${cta ? `<tr><td style="padding:8px 28px 28px"><a href="${cta.href}" style="display:inline-block;background:#ff7300;color:#ffffff;font-weight:800;text-decoration:none;padding:13px 22px;border-radius:10px;font-size:15px">${cta.label}</a><p style="margin:12px 0 0;font-size:12px;color:#62687a">Or copy this link: <a href="${cta.href}" style="color:#0a1733">${cta.href}</a></p></td></tr>` : ''}
<tr><td style="padding:16px 28px 24px;border-top:1px solid #eef1f8;font-size:12px;color:#8f95a8">Sent by Thuso, your student success team. Reply to this email to reach a person.</td></tr>
</table></td></tr></table></body></html>`;

export function quizEmail(quiz: RemedialQuiz, link: string) {
  const first = quiz.learner.name.split(' ')[0];
  const watch = link.replace('/quiz/', '/learn/');
  const mins = quiz.lesson ? Math.max(2, Math.round(quiz.lesson.slides.reduce((n, s) => n + s.say.split(/\s+/).length, 0) / 150)) : 3;
  const subject = `${first}, your study pack for ${quiz.module.code}: ${quiz.topic}`;
  const res = quiz.resources || [];
  const body = `
<p style="font-size:15px;line-height:1.65;margin:0 0 12px">Hi ${esc(first)},</p>
<p style="font-size:15px;line-height:1.65;margin:0 0 12px">Your last ${esc(quiz.module.code)} checkpoint showed one topic is holding you back: <b>${esc(quiz.topic)}</b>. That's normal, and it clicks fast once it clicks. We made you a short study pack on exactly that.</p>
${quiz.lesson ? `<p style="margin:16px 0 4px"><a href="${watch}" style="display:inline-block;background:#0a1733;color:#ffffff;font-weight:800;text-decoration:none;padding:13px 20px;border-radius:10px;font-size:15px">▶ Watch your ${mins}-minute lesson</a></p><p style="font-size:12px;color:#62687a;margin:0 0 6px">Made for you, on exactly this topic. Sound on.</p>` : ''}
<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:18px 0 6px">1 · The key points</p>
<p style="font-size:14px;line-height:1.6;margin:0;color:#24345a;background:#f4f7fc;border-radius:10px;padding:12px 14px">${quiz.keyPoints.slice(0, 4).map((k) => `• ${esc(k)}`).join('<br>')}</p>
${res.length ? `<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:18px 0 6px">2 · Watch and read</p>
<p style="font-size:14px;line-height:1.9;margin:0">${res.map((r) => `${r.kind === 'watch' ? '▶' : '📖'} <a href="${r.url}" style="color:#0a1733;font-weight:600">${esc(r.label)}</a>`).join('<br>')}</p>` : ''}
<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:18px 0 6px">${res.length ? '3' : '2'} · Prove it: 3 questions</p>
<p style="font-size:15px;line-height:1.65;margin:0">Pass (2 of 3) and your record updates on the spot.</p>`;
  const text = `Hi ${first},\n\nYour study pack for ${quiz.module.code}: ${quiz.topic}.\n\n${quiz.lesson ? `Watch your ${mins}-minute lesson: ${watch}\n\n` : ''}${quiz.keyPoints.slice(0, 4).map((k) => `- ${k}`).join('\n')}\n\n${res.map((r) => `${r.label}: ${r.url}`).join('\n')}\n\nTake the 3-question quiz: ${link}\n\nThuso · Student Success`;
  return { subject, html: shell(`Your ${quiz.module.code} study pack is ready`, body, { href: link, label: 'Take the 3-question quiz' }), text };
}

export function checkInEmail(m: CheckInMessage) {
  const body = `
<p style="font-size:15px;line-height:1.65;margin:0 0 14px">${esc(m.body)}</p>
<p style="font-size:14px;line-height:1.6;margin:0;color:#0a1733;background:#f4f7fc;border-radius:10px;padding:12px 14px"><b>One small thing:</b> ${esc(m.ask)}</p>`;
  const text = `${m.body}\n\n${m.ask}\n\nBongani · Thuso Student Success`;
  return { subject: m.subject, html: shell(m.subject, body, null), text };
}

/** After the quiz: well done, or the next steps with what was missed. */
export function resultEmail(quiz: RemedialQuiz, result: QuizResult, missed: QuizQuestion[]) {
  const first = quiz.learner.name.split(' ')[0];
  const base = publicUrl();
  if (result.passed) {
    const subject = `Well done, ${first}: ${quiz.module.code} cleared`;
    const body = `<p style="font-size:15px;line-height:1.65;margin:0 0 12px">Hi ${esc(first)},</p><p style="font-size:15px;line-height:1.65;margin:0 0 12px">You scored <b>${result.score} out of ${result.total} (${result.pct}%)</b> on ${esc(quiz.topic)}. Your record is updated and you're back on track. Keep the momentum going into the rest of ${esc(quiz.module.code)}.</p>`;
    return { subject, html: shell(`You're back on track`, body, null), text: `Hi ${first}, you scored ${result.score}/${result.total} (${result.pct}%) on ${quiz.topic}. You're back on track. Thuso · Student Success` };
  }
  const subject = `${first}, your next steps on ${quiz.module.code}`;
  const items = missed.map((q) => `<div style="margin:0 0 12px;padding:12px 14px;border-radius:10px;background:#f4f7fc"><b style="font-size:14px">${esc(q.prompt)}</b><p style="font-size:14px;margin:6px 0 0">Answer: <b>${esc(q.options[q.answerIndex] || '')}</b></p><p style="font-size:13px;color:#444a5c;margin:6px 0 0">${esc(q.explanation)}</p></div>`).join('');
  const lesson = base && quiz.lesson ? `<p style="margin:14px 0 4px"><a href="${base}/learn/${quiz.quizId}" style="display:inline-block;background:#0a1733;color:#fff;font-weight:800;text-decoration:none;padding:12px 18px;border-radius:10px;font-size:14px">▶ Watch the lesson again</a></p>` : '';
  const body = `<p style="font-size:15px;line-height:1.65;margin:0 0 12px">Hi ${esc(first)},</p>
<p style="font-size:15px;line-height:1.65;margin:0 0 12px">Thanks for taking the quiz. You scored ${result.score} out of ${result.total} (${result.pct}%). That's not a failure, it shows us exactly where to help. Here's what happens next:</p>
<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:16px 0 8px">1 · What you missed, explained</p>${items}
<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:16px 0 4px">2 · The lesson again</p>${lesson || '<p style="font-size:14px;margin:0">Rewatch the lesson from your study pack email.</p>'}
<p style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#62687a;margin:16px 0 4px">3 · A 20-minute catch-up</p><p style="font-size:14px;line-height:1.6;margin:0">Your tutor will be in touch to set up a short session on ${esc(quiz.topic)}. Reply to this email with a time that suits you.</p>`;
  const text = `Hi ${first}, you scored ${result.score}/${result.total} (${result.pct}%). Next steps: the answers you missed are explained in this email, rewatch the lesson, and your tutor will set up a 20-minute catch-up on ${quiz.topic}. Thuso · Student Success`;
  return { subject, html: shell('Your next steps', body, null), text };
}
