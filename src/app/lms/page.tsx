'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Icon from '@/components/Icon';

/* The LMS console: the learner records as the LMS holds them.
 *
 * Change a checkpoint score or the days since a learner last logged in, press
 * Save, and the LMS does what a real one does: it sends a signed webhook to
 * Thuso. Nobody touches Thuso itself; the colleague starts on its own. Open
 * this on a phone or a teammate's laptop during the demo. */

interface Row { id: string; name: string; email: string; phone: string; cohort: string; module?: string; moduleTitle?: string; checkpoint: number | null; daysSinceLogin: number | null; status: string; lastEvent: string | null }
interface Draft { checkpoint: string; days: string; email: string; phone: string }
interface Sent { id: string; at: number; status: number; payload: unknown }

/* The modules a new learner can be on, each with its cohort. */
const MODULE_OPTIONS = [
  { code: 'JS-07', label: 'JS-07 · Asynchronous JavaScript', cohort: 'FSWD-2026-Q3' },
  { code: 'RE-03', label: 'RE-03 · React State & Hooks', cohort: 'FSWD-2026-Q3' },
  { code: 'SQL-04', label: 'SQL-04 · SQL Joins & Aggregations', cohort: 'DA-2026-Q3' },
];

const STATUS: Record<string, { cls: string; label: string }> = {
  on_track: { cls: 'badge-good', label: 'On track' },
  at_risk: { cls: 'badge-bad', label: 'At risk' },
  intervention: { cls: 'badge-warn', label: 'Being helped' },
  recovered: { cls: 'badge-good', label: 'Back on track' },
};

