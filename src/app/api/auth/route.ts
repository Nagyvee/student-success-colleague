import { NextResponse } from 'next/server';
import type { TenantIntegrations } from '@/lib/types';
import {
  SESSION_COOKIE,
  addTeamMember,
  getMaskedIntegrations,
  getTenantSummary,
  hydrateAuthFromDb,
  publicTenantSummary,
  listTeamMembers,
  loginAccount,
  registerWorkspace,
  removeTeamMember,
  sessionFromRequest,
  tenantInboundToken,
  updateTenantIntegrations,
} from '@/lib/auth/accounts';
import { withTenant } from '@/lib/auth/tenantContext';
import { ensureAutomation, schedulingChanged } from '@/lib/engine/automation';
import { mutate, capabilities, setSettings } from '@/lib/engine/store';
import { MoodleLmsAdapter, testMoodleConnection } from '@/lib/lms/moodleAdapter';
import { setSheetUrl, testSheetConnection } from '@/lib/lms/sheet';
import { testManyChatConnection, testSmtpConnection, testWhatsAppConnection } from '@/lib/email/send';
import { testDbConnection } from '@/lib/db/postgres';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function cookieHeader(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 30 * 24 * 3600,
  };
}

export async function GET(req: Request) {
  await hydrateAuthFromDb();
  ensureAutomation();
  const s = sessionFromRequest(req);
  if (!s) return NextResponse.json({ authenticated: false, user: null, tenant: null, integrations: null, team: [] });
  const tid = s.tenantId;
  const manager = s.role === 'owner' || s.role === 'admin';
  return withTenant(tid, () => {
    const summary = getTenantSummary(tid);
    return NextResponse.json({
      authenticated: true,
      user: { id: s.userId, email: s.email, name: s.name, role: s.role, tenantId: s.tenantId },
      // Only owners and admins see the signing secret and the inbound token.
      tenant: manager ? { ...summary, inboundToken: tenantInboundToken(tid) } : { ...summary, webhookSecret: '' },
      integrations: getMaskedIntegrations(tid),
      team: listTeamMembers(tid),
    });
  });
}

