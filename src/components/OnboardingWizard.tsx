'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Icon from '@/components/Icon';
import Logo from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';
import type {
  OutreachChannel,
  TenantIntegrations,
  TenantSummary,
  TutorLanguage,
  WorkflowDef,
} from '@/lib/types';
import '../app/pages.css';

export default function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [origin, setOrigin] = useState('');
  const [tenant, setTenant] = useState<TenantSummary | null>(null);
  const [academyName, setAcademyName] = useState('');
  const [form, setForm] = useState<TenantIntegrations>({
    lmsProvider: 'webhook',
    defaultChannel: 'email',
    tutorLanguage: 'en',
    requireApproval: true,
    smtpPort: 465,
    manychatChannel: 'whatsapp',
  });
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checkOk, setCheckOk] = useState<boolean | null>(null);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    Promise.all([
      fetch('/api/auth', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/workflows', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([auth, wfs]) => {
        if (auth?.tenant) {
          setTenant(auth.tenant);
          setAcademyName(auth.tenant.name || '');
        }
        if (auth?.integrations) {
          setForm((prev) => ({
            ...prev,
            ...auth.integrations,
            lmsProvider:
              auth.integrations.lmsProvider === 'sandbox'
                ? 'webhook'
                : auth.integrations.lmsProvider || 'webhook',
          }));
        }
        if (Array.isArray(wfs?.workflows)) setWorkflows(wfs.workflows);
      })
      .catch(() => {});
  }, []);

  const saveStep = async (extra?: Partial<TenantIntegrations>, nextStep?: number) => {
    setBusy(true);
    setErr(null);
    setCheckMsg(null);
    setCheckOk(null);
    try {
      const payload = { ...form, ...extra, academyName };
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'saveIntegrations', integrations: payload }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json.error || 'Could not save settings.');
        return false;
      }
      if (json.tenant) setTenant(json.tenant);
      if (json.integrations) setForm((prev) => ({ ...prev, ...json.integrations }));
      if (typeof nextStep === 'number') setStep(nextStep);
      return true;
    } finally {
      setBusy(false);
    }
  };

  const verifyChannel = async (
    kind: 'moodle' | 'smtp' | 'whatsapp' | 'manychat' | 'sheet',
  ) => {
    setCheckMsg('Checking connection...');
    setCheckOk(null);
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'testConnection', kind, draft: form }),
    });
    const json = await res.json();
    setCheckOk(Boolean(json.ok));
    setCheckMsg(
      json.ok
        ? json.detail || json.site || 'Connected and verified'
        : json.error || 'Could not verify yet — check credentials.',
    );
  };

  const toggleWorkflow = async (wf: WorkflowDef) => {
    await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle', id: wf.id, enabled: !wf.enabled }),
    });
    setWorkflows((list) =>
      list.map((w) => (w.id === wf.id ? { ...w, enabled: !w.enabled } : w)),
    );
  };

  const finish = async (dest: '/' | '/workflows' | '/learners') => {
    const ok = await saveStep({ onboardingCompleted: true });
    if (ok) router.replace(dest);
  };

  const webhookUrl = `${origin || 'https://your-domain'}/api/webhooks/lms?tenant=${encodeURIComponent(
    tenant?.slug || 'default',
  )}`;

  return (
    <div className="ob-wrap">
      <div className="ob-card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Logo size="md" word="Thuso" />
            <span
              style={{
                fontSize: 13.5,
                color: 'var(--muted)',
                paddingLeft: 12,
                borderLeft: '1px solid var(--line)',
                fontWeight: 600,
              }}
            >
              Academy Setup &amp; Onboarding
            </span>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {tenant?.onboardingCompleted && (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => router.replace('/')}
              >
                Return to Live Office
              </button>
            )}
            <ThemeToggle className="iconbtn theme-btn" />
          </div>
        </div>

        <div className="ob-steps">
          {[
            { n: 1, label: '1. Academy Profile' },
            { n: 2, label: '2. LMS / Webhooks' },
            { n: 3, label: '3. Channels & SMTP' },
            { n: 4, label: '4. Workflow Offices' },
          ].map((s) => (
            <button
              key={s.n}
              type="button"
              onClick={() => {
                setStep(s.n);
                setCheckMsg(null);
              }}
              className={`ob-step${step === s.n ? ' on' : step > s.n ? ' done' : ''}`}
              style={{ cursor: 'pointer', textAlign: 'left' }}
            >
              <Icon name={step > s.n ? 'ok' : 'chevronRight'} size={15} />
              <span>{s.label}</span>
            </button>
          ))}
        </div>

        {err && (
          <div className="pg-err" style={{ marginBottom: 16 }}>
            <Icon name="warn" size={16} />
            <span>{err}</span>
          </div>
        )}

        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800 }}>
                Welcome{academyName ? `, ${academyName}` : ''}!
              </h2>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.55 }}>
                Configure your academy profile so every personalized study pack, tutor lesson, and
                follow-up sounds like it comes directly from your student success team.
              </p>
            </div>

            <div className="set-grid">
              <label className="field">
                <span>Academy / Organization Name</span>
                <input
                  className="in"
                  value={academyName}
                  onChange={(e) => setAcademyName(e.target.value)}
                  placeholder="e.g. Melsoft Academy"
                />
              </label>

              <label className="field">
                <span>Primary Programmes / Focus</span>
                <input
                  className="in"
                  value={form.academyFocus || ''}
                  onChange={(e) => setForm({ ...form, academyFocus: e.target.value })}
                  placeholder="e.g. Software Engineering & Data"
                />
              </label>

              <label className="field">
                <span>AI Tutor Language</span>
                <select
                  className="in"
                  value={form.tutorLanguage || 'en'}
                  onChange={(e) =>
                    setForm({ ...form, tutorLanguage: e.target.value as TutorLanguage })
                  }
                >
                  <option value="en">English</option>
                  <option value="zu">English + isiZulu summary</option>
                  <option value="st">English + Sesotho summary</option>
                </select>
              </label>
            </div>

            <div className="set-card" style={{ padding: 18 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 14,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <strong style={{ fontSize: 14.5 }}>
                    Start with Human Approval Mode (Recommended)
                  </strong>
                  <p style={{ margin: '4px 0 0', fontSize: 13 }}>
                    Messages sit in Live Office → Approvals until you approve sending. Switch to
                    full automation anytime.
                  </p>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={form.requireApproval !== false}
                    onChange={(e) =>
                      setForm({ ...form, requireApproval: e.target.checked })
                    }
                  />
                  <i />
                  <span>
                    {form.requireApproval !== false ? 'Approval Required' : 'Auto-Send'}
                  </span>
                </label>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => saveStep(undefined, 2)}
              >
                {busy ? 'Saving...' : 'Continue to LMS & Webhooks'}
                <Icon name="arrowRight" size={15} />
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800 }}>
                Connect Your LMS or Signed Webhooks
              </h2>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.55 }}>
                Your workspace runs strictly on real data. Sync directly from Moodle Web Services,
                stream live student events via signed webhooks, or link your attendance Google Sheet.
              </p>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: 12,
              }}
            >
              {[
                {
                  id: 'webhook',
                  title: 'Custom LMS / Webhooks',
                  desc: 'Receive signed HTTP events from any hosted LMS',
                },
                {
                  id: 'moodle',
                  title: 'Moodle Web Services',
                  desc: 'Pull courses, progress, assignments, quizzes & grades',
                },
                {
                  id: 'rest',
                  title: 'Custom LMS REST API',
                  desc: 'Connect your school’s existing REST endpoint',
                },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setForm({
                      ...form,
                      lmsProvider: opt.id as TenantIntegrations['lmsProvider'],
                    });
                    setCheckMsg(null);
                  }}
                  className="set-card"
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    padding: 16,
                    borderColor: form.lmsProvider === opt.id ? 'var(--accent)' : undefined,
                    background: form.lmsProvider === opt.id ? 'var(--wash)' : undefined,
                  }}
                >
                  <strong style={{ fontSize: 14 }}>{opt.title}</strong>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45 }}>
                    {opt.desc}
                  </span>
                </button>
              ))}
            </div>

            {form.lmsProvider === 'moodle' && (
              <div className="set-card" style={{ padding: 18, gap: 14 }}>
                <div className="set-grid">
                  <label className="field">
                    <span>Moodle Site URL</span>
                    <input
                      className="in"
                      type="url"
                      placeholder="https://lms.youracademy.com"
                      value={form.moodleUrl || ''}
                      onChange={(e) => setForm({ ...form, moodleUrl: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Moodle Web Service Token</span>
                    <input
                      className="in"
                      type="password"
                      placeholder="Paste Moodle token"
                      value={form.moodleToken || ''}
                      onChange={(e) => setForm({ ...form, moodleToken: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Course IDs (optional, comma-separated)</span>
                    <input
                      className="in"
                      placeholder="Leave blank to discover all courses"
                      value={form.moodleCourseIds || ''}
                      onChange={(e) => setForm({ ...form, moodleCourseIds: e.target.value })}
                    />
                  </label>
                </div>
                <div className="pg-actions">
                  <button
                    type="button"
                    className="btn btn-outline sm"
                    onClick={() => verifyChannel('moodle')}
                  >
                    Verify Moodle Connection
                  </button>
                </div>
              </div>
            )}

            {form.lmsProvider === 'rest' && (
              <div className="set-card" style={{ padding: 18, gap: 14 }}>
                <div className="set-grid">
                  <label className="field">
                    <span>LMS REST Base URL</span>
                    <input
                      className="in"
                      type="url"
                      placeholder="https://api.yourschool.com/v1"
                      value={form.lmsApiUrl || ''}
                      onChange={(e) => setForm({ ...form, lmsApiUrl: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>API Key / Bearer Token</span>
                    <input
                      className="in"
                      type="password"
                      placeholder="Bearer token"
                      value={form.lmsApiKey || ''}
                      onChange={(e) => setForm({ ...form, lmsApiKey: e.target.value })}
                    />
                  </label>
                </div>
              </div>
            )}

            <div className="set-card" style={{ padding: 18, gap: 10 }}>
              <strong style={{ fontSize: 14 }}>Your Academy&apos;s Signed Webhook Endpoint</strong>
              <p style={{ fontSize: 13 }}>
                Any hosted LMS or custom backend can POST student events here to enroll students
                and trigger coaching workflows automatically:
              </p>
              <div
                style={{
                  fontSize: 12.5,
                  fontFamily: 'ui-monospace, monospace',
                  background: 'var(--surface-sunken)',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                }}
              >
                <div>
                  <strong>POST</strong> {webhookUrl}
                </div>
                {tenant?.webhookSecret && (
                  <div style={{ marginTop: 4 }}>
                    <strong>X-LMS-Signature secret:</strong> {tenant.webhookSecret}
                  </div>
                )}
              </div>
            </div>

            <div className="set-card" style={{ padding: 18, gap: 14 }}>
              <strong style={{ fontSize: 14 }}>
                Google Sheet Attendance / Billing Sync (Optional)
              </strong>
              <div className="set-grid">
                <label className="field">
                  <span>Published Google Sheet CSV URL</span>
                  <input
                    className="in"
                    type="url"
                    placeholder="https://docs.google.com/spreadsheets/d/.../pub?output=csv"
                    value={form.googleSheetUrl || ''}
                    onChange={(e) => setForm({ ...form, googleSheetUrl: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Apps Script Writeback URL (optional)</span>
                  <input
                    className="in"
                    type="url"
                    placeholder="https://script.google.com/macros/s/..."
                    value={form.sheetWritebackUrl || ''}
                    onChange={(e) => setForm({ ...form, sheetWritebackUrl: e.target.value })}
                  />
                </label>
              </div>
              {form.googleSheetUrl && (
                <div>
                  <button
                    type="button"
                    className="btn btn-outline sm"
                    onClick={() => verifyChannel('sheet')}
                  >
                    Verify Google Sheet
                  </button>
                </div>
              )}
            </div>

            {checkMsg && (
              <div className={`pg-banner ${checkOk === false ? 'bad' : 'ok'}`}>
                <Icon name={checkOk === false ? 'warn' : 'ok'} size={15} />
                <span>{checkMsg}</span>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setStep(1)}
              >
                Back
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => saveStep(undefined, 3)}
              >
                {busy ? 'Saving...' : 'Continue to Channels'}
                <Icon name="arrowRight" size={15} />
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800 }}>
                Connect Your Academy&apos;s Outreach Channels
              </h2>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.55 }}>
                Messages send strictly from your academy&apos;s own SMTP server, WhatsApp bridge,
                and/or ManyChat API so students hear directly from {academyName || 'your team'}.
              </p>
            </div>

            <label className="field" style={{ maxWidth: 340 }}>
              <span>Default Outreach Channel</span>
              <select
                className="in"
                value={form.defaultChannel || 'email'}
                onChange={(e) =>
                  setForm({ ...form, defaultChannel: e.target.value as OutreachChannel })
                }
              >
                <option value="email">Academy Email (Own SMTP)</option>
                <option value="whatsapp">WhatsApp Bridge</option>
                <option value="manychat">ManyChat API</option>
                <option value="all">All Connected Channels</option>
              </select>
            </label>

            <div className="set-cards">
              <div className="set-card" style={{ padding: 18, gap: 12 }}>
                <h3>
                  <Icon name="mail" size={16} /> Your Email (Own SMTP)
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                  <label className="field">
                    <span>SMTP Host</span>
                    <input
                      className="in"
                      placeholder="smtp.gmail.com"
                      value={form.smtpHost || ''}
                      onChange={(e) => setForm({ ...form, smtpHost: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Port</span>
                    <input
                      className="in"
                      type="number"
                      placeholder="465"
                      value={form.smtpPort ?? 465}
                      onChange={(e) =>
                        setForm({ ...form, smtpPort: Number(e.target.value) || 465 })
                      }
                    />
                  </label>
                </div>
                <label className="field">
                  <span>SMTP Username / Email</span>
                  <input
                    className="in"
                    placeholder="support@youracademy.com"
                    value={form.smtpUser || ''}
                    onChange={(e) => setForm({ ...form, smtpUser: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>SMTP Password / App Password</span>
                  <input
                    className="in"
                    type="password"
                    placeholder="SMTP password"
                    value={form.smtpPass || ''}
                    onChange={(e) => setForm({ ...form, smtpPass: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Sender Display Name &amp; Address</span>
                  <input
                    className="in"
                    placeholder="Melsoft Student Success <support@melsoft.co.za>"
                    value={form.emailFrom || ''}
                    onChange={(e) => setForm({ ...form, emailFrom: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-outline sm"
                  onClick={() => verifyChannel('smtp')}
                >
                  Verify SMTP
                </button>
              </div>

              <div className="set-card" style={{ padding: 18, gap: 12 }}>
                <h3>
                  <Icon name="chat" size={16} /> WhatsApp &amp; ManyChat API
                </h3>
                <label className="field">
                  <span>WhatsApp Webhook / Bridge URL</span>
                  <input
                    className="in"
                    type="url"
                    placeholder="https://your-whatsapp-bridge.example/send"
                    value={form.whatsappUrl || ''}
                    onChange={(e) => setForm({ ...form, whatsappUrl: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>WhatsApp Bearer Token</span>
                  <input
                    className="in"
                    type="password"
                    placeholder="Optional bearer token"
                    value={form.whatsappToken || ''}
                    onChange={(e) => setForm({ ...form, whatsappToken: e.target.value })}
                  />
                </label>
                <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '2px 0' }} />
                <label className="field">
                  <span>ManyChat API Key</span>
                  <input
                    className="in"
                    type="password"
                    placeholder="Paste ManyChat API key"
                    value={form.manychatApiKey || ''}
                    onChange={(e) => setForm({ ...form, manychatApiKey: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>ManyChat Flow NS (optional)</span>
                  <input
                    className="in"
                    placeholder="Leave blank for direct subscriber text"
                    value={form.manychatFlowNs || ''}
                    onChange={(e) => setForm({ ...form, manychatFlowNs: e.target.value })}
                  />
                </label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {form.whatsappUrl && (
                    <button
                      type="button"
                      className="btn btn-outline sm"
                      onClick={() => verifyChannel('whatsapp')}
                    >
                      Verify WhatsApp
                    </button>
                  )}
                  {form.manychatApiKey && (
                    <button
                      type="button"
                      className="btn btn-outline sm"
                      onClick={() => verifyChannel('manychat')}
                    >
                      Verify ManyChat
                    </button>
                  )}
                </div>
              </div>
            </div>

            {checkMsg && (
              <div className={`pg-banner ${checkOk === false ? 'bad' : 'ok'}`}>
                <Icon name={checkOk === false ? 'warn' : 'ok'} size={15} />
                <span>{checkMsg}</span>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setStep(2)}
              >
                Back
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => saveStep(undefined, 4)}
              >
                {busy ? 'Saving...' : 'Continue to Workflow Offices'}
                <Icon name="arrowRight" size={15} />
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800 }}>
                Activate Your Starter Workflow Offices
              </h2>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.55 }}>
                Just like ManyChat flows, each office watches a real LMS trigger and delivers
                personalized study packs and follow-ups. Toggle which offices should start active:
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {workflows.map((wf) => (
                <div
                  key={wf.id}
                  className="set-card"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 14,
                    padding: 16,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14.5 }}>
                      {wf.officeName}{' '}
                      <span className="badge badge-soft" style={{ marginLeft: 6 }}>
                        {wf.trigger}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>
                      {wf.description}
                    </div>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={wf.enabled}
                      onChange={() => toggleWorkflow(wf)}
                    />
                    <i />
                    <span>{wf.enabled ? 'Active' : 'Off'}</span>
                  </label>
                </div>
              ))}
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                marginTop: 6,
              }}
            >
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setStep(3)}
              >
                Back
              </button>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={busy}
                  onClick={() => finish('/learners')}
                >
                  Sync / Import Students First
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={busy}
                  onClick={() => finish('/workflows')}
                >
                  Open Flow Builder
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() => finish('/')}
                >
                  Enter Live Office <Icon name="arrowRight" size={15} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
