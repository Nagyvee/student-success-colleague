'use client';

import { useCallback, useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import DataSourcesSection from '../../components/sources/DataSourcesSection';
import WhatsAppCard from '../../components/nurture/WhatsAppCard';
import { ESCALATION_LABEL, ESCALATION_TYPES } from '../../lib/escalation';
import type {
  OutreachChannel,
  TenantIntegrations,
  TenantSummary,
  UserSummary,
} from '../../lib/types';
import '../pages.css';

interface AuthState {
  authenticated: boolean;
  user: UserSummary | null;
  /** inboundToken is only sent to owners and admins. */
  tenant: (TenantSummary & { inboundToken?: string }) | null;
  integrations: TenantIntegrations | null;
  team: UserSummary[];
}

interface TestOutcome {
  ok: boolean;
  detail: string;
  testedAt: number;
}

interface MoodleCourseMeta {
  id: number;
  shortname: string;
  fullname: string;
  groups: { id: number; name: string }[];
}

function emptyIntegrations(): TenantIntegrations {
  return {
    lmsProvider: 'webhook',
    moodleUrl: '',
    moodleToken: '',
    moodleCourseIds: '',
    moodleCourseGroups: {},
    lmsApiUrl: '',
    lmsApiKey: '',
    googleSheetUrl: '',
    sheetWritebackUrl: '',
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPass: '',
    emailFrom: '',
    agentSenderName: '',
    agentSenderTitle: '',
    replyToEmail: '',
    managerEmail: '',
    whatsappUrl: '',
    whatsappToken: '',
    whatsappFrom: '',
    manychatApiKey: '',
    manychatFlowNs: '',
    manychatChannel: 'whatsapp',
    manychatTag: '',
    defaultChannel: 'email',
    tutorLanguage: 'en',
    academyFocus: '',
    requireApproval: true,
    autoRunMode: false,
    liveOutreachEnabled: false,
    testRecipientEmail: '',
    onboardingCompleted: true,
    escalations: {},
    handoff: {},
  };
}

export default function WorkspaceClient() {
  const [data, setData] = useState<AuthState | null>(null);
  const [form, setForm] = useState<TenantIntegrations>(emptyIntegrations);
  const [academyName, setAcademyName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, TestOutcome>>({});
  // The daily report, as it stands now (looked at here before anything goes to the team).
  type ReportView = { title: string; description: string; fields: { name: string; value: string }[] };
  const [report, setReport] = useState<(ReportView & { last?: ReportView | null }) | null>(null);
  async function reportAction(kind: 'report' | 'report-post') {
    setBusy(kind);
    setNotice(null);
    try {
      const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'testConnection', kind, draft: {} }) });
      const j = await res.json();
      if (kind === 'report' && j.report) setReport({ ...j.report, last: j.last });
      setNotice({ kind: j.ok ? 'ok' : 'err', text: j.detail || j.error || (j.ok ? 'Done.' : 'Something went wrong.') });
    } catch {
      setNotice({ kind: 'err', text: 'Network error.' });
    } finally {
      setBusy(null);
    }
  }
  const [origin, setOrigin] = useState('https://your-domain.example');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [moodleCatalog, setMoodleCatalog] = useState<MoodleCourseMeta[] | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  const [memberName, setMemberName] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<'advisor' | 'admin'>('advisor');
  const [memberPassword, setMemberPassword] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location?.origin) {
      setOrigin(window.location.origin);
    }
  }, []);

  const load = useCallback(async () => {
    const res = await fetch('/api/auth', { cache: 'no-store' });
    const j = (await res.json()) as AuthState;
    setData(j);
    if (j.integrations) {
      setForm({ ...emptyIntegrations(), ...j.integrations });
    }
    if (j.tenant) {
      setAcademyName(j.tenant.name);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function updateField<K extends keyof TenantIntegrations>(
    key: K,
    val: TenantIntegrations[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  async function saveIntegrations(
    patch: Partial<TenantIntegrations> & { academyName?: string },
    label: string,
  ) {
    setBusy(label);
    setNotice(null);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'saveIntegrations',
          integrations: patch,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setNotice({ kind: 'err', text: j.error || 'Could not save settings.' });
        return;
      }
      setNotice({ kind: 'ok', text: `${label} saved.` });
      await load();
    } catch {
      setNotice({ kind: 'err', text: 'Network error while saving settings.' });
    } finally {
      setBusy(null);
    }
  }

  async function loadMoodleCatalog() {
    setLoadingCatalog(true);
    setNotice(null);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'discoverMoodle', draft: form }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setNotice({ kind: 'err', text: j.error || 'Could not load courses & groups from Moodle.' });
        return;
      }
      setMoodleCatalog(Array.isArray(j.courses) ? j.courses : []);
      setNotice({ kind: 'ok', text: `Loaded ${(j.courses || []).length} course(s) and their active Moodle groups.` });
    } catch {
      setNotice({ kind: 'err', text: 'Failed to query Moodle courses & groups.' });
    } finally {
      setLoadingCatalog(false);
    }
  }

  const selectedCourseSet = new Set(
    (form.moodleCourseIds || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  );

  function toggleCourse(courseId: number) {
    const next = new Set(selectedCourseSet);
    if (next.has(courseId)) next.delete(courseId);
    else next.add(courseId);
    updateField('moodleCourseIds', [...next].join(', '));
  }

  function toggleGroup(courseId: number, groupId: number | 'all') {
    const prevMap = { ...(form.moodleCourseGroups || {}) };
    const key = String(courseId);
    if (groupId === 'all') {
      delete prevMap[key];
    } else {
      const cur = new Set(prevMap[key] || []);
      if (cur.has(groupId)) cur.delete(groupId);
      else cur.add(groupId);
      if (cur.size === 0) delete prevMap[key];
      else prevMap[key] = [...cur];
    }
    updateField('moodleCourseGroups', prevMap);
  }

  async function runTest(
    kind: 'moodle' | 'sheet' | 'smtp' | 'whatsapp' | 'manychat' | 'postgres' | 'discord' | 'dialer' | 'report',
  ) {
    setBusy(`test-${kind}`);
    setNotice(null);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'testConnection', kind, draft: form }),
      });
      const j = await res.json();
      const detail = j.detail
        || (j.ok && j.database ? `Connected · DB: ${j.database} (${j.tables ?? 0} tables)` : '')
        || (j.ok && typeof j.students === 'number' ? `Connected · ${j.students} learner(s)` : '')
        || (j.ok && typeof j.rows === 'number' ? `Connected · ${j.rows} sheet row(s)` : '')
        || (j.ok ? 'Connected & verified' : '')
        || j.error
        || 'Connection failed';
      setTests((prev) => ({
        ...prev,
        [kind]: {
          ok: Boolean(j.ok),
          detail: String(detail),
          testedAt: Date.now(),
        },
      }));
    } catch {
      setTests((prev) => ({
        ...prev,
        [kind]: { ok: false, detail: 'Connection check failed.', testedAt: Date.now() },
      }));
    } finally {
      setBusy(null);
    }
  }

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    setBusy('add-member');
    setNotice(null);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'addMember',
          name: memberName,
          email: memberEmail,
          role: memberRole,
          password: memberPassword,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setNotice({ kind: 'err', text: j.error || 'Could not add team member.' });
        return;
      }
      setMemberName('');
      setMemberEmail('');
      setMemberPassword('');
      setNotice({ kind: 'ok', text: `Added ${j.member?.email || 'team member'}.` });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(userId: string) {
    setBusy(`rm-${userId}`);
    setNotice(null);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'removeMember', userId }),
      });
      const j = await res.json();
      if (!res.ok) {
        setNotice({ kind: 'err', text: j.error || 'Could not remove member.' });
        return;
      }
      setNotice({ kind: 'ok', text: 'Team member removed.' });
      await load();
    } finally {
      setBusy(null);
    }
  }

  function renderTestStatus(kind: string) {
    const t = tests[kind];
    if (!t) return null;
    return (
      <span className={`test-pill ${t.ok ? 'ok' : 'bad'}`}>
        <Icon name={t.ok ? 'ok' : 'warn'} size={13} />
        {t.detail}
      </span>
    );
  }

  function copyValue(key: string, text: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    }
  }

  const tenant = data?.tenant;
  const isManager = data?.user?.role === 'owner' || data?.user?.role === 'admin';
  const replyHookUrl = `${origin}/api/webhooks/email-reply?tenant=${encodeURIComponent(tenant?.slug || 'default')}${tenant?.inboundToken ? `&token=${tenant.inboundToken}` : ''}`;
  const webhookUrl = `${origin}/api/webhooks/lms?tenant=${encodeURIComponent(
    tenant?.slug || 'melsoft',
  )}`;
  const samplePayload = JSON.stringify(
    {
      event: 'quiz.failed',
      learner_id: 'stu_1042',
      learner_name: 'Thabo Mokoena',
      email: 'thabo@example.com',
      phone: '+27821234567',
      cohort: 'Software Engineering Q2',
      data: {
        checkpoint_score: 44,
        module: 'REST APIs & Auth',
        missed_classes: 1,
        payment_status: 'paid',
        days_since_login: 2,
        missed_questions: ['JWT signature verification', 'HTTP 401 vs 403'],
      },
    },
    null,
    2,
  );

  return (
    <main className="pg-main">
      {notice && (
        <div
          className={`pg-banner ${notice.kind === 'err' ? 'bad' : 'ok'}`}
          role="status"
        >
          <Icon name={notice.kind === 'err' ? 'warn' : 'ok'} size={15} />
          <span>{notice.text}</span>
        </div>
      )}

      {/* Where the agents get their information: sheets, leads from ads, academy knowledge */}
      {data?.authenticated && (
        <DataSourcesSection origin={origin} tenantSlug={tenant?.slug || 'default'} isManager={isManager} />
      )}

      {/* Workspace Summary + Signed Webhook Endpoint */}
      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2>
              <Icon name="webhook" size={16} />{' '}
              {tenant?.name || 'Academy Workspace'} — LMS Webhook &amp; Identity
            </h2>
            <p className="pg-sub">
              Works with Moodle or any custom/hosted LMS. Real learner events pushed to
              this signed endpoint automatically enroll and update student records.
            </p>
          </div>
          {tenant && (
            <span className="pill ok">
              <Icon name="shield" size={12} /> {tenant.slug}
            </span>
          )}
        </div>

        <div className="set-grid">
          <label className="field">
            <span>Academy Name</span>
            <input
              type="text"
              value={academyName}
              onChange={(e) => setAcademyName(e.target.value)}
              placeholder="Melsoft Academy"
            />
          </label>
          <label className="field">
            <span>Webhook Endpoint URL</span>
            <div className="pg-inline-copy">
              <input type="text" readOnly value={webhookUrl} />
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => copyValue('url', webhookUrl)}
              >
                {copiedKey === 'url' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </label>
          <label className="field">
            <span>Signing Secret (X-LMS-Signature)</span>
            <div className="pg-inline-copy">
              <input
                type="text"
                readOnly
                value={tenant?.webhookSecret || 'Loading...'}
              />
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => copyValue('secret', tenant?.webhookSecret || '')}
              >
                {copiedKey === 'secret' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </label>
        </div>

        <details className="pg-details">
          <summary>View Webhook JSON Payload Example (POST)</summary>
          <pre className="pg-code">{samplePayload}</pre>
        </details>
      </section>

      {/* Outreach Safety & Default Channel */}
      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2>
              <Icon name="shield" size={16} /> Outreach Safety &amp; Default Delivery
            </h2>
            <p className="pg-sub">
              Choose whether outreach drafts wait in human approval first, and pick the
              academy&apos;s default channel when a workflow does not override it.
            </p>
          </div>
          <button
            type="button"
            className="btn primary sm"
            disabled={busy === 'Outreach Defaults'}
            onClick={() =>
              saveIntegrations(
                {
                  academyName,
                  requireApproval: form.requireApproval,
                  autoRunMode: form.autoRunMode,
                  liveOutreachEnabled: Boolean(form.liveOutreachEnabled),
                  testRecipientEmail: form.testRecipientEmail || '',
                  agentSenderName: form.agentSenderName,
                  agentSenderTitle: form.agentSenderTitle,
                  replyToEmail: form.replyToEmail,
                  defaultChannel: form.defaultChannel,
                  tutorLanguage: form.tutorLanguage,
                },
                'Outreach Defaults',
              )
            }
          >
            {busy === 'Outreach Defaults' ? 'Saving...' : 'Save Defaults'}
          </button>
        </div>

        <div className="set-grid">
          <label className="field">
            <span>Approval Gate</span>
            <select
              value={form.requireApproval ? 'yes' : 'no'}
              onChange={(e) =>
                updateField('requireApproval', e.target.value === 'yes')
              }
            >
              <option value="yes">
                Start with Human Approval before sending (Recommended)
              </option>
              <option value="no">
                Auto-send verified outreach immediately
              </option>
            </select>
          </label>

          <label className="field">
            <span>Default Outreach Channel</span>
            <select
              value={form.defaultChannel || 'email'}
              onChange={(e) =>
                updateField('defaultChannel', e.target.value as OutreachChannel)
              }
            >
              <option value="email">Academy Email (Own SMTP)</option>
              <option value="whatsapp">WhatsApp Bridge</option>
              <option value="manychat">ManyChat API</option>
              <option value="all">All Connected Channels</option>
            </select>
          </label>

          <label className="field">
            <span>AI Tutor Primary Language</span>
            <select
              value={form.tutorLanguage || 'en'}
              onChange={(e) =>
                updateField(
                  'tutorLanguage',
                  e.target.value as TenantIntegrations['tutorLanguage'],
                )
              }
            >
              <option value="en">English</option>
              <option value="zu">isiZulu</option>
              <option value="st">Sesotho</option>
            </select>
          </label>

          <label className="field">
            <span>Operating Mode (Scan vs Manual Coach)</span>
            <select
              value={form.autoRunMode ? 'auto' : 'manual'}
              onChange={(e) =>
                updateField('autoRunMode', e.target.value === 'auto')
              }
            >
              <option value="manual">
                Manual Review (Sync saves quietly; run when you click Coach)
              </option>
              <option value="auto">
                Full Auto (Auto-trigger &amp; follow-up on LMS/Sheet changes)
              </option>
            </select>
          </label>

          <label className="field">
            <span>Outgoing Agent Name (Emails &amp; Sign-off)</span>
            <input
              type="text"
              value={form.agentSenderName || ''}
              onChange={(e) => updateField('agentSenderName', e.target.value)}
              placeholder="e.g. Sarah Khumalo or Student Success Team"
            />
          </label>

          <label className="field">
            <span>Outgoing Agent Role / Title</span>
            <input
              type="text"
              value={form.agentSenderTitle || ''}
              onChange={(e) => updateField('agentSenderTitle', e.target.value)}
              placeholder="e.g. Student Success Advisor"
            />
          </label>

          <label className="field">
            <span>Reply-To Email (Student Replies Destination)</span>
            <input
              type="email"
              value={form.replyToEmail || ''}
              onChange={(e) => updateField('replyToEmail', e.target.value)}
              placeholder="replies@melsoftacademy.com"
            />
          </label>

          <label className="field">
            <span>Outreach Delivery Mode (Test vs Live)</span>
            <select
              value={form.liveOutreachEnabled ? 'live' : 'test'}
              onChange={(e) =>
                updateField('liveOutreachEnabled', e.target.value === 'live')
              }
            >
              <option value="test">
                Safe Test Mode — In-app Inbox preview only (No live emails/calls)
              </option>
              <option value="live">
                Live Outreach — Real SMTP emails, WhatsApp, ManyChat &amp; AI calls
              </option>
            </select>
          </label>

          <label className="field">
            <span>Test Redirect Inbox (Optional when Live)</span>
            <input
              type="email"
              value={form.testRecipientEmail || ''}
              onChange={(e) => updateField('testRecipientEmail', e.target.value)}
              placeholder="If set, all outbound emails go only here instead of real learners"
            />
          </label>
        </div>
      </section>

      {/* Connections Grid */}
      <div className="set-cards">
        {/* 1. LMS Source */}
        <section className="pg-card">
          <div className="pg-card-h">
            <div>
              <h2>
                <Icon name="plug" size={16} /> 1. LMS Source
              </h2>
              <p className="pg-sub">
                Connect Moodle directly, point to any custom LMS REST API, or receive
                real-time signed webhooks from a hosted LMS.
              </p>
            </div>
            {renderTestStatus('moodle')}
          </div>

          <div className="set-grid">
            <label className="field">
              <span>LMS Integration Mode</span>
              <select
                value={form.lmsProvider}
                onChange={(e) =>
                  updateField(
                    'lmsProvider',
                    e.target.value as TenantIntegrations['lmsProvider'],
                  )
                }
              >
                <option value="webhook">Custom / Hosted LMS via Webhooks</option>
                <option value="moodle">Moodle Web Services REST API</option>
                <option value="rest">Custom LMS REST Endpoint</option>
                <option value="sandbox">Local Sandbox (Testing Only)</option>
              </select>
            </label>

            {form.lmsProvider === 'moodle' && (
              <>
                <label className="field">
                  <span>Moodle Site URL</span>
                  <input
                    type="url"
                    value={form.moodleUrl}
                    onChange={(e) => updateField('moodleUrl', e.target.value)}
                    placeholder="https://lms.youracademy.com"
                  />
                </label>
                <label className="field">
                  <span>Moodle Web Service Token</span>
                  <input
                    type="password"
                    value={form.moodleToken}
                    onChange={(e) => updateField('moodleToken', e.target.value)}
                    placeholder="Paste Moodle token"
                  />
                </label>
                <label className="field">
                  <span>Course IDs (comma-separated, or select below)</span>
                  <input
                    type="text"
                    value={form.moodleCourseIds}
                    onChange={(e) => updateField('moodleCourseIds', e.target.value)}
                    placeholder="2, 5, 11"
                  />
                </label>
                <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                      Course &amp; Group Filter (Track active cohorts only — skip old alumni)
                    </span>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={loadingCatalog}
                      onClick={() => void loadMoodleCatalog()}
                    >
                      {loadingCatalog ? 'Loading Courses & Groups...' : 'Load Courses & Groups from Moodle'}
                    </button>
                  </div>
                  {moodleCatalog && moodleCatalog.length > 0 && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                        gap: 10,
                        padding: 12,
                        borderRadius: 12,
                        background: 'var(--surface)',
                        border: '1px solid var(--line)',
                        maxHeight: 280,
                        overflowY: 'auto',
                      }}
                    >
                      {moodleCatalog.map((c) => {
                        const checked = selectedCourseSet.has(c.id);
                        const activeGroups = form.moodleCourseGroups?.[String(c.id)] || [];
                        return (
                          <div
                            key={c.id}
                            style={{
                              padding: '10px 12px',
                              borderRadius: 10,
                              border: checked ? '1.5px solid #2563eb' : '1px solid var(--line)',
                              background: '#ffffff',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 6,
                              fontSize: 12,
                            }}
                          >
                            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontWeight: 700 }}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleCourse(c.id)}
                                style={{ marginTop: 2 }}
                              />
                              <span>
                                {c.shortname} · {c.fullname}{' '}
                                <span style={{ color: 'var(--muted)', fontWeight: 500 }}>(ID {c.id})</span>
                              </span>
                            </label>
                            {checked && (
                              <div style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>
                                  Moodle Groups to track:
                                </span>
                                {c.groups.length === 0 ? (
                                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                                    No Moodle groups defined — syncing all enrolled learners in course.
                                  </span>
                                ) : (
                                  <>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11.5 }}>
                                      <input
                                        type="checkbox"
                                        checked={activeGroups.length === 0}
                                        onChange={() => toggleGroup(c.id, 'all')}
                                      />
                                      <span>All groups</span>
                                    </label>
                                    {c.groups.map((grp) => (
                                      <label
                                        key={grp.id}
                                        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11.5 }}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={activeGroups.includes(grp.id)}
                                          onChange={() => toggleGroup(c.id, grp.id)}
                                        />
                                        <span>{grp.name}</span>
                                      </label>
                                    ))}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}

            {form.lmsProvider === 'rest' && (
              <>
                <label className="field">
                  <span>LMS Roster API URL</span>
                  <input
                    type="url"
                    value={form.lmsApiUrl}
                    onChange={(e) => updateField('lmsApiUrl', e.target.value)}
                    placeholder="https://api.yourlms.com/v1/learners"
                  />
                </label>
                <label className="field">
                  <span>Bearer API Key</span>
                  <input
                    type="password"
                    value={form.lmsApiKey}
                    onChange={(e) => updateField('lmsApiKey', e.target.value)}
                    placeholder="sk_live_..."
                  />
                </label>
              </>
            )}
          </div>

          <div className="pg-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy === 'LMS Connection'}
              onClick={() =>
                saveIntegrations(
                  {
                    academyName,
                    lmsProvider: form.lmsProvider,
                    moodleUrl: form.moodleUrl,
                    moodleToken: form.moodleToken,
                    moodleCourseIds: form.moodleCourseIds,
                    moodleCourseGroups: form.moodleCourseGroups,
                    lmsApiUrl: form.lmsApiUrl,
                    lmsApiKey: form.lmsApiKey,
                  },
                  'LMS Connection',
                )
              }
            >
              Save LMS
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy === 'test-moodle'}
              onClick={() => runTest('moodle')}
            >
              {busy === 'test-moodle' ? 'Checking...' : 'Verify LMS'}
            </button>
          </div>
        </section>

        {/* 2. Google Sheet */}
        <section className="pg-card">
          <div className="pg-card-h">
            <div>
              <h2>
                <Icon name="flow" size={16} /> 2. Learner Record Sheet &amp; Sheet Write-back
              </h2>
              <p className="pg-sub">
                The classic learner roster sheet (scores, logins, attendance) used by the tutoring team.
                The tracker, fees and leads sheets the department agents read are under{' '}
                <a href="#data-sources">Data sources</a> above. The write-back URL (an Apps Script web app)
                is also used when an agent updates a record, so statuses flow back into your sheets.
              </p>
            </div>
            {renderTestStatus('sheet')}
          </div>

          <div className="set-grid">
            <label className="field">
              <span>Google Sheet URL (Published CSV or Sheet link)</span>
              <input
                type="url"
                value={form.googleSheetUrl}
                onChange={(e) => updateField('googleSheetUrl', e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/..."
              />
            </label>
            <label className="field">
              <span>Writeback Webhook URL (Optional)</span>
              <input
                type="url"
                value={form.sheetWritebackUrl}
                onChange={(e) => updateField('sheetWritebackUrl', e.target.value)}
                placeholder="https://script.google.com/macros/s/..."
              />
            </label>
          </div>

          <div className="pg-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy === 'Google Sheet'}
              onClick={() =>
                saveIntegrations(
                  {
                    googleSheetUrl: form.googleSheetUrl,
                    sheetWritebackUrl: form.sheetWritebackUrl,
                  },
                  'Google Sheet',
                )
              }
            >
              Save Sheet
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy === 'test-sheet'}
              onClick={() => runTest('sheet')}
            >
              {busy === 'test-sheet' ? 'Checking...' : 'Verify Sheet'}
            </button>
          </div>
        </section>

        {/* 3. Own Email SMTP */}
        <section className="pg-card">
          <div className="pg-card-h">
            <div>
              <h2>
                <Icon name="mail" size={16} /> 3. Academy Email (Own SMTP)
              </h2>
              <p className="pg-sub">
                Emails go out exclusively through your academy&apos;s own SMTP server
                and sender name so students hear directly from your team.
              </p>
            </div>
            {renderTestStatus('smtp')}
          </div>

          <div className="set-grid">
            <label className="field">
              <span>SMTP Host</span>
              <input
                type="text"
                value={form.smtpHost}
                onChange={(e) => updateField('smtpHost', e.target.value)}
                placeholder="smtp.gmail.com or mail.yourdomain.com"
              />
            </label>
            <label className="field">
              <span>SMTP Port</span>
              <input
                type="number"
                value={form.smtpPort}
                onChange={(e) =>
                  updateField('smtpPort', Number(e.target.value) || 587)
                }
                placeholder="587"
              />
            </label>
            <label className="field">
              <span>SMTP Username</span>
              <input
                type="text"
                value={form.smtpUser}
                onChange={(e) => updateField('smtpUser', e.target.value)}
                placeholder="support@melsoftacademy.com"
              />
            </label>
            <label className="field">
              <span>SMTP Password / App Password</span>
              <input
                type="password"
                value={form.smtpPass}
                onChange={(e) => updateField('smtpPass', e.target.value)}
                placeholder="App password or SMTP secret"
              />
            </label>
            <label className="field">
              <span>Sender Display Name &amp; Email (From)</span>
              <input
                type="text"
                value={form.emailFrom}
                onChange={(e) => updateField('emailFrom', e.target.value)}
                placeholder="Melsoft Student Success <support@melsoftacademy.com>"
              />
            </label>
            <label className="field">
              <span>Academy Manager Escalation Email (gets anything not routed below)</span>
              <input
                type="email"
                value={form.managerEmail}
                onChange={(e) => updateField('managerEmail', e.target.value)}
                placeholder="dean@melsoftacademy.com"
              />
            </label>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <span>Escalations: who hears about what (one or more emails, comma-separated; empty goes to the manager)</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10, marginTop: 4 }}>
                {ESCALATION_TYPES.map((k) => (
                  <label key={k} className="field" style={{ margin: 0 }}>
                    <span style={{ fontWeight: 700 }}>{ESCALATION_LABEL[k].title}</span>
                    <input
                      type="text"
                      value={form.escalations?.[k] || ''}
                      onChange={(e) => updateField('escalations', { ...(form.escalations || {}), [k]: e.target.value })}
                      placeholder={form.managerEmail ? `${form.managerEmail} (manager)` : 'name@melsoftacademy.com'}
                    />
                    <small style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>{ESCALATION_LABEL[k].who}</small>
                  </label>
                ))}
              </div>
            </div>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span>
                Inbound Student Email Reply Webhook (Forward / Mailgun / Postmark / Resend)
                {!tenant?.inboundToken && ' · only owners and admins see the token it needs'}
              </span>
              <div className="pg-inline-copy">
                <input type="text" readOnly value={replyHookUrl} />
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => copyValue('reply-hook', replyHookUrl)}
                >
                  {copiedKey === 'reply-hook' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </label>
          </div>

          <div className="pg-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy === 'Email SMTP'}
              onClick={() =>
                saveIntegrations(
                  {
                    smtpHost: form.smtpHost,
                    smtpPort: form.smtpPort,
                    smtpUser: form.smtpUser,
                    smtpPass: form.smtpPass,
                    emailFrom: form.emailFrom,
                    managerEmail: form.managerEmail,
                    escalations: form.escalations || {},
                  },
                  'Email SMTP',
                )
              }
            >
              Save SMTP
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy === 'test-smtp'}
              onClick={() => runTest('smtp')}
            >
              {busy === 'test-smtp' ? 'Sending...' : 'Verify SMTP'}
            </button>
          </div>
        </section>

        {/* Qualified leads → the sales team */}
        <section className="pg-card">
          <div className="pg-card-h">
            <div>
              <h2>
                <Icon name="phone" size={16} /> Qualified leads: Discord and the dialer
              </h2>
              <p className="pg-sub">
                When a lead says yes (taps &ldquo;Yes, I want to enrol&rdquo; or &ldquo;Call me&rdquo;, or replies that they want to sign up) or reaches 8 points,
                Thuso posts a &ldquo;call now&rdquo; card in your Discord channel and adds them to the dialer as a new lead, with a brief in the notes:
                where they came from, what they want, how they would pay and what they did. Every weekday at 17:00 the Admissions report
                (what happened since the last one) posts in the same channel.
              </p>
            </div>
            {renderTestStatus('discord')}
            {renderTestStatus('dialer')}

          </div>
          <div className="pg-grid">
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span>Discord webhook (Server settings → Integrations → Webhooks → New webhook → Copy webhook URL)</span>
              <input
                type="password"
                value={form.handoff?.discordWebhook || ''}
                onChange={(e) => updateField('handoff', { ...(form.handoff || {}), discordWebhook: e.target.value })}
                placeholder="https://discord.com/api/webhooks/…"
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>Dialer address</span>
              <input
                type="url"
                value={form.handoff?.dialerUrl || ''}
                onChange={(e) => updateField('handoff', { ...(form.handoff || {}), dialerUrl: e.target.value })}
                placeholder="https://dialer.melsoft.org"
              />
            </label>
            <label className="field">
              <span>Dialer API key (scope: create leads)</span>
              <input
                type="password"
                value={form.handoff?.dialerKey || ''}
                onChange={(e) => updateField('handoff', { ...(form.handoff || {}), dialerKey: e.target.value })}
                placeholder="zad_…"
                autoComplete="off"
              />
            </label>
            <label className="switch" style={{ gridColumn: '1 / -1', alignItems: 'flex-start', lineHeight: 1.45 }}>
              <input
                type="checkbox"
                checked={Boolean(form.handoff?.dialerOn)}
                onChange={(e) => updateField('handoff', { ...(form.handoff || {}), dialerOn: e.target.checked })}
              />
              <i />
              <span style={{ display: 'block' }}>
                <b style={{ color: 'var(--ink)' }}>Send qualified leads to the dialer</b><br />
                The dialer calls them, so this also waits for Live Outreach. Discord only reaches your team.
              </span>
            </label>
            <label className="switch" style={{ gridColumn: '1 / -1', alignItems: 'flex-start', lineHeight: 1.45 }}>
              <input
                type="checkbox"
                checked={form.handoff?.reportOn !== false}
                onChange={(e) => updateField('handoff', { ...(form.handoff || {}), reportOn: e.target.checked })}
              />
              <i />
              <span style={{ display: 'block' }}>
                <b style={{ color: 'var(--ink)' }}>Post the daily report in Discord</b><br />
                Every weekday at 17:00 (not on weekends): what happened since the last report. On unless you switch it off here.
              </span>
            </label>
          </div>
          <div className="pg-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy === 'Qualified leads'}
              onClick={() => saveIntegrations({ handoff: form.handoff || {} }, 'Qualified leads')}
            >
              Save
            </button>
            <button type="button" className="btn ghost sm" disabled={busy === 'test-discord'} onClick={() => runTest('discord')}>
              {busy === 'test-discord' ? 'Posting…' : 'Send a test to Discord'}
            </button>
            <button type="button" className="btn ghost sm" disabled={busy === 'test-dialer'} onClick={() => runTest('dialer')}>
              {busy === 'test-dialer' ? 'Checking…' : 'Check the dialer'}
            </button>
            <button type="button" className="btn ghost sm" disabled={busy === 'report'} onClick={() => void reportAction('report')} title="What the Admissions report says so far (nothing is posted)">
              {busy === 'report' ? 'Reading…' : 'Preview the daily report'}
            </button>
          </div>
        </section>

        {report && (
          <section className="pg-card" aria-label="Daily report preview">
            <div className="pg-card-h">
              <div>
                <h2><Icon name="chart" size={16} /> {report.title}</h2>
                <p className="pg-sub">{report.description} This preview was not posted anywhere.</p>
              </div>
            </div>
            {[report, ...(report.last ? [report.last] : [])].map((part, i) => (
              <div key={part.title}>
                {i > 0 && <p className="pg-sub" style={{ margin: '16px 0 8px' }}><b style={{ color: 'var(--ink)' }}>{part.title}.</b> {part.description} Only here, never posted.</p>}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                  {part.fields.map((f) => (
                    <div key={f.name} style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface-sunken)' }}>
                      <b style={{ fontSize: 12.5 }}>{f.name}</b>
                      <div style={{ fontSize: 13, whiteSpace: 'pre-line', marginTop: 4 }}>{f.value.replace(/\*\*/g, '')}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="pg-actions">
              <button type="button" className="btn primary sm" disabled={busy === 'report-post'} onClick={() => { if (window.confirm('Post this report in the Discord channel now? Everyone in the channel sees it.')) void reportAction('report-post'); }}>
                {busy === 'report-post' ? 'Posting…' : 'Post it in Discord now'}
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setReport(null)}>Close</button>
            </div>
          </section>
        )}

        {/* 4. WhatsApp Bridge */}
        <section className="pg-card">
          <div className="pg-card-h">
            <div>
              <h2>
                <Icon name="chat" size={16} /> 4. WhatsApp Bridge / Webhook
              </h2>
              <p className="pg-sub">
                Connect your academy&apos;s own WhatsApp Business webhook, Cloud API
                relay, or Twilio WhatsApp bridge.
              </p>
            </div>
            {renderTestStatus('whatsapp')}
          </div>

          <div className="set-grid">
            <label className="field">
              <span>WhatsApp Webhook / API URL</span>
              <input
                type="url"
                value={form.whatsappUrl}
                onChange={(e) => updateField('whatsappUrl', e.target.value)}
                placeholder="https://your-whatsapp-bridge.example/send"
              />
            </label>
            <label className="field">
              <span>Bearer Token</span>
              <input
                type="password"
                value={form.whatsappToken}
                onChange={(e) => updateField('whatsappToken', e.target.value)}
                placeholder="Optional Bearer token"
              />
            </label>
            <label className="field">
              <span>Sender Phone Number</span>
              <input
                type="text"
                value={form.whatsappFrom}
                onChange={(e) => updateField('whatsappFrom', e.target.value)}
                placeholder="+27820001111"
              />
            </label>
          </div>

          <div className="pg-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy === 'WhatsApp'}
              onClick={() =>
                saveIntegrations(
                  {
                    whatsappUrl: form.whatsappUrl,
                    whatsappToken: form.whatsappToken,
                    whatsappFrom: form.whatsappFrom,
                  },
                  'WhatsApp',
                )
              }
            >
              Save WhatsApp
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy === 'test-whatsapp'}
              onClick={() => runTest('whatsapp')}
            >
              {busy === 'test-whatsapp' ? 'Checking...' : 'Verify WhatsApp'}
            </button>
          </div>
        </section>

        {/* 5. ManyChat API */}
        <section className="pg-card">
          <div className="pg-card-h">
            <div>
              <h2>
                <Icon name="chat" size={16} /> 5. ManyChat Automation API
              </h2>
              <p className="pg-sub">
                Connect your academy&apos;s ManyChat API key to send personalized
                WhatsApp, Instagram, Messenger, or SMS tutor messages via ManyChat.
              </p>
            </div>
            {renderTestStatus('manychat')}
          </div>

          <div className="set-grid">
            <label className="field">
              <span>ManyChat API Key</span>
              <input
                type="password"
                value={form.manychatApiKey}
                onChange={(e) => updateField('manychatApiKey', e.target.value)}
                placeholder="Paste ManyChat API key"
              />
            </label>
            <label className="field">
              <span>Default ManyChat Channel</span>
              <select
                value={form.manychatChannel || 'whatsapp'}
                onChange={(e) =>
                  updateField(
                    'manychatChannel',
                    e.target.value as TenantIntegrations['manychatChannel'],
                  )
                }
              >
                <option value="whatsapp">WhatsApp</option>
                <option value="messenger">Messenger</option>
                <option value="instagram">Instagram DM</option>
                <option value="sms">SMS</option>
              </select>
            </label>
            <label className="field">
              <span>Default Flow NS (Optional)</span>
              <input
                type="text"
                value={form.manychatFlowNs || ''}
                onChange={(e) => updateField('manychatFlowNs', e.target.value)}
                placeholder="content20240101000000_123456"
              />
            </label>
            <label className="field">
              <span>Subscriber Tag Name (Optional)</span>
              <input
                type="text"
                value={form.manychatTag || ''}
                onChange={(e) => updateField('manychatTag', e.target.value)}
                placeholder="thuso-tutor-outreach"
              />
            </label>
          </div>

          <div className="pg-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy === 'ManyChat'}
              onClick={() =>
                saveIntegrations(
                  {
                    manychatApiKey: form.manychatApiKey,
                    manychatChannel: form.manychatChannel,
                    manychatFlowNs: form.manychatFlowNs,
                    manychatTag: form.manychatTag,
                  },
                  'ManyChat',
                )
              }
            >
              Save ManyChat
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy === 'test-manychat'}
              onClick={() => runTest('manychat')}
            >
              {busy === 'test-manychat' ? 'Checking...' : 'Verify ManyChat'}
            </button>
          </div>
        </section>

        <WhatsAppCard
          value={form.whatsappFollowups || {}}
          saved={data?.integrations?.whatsappFollowups || {}}
          onChange={(whatsappFollowups) => updateField('whatsappFollowups', whatsappFollowups)}
          onSave={() => saveIntegrations({ whatsappFollowups: form.whatsappFollowups || {} }, 'WhatsApp follow-ups')}
          saving={busy === 'WhatsApp follow-ups'}
          replyUrl={`${origin}/api/webhooks/whatsapp-reply?tenant=${encodeURIComponent(tenant?.slug || 'default')}`}
          replyKey={tenant?.inboundToken || ''}
        />

        {/* 6. PostgreSQL */}
        <section className="pg-card">
          <div className="pg-card-h">
            <div>
              <h2>
                <Icon name="database" size={16} /> 6. PostgreSQL Long-Term Memory
              </h2>
              <p className="pg-sub">
                Verifies the multi-tenant <code>student-success</code> schema and
                read/write latency for persistent tenants, workflows, and outreach logs.
              </p>
            </div>
            {renderTestStatus('postgres')}
          </div>

          <div className="pg-actions">
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy === 'test-postgres'}
              onClick={() => runTest('postgres')}
            >
              {busy === 'test-postgres'
                ? 'Checking...'
                : 'Verify & Migrate PostgreSQL'}
            </button>
          </div>
        </section>
      </div>

      {/* Team Members */}
      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2>
              <Icon name="users" size={16} /> Academy Team Members
            </h2>
            <p className="pg-sub">
              Invite advisors or co-admins into {tenant?.name || 'this workspace'}.
            </p>
          </div>
        </div>

        <div className="team-list">
          {(data?.team || []).map((member) => (
            <div key={member.id} className="team-row">
              <div>
                <strong>{member.name}</strong>
                <span className="pg-sub">
                  {' '}
                  · {member.email} · <span className="pill">{member.role}</span>
                </span>
              </div>
              {member.role !== 'owner' && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy === `rm-${member.id}`}
                  onClick={() => removeMember(member.id)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>

        <form className="set-grid" onSubmit={addMember} style={{ marginTop: 14 }}>
          <label className="field">
            <span>Full Name</span>
            <input
              type="text"
              required
              value={memberName}
              onChange={(e) => setMemberName(e.target.value)}
              placeholder="Sipho Ndlovu"
            />
          </label>
          <label className="field">
            <span>Work Email</span>
            <input
              type="email"
              required
              value={memberEmail}
              onChange={(e) => setMemberEmail(e.target.value)}
              placeholder="sipho@melsoftacademy.com"
            />
          </label>
          <label className="field">
            <span>Role</span>
            <select
              value={memberRole}
              onChange={(e) =>
                setMemberRole(e.target.value === 'admin' ? 'admin' : 'advisor')
              }
            >
              <option value="advisor">Advisor (Approve &amp; Review)</option>
              <option value="admin">Admin (Manage Channels &amp; Team)</option>
            </select>
          </label>
          <label className="field">
            <span>Temporary Password</span>
            <input
              type="password"
              required
              minLength={6}
              value={memberPassword}
              onChange={(e) => setMemberPassword(e.target.value)}
              placeholder="Minimum 6 characters"
            />
          </label>
          <div className="pg-actions" style={{ gridColumn: '1 / -1' }}>
            <button
              type="submit"
              className="btn primary sm"
              disabled={busy === 'add-member'}
            >
              {busy === 'add-member' ? 'Adding...' : 'Add Team Member'}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
