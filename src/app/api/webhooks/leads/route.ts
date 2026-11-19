import { NextResponse } from 'next/server';
import { runWithInboundAuth } from '@/lib/auth/requestTenant';
import { bootReady } from '@/lib/engine/automation';
import { receiveLead } from '@/lib/engine/agentTriggers';
import { currentTenantId } from '@/lib/auth/tenantContext';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* Leads from ads and forms.
 *
 * POST /api/webhooks/leads?tenant=<workspace>&token=<inbound token>
 * (or the token in an X-Thuso-Token header). Send JSON from Zapier, Make, a
 * website form, or Meta lead forms (the field_data array is understood):
 *   { "full_name": "Thandi Mokoena", "email": "thandi@example.com",
 *     "phone_number": "082 123 4567", "course": "Data Analytics",
 *     "campaign": "Oct intake - Facebook" }
 * The lead joins the leads list and, with autopilot on, the Admissions agents
 * start on it straight away. */

export async function POST(req: Request) {
  return runWithInboundAuth(req, async () => {
    await bootReady(currentTenantId());
    const ct = req.headers.get('content-type') || '';
    let payload: Record<string, unknown> = {};
    if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
      const form = await req.formData().catch(() => null);
      if (form) for (const [k, v] of form.entries()) if (typeof v === 'string') payload[k] = v;
    } else {
      payload = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    }
    // Meta's webhook shape: { entry: [{ changes: [{ value: {...} }] }] } carries ids only; Zapier/Make send the fields.
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return NextResponse.json({ error: 'Send the lead as a JSON object.' }, { status: 400 });
    const r = await receiveLead(payload);
    if (!r.record.email && !r.record.phone) {
      return NextResponse.json({ ok: true, warning: 'Saved, but the lead has no email or phone, so agents cannot reach them.', key: r.record.key }, { status: 202 });
    }
    return NextResponse.json({ ok: true, created: r.created, agentsStarted: r.started, key: r.record.key }, { status: 202 });
  });
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/webhooks/leads?tenant=<workspace slug>',
    auth: 'X-Thuso-Token header or ?token= (Channels & API shows it)',
    accepts: { full_name: 'Thandi Mokoena', email: 'thandi@example.com', phone_number: '082 123 4567', course: 'Data Analytics', campaign: 'Oct intake - Facebook', message: 'optional' },
  });
}
