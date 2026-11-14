import { NextResponse } from 'next/server';
import { getState, log } from '@/lib/engine/store';
import { buildReport, type Period } from '@/lib/reports';
import { NAMES, emailReport, writeReport } from '@/lib/musaReport';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const p = (new URL(req.url).searchParams.get('period') || 'today') as Period;
  return NextResponse.json(buildReport(getState(), ['today', 'week', 'all'].includes(p) ? p : 'today'));
}

/* Ask Musa to write the report; with an email address, he sends it too. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { period?: Period; email?: string };
  const period = (['today', 'week', 'all'].includes(String(body.period)) ? body.period : 'today') as Period;
  const to = (body.email || process.env.MANAGER_EMAIL || '').trim();
  if (body.email !== undefined && /.+@.+\..+/.test(to)) return NextResponse.json(await emailReport(period, to));
  const out = await writeReport(period);
  log('coo', 'info', `Musa wrote the ${NAMES[period]} report.`);
  return NextResponse.json({ ...out, mailed: null });
}