export default function LmsConsole() {
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', module: 'JS-07', checkpoint: '72', days: '1' });
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function act(body: Record<string, unknown>) {
    const res = await fetch('/api/lms/learners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = (await res.json()) as { error?: string; id?: string };
    if (!res.ok) throw new Error(out.error || 'Failed');
    return out;
  }
  async function add() {
    setAdding(true); setErr(null);
    try {
      const m = MODULE_OPTIONS.find((x) => x.code === form.module) || MODULE_OPTIONS[0];
      await act({ action: 'add', name: form.name, email: form.email, phone: form.phone, module: m.code, cohort: m.cohort, checkpoint: form.checkpoint === '' ? null : Number(form.checkpoint), daysSinceLogin: Number(form.days || 1) });
      setNote(`${form.name} added. Change their mark below to start Thuso.`);
      setForm({ name: '', email: '', phone: '', module: form.module, checkpoint: '72', days: '1' });
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setAdding(false); }
  }
  async function remove(r: Row) {
    if (!confirm(`Remove ${r.name} from the learner records?`)) return;
    try { await act({ action: 'remove', id: r.id }); await load(); } catch (e) { setErr((e as Error).message); }
  }
  const ownCount = rows.filter((r) => r.id.startsWith('ST-')).length;
  const demoShown = rows.some((r) => !r.id.startsWith('ST-'));

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/lms/learners', { cache: 'no-store' });
      const d = (await r.json()) as { learners: Row[] };
      setRows(d.learners);
    } catch { /* keep the last list */ }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);

  const draft = (r: Row): Draft => drafts[r.id] || { checkpoint: r.checkpoint === null ? '' : String(r.checkpoint), days: r.daysSinceLogin === null ? '' : String(r.daysSinceLogin), email: r.email, phone: r.phone || '' };
  const edit = (r: Row, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [r.id]: { ...draft(r), ...patch } }));
  const dirty = (r: Row) => {
    const d = drafts[r.id];
    return Boolean(d && (d.checkpoint !== (r.checkpoint === null ? '' : String(r.checkpoint)) || d.days !== (r.daysSinceLogin === null ? '' : String(r.daysSinceLogin)) || d.email !== r.email || d.phone !== (r.phone || '')));
  };

  async function save(r: Row) {
    const d = draft(r);
    setSaving(r.id); setErr(null);
    try {
      const body: Record<string, unknown> = { id: r.id };
      if (d.email !== r.email) body.email = d.email;
      if (d.phone !== (r.phone || '')) body.phone = d.phone;
      if (d.checkpoint !== (r.checkpoint === null ? '' : String(r.checkpoint)) && d.checkpoint.trim() !== '') body.checkpoint = Number(d.checkpoint);
      if (d.days !== (r.daysSinceLogin === null ? '' : String(r.daysSinceLogin)) && d.days.trim() !== '') body.daysSinceLogin = Number(d.days);
      const res = await fetch('/api/lms/learners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = (await res.json()) as { error?: string; webhook?: { status: number; payload: unknown } };
      if (!res.ok) throw new Error(out.error || 'Save failed');
      if (out.webhook) setSent({ id: r.id, at: Date.now(), status: out.webhook.status, payload: out.webhook.payload });
      setDrafts((x) => { const n = { ...x }; delete n[r.id]; return n; });
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setSaving(null); }
  }

  return (
    <div className="pg">
      <header className="pg-top">
        <span className="pg-brand"><span className="lms-mark"><Icon name="graduation" size={18} /></span><b className="lms-name">Campus LMS</b><em>Learner records · sandbox</em></span>
        <Link href="/" className="btn btn-outline btn-sm"><Icon name="arrowLeft" size={14} />Back to Thuso</Link>
      </header>
      <main className="pg-main">
        <div className="pg-intro">
          <h1>Learner records</h1>
          <p>This is the learning system Thuso watches. Change a mark or the days since a learner logged in, then press <b>Save</b>. The LMS sends a signed webhook and Thuso starts on its own. Put a teammate&apos;s real email on a learner to receive the study pack.</p>
        </div>
        <section className="lms-add">
          <h2><Icon name="plus" size={15} />Add a learner</h2>
          <div className="lms-add-grid">
            <label><span>Full name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Thandeka Mokoena" /></label>
            <label><span>Email (real, to receive the study pack)</span><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" /></label>
            <label><span>Phone (for the follow-up call)</span><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+27 82 000 0000" /></label>
            <label><span>Module</span><select value={form.module} onChange={(e) => setForm({ ...form, module: e.target.value })}>{MODULE_OPTIONS.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}</select></label>
            <label><span>Checkpoint %</span><input type="number" min={0} max={100} value={form.checkpoint} onChange={(e) => setForm({ ...form, checkpoint: e.target.value })} /></label>
            <label><span>Days since login</span><input type="number" min={0} max={90} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} /></label>
            <button type="button" className="btn btn-cta" disabled={adding || form.name.trim().length < 2 || !form.email.includes('@')} onClick={add}>{adding ? <Icon name="spinner" size={14} className="spin" /> : <Icon name="plus" size={14} />}Add learner</button>
          </div>
          <div className="lms-add-foot">
            <span>{ownCount ? `${ownCount} of your own learner${ownCount === 1 ? '' : 's'}` : 'No learners of your own yet'}. Adding someone does not start Thuso; changing their mark or logins does.</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={async () => { await act({ action: 'demo', hide: demoShown }); await load(); }}>{demoShown ? 'Hide the demo learners' : 'Show the demo learners'}</button>
          </div>
        </section>
        {note && <div className="pg-sent"><Icon name="ok" size={14} />{note}</div>}
        {sent && (
          <div className="pg-sent">
            <span className={`badge ${sent.status === 202 ? 'badge-good' : 'badge-bad'}`}><Icon name={sent.status === 202 ? 'send' : 'warn'} size={11} />Webhook {sent.status === 202 ? 'delivered · 202 Accepted' : `failed · ${sent.status || 'no answer'}`}</span>
            <span className="pg-sent-t">LMS → Thuso · POST /api/webhooks/lms · signed sha256 · {new Date(sent.at).toLocaleTimeString('en-ZA')}</span>
            <pre>{JSON.stringify(sent.payload, null, 2)}</pre>
          </div>
        )}
        {err && <div className="pg-err"><Icon name="warn" size={14} />{err}</div>}
        <div className="lms-table" role="table">
          <div className="lms-row lms-head" role="row">
            <span>Learner</span><span>Cohort · module</span><span>Checkpoint %</span><span>Days since login</span><span>Status</span><span />
          </div>
          {rows.map((r) => {
            const d = draft(r);
            const st = STATUS[r.status] || STATUS.on_track;
            return (
              <div key={r.id} className={`lms-row${dirty(r) ? ' is-dirty' : ''}`} role="row">
                <span className="lms-who"><b>{r.name}{r.id.startsWith('ST-') && <span className="badge badge-cta" style={{ marginLeft: 6 }}>Yours</span>}</b><input value={d.email} onChange={(e) => edit(r, { email: e.target.value })} aria-label={`Email for ${r.name}`} spellCheck={false} /><input value={d.phone} onChange={(e) => edit(r, { phone: e.target.value })} aria-label={`Phone for ${r.name}`} placeholder="Phone" spellCheck={false} /></span>
                <span className="lms-mod"><b>{r.cohort}</b><em>{r.module} · {r.moduleTitle}</em></span>
                <span><input type="number" min={0} max={100} value={d.checkpoint} onChange={(e) => edit(r, { checkpoint: e.target.value })} aria-label={`Checkpoint score for ${r.name}`} placeholder="—" /></span>
                <span><input type="number" min={0} max={90} value={d.days} onChange={(e) => edit(r, { days: e.target.value })} aria-label={`Days since ${r.name} last logged in`} /></span>
                <span><span className={`badge ${st.cls}`}>{st.label}</span>{r.lastEvent && <em className="lms-ev">{r.lastEvent}</em>}</span>
                <span className="lms-acts"><button type="button" className="btn btn-cta btn-sm" disabled={!dirty(r) || saving === r.id} onClick={() => save(r)}>{saving === r.id ? <Icon name="spinner" size={13} className="spin" /> : <Icon name="save" size={13} />}Save</button><button type="button" className="iconbtn" title={`Remove ${r.name}`} aria-label={`Remove ${r.name}`} onClick={() => remove(r)}><Icon name="trash" size={14} /></button></span>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
