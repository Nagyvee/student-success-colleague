'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Icon from '@/components/Icon';
import Gradebook, { StudentGradebook } from '@/components/Gradebook';
import '../app/pages.css';

interface GradeSummary {
  id: string;
  title: string;
  courseName: string;
  scorePct: number;
  passMark: number;
  passed: boolean;
  feedback: string | null;
  missedQuestions: number;
  takenAt: string;
}

interface CourseSummary {
  id: number;
  code: string;
  name: string;
  progressPct: number | null;
  completedActivities: number;
  totalActivities: number;
}

interface IncompleteActivity {
  name: string;
  type: string;
  course: string;
  dueAt?: string;
}

interface Row {
  id: string;
  name: string;
  email: string;
  phone: string;
  cohort: string;
  programme?: string;
  module?: string | null;
  moduleTitle?: string;
  checkpoint: number | null;
  avgScore?: number | null;
  assessmentsCount?: number;
  recentGrades?: GradeSummary[];
  completionPct?: number;
  completedActivities?: number;
  totalActivities?: number;
  courses?: CourseSummary[];
  incompleteActivities?: IncompleteActivity[];
  daysSinceLogin: number | null;
  neverLoggedIn?: boolean;
  lastActivityAt?: string | null;
  missedClasses?: number;
  missedAssignments?: number;
  paymentStatus?: string;
  riskScore?: number;
  riskBand?: 'on_track' | 'watch' | 'at_risk';
  signals?: string[];
  weakTopic?: string | null;
  status: string;
  lastEvent: string | null;
  groups?: string[];
}

const NO_GROUP = '__none__';

interface Diagnostics {
  coursesFound: number;
  studentsFound: number;
  lastSyncAt: number | null;
  lastSyncedAt?: number | null;
  lastError: string | null;
  warnings: string[];
}

const STATUS: Record<string, { cls: string; label: string }> = {
  on_track: { cls: 'badge-good', label: 'On track' },
  at_risk: { cls: 'badge-bad', label: 'Needs help' },
  intervention: { cls: 'badge-warn', label: 'Outreach active' },
  recovered: { cls: 'badge-good', label: 'Recovered' },
};

let cachedRoster: { rows: Row[]; provider: string; diag: Diagnostics | null } | null = null;

