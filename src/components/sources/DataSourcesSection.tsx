'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DataSource, DataSourceKind, RecordField } from '@/lib/types';
import Icon, { type IconName } from '@/components/Icon';
import { KIND_LABEL, agoLabel, postDepartments, sortedFloors, useBuildingData, type BuildingData } from '@/components/office/buildingData';
import '@/app/sources.css';

/* Channels & API, top section: where the agents get their information.
 *
 * 1. Data sources: the student tracker (students, fees, invoices), other
 *    sheet tabs, the leads list and B2B prospects. Paste a Google Sheet link,
 *    check the columns were understood, save, and the agents read it every
 *    half minute.
 * 2. Leads from ads: the webhook Zapier, Make, Meta lead forms or a website
 *    form posts new leads to; the Admissions agents start on them.
 * 3. What the agents know: programmes, fees, intakes, policies, the
 *    application link. Every agent reads this before it writes. */

const LEADS_ID = 'src_leads';
const MOODLE_ID = 'src_moodle';
const BUILT_IN = new Set([LEADS_ID, MOODLE_ID, 'src_tracker', 'src_prospects']);
const ALL_FIELDS: RecordField[] = [
  'id', 'name', 'first_name', 'last_name', 'email', 'phone', 'status', 'programme', 'cohort', 'company', 'source', 'interest', 'notes', 'owner',
  'amount_due', 'amount_paid', 'total_fee', 'due_date', 'invoice_number', 'payment_status', 'last_payment_date',
];
const KIND_ICON: Record<DataSourceKind, IconName> = { students: 'graduation', finance: 'wallet', leads: 'inbox', prospects: 'briefcase', custom: 'sheet' };
const KINDS: DataSourceKind[] = ['finance', 'students', 'leads', 'prospects', 'custom'];

interface Props {
  origin: string;
  tenantSlug: string;
  isManager: boolean;
}

interface TestResult { headers: string[]; sample: string[][]; rows: number; mapping: Partial<Record<RecordField, string>> }

interface RecordRow { key: string; sourceId: string; name: string; email: string; phone: string; fields: Record<string, string>; updatedAt: number }

function copy(text: string, done: () => void) {
  try {
    void navigator.clipboard.writeText(text).then(done, () => { /* ignore */ });
  } catch { /* clipboard unavailable */ }
}

