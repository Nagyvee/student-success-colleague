import { NextResponse } from 'next/server';
import { getState, log } from '@/lib/engine/store';
import { buildReport, type Period } from '@/lib/reports';
import { NAMES, emailReport, writeReport } from '@/lib/musaReport';
import { runWithSessionTenant } from '@/lib/auth/requestTenant';
import { listWorkflows } from '@/lib/engine/workflows';
import { listCustomAgents, listFlowRuns, listOffices } from '@/lib/engine/offices';
import { listFollowUps } from '@/lib/engine/followups';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function workspaceExtras() {
  return {
    workflows: listWorkflows(),
    offices: listOffices(),
    customAgents: listCustomAgents(),
    flowRuns: listFlowRuns(),
    followUps: listFollowUps(),
  };
}

export async function GET(req: Request) {
  return runWithSessionTenant(req, () => {
    const p = (new URL(req.url).searchParams.get('period') || 'today') as Period;
    return NextResponse.json(
      buildReport(getState(), ['today', 'week', 'all'].includes(p) ? p : 'today', workspaceExtras()),
    );
  });
}

/* Generate multi-floor operations briefing; with an email address, queue/send via sendMail. */
export async function POST(req: Request) {
  return runWithSessionTenant(req, async () => {
    const body = (await req.json().catch(() => ({}))) as { period?: Period; email?: string };
    const period = (['today', 'week', 'all'].includes(String(body.period)) ? body.period : 'today') as Period;
    const to = (body.email || process.env.MANAGER_EMAIL || '').trim();
    if (body.email !== undefined && /.+@.+\..+/.test(to)) return NextResponse.json(await emailReport(period, to));
    const out = await writeReport(period);
    log('coo', 'info', `Multi-floor operations report compiled for ${NAMES[period]}.`);
    return NextResponse.json({ ...out, mailed: null });
  });
}
