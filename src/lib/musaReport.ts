import { getState, log } from '@/lib/engine/store';
import { buildReport, type Period } from '@/lib/reports';
import { complete } from '@/lib/ai/llm';
import { teach } from '@/lib/ai/instructions';
import { emailShell, formatHtmlParagraphs, sendMail } from '@/lib/email/send';
import { listWorkflows } from '@/lib/engine/workflows';
import { listCustomAgents, listFlowRuns, listOffices } from '@/lib/engine/offices';
import { listFollowUps } from '@/lib/engine/followups';
import { getAcademyContext } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';

/* Multi-floor operations briefing, for the Reports page and scheduled summaries. */

export const NAMES: Record<Period, string> = { today: 'today', week: 'this week', all: 'so far' };

const escHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Write a multi-department report across ALL floors, workflows, and agents. */
export async function writeReport(period: Period) {
  const ac = getAcademyContext(currentTenantId());
  const r = buildReport(getState(), period, {
    workflows: listWorkflows(),
    offices: listOffices(),
    customAgents: listCustomAgents(),
    flowRuns: listFlowRuns(),
    followUps: listFollowUps(),
  });
  const n = r.numbers;
  const floorLines = r.floors.length
    ? r.floors
        .map(
          (f) =>
            `- ${f.officeName} · "${f.workflowName}" (${f.enabled ? 'Active' : 'Paused'}, trigger: ${f.trigger}, lead agent: ${f.agentName}): ${f.runsInPeriod} run(s) in period, ${f.pendingApprovals} pending approval, ${f.activeFollowUps} active follow-up(s)${f.latestTarget ? `, latest: ${f.latestTarget} (${f.latestOutcome || 'recorded'})` : ''}.`,
        )
        .join('\n')
    : '- No custom workflow floors configured.';

  const facts = [
    `Academy: ${ac.academyName}. Reporting Lead: ${ac.senderName} (${ac.senderTitle}).`,
    `Total runs across all floors (${NAMES[period]}): ${n.runs} (${n.flowRuns} floor workflow run(s), webhook ${r.byTrigger.webhook || 0}, Google Sheet ${r.byTrigger.sheet || 0}, schedule ${r.byTrigger.schedule || 0}, manager ${r.byTrigger.manager || 0}).`,
    `Floors / Offices:\n${floorLines}`,
    `Student Success specifics: ${n.checked} checked, ${n.helped} reached, ${n.studyPacks} study packs sent, ${n.checkIns} check-ins/workflow emails, ${n.quizzesDone} quizzes completed${n.passRate !== null ? ` (${n.passRate}% passed)` : ''}.`,
    `Quality & Approvals: ${n.mistakesCaught} issue(s) caught before dispatch (${n.mistakesFixed} fixed), ${n.pendingApprovals} item(s) awaiting human approval in Inbox, ${n.activeFollowUps} active scheduled follow-up(s).`,
    `Reached in this period: ${r.helped.map((h) => `${h.name} via ${h.office} (${h.what})`).join('; ') || 'nobody yet'}.`,
    `Still flagged / at risk: ${r.learners.filter((l) => l.status === 'at_risk').map((l) => l.name).join(', ') || 'nobody'}.`,
  ].join('\n\n');

  const text = await complete({
    system: `You are ${ac.senderName} (${ac.senderTitle}) compiling the executive briefing across ALL departments and floors at ${ac.academyName} (Finance & Collections, Admissions, Student Success, Learning & Assessment, and any custom workflows). Plain text only (no markdown headings or hashes), warm, concrete, and clearly separated into short paragraphs with blank lines between sections.${teach('coo')}`,
    prompt: `Write the ${NAMES[period]} operations briefing for ${ac.academyName} using ONLY these facts. Never invent numbers or names. Do NOT reduce the briefing to only Student Success — cover activity and readiness across EVERY floor listed below.\n\n${facts}\n\nStructure with blank lines between paragraphs:\n1. Brief greeting introducing yourself as ${ac.senderName} from ${ac.academyName} and summarizing overall activity across the building.\n2. Floor-by-floor update (Finance, Admissions, Student Success, Learning, Custom) mentioning which workflows ran, what agents did, or which are standing by.\n3. Pending approvals, active follow-ups, quality checks caught, and what management should review next.`,
    maxTokens: 6000,
    timeoutMs: 20000,
    json: false,
  });

  const activeFloorsSummary = r.floors
    .map((f) =>
      f.runsInPeriod > 0
        ? `${f.officeName} ("${f.workflowName}", led by ${f.agentName}): ${f.runsInPeriod} run${f.runsInPeriod === 1 ? '' : 's'} — latest for ${f.latestTarget || 'queue'} (${f.latestOutcome || 'logged'}).`
        : `${f.officeName} ("${f.workflowName}", led by ${f.agentName}): 0 runs ${NAMES[period]} (${f.enabled ? 'monitoring' : 'paused'}).`,
    )
    .join('\n');

  const fallback = [
    `Hi Team,\n\nThis is ${ac.senderName} (${ac.senderTitle}) at ${ac.academyName} with your ${NAMES[period]} multi-floor operations briefing.`,
    `Across all departments, the team completed ${n.runs} total run${n.runs === 1 ? '' : 's'} (${n.flowRuns} floor workflow run${n.flowRuns === 1 ? '' : 's'}), checked ${n.checked} record${n.checked === 1 ? '' : 's'}, and reached ${n.helped} person${n.helped === 1 ? '' : 's'} across ${n.floorsActive} active floor${n.floorsActive === 1 ? '' : 's'}.`,
    `Floor-by-floor status:\n${activeFloorsSummary || 'All floors standing by.'}`,
    `Quality & approvals: ${n.mistakesCaught} quality issue${n.mistakesCaught === 1 ? '' : 's'} caught (${n.mistakesFixed} revised), ${n.pendingApprovals} message${n.pendingApprovals === 1 ? '' : 's'} waiting in Inbox for approval, and ${n.activeFollowUps} active recurring follow-up${n.activeFollowUps === 1 ? '' : 's'}.`,
    `Warm regards,\n${ac.senderName}\n${ac.senderTitle} · ${ac.academyName}`,
  ].join('\n\n');

  return { report: r, text: text?.trim() || fallback, viaAi: Boolean(text), at: Date.now() };
}

