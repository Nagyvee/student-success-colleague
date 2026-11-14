import { NextResponse } from 'next/server';
import { ensureAutomation } from '@/lib/engine/automation';
import { getState } from '@/lib/engine/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* Alive? Also wakes the always-on pump after a restart. */
export async function GET() {
  ensureAutomation();
  const s = getState();
  return NextResponse.json({ ok: true, busy: s.busy, email: s.caps.email, dialer: s.caps.dialer, at: new Date().toISOString() });
}
