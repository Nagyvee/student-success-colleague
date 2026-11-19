'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Period, Report } from '@/lib/reports';
import Icon from '@/components/Icon';
import '../pages.css';

const PERIODS: { id: Period; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'all', label: 'Everything' },
];
const STATUS: Record<string, { cls: string; label: string }> = {
  on_track: { cls: 'badge-good', label: 'On track' },
  at_risk: { cls: 'badge-bad', label: 'Needs help' },
  intervention: { cls: 'badge-warn', label: 'Outreach active' },
  recovered: { cls: 'badge-good', label: 'Recovered' },
};
const time = (t: number) => new Date(t).toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const dur = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };

export default function ReportsClient() {
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
    <main className="pg-main">
      <div className="rp-head">
        <div className="pg-intro">
          <h1>Academy Outcomes</h1>
          <p>Real metrics counted from verified workflows, student interactions, and reviewer checks.</p>
        </div>
        <div className="seg" role="tablist">
          {PERIODS.map((p) => (
            <button key={p.id} type="button" className={period === p.id ? 'on' : ''} onClick={() => setPeriod(p.id)}>{p.label}</button>
          ))}
        </div>
      </div>

      <div className="rp-kpis">
        <div><b>{n?.checked ?? 0}</b><span>learners checked</span></div>
        <div><b>{n?.helped ?? 0}</b><span>learners helped</span></div>
        <div><b>{n?.studyPacks ?? 0}</b><span>study packs sent<br />(lesson + quiz)</span></div>
        <div><b>{n?.checkIns ?? 0}</b><span>personal check-ins</span></div>
        <div><b>{n?.quizzesDone ?? 0}</b><span>quizzes taken{n?.passRate !== null && n?.passRate !== undefined ? ` · ${n.passRate}% passed` : ''}</span></div>
        <div className="is-warn"><b>{n?.mistakesCaught ?? 0}</b><span>quality issues caught<br />{n?.mistakesFixed ?? 0} revised before send</span></div>
        <div className="is-good"><b>{n?.runs ?? 0}</b><span>workflow runs</span></div>
      </div>

      <section className="rp-musa">
        <div className="rp-musa-head">
          <span className="agent-av">OP</span>
          <div><b>Operations Briefing Across All Floors</b><em>Compiled from every office, workflow, agent, and learner interaction</em></div>
        </div>
        {musa ? (
          <div className="rp-text">
            {musa.text.split(/\n+/).filter(Boolean).map((p, i) => <p key={i}>{p}</p>)}
            <span className="dim">Written {time(musa.at)}{musa.viaAi ? ' with AI' : ''}{musa.mailed ? ` · emailed to ${musa.mailed}` : ''}</span>
          </div>
        ) : <p className="dim" style={{ margin: 0 }}>Generate {period === 'today' ? "today's" : period === 'week' ? "this week's" : 'the full'} report across Finance, Admissions, Student Success, Learning, and Custom floors.</p>}
        <div className="set-inline">
          <button type="button" className="btn btn-cta btn-sm" onClick={() => write(false)} disabled={writing}>
            {writing ? <Icon name="spinner" size={13} className="spin" /> : <Icon name="file" size={13} />}Generate report
          </button>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email report to..." type="email" />
          <button type="button" className="btn btn-outline btn-sm" onClick={() => write(true)} disabled={writing || !email.includes('@')}>
            <Icon name="send" size={13} />Generate &amp; Email
          </button>
        </div>
      </section>

      <section className="rp-card" style={{ marginBottom: 16 }}>
        <h2><Icon name="layers" size={15} />Activity by Floor &amp; Office</h2>
        {r?.floors?.length ? (
          <div className="rp-table">
            {r.floors.map((f) => (
              <div key={f.workflowId} className="rp-row">
                <b>{f.officeName} · {f.workflowName}</b>
                <span>Agent: {f.agentName}</span>
                <span><span className={`badge ${f.enabled ? 'badge-good' : 'badge-mute'}`}>{f.runsInPeriod} run{f.runsInPeriod === 1 ? '' : 's'}</span></span>
                <span className="dim">{f.latestTarget ? `${f.latestTarget} (${f.latestOutcome || 'recorded'})` : (f.enabled ? 'Standing by' : 'Paused')}</span>
              </div>
            ))}
          </div>
        ) : <p className="dim">No workflow floors configured yet.</p>}
      </section>

      <div className="rp-cols">
        <section className="rp-card">
          <h2><Icon name="users" size={15} />People &amp; Learners Reached</h2>
          {r?.helped.length ? r.helped.map((h, i) => <div key={i} className="rp-item"><b>{h.name} · {h.office}</b><span>{h.what}</span><em>{time(h.at)}</em></div>) : <p className="dim">None recorded in this period.</p>}
        </section>
        <section className="rp-card">
          <h2><Icon name="shield" size={15} />Quality Checks Caught</h2>
          {r?.mistakes.length ? r.mistakes.map((m, i) => <div key={i} className="rp-item"><b>{m.title} · {m.subject}</b><span>{m.note}</span><em>{m.fixed ? 'Revised & approved' : 'Sent back'} · {time(m.at)}</em></div>) : <p className="dim">No issues flagged in this period.</p>}
        </section>
      </div>

      <section className="rp-card">
        <h2><Icon name="graduation" size={15} />Learner Status</h2>
        {r?.learners.length ? (
          <div className="rp-table">
            {r.learners.map((l) => {
              const st = STATUS[l.status] || STATUS.on_track;
              return (
                <div key={l.id} className="rp-row">
                  <b>{l.name}</b>
                  <span>{l.cohort}</span>
                  <span><span className={`badge ${st.cls}`}>{st.label}</span></span>
                  <span className="dim">{l.lastEvent || '—'}</span>
                </div>
              );
            })}
          </div>
        ) : <p className="dim">No real learners synced yet.</p>}
      </section>

      <section className="rp-card">
        <h2><Icon name="activity" size={15} />All Floor &amp; Workflow Runs</h2>
        {r?.runs.length ? (
          <div className="rp-table">
            {r.runs.map((t) => (
              <div key={t.id} className="rp-row">
                <b>{time(t.at)}</b>
                <span>{t.office} · {t.trigger}</span>
                <span>{t.detail}</span>
                <span className="dim">{dur(t.ms)}</span>
              </div>
            ))}
          </div>
        ) : <p className="dim">No workflow runs in this period.</p>}
      </section>
    </main>
  );
}

