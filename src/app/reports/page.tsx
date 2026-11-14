'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Period, Report } from '@/lib/reports';
import Logo from '@/components/Logo';
import Icon from '@/components/Icon';

/* Reports: what happened at the school, from Musa, the Reviewer.
 *
 * The numbers are counted from what the team actually did; nothing here is
 * estimated. Musa writes the summary on request (with Claude, from these
 * numbers only) and can email it; he also sends it every day at 17:00 when a
 * manager's address is set. */

const PERIODS: { id: Period; label: string }[] = [{ id: 'today', label: 'Today' }, { id: 'week', label: 'This week' }, { id: 'all', label: 'Everything' }];
const STATUS: Record<string, { cls: string; label: string }> = {
  on_track: { cls: 'badge-good', label: 'On track' }, at_risk: { cls: 'badge-bad', label: 'At risk' },
  intervention: { cls: 'badge-warn', label: 'Being helped' }, recovered: { cls: 'badge-good', label: 'Back on track' },
};
const time = (t: number) => new Date(t).toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const dur = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };

export default function ReportsPage() {
  const [period, setPeriod] = useState<Period>('today');
  const [r, setR] = useState<Report | null>(null);
  const [musa, setMusa] = useState<{ text: string; at: number; viaAi: boolean; mailed: string | null } | null>(null);
  const [writing, setWriting] = useState(false);
  const [email, setEmail] = useState('');

  const load = useCallback(async () => {
    try { const res = await fetch(`/api/reports?period=${period}`, { cache: 'no-store' }); setR(await res.json()); } catch { /* keep */ }
  }, [period]);
  useEffect(() => { void load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  useEffect(() => { setMusa(null); }, [period]);

  async function write(withEmail: boolean) {
    setWriting(true);
    try {
      const res = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period, ...(withEmail ? { email } : {}) }) });
      const d = await res.json();
      setMusa({ text: d.text, at: d.at, viaAi: d.viaAi, mailed: d.mailed });
    } finally { setWriting(false); }
  }

  const n = r?.numbers;
  return (
    <div className="pg">
      <header className="pg-top">
        <span className="pg-brand"><Logo size="sm" /><em>Reports</em></span>
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <Link href="/settings" className="btn btn-outline btn-sm"><Icon name="gear" size={14} />Settings</Link>
          <Link href="/" className="btn btn-outline btn-sm"><Icon name="arrowLeft" size={14} />Back to the office</Link>
        </span>
      </header>
      <main className="pg-main">
        <div className="rp-head">
          <div className="pg-intro"><h1>What happened at your school</h1><p>Counted from what the team actually did. Musa, the Reviewer, writes the summary and sends it to you every day at 17:00.</p></div>
          <div className="seg" role="tablist">{PERIODS.map((p) => <button key={p.id} type="button" className={period === p.id ? 'on' : ''} onClick={() => setPeriod(p.id)}>{p.label}</button>)}</div>
        </div>

        <div className="rp-kpis">
          <div><b>{n?.checked ?? 0}</b><span>learners checked</span></div>
          <div><b>{n?.helped ?? 0}</b><span>learners helped</span></div>
          <div><b>{n?.studyPacks ?? 0}</b><span>study packs sent<br />(lesson + quiz)</span></div>
          <div><b>{n?.checkIns ?? 0}</b><span>personal check-ins</span></div>
          <div><b>{n?.quizzesDone ?? 0}</b><span>quizzes taken{n?.passRate !== null && n?.passRate !== undefined ? ` · ${n.passRate}% passed` : ''}</span></div>
          <div className="is-warn"><b>{n?.mistakesCaught ?? 0}</b><span>mistakes caught<br />{n?.mistakesFixed ?? 0} fixed before sending</span></div>
          <div className="is-good"><b>0</b><span>human interventions</span></div>
          <div><b>{n?.runs ?? 0}</b><span>runs · {r ? `${r.byTrigger.webhook + r.byTrigger.sheet} from the LMS, ${r.byTrigger.schedule} scheduled, ${r.byTrigger.manager} by a manager` : ''}</span></div>
        </div>

        <section className="rp-musa">
          <div className="rp-musa-head">
            <span className="agent-av">MU</span>
            <div><b>Musa&apos;s report</b><em>The Reviewer · written from these numbers only</em></div>
          </div>
          {musa ? (
            <div className="rp-text">{musa.text.split(/\n+/).filter(Boolean).map((p, i) => <p key={i}>{p}</p>)}<span className="dim">Written {time(musa.at)}{musa.viaAi ? ' with Claude' : ''}{musa.mailed ? ` · emailed to ${musa.mailed}` : ''}</span></div>
          ) : <p className="dim" style={{ margin: 0 }}>Ask Musa for {period === 'today' ? "today's" : period === 'week' ? "this week's" : 'the full'} report.</p>}
          <div className="set-inline">
            <button type="button" className="btn btn-cta btn-sm" onClick={() => write(false)} disabled={writing}>{writing ? <Icon name="spinner" size={13} className="spin" /> : <Icon name="file" size={13} />}Write the report</button>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email it to… (your address)" type="email" />
            <button type="button" className="btn btn-outline btn-sm" onClick={() => write(true)} disabled={writing || !email.includes('@')}><Icon name="send" size={13} />Write and email</button>
          </div>
        </section>

        <div className="rp-cols">
          <section className="rp-card">
            <h2><Icon name="users" size={15} />Who was helped</h2>
            {r?.helped.length ? r.helped.map((h, i) => <div key={i} className="rp-item"><b>{h.name}</b><span>{h.what}</span><em>{time(h.at)}</em></div>) : <p className="dim">Nobody yet in this period.</p>}
          </section>
          <section className="rp-card">
            <h2><Icon name="shield" size={15} />Mistakes Musa caught</h2>
            {r?.mistakes.length ? r.mistakes.map((m, i) => <div key={i} className="rp-item"><b>{m.title} · {m.subject}</b><span>{m.note}</span><em>{m.fixed ? 'Fixed and approved' : 'Sent back'} · {time(m.at)}</em></div>) : <p className="dim">No mistakes in this period.</p>}
          </section>
        </div>

        <section className="rp-card">
          <h2><Icon name="graduation" size={15} />Every learner</h2>
          <div className="rp-table">
            {r?.learners.map((l) => { const st = STATUS[l.status] || STATUS.on_track; return (
              <div key={l.id} className="rp-row"><b>{l.name}</b><span>{l.cohort}</span><span><span className={`badge ${st.cls}`}>{st.label}</span></span><span className="dim">{l.lastEvent || '—'}</span></div>
            ); })}
          </div>
        </section>

        <section className="rp-card">
          <h2><Icon name="activity" size={15} />Every run</h2>
          {r?.runs.length ? <div className="rp-table">{r.runs.map((t) => (
            <div key={t.id} className="rp-row"><b>{time(t.at)}</b><span>{t.trigger}</span><span>{t.summary ? `${t.summary.checked} checked · ${t.summary.needHelp} helped · ${t.corrections} fixed` : t.status}</span><span className="dim">{dur(t.ms)} · 0 human steps</span></div>
          ))}</div> : <p className="dim">No runs in this period.</p>}
        </section>
      </main>
    </div>
  );
}
