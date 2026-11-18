import { NextResponse } from 'next/server';
import { runWithSessionTenant } from '@/lib/auth/requestTenant';
import { approveOutreachById, rejectOutreachById } from '@/lib/engine/approvals';
import { getState } from '@/lib/engine/store';
import { ensureAutomation } from '@/lib/engine/automation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  return runWithSessionTenant(req, () => {
    ensureAutomation();
    return NextResponse.json({ pendingOutreach: getState().pendingOutreach || [] });
  });
}

export async function POST(req: Request) {
  return runWithSessionTenant(req, async () => {
    ensureAutomation();
    const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string; ids?: unknown };
    const action = String(body.action || '');

    if (action === 'approve' && body.id) {
      const res = await approveOutreachById(body.id);
      if (!res) return NextResponse.json({ error: 'Pending item not found or already resolved.' }, { status: 404 });
      return NextResponse.json({ ok: true, ...res, pendingOutreach: getState().pendingOutreach || [] });
    }

    if (action === 'approveAll') {
      const only = Array.isArray(body.ids) ? new Set((body.ids as unknown[]).map(String)) : null;
      const pending = (getState().pendingOutreach || []).filter((x) => x.status === 'pending' && (!only || only.has(x.id)));
      let sent = 0;
      for (const item of pending) {
        const res = await approveOutreachById(item.id);
        if (res) sent += 1;
      }
      return NextResponse.json({ ok: true, sent, pendingOutreach: getState().pendingOutreach || [] });
    }

    if (action === 'reject' && body.id) {
      const item = rejectOutreachById(body.id);
      if (!item) return NextResponse.json({ error: 'Pending item not found.' }, { status: 404 });
      return NextResponse.json({ ok: true, item, pendingOutreach: getState().pendingOutreach || [] });
    }

    return NextResponse.json({ error: 'Invalid approval action.' }, { status: 400 });
  });
}

