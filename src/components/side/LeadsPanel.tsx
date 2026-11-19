'use client';

import { useEffect, useMemo, useState } from 'react';
import Icon from '@/components/Icon';
import { leadStage } from '@/lib/nurture/stage';

/* The leads Admissions is nurturing, by stage: new, warming up, hot,
 * qualified (handed to the sales team), and those who asked us to stop.
 * Read from the leads list every 20 seconds while the drawer is open. */

interface LeadRow {
  key: string; name: string; programme: string; channel: string; score: number;
  engagement: 'cold' | 'warm' | 'hot'; qualified: boolean; optedOut: boolean; status: string;
  sent: number; opens: number; clicks: number; lastClicked: string; fit: string; dialer: string;
}

// The same stages as Lead Nurturing (one definition on the server).
type Stage = 'all' | 'qualified' | 'hot' | 'warm' | 'cold' | 'applied' | 'opted_out';
const STAGES: { id: Stage; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'qualified', label: 'Qualified' }, { id: 'hot', label: 'Hot' },
  { id: 'warm', label: 'Warming up' }, { id: 'cold', label: 'New' }, { id: 'applied', label: 'Applied' }, { id: 'opted_out', label: 'Stopped' },
];

const stageOf = (l: LeadRow): Exclude<Stage, 'all'> => leadStage(l);
const BADGE: Record<Exclude<Stage, 'all'>, { cls: string; label: string }> = {
  qualified: { cls: 'badge-good', label: 'Qualified' },
  applied: { cls: 'badge-good', label: 'Applied' },
  hot: { cls: 'badge-bad', label: 'Hot' },
  warm: { cls: 'badge-warn', label: 'Warming up' },
  cold: { cls: 'badge-soft', label: 'New' },
  opted_out: { cls: 'badge-mute', label: 'Stopped' },
};

export default function LeadsPanel() {
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  const [totals, setTotals] = useState<Record<Stage, number> | null>(null);
  const [stage, setStage] = useState<Stage>('all');
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/nurture?leads=1', { cache: 'no-store' }).then((r) => r.json()).then((j) => { if (live) { setRows(j.leads || []); setTotals(j.counts || null); } }).catch(() => { if (live) setRows([]); });
    load();
    const t = setInterval(load, 20_000);
    return () => { live = false; clearInterval(t); };
  }, []);

  // Every lead by stage, from the server (the list itself is the 300 most engaged).
  const counts = useMemo(() => {
    if (totals) return totals;
    const c: Record<Stage, number> = { all: 0, qualified: 0, hot: 0, warm: 0, cold: 0, applied: 0, opted_out: 0 };
    for (const l of rows || []) { c.all++; c[stageOf(l)]++; }
    return c;
  }, [rows, totals]);

  const shown = (rows || [])
    .filter((l) => stage === 'all' || stageOf(l) === stage)
    .filter((l) => !q || `${l.name} ${l.programme} ${l.channel}`.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 120);

  if (!rows) return <div className="feed-empty">Loading the leads…</div>;

  return (
    <div className="list">
      <div className="seg" style={{ flexWrap: 'wrap' }}>
        {STAGES.map((s) => (
          <button key={s.id} type="button" className={stage === s.id ? 'on' : ''} onClick={() => setStage(s.id)}>
            {s.label} <span className="faint">{counts[s.id]}</span>
          </button>
        ))}
      </div>
      <input className="in" placeholder="Search a name, programme or source" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search leads" />
      {!shown.length && <div className="feed-empty">{rows.length ? 'No leads at this stage.' : 'No leads yet. New leads from the leads sheet appear here as Admissions starts nurturing them.'}</div>}
      {shown.map((l) => {
        const st = stageOf(l);
        return (
          <a key={l.key} className={`lrow lead-row is-${st}`} href={`/nurture?tab=leads&q=${encodeURIComponent(l.name)}`}>
            <div className="lrow-t"><b>{l.name}</b><span>{[l.programme, l.channel].filter(Boolean).join(' · ') || 'Programme not chosen yet'}</span></div>
            <span className={`badge ${BADGE[st].cls}`}><span className="dot" />{BADGE[st].label}</span>
            <div className="lrow-risk">
              <span className={`meter ${l.score >= 8 ? 'is-good' : l.score >= 3 ? 'is-warn' : ''}`}><span style={{ width: `${Math.min(100, (l.score / 12) * 100)}%` }} /></span>
              <b className="num">{l.score}</b>
            </div>
            <div className="lrow-stats">
              <span>Emails <b>{l.sent}</b></span>
              <span>Opened <b>{l.opens}</b></span>
              <span>Clicked <b>{l.clicks}</b></span>
              {l.fit && <span>Quiz <b>{l.fit.split(' → ')[0]}</b></span>}
            </div>
            {(l.qualified && l.dialer) || l.lastClicked ? (
              <div className="lrow-ev"><Icon name={l.qualified ? 'phoneCall' : 'activity'} size={12} />{l.qualified && l.dialer ? `Dialer: ${l.dialer}` : `Last opened ${l.lastClicked}`}</div>
            ) : null}
          </a>
        );
      })}
    </div>
  );
}
