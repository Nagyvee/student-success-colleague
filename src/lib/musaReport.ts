import { getState, log } from '@/lib/engine/store';
import { buildReport, type Period } from '@/lib/reports';
import { complete } from '@/lib/ai/llm';
import { teach } from '@/lib/ai/instructions';
import { sendMail } from '@/lib/email/send';

/* Musa's written report, for the Reports page and the daily email. */

export const NAMES: Record<Period, string> = { today: 'today', week: 'this week', all: 'so far' };

/** Musa writes the report from the numbers: plain words a principal can act on. */
export async function writeReport(period: Period) {
  const r = buildReport(getState(), period);
  const n = r.numbers;
  const facts = [
    `Runs: ${n.runs} (LMS webhook ${r.byTrigger.webhook}, Google Sheet ${r.byTrigger.sheet}, schedule ${r.byTrigger.schedule}, manager ${r.byTrigger.manager}).`,
    `Learners checked: ${n.checked}. Learners helped: ${n.helped}. Study packs with lesson and quiz sent: ${n.studyPacks}. Personal check-ins sent: ${n.checkIns}.`,
    `Quizzes completed by learners: ${n.quizzesDone}${n.passRate !== null ? `, pass rate ${n.passRate}%` : ''}.`,
    `Mistakes the Reviewer caught before a learner saw them: ${n.mistakesCaught}, fixed: ${n.mistakesFixed}. Human interventions: 0.`,
    `Helped: ${r.helped.map((h) => `${h.name} (${h.what})`).join('; ') || 'nobody yet'}.`,
    `Mistakes: ${r.mistakes.map((m) => `${m.title} for ${m.subject}: ${m.note}`).join(' | ') || 'none'}.`,
    `Still at risk: ${r.learners.filter((l) => l.status === 'at_risk').map((l) => l.name).join(', ') || 'nobody'}.`,
  ].join('\n');
  const text = await complete({
    system: `You are Musa, the Reviewer in the academy's student success team. You write the report the head of the school reads. Plain text, no markdown, no headings, no lists, no preamble. Warm, exact, brief.${teach('coo')}`,
    prompt: `Write the student success report for ${NAMES[period]} from these facts only. Never invent a number or a name.\n\n${facts}\n\nFour short paragraphs, under 170 words in total: what the team did, who was helped and how, what you caught and fixed, and the one thing the head should watch next.`,
    maxTokens: 6000, timeoutMs: 20000, json: false,
  });
  const fallback = `${NAMES[period][0].toUpperCase()}${NAMES[period].slice(1)}, the team ran ${n.runs} time${n.runs === 1 ? '' : 's'}, checked ${n.checked} learners and helped ${n.helped}: ${n.studyPacks} study pack${n.studyPacks === 1 ? '' : 's'} with a lesson and quiz, and ${n.checkIns} personal check-in${n.checkIns === 1 ? '' : 's'}.\n\n${r.helped.map((h) => `${h.name}: ${h.what}.`).join(' ') || 'Nobody needed help.'}\n\nI caught ${n.mistakesCaught} mistake${n.mistakesCaught === 1 ? '' : 's'} before any learner saw them and all ${n.mistakesFixed} were fixed. No person had to step in.\n\nWatch next: ${r.learners.filter((l) => l.status === 'at_risk').map((l) => l.name).join(', ') || 'nobody is at risk right now'}.`;
  return { report: r, text: text?.trim() || fallback, viaAi: Boolean(text), at: Date.now() };
}

const escHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Write the report and email it, for the Reports page and the daily schedule. */
export async function emailReport(period: Period, to: string) {
  const out = await writeReport(period);
  const n = out.report.numbers;
  const paras = out.text.split(/\n+/).filter(Boolean).map((p) => `<p>${escHtml(p)}</p>`).join('');
  const html = `<!doctype html><html><body style="font-family:Inter,Segoe UI,Arial,sans-serif;color:#101628;background:#f4f7fc;padding:24px"><div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e4e9f2;border-radius:16px;overflow:hidden"><div style="background:#0a1733;color:#fff;padding:18px 24px;font-weight:800">Thuso · Student success report (${NAMES[period]})</div><div style="padding:24px;font-size:15px;line-height:1.65">${paras}<p style="color:#62687a;font-size:13px">Learners checked ${n.checked} · helped ${n.helped} · mistakes caught ${n.mistakesCaught} · human interventions 0</p><p style="color:#62687a;font-size:13px">Musa, Reviewer</p></div></div></body></html>`;
  const m = await sendMail({ to, toName: 'Head of school', subject: `Student success report · ${NAMES[period]}`, html, text: out.text, link: null, taskId: 'report', deliverableId: null });
  log('coo', 'email', `Musa emailed the ${NAMES[period]} report to ${m.to}${m.delivery === 'simulated' ? ' (preview: no email account connected)' : ''}.`);
  return { ...out, mailed: m.delivery === 'simulated' ? `${m.to} (preview: no email account connected)` : m.to };
}


