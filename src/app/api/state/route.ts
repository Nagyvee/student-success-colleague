import { NextResponse } from 'next/server';
import { getState, log, resetWorld, setPublicUrl, setSettings } from '@/lib/engine/store';
import type { Settings } from '@/lib/types';
import { enqueue, ensureAutomation, schedulingChanged, sweepNow } from '@/lib/engine/automation';
import { setSheetUrl } from '@/lib/lms/sheet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(getState());
}

export async function POST(req: Request) {
  ensureAutomation();
  const body = (await req.json().catch(() => ({}))) as { action?: string; settings?: Partial<Settings>; url?: string | null; goal?: string };
  if (body.action === 'sweep') { sweepNow(); return NextResponse.json({ ok: true }); }
  if (body.action === 'publicUrl') {
    try { setPublicUrl(body.url || null); return NextResponse.json({ ok: true }); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  }
  if (body.action === 'goal' && typeof body.goal === 'string' && body.goal.trim().length >= 8) {
    enqueue({ goal: body.goal, trigger: { kind: 'manager', label: "Manager's goal" } });
    return NextResponse.json({ ok: true });
  }
  if (body.action === 'sheet') {
    try { setSheetUrl(body.url || null); schedulingChanged(); return NextResponse.json({ ok: true }); }
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
    setSettings(patch);
    if (typeof patch.scheduleEnabled === 'boolean') schedulingChanged();
    const s = getState().settings;
    if (patch.lmsMode) log('system', 'system', `LMS mode → ${s.lmsMode === 'live' ? 'Live (LMS API)' : 'Demo Sandbox'}.`);
    if (typeof patch.injectDefects === 'boolean') log('system', 'system', `Demo defects ${s.injectDefects ? 'on: each first draft carries one planted error for the COO to catch' : 'off: drafts go to the COO as written'}.`);
    if (patch.speed) log('system', 'system', `Office pace → ${s.speed}.`);
    if (patch.tutorLanguage) {
      const label = patch.tutorLanguage === 'zu' ? 'isiZulu + English' : patch.tutorLanguage === 'st' ? 'Sesotho + English' : 'English';
      log('learning', 'info', `Tutor explanation language → ${label}.`, { toolCall: { tool: 'learning.set_tutor_language', payload: { language: patch.tutorLanguage, mode: label } } });
    }
    return NextResponse.json({ ok: true, settings: s });
  }
  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
}
