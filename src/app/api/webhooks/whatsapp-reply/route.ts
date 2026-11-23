import { NextResponse } from 'next/server';
import { runWithInboundAuth } from '@/lib/auth/requestTenant';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { bootReady } from '@/lib/engine/automation';
import { manychat } from '@/lib/messaging/manychat';
import { readIncoming, receive } from '@/lib/nurture/waReplies';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* A Thuso lead typed something on WhatsApp.
 *
 * ManyChat's Default Reply sends people tagged thuso_lead here: an External
 * Request, POST, Full Contact Data, with the workspace's inbound token in the
 * X-Thuso-Token header. It answers at once (ManyChat waits only seconds); the
 * reply itself goes out a little later, when they have stopped typing. */

export async function POST(req: Request) {
  return runWithInboundAuth(req, async (tid) => {
    await bootReady(tid);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const m = body && typeof body === 'object' ? readIncoming(body) : null;
    if (!m) return NextResponse.json({ ok: false, error: 'Send the contact: ManyChat\'s Full Contact Data.' }, { status: 400 });
    if (!m.text) {
      // Not in what was sent: ask ManyChat what they typed last.
      const key = (getTenantIntegrations(tid).manychatApiKey || '').trim();
      const r = key ? await manychat(key, 4000).info(m.id) : null;
      m.text = String(r?.data?.last_input_text || '').trim().slice(0, 1500);
      m.phone ||= String(r?.data?.whatsapp_phone || r?.data?.phone || '');
    }
    const kept = receive(m, tid);
    return NextResponse.json({ ok: kept }, { status: kept ? 200 : 503 });
  });
}