export default function DataSourcesSection({ origin, tenantSlug, isManager }: Props) {
  const { data, refresh } = useBuildingData(20_000);
  const [editing, setEditing] = useState<DataSource | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  const sources = useMemo(() => {
    const list = data?.sources || [];
    // The student tracker first, then the other sheets, the leads list last.
    const rank = (s: DataSource) => (s.id === 'src_tracker' ? 0 : s.id === MOODLE_ID ? 0.5 : s.id === LEADS_ID ? 3 : s.id === 'src_prospects' ? 2 : 1);
    return [...list].sort((a, b) => rank(a) - rank(b));
  }, [data]);
  const departments = useMemo(() => sortedFloors(data?.departments || []), [data]);
  const deptName = (id?: string) => departments.find((d) => d.id === id)?.name;
  const viewingSource = sources.find((s) => s.id === viewing) || null;

  async function act(label: string, body: Record<string, unknown>, ok: string) {
    setBusy(label);
    setNotice(null);
    try {
      const j = await postDepartments<{ changes?: number; source?: DataSource }>(body);
      if (j.error || j.ok === false) setNotice({ kind: 'bad', text: j.error || 'That did not work.' });
      else setNotice({ kind: 'ok', text: typeof j.changes === 'number' ? `${ok} ${j.changes} change${j.changes === 1 ? '' : 's'} found.` : ok });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <section className="pg-card src-section" id="data-sources">
        <div className="pg-card-h">
          <div>
            <h2><Icon name="sheet" size={16} /> Data sources: what the agents read</h2>
            <p className="pg-sub">
              Your student tracker (students, fees, invoices), any other sheet tab, B2B prospects, and leads from ads.
              The agents read these every half minute and act on what changes: a payment coming due, a new lead, a status update.
            </p>
          </div>
          {data && <span className="pill ok"><Icon name="database" size={12} /> {sources.length} source{sources.length === 1 ? '' : 's'}</span>}
        </div>

        <div className="src-intro">
          <Icon name="idea" size={16} />
          <div>
            <b>Connecting a Google Sheet takes a minute.</b>
            <ol>
              <li>In Google Sheets, click <b>Share</b> and set <b>General access → Anyone with the link: Viewer</b>.</li>
              <li>Open the tab you want (each tab has its own link: the <code>#gid=</code> part at the end picks the tab), and copy the address bar.</li>
              <li>Paste it below, check that the columns were matched correctly, and save. Existing rows become the starting point: nobody is messaged just because a sheet was connected.</li>
            </ol>
          </div>
        </div>

        {notice && <div className={`src-note ${notice.kind}`}><Icon name={notice.kind === 'ok' ? 'ok' : 'warn'} size={14} /><span>{notice.text}</span></div>}

        {!data ? (
          <p className="src-help">Loading data sources…</p>
        ) : (
          <div className="src-grid">
            {sources.map((s) => {
              const isLeads = s.id === LEADS_ID;
              const isMoodle = s.id === MOODLE_ID;
              const connected = isLeads || Boolean(s.url) || (isMoodle && (s.rows ?? 0) > 0);
              const state = s.lastError ? 'bad' : connected ? 'ok' : 'off';
              return (
                <article key={s.id} className={`src-card k-${s.kind}${state === 'off' ? ' is-off' : ''}${state === 'bad' ? ' is-bad' : ''}${viewing === s.id || (editing !== 'new' && editing?.id === s.id) ? ' is-sel' : ''}`}>
                  <div className="src-card-h">
                    <span className="src-ic"><Icon name={KIND_ICON[s.kind] || 'sheet'} size={18} /></span>
                    <div className="src-title">
                      <b>{s.name}</b>
                      <span>{KIND_LABEL[s.kind]}{deptName(s.departmentId) ? ` · ${deptName(s.departmentId)}` : ''}</span>
                    </div>
                    <span className={`src-state ${state}`}>{state === 'ok' ? (isLeads ? 'Webhook' : isMoodle ? 'Moodle' : 'Connected') : state === 'bad' ? 'Problem' : 'Not connected'}</span>
                  </div>
                  <div className="src-meta">
                    <span><Icon name="list" size={12} /> {s.rows ?? 0} {isLeads ? 'leads' : isMoodle ? 'students' : 'rows'}</span>
                    {s.url && <span><Icon name="refresh" size={12} /> read {agoLabel(s.lastReadAt)}</span>}
                    {!!s.columns?.length && <span><Icon name="layers" size={12} /> {s.columns.length} columns</span>}
                  </div>
                  {s.lastError && <p className="src-err">{s.lastError}</p>}
                  {!connected && !isMoodle && <p className="src-help">Paste the Google Sheet link for this list so the agents can use it.</p>}
                  {isLeads && <p className="src-help">Filled by the leads webhook below (ads, forms, Zapier, Make).</p>}
                  {isMoodle && <p className="src-help">{connected ? 'Filled by the Moodle sync every 5 minutes: activity, overdue work, results and the next assessment for each student. Student Success and Learning & Assessment work from it.' : 'Fills in by itself once Moodle is connected (Channels & API) and the first sync has run.'}</p>}
                  {s.url && <span className="src-url" title={s.url}>{s.url}</span>}
                  {!!s.tabs?.length && <p className="src-help">Also reads {s.tabs.length} more tab{s.tabs.length === 1 ? '' : 's'}: {s.tabs.map((t) => t.label || 'tab').join(', ')}.</p>}
                  <div className="src-actions">
                    {!isLeads && !isMoodle && isManager && (
                      <button type="button" className={`btn sm ${connected ? 'ghost' : 'primary'}`} onClick={() => { setEditing(s); setViewing(null); }}>
                        <Icon name={connected ? 'sliders' : 'link'} size={13} /> {connected ? 'Columns' : 'Connect sheet'}
                      </button>
                    )}
                    {s.url && (
                      <button type="button" className="btn ghost sm" disabled={busy === `sync-${s.id}`} onClick={() => void act(`sync-${s.id}`, { action: 'syncSource', id: s.id }, `${s.name} read.`)}>
                        <Icon name="refresh" size={13} /> {busy === `sync-${s.id}` ? 'Reading…' : 'Sync now'}
                      </button>
                    )}
                    {(connected && (s.rows ?? 0) > 0) && (
                      <button type="button" className="btn ghost sm" onClick={() => { setViewing(viewing === s.id ? null : s.id); setEditing(null); }}>
                        <Icon name="eye" size={13} /> {viewing === s.id ? 'Hide' : 'View'} {isLeads ? 'leads' : 'records'}
                      </button>
                    )}
                    {isManager && s.url && BUILT_IN.has(s.id) && (
                      <button type="button" className="btn ghost sm" disabled={busy === `off-${s.id}`} onClick={() => {
                        if (window.confirm(`Disconnect the sheet from "${s.name}"? Agents that read it will stop picking up its rows.`)) void act(`off-${s.id}`, { action: 'saveSource', source: { id: s.id, name: s.name, kind: s.kind, url: '' } }, `${s.name} disconnected.`);
                      }}>
                        <Icon name="x" size={13} /> Disconnect
                      </button>
                    )}
                    {isManager && !BUILT_IN.has(s.id) && (
                      <button type="button" className="btn ghost sm" disabled={busy === `del-${s.id}`} onClick={() => {
                        if (window.confirm(`Remove "${s.name}"? Its records are removed from Thuso (the sheet itself is not touched).`)) void act(`del-${s.id}`, { action: 'deleteSource', id: s.id }, `${s.name} removed.`);
                      }}>
                        <Icon name="trash" size={13} /> Remove
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
            {isManager && (
              <button type="button" className="src-add" onClick={() => { setEditing('new'); setViewing(null); }}>
                <Icon name="plus" size={20} />
                Add another sheet or tab
                <span style={{ fontSize: 11.5, fontWeight: 600 }}>e.g. a fees tab, an attendance tab, a leads sheet</span>
              </button>
            )}
          </div>
        )}

        {editing && data && (
          <SheetConnect
            key={editing === 'new' ? 'new' : editing.id}
            source={editing === 'new' ? null : editing}
            data={data}
            onCancel={() => setEditing(null)}
            onSaved={async (msg) => { setEditing(null); setNotice({ kind: 'ok', text: msg }); await refresh(); }}
          />
        )}

        {viewingSource && data && (
          <RecordsPreview source={viewingSource} onClose={() => setViewing(null)} />
        )}
      </section>

      {data && <LeadsWebhookCard data={data} origin={origin} tenantSlug={tenantSlug} onView={() => { setViewing(LEADS_ID); setEditing(null); document.getElementById('data-sources')?.scrollIntoView({ behavior: 'smooth' }); }} />}
      {data && <KnowledgeCard data={data} isManager={isManager} onSaved={refresh} />}
    </>
  );
}

/* ── Connect a sheet and match its columns ────────────────────────────────── */

function SheetConnect({ source, data, onCancel, onSaved }: {
  source: DataSource | null;
  data: BuildingData;
  onCancel: () => void;
  onSaved: (message: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(source?.name || '');
  const [kind, setKind] = useState<DataSourceKind>(source?.kind || 'finance');
  const [departmentId, setDepartmentId] = useState(source?.departmentId || '');
  const [url, setUrl] = useState(source?.url || '');
  const [test, setTest] = useState<TestResult | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<RecordField, string>>>(source?.mapping || {});
  // Other tabs of the same list (e.g. several lead sources): "Name | link", one per line.
  const [tabsText, setTabsText] = useState((source?.tabs || []).map((t) => `${t.label ? `${t.label} | ` : ''}${t.url}`).join(String.fromCharCode(10)));
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const departments = sortedFloors(data.departments);

  const readSheet = useCallback(async (link: string, keepMapping: boolean) => {
    setBusy('test');
    setError(null);
    try {
      const j = await postDepartments<TestResult>({ action: 'testSource', url: link, kind });
      if (j.ok === false || j.error) { setError(j.error || 'Could not read that sheet.'); setTest(null); return; }
      setTest({ headers: j.headers || [], sample: j.sample || [], rows: j.rows || 0, mapping: j.mapping || {} });
      setMapping((prev) => {
        if (keepMapping && Object.keys(prev).length) {
          // Keep the saved choices that still match a column; fill gaps from the automatic match.
          const kept: Partial<Record<RecordField, string>> = {};
          for (const [f, col] of Object.entries(prev) as [RecordField, string][]) if (col && (j.headers || []).includes(col)) kept[f] = col;
          return { ...(j.mapping || {}), ...kept };
        }
        return j.mapping || {};
      });
    } finally {
      setBusy(null);
    }
  }, [kind]);

  // Editing a connected sheet: load its columns straight away.
  useEffect(() => {
    if (source?.url) void readSheet(source.url, true);
  }, []); // once, when the panel opens

  const primary = data.kindFields[kind] || [];
  const fields = showAll ? [...primary, ...ALL_FIELDS.filter((f) => !primary.includes(f))] : primary;
  const colIndex = (col?: string) => (col && test ? test.headers.indexOf(col) : -1);
  const fieldOf = (col: string) => (Object.entries(mapping) as [RecordField, string][]).find(([, c]) => c === col)?.[0];
  const needsName = !mapping.name && !mapping.first_name && !(kind === 'prospects' && mapping.company);
  const needsContact = !mapping.email && !mapping.phone;
  const financeGap = (kind === 'finance' || kind === 'students') && !mapping.amount_due && !(mapping.total_fee && mapping.amount_paid);

  async function save() {
    if (!name.trim()) { setError('Give this list a name, e.g. "Student tracker 2026".'); return; }
    setBusy('save');
    setError(null);
    try {
      const j = await postDepartments<{ source?: DataSource }>({
        action: 'saveSource',
        source: {
          id: source?.id, name: name.trim(), kind, url: url.trim(), departmentId: departmentId || undefined, mapping,
          tabs: tabsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
            const [a, b] = line.includes('|') ? line.split('|').map((x) => x.trim()) : ['', line];
            const prev = source?.tabs?.find((t) => t.url === b);
            return { url: b, ...(a ? { label: a } : {}), ...(prev?.mapping ? { mapping: prev.mapping } : {}) };
          }),
        },
      });
      if (j.error) { setError(j.error); return; }
      const s = j.source;
      await onSaved(s?.lastError
        ? `Saved, but reading the sheet failed: ${s.lastError}`
        : `${name.trim()} saved${s?.rows !== undefined ? ` · ${s.rows} rows read` : ''}. The agents use it from now on.`);
    } finally {
      setBusy(null);
    }
  }

  const step = !test ? 1 : 2;

  return (
    <div className="src-panel" aria-label="Connect a Google Sheet">
      <div className="src-panel-h">
        <h3><Icon name="link" size={15} /> {source ? `${source.name}: sheet and columns` : 'Add a sheet or tab'}</h3>
        <div className="src-steps">
          <span className={step === 1 ? 'on' : 'done'}>1 · Paste the link</span>
          <span className={step === 2 ? 'on' : ''}>2 · Check the columns</span>
          <span>3 · Save</span>
        </div>
      </div>

      <div className="set-grid">
        <label className="field">
          <span>Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Student tracker 2026" />
        </label>
        <label className="field">
          <span>What is in it</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as DataSourceKind)} disabled={source?.id === 'src_tracker' || source?.id === 'src_prospects'}>
            {KINDS.filter((k) => k !== 'leads' || !source || source.kind === 'leads').map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Department that uses it</span>
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Any department</option>
            {departments.map((d) => <option key={d.id} value={d.id}>F{d.floor ?? '?'} · {d.name}</option>)}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Google Sheet link (the tab you want)</span>
        <div className="pg-inline-copy">
          <input type="url" value={url} onChange={(e) => { setUrl(e.target.value); setTest(null); }} placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" />
          <button type="button" className="btn primary sm" disabled={!url.trim() || busy === 'test'} onClick={() => void readSheet(url, Boolean(source))}>
            <Icon name={busy === 'test' ? 'spinner' : 'scanSearch'} size={14} /> {busy === 'test' ? 'Reading…' : test ? 'Read again' : 'Read the sheet'}
          </button>
        </div>
      </label>
      <p className="src-help">Shared as <b>Anyone with the link: Viewer</b>? Each tab has its own link (<code>#gid=…</code>), so a fees tab and a students tab are two sources.</p>
      <label className="field">
        <span>More tabs of this same list (optional, one per line: <code>Name | link</code>). A person on several tabs becomes one record; a newly added tab is imported quietly.</span>
        <textarea rows={3} value={tabsText} onChange={(e) => setTabsText(e.target.value)} placeholder={'WhatsApp Leads | https://docs.google.com/spreadsheets/d/…/edit#gid=1802008130'} style={{ width: '100%', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12.5, padding: 10, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface-raised)', color: 'var(--ink)' }} />
      </label>

      {error && <div className="src-note bad"><Icon name="warn" size={14} /><span>{error}</span></div>}

      {test && (
        <>
          <div className="src-found"><Icon name="ok" size={15} /> Found {test.rows} row{test.rows === 1 ? '' : 's'} and {test.headers.length} columns.</div>
          <div className="src-table-wrap">
            <table className="src-table">
              <thead>
                <tr>{test.headers.map((h) => { const f = fieldOf(h); return <th key={h}>{f && <em>{data.fieldLabels[f]}</em>}{h}</th>; })}</tr>
              </thead>
              <tbody>
                {test.sample.map((r, i) => <tr key={i}>{test.headers.map((h, c) => <td key={h} title={r[c] || ''}>{r[c] || ''}</td>)}</tr>)}
              </tbody>
            </table>
          </div>

          <div className="src-panel-h">
            <h3 style={{ fontSize: 14 }}><Icon name="sliders" size={14} /> Match the columns</h3>
            <span className="src-help">Matched automatically; change any that are wrong.</span>
          </div>
          <div className="src-map">
            {fields.map((f) => {
              const col = mapping[f];
              const idx = colIndex(col);
              const sample = idx >= 0 ? test.sample[0]?.[idx] : '';
              return (
                <div key={f} className={`src-map-row${col ? ' is-set' : ''}`}>
                  <label htmlFor={`map-${f}`}>
                    {data.fieldLabels[f]}
                    <small>{col ? (sample ? `e.g. ${sample}` : 'matched') : 'not in this sheet'}</small>
                  </label>
                  <select id={`map-${f}`} value={col || ''} onChange={(e) => setMapping((m) => { const next = { ...m }; if (e.target.value) next[f] = e.target.value; else delete next[f]; return next; })}>
                    <option value="">Not in this sheet</option>
                    {test.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
          <button type="button" className="src-more" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show the main fields only' : 'Show all fields'}</button>

          {needsName && <div className="src-note"><Icon name="warn" size={14} /><span>No name column is matched. Agents can still work, but greetings will fall back to the email address.</span></div>}
          {needsContact && <div className="src-note"><Icon name="warn" size={14} /><span>No email or phone column is matched, so agents cannot reach anyone from this list.</span></div>}
          {financeGap && <div className="src-note"><Icon name="warn" size={14} /><span>For fee reminders, match a balance column (or both the total fee and the amount paid) and a due date.</span></div>}
        </>
      )}

      <div className="pg-actions">
        <button type="button" className="btn primary sm" disabled={busy === 'save' || (!test && Boolean(url.trim()) && !source)} onClick={() => void save()}>
          <Icon name="save" size={14} /> {busy === 'save' ? 'Saving and reading…' : 'Save'}
        </button>
        <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>
        {!test && url.trim() && !source && <span className="src-help">Read the sheet first so you can check the columns.</span>}
      </div>
    </div>
  );
}

/* ── Records ──────────────────────────────────────────────────────────────── */

const KIND_COLUMNS: Record<DataSourceKind, { key: string; label: string }[]> = {
  finance: [{ key: 'programme', label: 'Programme' }, { key: 'amount_due_display', label: 'Balance' }, { key: 'due_date_display', label: 'Due' }, { key: 'payment_state', label: 'Payment' }, { key: 'status', label: 'Status' }],
  students: [{ key: 'programme', label: 'Programme' }, { key: 'cohort', label: 'Cohort' }, { key: 'status', label: 'Status' }, { key: 'payment_state', label: 'Payment' }],
  leads: [{ key: 'interest', label: 'Interested in' }, { key: 'campaign', label: 'Campaign' }, { key: 'source', label: 'Source' }, { key: 'status', label: 'Status' }, { key: 'lead_score', label: 'Score' }],
  prospects: [{ key: 'company', label: 'Company' }, { key: 'status', label: 'Status' }, { key: 'owner', label: 'Owner' }, { key: 'fit_score', label: 'Fit' }],
  custom: [{ key: 'status', label: 'Status' }, { key: 'notes', label: 'Notes' }],
};

function RecordsPreview({ source, onClose }: { source: DataSource; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/departments?records=${encodeURIComponent(source.id)}&q=${encodeURIComponent(q)}`, { cache: 'no-store' });
        const j = await res.json();
        if (!live) return;
        if (!res.ok) { setError(j.error || 'Could not load the records.'); return; }
        setRows(j.records || []);
        setError(null);
      } catch {
        if (live) setError('Could not reach the server.');
      }
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [source.id, q]);

  const cols = KIND_COLUMNS[source.kind] || KIND_COLUMNS.custom;

  return (
    <div className="src-panel" aria-label={`${source.name} records`}>
      <div className="src-records-h">
        <h3 style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center', fontSize: 15, fontWeight: 800 }}>
          <Icon name="list" size={15} /> {source.name}
          <span className="src-help">{rows ? `${rows.length}${rows.length >= 200 ? '+' : ''} shown` : ''}</span>
        </h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="src-search"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or phone" /></label>
          <button type="button" className="btn ghost sm" onClick={onClose}><Icon name="x" size={13} /> Close</button>
        </div>
      </div>
      {error && <div className="src-note bad"><Icon name="warn" size={14} /><span>{error}</span></div>}
      {!rows ? (
        <p className="src-help">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="src-help">{q ? 'No records match that search.' : 'No records yet.'}</p>
      ) : (
        <div className="src-table-wrap" style={{ maxHeight: 420 }}>
          <table className="src-table">
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Phone</th>
                {cols.map((c) => <th key={c.key}>{c.label}</th>)}
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td title={r.name}><b>{r.name}</b></td>
                  <td title={r.email}>{r.email || '—'}</td>
                  <td>{r.phone || '—'}</td>
                  {cols.map((c) => {
                    const v = r.fields[c.key] || '';
                    if (c.key === 'payment_state' && v) return <td key={c.key}><span className={`src-pay p-${v}`}>{v}</span></td>;
                    return <td key={c.key} title={v}>{v || '—'}</td>;
                  })}
                  <td>{agoLabel(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Leads from ads ───────────────────────────────────────────────────────── */

function LeadsWebhookCard({ data, origin, tenantSlug, onView }: { data: BuildingData; origin: string; tenantSlug: string; onView: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [tab, setTab] = useState<'json' | 'curl' | 'meta'>('json');
  const token = data.leadsWebhook.token;
  const leads = data.sources.find((s) => s.id === LEADS_ID);
  const admissions = sortedFloors(data.departments).find((d) => d.kind === 'admissions');
  const nurturer = admissions?.agents.find((a) => a.workflow?.agentTrigger?.kind === 'lead.created');
  const base = `${origin}${data.leadsWebhook.path}?tenant=${encodeURIComponent(tenantSlug)}`;
  const url = token ? `${base}&token=${token}` : base;
  const sample = JSON.stringify({
    full_name: 'Thandi Mokoena',
    email: 'thandi@example.com',
    phone_number: '082 123 4567',
    course: 'Data Analytics',
    campaign: 'October intake · Facebook',
    message: 'Can I study part time while working?',
  }, null, 2);
  const curl = `curl -X POST "${base}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-Thuso-Token: ${token || '<your inbound token>'}" \\\n  -d '${JSON.stringify({ full_name: 'Thandi Mokoena', email: 'thandi@example.com', phone_number: '0821234567', course: 'Data Analytics', campaign: 'October intake' })}'`;
  const meta = JSON.stringify({ field_data: [{ name: 'full_name', values: ['Thandi Mokoena'] }, { name: 'email', values: ['thandi@example.com'] }, { name: 'phone_number', values: ['+27821234567'] }, { name: 'which_course_are_you_interested_in', values: ['Data Analytics'] }], campaign_name: 'October intake' }, null, 2);
  const shown = tab === 'json' ? sample : tab === 'curl' ? curl : meta;
  const doCopy = (key: string, text: string) => copy(text, () => { setCopied(key); setTimeout(() => setCopied(null), 1800); });

  return (
    <section className="pg-card src-section" id="leads-webhook">
      <div className="pg-card-h">
        <div>
          <h2><Icon name="inbox" size={16} /> Leads from ads and forms</h2>
          <p className="pg-sub">
            Send every new lead here (Facebook and Instagram lead forms, Google Ads, your website form, the WhatsApp bot).
            It joins the leads list and{nurturer ? ` ${nurturer.name}, the ${nurturer.title.toLowerCase()} on the Admissions floor,` : ' the Admissions agents'} starts on it within seconds when autopilot is on.
          </p>
        </div>
        <div className="lead-stat">
          <span><b>{leads?.rows ?? 0}</b>leads</span>
          <span><b>{data.autopilot ? 'On' : 'Off'}</b>autopilot</span>
        </div>
      </div>

      <div className="lead-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <label className="field">
            <span>Webhook URL (POST, JSON or form data)</span>
            <div className="pg-inline-copy">
              <input type="text" readOnly value={url} />
              <button type="button" className="btn ghost sm" onClick={() => doCopy('url', url)}>{copied === 'url' ? 'Copied' : 'Copy'}</button>
            </div>
          </label>
          {token ? (
            <label className="field">
              <span>Inbound token (or send it as the X-Thuso-Token header)</span>
              <div className="pg-inline-copy">
                <input type="text" readOnly value={token} />
                <button type="button" className="btn ghost sm" onClick={() => doCopy('token', token)}>{copied === 'token' ? 'Copied' : 'Copy'}</button>
              </div>
            </label>
          ) : (
            <div className="src-note"><Icon name="shield" size={14} /><span>Only workspace owners and admins can see the inbound token.</span></div>
          )}
          <ul className="lead-how">
            <li><span>Z</span><div><b>Zapier:</b> trigger <i>Facebook Lead Ads → New Lead</i> (or your form), action <i>Webhooks by Zapier → POST</i>, payload type JSON, URL above. Map name, email, phone, course and campaign.</div></li>
            <li><span>M</span><div><b>Make:</b> Facebook Lead Ads <i>Watch leads</i> → <i>HTTP → Make a request</i>, method POST, body type JSON, URL above.</div></li>
            <li><span>W</span><div><b>Website form:</b> post the form fields to the URL above (form data works too). Field names like <code>full_name</code>, <code>email</code>, <code>phone_number</code> and <code>course</code> are understood; anything else is kept on the lead.</div></li>
            <li><span>!</span><div>Keep the URL private: it includes your token. To change the token, ask a developer to rotate the webhook secret.</div></li>
          </ul>
          {(leads?.rows ?? 0) > 0 && (
            <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={onView}><Icon name="eye" size={13} /> View the leads list</button>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div className="src-tabs" role="tablist">
            <button type="button" className={tab === 'json' ? 'on' : ''} onClick={() => setTab('json')}>Sample JSON</button>
            <button type="button" className={tab === 'curl' ? 'on' : ''} onClick={() => setTab('curl')}>curl test</button>
            <button type="button" className={tab === 'meta' ? 'on' : ''} onClick={() => setTab('meta')}>Meta field_data</button>
          </div>
          <div className="src-code-wrap">
            <pre className="pg-code">{shown}</pre>
            <button type="button" className="btn ghost sm" onClick={() => doCopy(tab, shown)}>{copied === tab ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="src-help">A lead needs an email or a phone number for the agents to reach them. The same person sending twice updates their lead instead of creating a second one.</p>
        </div>
      </div>
    </section>
  );
}

/* ── What the agents know ─────────────────────────────────────────────────── */

function KnowledgeCard({ data, isManager, onSaved }: { data: BuildingData; isManager: boolean; onSaved: () => Promise<void> | void }) {
  const [text, setText] = useState(data.knowledge.agentKnowledge);
  const [applyUrl, setApplyUrl] = useState(data.knowledge.applyUrl);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const dirty = text !== data.knowledge.agentKnowledge || applyUrl !== data.knowledge.applyUrl;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const j = await postDepartments({ action: 'saveKnowledge', agentKnowledge: text, applyUrl });
      setMsg(j.error ? { kind: 'bad', text: j.error } : { kind: 'ok', text: 'Saved. Every agent uses this from its next message.' });
      if (!j.error) await onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pg-card src-section" id="agent-knowledge">
      <div className="pg-card-h">
        <div>
          <h2><Icon name="brain" size={16} /> What the agents know</h2>
          <p className="pg-sub">
            Every agent reads this before it writes: admissions uses it to answer leads, finance for payment details,
            student success for support. Agents never invent facts that are not here, so the more specific, the better.
          </p>
        </div>
        <span className="pill">{text.length.toLocaleString()} / 8,000</span>
      </div>
      <ul className="know-tips">
        <li>Programmes: what they teach, duration, how classes work</li>
        <li>Fees, payment options, instalments, bank details</li>
        <li>Next intakes and application deadlines</li>
        <li>Requirements: documents, entry criteria</li>
        <li>Support: who to contact, office hours, phone</li>
        <li>Policies: refunds, deferrals, arrangements</li>
      </ul>
      <label className="field">
        <span>About the academy</span>
        <textarea
          className="know-text"
          value={text}
          maxLength={8000}
          disabled={!isManager}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Full-Stack Web Development: 12 months, online live evening classes and weekend labs. R42,000, or R3,500 a month.\nData Analytics with Python & SQL: 9 months …\nNext intake: 3 February 2026. Applications close 20 January.\nPayments: EFT to … reference = student number. Arrangements: email finance@…'}
        />
      </label>
      <div className="set-grid">
        <label className="field">
          <span>Application link (Admissions sends this to leads)</span>
          <input type="url" value={applyUrl} disabled={!isManager} onChange={(e) => setApplyUrl(e.target.value)} placeholder="https://yourdomain.com/apply" />
        </label>
      </div>
      {msg && <div className={`src-note ${msg.kind}`}><Icon name={msg.kind === 'ok' ? 'ok' : 'warn'} size={14} /><span>{msg.text}</span></div>}
      <div className="pg-actions">
        <button type="button" className="btn primary sm" disabled={!isManager || busy || !dirty} onClick={() => void save()}>
          <Icon name="save" size={14} /> {busy ? 'Saving…' : 'Save what the agents know'}
        </button>
        {!isManager && <span className="src-help">Only owners and admins can change this.</span>}
      </div>
    </section>
  );
}
