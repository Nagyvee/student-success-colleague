import { NextResponse } from 'next/server';
import { capabilities, getState, log, mutate, resetWorld, setPublicUrl, setSettings } from '@/lib/engine/store';
import type { Settings } from '@/lib/types';
import { enqueue, ensureAutomation, schedulingChanged, sweepNow } from '@/lib/engine/automation';
import { setSheetUrl } from '@/lib/lms/sheet';
import { MANAGER_ROLES, runWithSessionTenant } from '@/lib/auth/requestTenant';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { updateTenantIntegrations } from '@/lib/auth/accounts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  return runWithSessionTenant(req, () => {
    ensureAutomation();
    return NextResponse.json(getState());
  });
}

export async function POST(req: Request) {
  return runWithSessionTenant(req, async (session) => {
    ensureAutomation();
    const body = (await req.json().catch(() => ({}))) as { action?: string; settings?: Partial<Settings>; url?: string | null; goal?: string; focus?: string[] };
    const manager = MANAGER_ROLES.includes(session.role);
    const sensitive = body.action === 'reset' || body.action === 'publicUrl' || body.action === 'sheet'
      || (body.action === 'settings' && body.settings && ['requireApproval', 'autoRunMode', 'liveOutreachEnabled', 'lmsMode'].some((k) => k in (body.settings as object)));
    if (sensitive && !manager) {
      return NextResponse.json({ error: 'Only a workspace owner or admin can change sending, autopilot or data settings.' }, { status: 403 });
    }
    if (body.action === 'sweep') { sweepNow(); return NextResponse.json({ ok: true }); }
    if (body.action === 'publicUrl') {
      try { setPublicUrl(body.url || null); return NextResponse.json({ ok: true }); }
      catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
    }
    if (body.action === 'goal' && typeof body.goal === 'string' && body.goal.trim().length >= 8) {
      const focus = Array.isArray(body.focus) ? body.focus.filter((x) => typeof x === 'string' && x.trim()) : undefined;
      enqueue({ goal: body.goal, trigger: { kind: 'manager', label: focus?.length ? 'Focused coaching' : "Manager's goal" }, focus });
      return NextResponse.json({ ok: true });
    }
    if (body.action === 'sheet') {
      try {
        setSheetUrl(body.url || null);
        updateTenantIntegrations(currentTenantId(), { googleSheetUrl: body.url || '' });
        schedulingChanged();
        return NextResponse.json({ ok: true });
      }
      catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
    }
    if (body.action === 'reset') {
      if (getState().busy) return NextResponse.json({ error: 'Wait for the current run to finish before resetting.' }, { status: 409 });
      resetWorld();
      return NextResponse.json({ ok: true });
    }
    if (body.action === 'settings' && body.settings) {
      const patch: Partial<Settings> = {};
      if (typeof body.settings.injectDefects === 'boolean') patch.injectDefects = body.settings.injectDefects;
      if (body.settings.lmsMode === 'sandbox' || body.settings.lmsMode === 'live') patch.lmsMode = body.settings.lmsMode;
      if (body.settings.speed === 'normal' || body.settings.speed === 'fast') patch.speed = body.settings.speed;
      if (body.settings.tutorLanguage === 'en' || body.settings.tutorLanguage === 'zu' || body.settings.tutorLanguage === 'st') patch.tutorLanguage = body.settings.tutorLanguage;
      if (typeof body.settings.scheduleEnabled === 'boolean') patch.scheduleEnabled = body.settings.scheduleEnabled;
      if (typeof body.settings.callFollowUp === 'boolean') patch.callFollowUp = body.settings.callFollowUp;
      if (typeof body.settings.requireApproval === 'boolean') {
        patch.requireApproval = body.settings.requireApproval;
        updateTenantIntegrations(currentTenantId(), { requireApproval: body.settings.requireApproval });
      }
      if (typeof body.settings.autoRunMode === 'boolean') {
        patch.autoRunMode = body.settings.autoRunMode;
        patch.scheduleEnabled = body.settings.autoRunMode;
        updateTenantIntegrations(currentTenantId(), { autoRunMode: body.settings.autoRunMode });
      }
      if (typeof body.settings.liveOutreachEnabled === 'boolean') {
        patch.liveOutreachEnabled = body.settings.liveOutreachEnabled;
        updateTenantIntegrations(currentTenantId(), { liveOutreachEnabled: body.settings.liveOutreachEnabled });
      }
      setSettings(patch);
      if (typeof body.settings.liveOutreachEnabled === 'boolean') {
        const tid = currentTenantId();
        mutate((st) => { st.caps = capabilities(tid); });
      }
      if (typeof patch.scheduleEnabled === 'boolean') schedulingChanged();
      const s = getState().settings;
      if (patch.lmsMode) log('system', 'system', `LMS mode → ${s.lmsMode === 'live' ? 'Live (LMS API)' : 'Demo Sandbox'}.`);
      if (typeof patch.injectDefects === 'boolean') log('system', 'system', `Demo defects ${s.injectDefects ? 'on: each first draft carries one planted error for the COO to catch' : 'off: drafts go to the COO as written'}.`);
      if (patch.speed) log('system', 'system', `Office pace → ${s.speed}.`);
      if (typeof patch.requireApproval === 'boolean') log('system', 'system', `Approval before sending → ${patch.requireApproval ? 'ON (you click Approve before sending)' : 'OFF (auto-send enabled)'}.`);
      if (typeof patch.autoRunMode === 'boolean') log('system', 'system', `Operating mode → ${patch.autoRunMode ? 'Full Auto (auto-scan & follow-ups enabled)' : 'Manual Review (sync saves records quietly until you click Coach or Run)'}.`);
      if (typeof patch.liveOutreachEnabled === 'boolean') log('system', 'system', `Outreach mode → ${patch.liveOutreachEnabled ? 'LIVE OUTREACH ON (real SMTP / WhatsApp / Dialer sends active)' : 'SAFE TEST MODE (all outreach simulated in-app only; zero live sends)'}.`);
      if (patch.tutorLanguage) {
        const label = patch.tutorLanguage === 'zu' ? 'isiZulu + English' : patch.tutorLanguage === 'st' ? 'Sesotho + English' : 'English';
        log('learning', 'info', `Tutor explanation language → ${label}.`, { toolCall: { tool: 'learning.set_tutor_language', payload: { language: patch.tutorLanguage, mode: label } } });
      }
      return NextResponse.json({ ok: true, settings: s });
    }
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  });
}