/** Write the multi-floor report and queue/send via sendMail. */
export async function emailReport(period: Period, to: string) {
  const ac = getAcademyContext(currentTenantId());
  const out = await writeReport(period);
  const n = out.report.numbers;

  const kpiCards = [
    { label: 'Total Runs', val: String(n.runs) },
    { label: 'Active Floors', val: String(n.floorsActive) },
    { label: 'People Reached', val: String(n.helped) },
    { label: 'Pending Approval', val: String(n.pendingApprovals) },
  ]
    .map(
      (k) =>
        `<td width="25%" style="padding:10px 8px;background:#f4f7fc;border-radius:10px;text-align:center">
          <div style="font-size:20px;font-weight:800;color:#0a1733">${escHtml(k.val)}</div>
          <div style="font-size:11px;font-weight:600;color:#5b6478;text-transform:uppercase;letter-spacing:.04em;margin-top:4px">${escHtml(k.label)}</div>
        </td>`,
    )
    .join('<td width="8"></td>');

  const floorRows = out.report.floors
    .map(
      (f) => `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #eef1f8;font-size:13px"><b>${escHtml(f.officeName)}</b><div style="color:#5b6478;font-size:12px">${escHtml(f.workflowName)}</div></td>
        <td style="padding:10px 12px;border-bottom:1px solid #eef1f8;font-size:13px">${escHtml(f.agentName)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eef1f8;font-size:13px">${f.runsInPeriod} run${f.runsInPeriod === 1 ? '' : 's'}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eef1f8;font-size:12px;color:#3d465a">${f.latestTarget ? `${escHtml(f.latestTarget)}: ${escHtml(f.latestOutcome || 'recorded')}` : (f.enabled ? 'Standing by' : 'Paused')}</td>
      </tr>`,
    )
    .join('');

  const body = `
<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr>${kpiCards}</tr></table>
${formatHtmlParagraphs(out.text)}
${out.report.floors.length ? `<div style="margin:24px 0 8px">
  <div style="font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#5b6478;margin:0 0 10px">Activity by Floor &amp; Office</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e9f2;border-radius:10px;border-collapse:collapse;overflow:hidden">
    <tr style="background:#f4f7fc;text-align:left;font-size:11px;text-transform:uppercase;color:#5b6478">
      <th style="padding:10px 12px">Floor / Workflow</th>
      <th style="padding:10px 12px">Lead Agent</th>
      <th style="padding:10px 12px">Runs</th>
      <th style="padding:10px 12px">Latest Status</th>
    </tr>
    ${floorRows}
  </table>
</div>` : ''}
<div style="margin:22px 0 6px;padding-top:16px;border-top:1px solid #e7ecf5;font-size:14px;line-height:1.65;color:#1b253b">
  <p style="margin:0 0 4px">Warm regards,</p>
  <p style="margin:0;font-weight:700;color:#0a1733">${escHtml(ac.senderName)} &amp; Operations Team</p>
  <p style="margin:0;font-size:13px;color:#5b6478">${escHtml(ac.senderTitle)} · ${escHtml(ac.academyName)}</p>
</div>`;

  const html = emailShell(
    `${ac.academyName} · Multi-Floor Operations Report (${NAMES[period]})`,
    body,
    null,
    { agentName: ac.senderName, officeName: `${ac.academyName} Operations` },
  );

  const m = await sendMail({
    to,
    toName: `${ac.academyName} Leadership`,
    subject: `${ac.academyName} · Operations Report (${NAMES[period]})`,
    html,
    text: out.text,
    link: null,
    taskId: 'report',
    deliverableId: null,
  });
  log('coo', 'email', `Operations report (${NAMES[period]}) ${m.delivery === 'simulated' ? 'saved to Inbox preview' : `emailed to ${m.to}`}.`);
  return { ...out, mailed: m.delivery === 'simulated' ? `${m.to} (preview in Inbox · Safe Test Mode)` : m.to };
}