export default function LearnersDirectory() {
  const [rows, setRows] = useState<Row[]>(() => cachedRoster?.rows || []);
  const [provider, setProvider] = useState<string>(() => cachedRoster?.provider || 'webhook');
  const [lmsError, setLmsError] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(() => cachedRoster?.diag || null);
  const [syncing, setSyncing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showCsv, setShowCsv] = useState(false);
  const [csvText, setCsvText] = useState('name,email,phone,cohort,programme,module,checkpoint,daysSinceActivity\n');
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    cohort: '',
    programme: '',
    module: '',
    checkpoint: '',
    days: '0',
  });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<'students' | 'gradebooks'>('students');
  const [groupFilter, setGroupFilter] = useState('');
  const [query, setQuery] = useState('');

  // Groups are the intakes in Moodle; a student can be in none.
  const groups = useMemo(() => [...new Set(rows.flatMap((r) => r.groups || []))].sort(), [rows]);
  const ungrouped = useMemo(() => rows.filter((r) => !(r.groups || []).length).length, [rows]);
  const shown = useMemo(() => {
    const term = query.trim().toLowerCase();
    return rows.filter((r) => {
      const g = r.groups || [];
      if (groupFilter === NO_GROUP && g.length) return false;
      if (groupFilter && groupFilter !== NO_GROUP && !g.includes(groupFilter)) return false;
      return !term || r.name.toLowerCase().includes(term) || r.email.toLowerCase().includes(term);
    });
  }, [rows, groupFilter, query]);

  const load = useCallback(async (forceSync = false) => {
    setSyncing(true);
    try {
      const res = await fetch(forceSync ? '/api/lms/learners?sync=1' : '/api/lms/learners', {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const d = await res.json();
      const nextRows = Array.isArray(d.learners) ? d.learners : [];
      const nextProvider = d.lmsProvider || 'webhook';
      const nextDiag = d.diagnostics || null;
      cachedRoster = { rows: nextRows, provider: nextProvider, diag: nextDiag };
      setRows(nextRows);
      setProvider(nextProvider);
      setLmsError(d.lmsError || null);
      setDiag(nextDiag);
      window.dispatchEvent(new CustomEvent('thuso:refresh-shell'));
      if (forceSync) {
        const qMsg = d.queuedJobs > 0 ? ` · auto-started ${d.queuedJobs} workflow(s) on changes/at-risk cases` : '';
        setNote(
          d.fromCache && d.lmsError
            ? `Moodle is unreachable: showing the ${nextRows.length} student(s) and gradebooks saved at the last sync.`
            : `Synced ${nextRows.length} student(s) with groups, course completion, assignments and full gradebooks${qMsg}.`,
        );
      }
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const enrollOne = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const res = await fetch('/api/lms/learners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          name: form.name,
          email: form.email,
          phone: form.phone,
          cohort: form.cohort || 'Active Cohort',
          programme: form.programme || 'Enrolled Programme',
          module: form.module || undefined,
          checkpoint: form.checkpoint === '' ? null : Number(form.checkpoint),
          daysSinceLogin: form.days === '' ? 0 : Number(form.days),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not add student.');
      setNote(`Enrolled ${form.name}.`);
      setForm({ name: '', email: '', phone: '', cohort: '', programme: '', module: '', checkpoint: '', days: '0' });
      setShowAdd(false);
      await load(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const hasHeader = lines[0]?.toLowerCase().includes('email');
      const dataLines = hasHeader ? lines.slice(1) : lines;
      const parsed = dataLines.map((line) => {
        const cols = line.split(',').map((c) => c.trim());
        return {
          name: cols[0] || '',
          email: cols[1] || '',
          phone: cols[2] || '',
          cohort: cols[3] || 'Active Cohort',
          programme: cols[4] || 'Enrolled Programme',
          module: cols[5] || '',
          checkpoint: cols[6] && !Number.isNaN(Number(cols[6])) ? Number(cols[6]) : null,
          daysSinceLogin: cols[7] && !Number.isNaN(Number(cols[7])) ? Number(cols[7]) : 0,
        };
      });
      const res = await fetch('/api/lms/learners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', rows: parsed }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Import failed.');
      setNote(`Imported ${json.imported} student(s) into your workspace.`);
      setShowCsv(false);
      await load(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeRow = async (r: Row) => {
    if (!confirm(`Remove ${r.name} from this workspace?`)) return;
    await fetch('/api/lms/learners', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', id: r.id }),
    });
    await load(false);
  };

  const coachNow = async (r: Row) => {
    setBusy(true);
    setErr(null);
    try {
      const contextBits = [
        r.weakTopic ? `weak topic: ${r.weakTopic}` : '',
        r.incompleteActivities?.length ? `incomplete: ${r.incompleteActivities[0].name}` : '',
        r.missedAssignments ? `${r.missedAssignments} overdue assignment(s)` : '',
      ]
        .filter(Boolean)
        .join('; ');
      const goal = `Help ${r.name} (${r.cohort}) right now${contextBits ? ` (${contextBits})` : ''} — build a personalized study pack and check-in.`;
      await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'goal', goal, focus: [r.id] }),
      });
      setNote(`Started personalized AI coaching for ${r.name}. Watch progress in Live Office.`);
    } finally {
      setBusy(false);
    }
  };

  const triggerAtRisk = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const res = await fetch('/api/lms/learners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trigger_at_risk', limit: 5 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not queue workflows.');
      setNote(
        json.queued > 0
          ? `Started workflows for ${json.queued} high-priority at-risk learner(s). Watch agents in Live Office.`
          : `No new unsent at-risk learners in queue (${json.eligible ?? 0} total flagged).`,
      );
      window.dispatchEvent(new CustomEvent('thuso:refresh-shell'));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const atRiskCount = rows.filter((r) => r.status === 'at_risk' || (r.riskScore ?? 0) >= 60).length;

  return (
    <main className="pg-main">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {provider === 'moodle' && (
            <div className="lms-views" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={view === 'students'} className={view === 'students' ? 'on' : ''} onClick={() => setView('students')}><Icon name="users" size={13} /> Students</button>
              <button type="button" role="tab" aria-selected={view === 'gradebooks'} className={view === 'gradebooks' ? 'on' : ''} onClick={() => setView('gradebooks')}><Icon name="book" size={13} /> Gradebooks</button>
            </div>
          )}
          <span className="badge badge-soft">Source: {provider.toUpperCase()}</span>
          <span className="badge badge-good">{rows.length} student{rows.length === 1 ? '' : 's'}</span>
          {diag && (
            <span className="badge badge-mute">
              {diag.coursesFound} Moodle course{diag.coursesFound === 1 ? '' : 's'} synced
              {diag.lastSyncedAt || diag.lastSyncAt
                ? ` · ${new Date(diag.lastSyncedAt || diag.lastSyncAt || 0).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}`
                : ''}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {atRiskCount > 0 && (
            <button type="button" className="btn btn-outline btn-sm" disabled={busy || syncing} onClick={() => void triggerAtRisk()}>
              <Icon name="zap" size={14} /> Run Workflows ({atRiskCount} flagged)
            </button>
          )}
          <button type="button" className="btn btn-outline btn-sm" disabled={syncing} onClick={() => void load(true)}>
            <Icon name="refresh" size={14} className={syncing ? 'spin' : undefined} />
            {syncing ? 'Syncing LMS...' : provider === 'moodle' ? 'Sync Moodle Now' : 'Refresh'}
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => { setShowCsv((v) => !v); setShowAdd(false); }}>
            <Icon name="upload" size={14} /> Bulk CSV Import
          </button>
          <button type="button" className="btn btn-cta btn-sm" onClick={() => { setShowAdd((v) => !v); setShowCsv(false); }}>
            <Icon name="plus" size={14} /> Add Student
          </button>
        </div>
      </div>

      {lmsError && (
        <div className="pg-err">
          <Icon name="warn" size={15} />
          <span>LMS sync notice: {lmsError}</span>
        </div>
      )}
      {diag?.warnings?.length ? (
        <div className="pg-banner warn">
          <Icon name="warn" size={15} />
          <span>Moodle note: {diag.warnings[0]}</span>
        </div>
      ) : null}
      {err && <div className="pg-err"><Icon name="warn" size={15} /><span>{err}</span></div>}
      {note && <div className="pg-sent"><Icon name="ok" size={15} /><span>{note}</span></div>}

      {showAdd && (
        <form className="lms-add" onSubmit={enrollOne}>
          <h2><Icon name="user" size={16} /> Enroll Real Student</h2>
          <div className="set-grid">
            <label className="field">
              <span>Full Name *</span>
              <input className="in" placeholder="Thabo Mokoena" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="field">
              <span>Email Address *</span>
              <input className="in" type="email" placeholder="thabo@example.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </label>
            <label className="field">
              <span>WhatsApp / Phone</span>
              <input className="in" placeholder="+27821234567" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </label>
            <label className="field">
              <span>Cohort</span>
              <input className="in" placeholder="FSWD-2026" value={form.cohort} onChange={(e) => setForm({ ...form, cohort: e.target.value })} />
            </label>
            <label className="field">
              <span>Programme</span>
              <input className="in" placeholder="Software Engineering" value={form.programme} onChange={(e) => setForm({ ...form, programme: e.target.value })} />
            </label>
            <label className="field">
              <span>Current Module</span>
              <input className="in" placeholder="REST APIs & Auth" value={form.module} onChange={(e) => setForm({ ...form, module: e.target.value })} />
            </label>
            <label className="field">
              <span>Latest Score %</span>
              <input className="in" type="number" placeholder="72" value={form.checkpoint} onChange={(e) => setForm({ ...form, checkpoint: e.target.value })} />
            </label>
            <label className="field">
              <span>Days Since Last Activity</span>
              <input className="in" type="number" placeholder="0" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
            </label>
          </div>
          <div className="pg-actions">
            <button type="submit" className="btn btn-cta btn-sm" disabled={busy}>Save Student</button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </form>
      )}

      {showCsv && (
        <div className="lms-add">
          <h2><Icon name="sheet" size={16} /> Bulk Import Students (CSV)</h2>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            Paste rows with columns: <code>name, email, phone, cohort, programme, module, checkpoint, daysSinceLogin</code>
          </p>
          <textarea
            rows={6}
            className="in"
            style={{ width: '100%', height: 'auto', minHeight: 130, padding: 12, fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
          <div className="pg-actions">
            <button type="button" className="btn btn-cta btn-sm" disabled={busy} onClick={importCsv}>Import Students</button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowCsv(false)}>Cancel</button>
          </div>
        </div>
      )}

      {view === 'gradebooks' ? (
        <Gradebook onSync={() => void load(true)} syncing={syncing} />
      ) : !rows.length ? (
        <div className="set-card" style={{ padding: 28, alignItems: 'flex-start' }}>
          <h3 style={{ margin: 0 }}><Icon name="users" size={18} /> No students synced yet</h3>
          <p style={{ maxWidth: 660 }}>
            Your workspace uses real academy data only — no demo students are pre-loaded.
            {provider === 'moodle'
              ? ' Click "Sync Moodle Now" above or verify your Moodle courses & Web Service token in Channels & API.'
              : ' Connect your Moodle courses, link a Google Sheet, push signed learner events via your academy webhook, or enroll/import your roster above.'}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {provider === 'moodle' && (
              <button type="button" className="btn btn-cta btn-sm" disabled={syncing} onClick={() => void load(true)}>
                <Icon name="refresh" size={14} /> Sync Moodle Now
              </button>
            )}
            <Link href="/workspace" className="btn btn-outline btn-sm"><Icon name="plug" size={14} /> Check Channels &amp; API</Link>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowAdd(true)}>Add Student Manually</button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowCsv(true)}>Import CSV</button>
          </div>
        </div>
      ) : (
        <>
        {(groups.length > 0 || rows.length > 12) && (
          <div className="lms-filters">
            {groups.length > 0 && (
              <label className="gb-field">
                <span>Group (intake)</span>
                <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
                  <option value="">All groups ({rows.length})</option>
                  {groups.map((g) => <option key={g} value={g}>{g} ({rows.filter((r) => (r.groups || []).includes(g)).length})</option>)}
                  <option value={NO_GROUP}>No group in Moodle ({ungrouped})</option>
                </select>
              </label>
            )}
            <label className="gb-field gb-search">
              <span>Find a student</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or email" />
            </label>
            {groupFilter || query ? <span className="badge badge-mute">Showing {shown.length} of {rows.length}</span> : null}
          </div>
        )}
        {provider === 'moodle' && groups.length > 0 && ungrouped > 0 && (
          <p className="gb-note"><Icon name="warn" size={13} /> {ungrouped} of {rows.length} students are not in any Moodle group (intake). Add them to their intake group in Moodle; the next sync picks it up.</p>
        )}
        <div className="lms-table">
          <div className="lms-row lms-row-wide lms-head">
            <span>Student</span>
            <span>Courses &amp; Progress</span>
            <span>Grades</span>
            <span>Last Activity</span>
            <span>Risk &amp; Status</span>
            <span>Action</span>
          </div>
          {shown.map((r) => {
            const st = STATUS[r.status] || { cls: 'badge-soft', label: r.status };
            const isOpen = expandedId === r.id;
            return (
              <Fragment key={r.id}>
                <div className="lms-row lms-row-wide">
                  <div className="lms-who">
                    <b>{r.name}</b>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {r.email}{r.phone ? ` · ${r.phone}` : ''}
                    </span>
                    {r.lastEvent && <em className="lms-ev">{r.lastEvent}</em>}
                  </div>

                  <div className="lms-mod">
                    <b>{r.cohort}</b>
                    {provider === 'moodle' && (
                      <span className="lms-group">
                        {(r.groups || []).length ? (r.groups || []).map((g) => <span key={g}>{g}</span>) : <span className="none">No group</span>}
                      </span>
                    )}
                    <em>
                      {r.completionPct ?? 0}% complete
                      {r.totalActivities ? ` (${r.completedActivities}/${r.totalActivities} activities)` : ''}
                      {r.missedAssignments ? ` · ${r.missedAssignments} overdue` : ''}
                    </em>
                    {r.weakTopic && (
                      <em style={{ color: 'var(--warn-ink)', fontWeight: 600 }}>Focus: {r.weakTopic}</em>
                    )}
                  </div>

                  <div>
                    <b style={{ fontSize: 14 }}>
                      {r.avgScore !== null && r.avgScore !== undefined
                        ? `${r.avgScore}%`
                        : r.checkpoint !== null
                          ? `${r.checkpoint}%`
                          : 'No grades yet'}
                    </b>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                      {r.assessmentsCount ? `${r.assessmentsCount} graded item${r.assessmentsCount === 1 ? '' : 's'}` : 'Gradebook empty'}
                    </div>
                  </div>

                  <div>
                    <b style={{ fontSize: 13 }}>
                      {r.neverLoggedIn
                        ? 'No activity yet'
                        : r.daysSinceLogin === 0
                          ? 'Active today'
                          : r.daysSinceLogin !== null
                            ? `${r.daysSinceLogin}d ago`
                            : 'Unknown'}
                    </b>
                    {r.lastActivityAt && !r.neverLoggedIn && new Date(r.lastActivityAt).getTime() > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {new Date(r.lastActivityAt).toLocaleDateString('en-ZA')}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                    <span className={`badge ${st.cls}`}>{st.label}</span>
                    {typeof r.riskScore === 'number' && (
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>Risk score: <b>{r.riskScore}/100</b></span>
                    )}
                  </div>

                  <div className="lms-acts">
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => setExpandedId(isOpen ? null : r.id)}
                      title="Inspect full LMS data"
                    >
                      {isOpen ? 'Hide' : 'Inspect'}
                    </button>
                    <button type="button" className="btn btn-cta btn-sm" disabled={busy} onClick={() => coachNow(r)}>
                      Coach
                    </button>
                    {provider !== 'moodle' && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeRow(r)} title="Remove learner">
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                  </div>
                </div>

                {isOpen && (
                  <div className="lms-inspect">
                    <div className="lms-inspect-grid">
                      <div>
                        <h4>Enrolled Courses</h4>
                        {r.courses?.length ? (
                          <ul>
                            {r.courses.map((c) => (
                              <li key={c.id}>
                                <b>{c.code}</b> — {c.name} ({c.progressPct ?? 0}%
                                {c.totalActivities ? ` · ${c.completedActivities}/${c.totalActivities} done` : ''})
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="dim">Programme: {r.programme || r.cohort}</p>
                        )}
                      </div>

                      <div>
                        <h4>AI Risk Signals &amp; Incomplete Work</h4>
                        {r.signals?.length ? (
                          <ul>
                            {r.signals.map((s, i) => <li key={i}>{s}</li>)}
                          </ul>
                        ) : (
                          <p className="dim">No risk alerts flagged yet.</p>
                        )}
                        {r.incompleteActivities?.length ? (
                          <>
                            <h4 style={{ marginTop: 10 }}>Next Incomplete / Due Activities</h4>
                            <ul>
                              {r.incompleteActivities.slice(0, 5).map((act, i) => (
                                <li key={i}>
                                  [{act.course}] <b>{act.name}</b> ({act.type})
                                </li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                      </div>

                      <div>
                        <h4>Gradebook</h4>
                        {provider === 'moodle' ? <StudentGradebook studentId={r.id} /> : r.recentGrades?.length ? (
                          <ul>
                            {r.recentGrades.slice(0, 6).map((g) => (
                              <li key={g.id}>
                                <b>{g.title}</b> ({g.courseName}): <b>{g.scorePct}%</b>{' '}
                                <span className={`badge ${g.passed ? 'badge-good' : 'badge-bad'}`}>
                                  {g.passed ? 'Pass' : `Below ${g.passMark}%`}
                                </span>
                                {g.missedQuestions ? ` · ${g.missedQuestions} wrong Qs captured` : ''}
                                {g.feedback ? <div className="dim" style={{ fontSize: 11.5 }}>Feedback: {g.feedback}</div> : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="dim">No graded quizzes or assignments recorded in Moodle yet.</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
        </>
      )}
    </main>
  );
}