export async function POST(req: Request) {
  await hydrateAuthFromDb();
  ensureAutomation();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action || '');

  if (action === 'register') {
    if (/^(0|false|no|off)$/i.test(process.env.ALLOW_SIGNUPS || '')) {
      return NextResponse.json({ error: 'New workspaces are closed on this server. Ask an owner to add you to the team.' }, { status: 403 });
    }
    try {
      const { user, tenant, token } = registerWorkspace({
        academyName: String(body.academyName || ''),
        name: String(body.name || ''),
        email: String(body.email || ''),
        password: String(body.password || ''),
      });
      const res = NextResponse.json({ ok: true, user, tenant });
      res.cookies.set(cookieHeader(token));
      return res;
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  if (action === 'login') {
    try {
      const { user, tenant, token } = loginAccount({
        email: String(body.email || ''),
        password: String(body.password || ''),
      });
      const res = NextResponse.json({ ok: true, user, tenant });
      res.cookies.set(cookieHeader(token));
      return res;
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 401 });
    }
  }

  if (action === 'logout') {
    const res = NextResponse.json({ ok: true });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  const s = sessionFromRequest(req);
  if (!s) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  const tid = s.tenantId;
  const isManager = s.role === 'owner' || s.role === 'admin';
  if (!isManager && ['saveIntegrations', 'discoverMoodle', 'testConnection', 'addMember', 'removeMember'].includes(action)) {
    return NextResponse.json({ error: 'Only a workspace owner or admin can change integrations and the team.' }, { status: 403 });
  }

  if (action === 'saveIntegrations') {
    return withTenant(tid, () => {
      const patch = (body.integrations || {}) as Partial<TenantIntegrations> & { academyName?: string };
      const saved = updateTenantIntegrations(tid, patch);
      if (patch.googleSheetUrl !== undefined) {
        try { setSheetUrl(patch.googleSheetUrl || null, tid); } catch { /* ignore invalid */ }
        schedulingChanged();
      }
      if (typeof saved.requireApproval === 'boolean') {
        setSettings({ requireApproval: saved.requireApproval });
      }
      if (typeof saved.autoRunMode === 'boolean') {
        setSettings({ autoRunMode: saved.autoRunMode, scheduleEnabled: saved.autoRunMode });
        schedulingChanged();
      }
      if (typeof saved.liveOutreachEnabled === 'boolean') {
        setSettings({ liveOutreachEnabled: saved.liveOutreachEnabled });
      }
      if (saved.lmsProvider !== 'sandbox') {
        setSettings({ lmsMode: 'live' });
      } else {
        setSettings({ lmsMode: 'sandbox' });
      }
      if (saved.tutorLanguage) {
        setSettings({ tutorLanguage: saved.tutorLanguage });
      }
      mutate((st) => {
        st.caps = capabilities(tid);
        st.tenant = publicTenantSummary(tid);
      });
      return NextResponse.json({
        ok: true,
        tenant: getTenantSummary(tid),
        integrations: getMaskedIntegrations(tid),
      });
    });
  }

  if (action === 'discoverMoodle') {
    const draft = (body.draft || {}) as Partial<TenantIntegrations>;
    return withTenant(tid, async () => {
      const { getTenantIntegrations } = await import('@/lib/auth/accounts');
      const real = getTenantIntegrations(tid);
      const url = (draft.moodleUrl ?? real.moodleUrl ?? process.env.MOODLE_URL ?? '').trim();
      const token =
        draft.moodleToken && !draft.moodleToken.startsWith('••••')
          ? draft.moodleToken.trim()
          : (real.moodleToken || process.env.MOODLE_TOKEN || '').trim();
      if (!url || !token) {
        return NextResponse.json({ ok: false, error: 'Moodle URL and token are required to load courses and groups.' }, { status: 400 });
      }
      try {
        const adapter = new MoodleLmsAdapter(url, token);
        const courses = await adapter.listCoursesWithGroups();
        return NextResponse.json({ ok: true, courses });
      } catch (e) {
        return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
      }
    });
  }

  if (action === 'testConnection') {
    const kind = String(body.kind || '');
    const draft = (body.draft || {}) as Partial<TenantIntegrations> & { testRecipient?: string };
    return withTenant(tid, async () => {
      if (kind === 'moodle') {
        const current = getMaskedIntegrations(tid);
        const token = draft.moodleToken && !draft.moodleToken.startsWith('••••')
          ? draft.moodleToken
          : undefined;
        // Resolve real stored token if masked or omitted:
        const { getTenantIntegrations } = await import('@/lib/auth/accounts');
        const real = getTenantIntegrations(tid);
        const res = await testMoodleConnection({
          url: draft.moodleUrl ?? real.moodleUrl ?? undefined,
          token: token ?? real.moodleToken ?? undefined,
          courseIds: draft.moodleCourseIds ?? real.moodleCourseIds ?? current.moodleCourseIds,
        });
        return NextResponse.json(res);
      }
      if (kind === 'sheet') {
        const { getTenantIntegrations } = await import('@/lib/auth/accounts');
        const real = getTenantIntegrations(tid);
        const url = String(draft.googleSheetUrl ?? real.googleSheetUrl ?? '').trim();
        const res = await testSheetConnection(url);
        return NextResponse.json(res);
      }
      if (kind === 'smtp') {
        const { getTenantIntegrations } = await import('@/lib/auth/accounts');
        const real = getTenantIntegrations(tid);
        const pass = draft.smtpPass && !draft.smtpPass.startsWith('••••') ? draft.smtpPass : real.smtpPass;
        const res = await testSmtpConnection(
          {
            host: draft.smtpHost ?? real.smtpHost,
            port: draft.smtpPort ?? real.smtpPort,
            user: draft.smtpUser ?? real.smtpUser,
            pass,
            emailFrom: draft.emailFrom ?? real.emailFrom,
          },
          draft.testRecipient,
        );
        return NextResponse.json(res);
      }
      if (kind === 'whatsapp') {
        const { getTenantIntegrations } = await import('@/lib/auth/accounts');
        const real = getTenantIntegrations(tid);
        const token = draft.whatsappToken && !draft.whatsappToken.startsWith('••••') ? draft.whatsappToken : real.whatsappToken;
        const res = await testWhatsAppConnection({
          url: draft.whatsappUrl ?? real.whatsappUrl,
          token,
        });
        return NextResponse.json(res);
      }
      if (kind === 'manychat') {
        const { getTenantIntegrations } = await import('@/lib/auth/accounts');
        const real = getTenantIntegrations(tid);
        const apiKey = draft.manychatApiKey && !draft.manychatApiKey.startsWith('••••') ? draft.manychatApiKey : real.manychatApiKey;
        const res = await testManyChatConnection({ apiKey });
        return NextResponse.json(res);
      }
      if (kind === 'postgres') {
        const res = await testDbConnection();
        return NextResponse.json(res);
      }
      if (kind === 'report') {
        const { previewNurtureReport } = await import('@/lib/nurture/report');
        return NextResponse.json(await previewNurtureReport(tid));
      }
      if (kind === 'discord' || kind === 'dialer') {
        const { getTenantIntegrations } = await import('@/lib/auth/accounts');
        const real = getTenantIntegrations(tid).handoff || {};
        const d = draft.handoff || {};
        const secret = (v: string | undefined, saved: string | undefined) => (v && !v.startsWith('••••') ? v : saved || '');
        const { testDialer, testDiscord } = await import('@/lib/nurture/qualify');
        if (kind === 'discord') {
          const hook = secret(d.discordWebhook, real.discordWebhook);
          return NextResponse.json(hook ? await testDiscord(hook) : { ok: false, error: 'Paste the Discord webhook address first.' });
        }
        // Settings first, else the server's DIALER_URL / DIALER_API_KEY (what the hand-off uses too).
        return NextResponse.json(await testDialer(d.dialerUrl || real.dialerUrl || process.env.DIALER_URL || '', secret(d.dialerKey, real.dialerKey) || process.env.DIALER_API_KEY || ''));
      }
      return NextResponse.json({ ok: false, error: `Unknown connection kind "${kind}".` }, { status: 400 });
    });
  }

  if (action === 'addMember') {
    if (!s) return NextResponse.json({ error: 'Sign in to add team members.' }, { status: 401 });
    if (s.role === 'advisor') return NextResponse.json({ error: 'Only workspace owners or admins can manage team members.' }, { status: 403 });
    try {
      const member = addTeamMember(tid, {
        name: String(body.name || ''),
        email: String(body.email || ''),
        role: body.role === 'admin' ? 'admin' : 'advisor',
        password: String(body.password || ''),
      });
      return NextResponse.json({ ok: true, member, team: listTeamMembers(tid) });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  if (action === 'removeMember') {
    if (!s) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
    if (s.role === 'advisor') return NextResponse.json({ error: 'Only owners or admins can remove members.' }, { status: 403 });
    try {
      const ok = removeTeamMember(tid, s.userId, String(body.userId || ''));
      return NextResponse.json({ ok, team: listTeamMembers(tid) });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
}

