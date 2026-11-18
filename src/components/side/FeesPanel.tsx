'use client';

import { useEffect, useMemo, useState } from 'react';
import Icon from '@/components/Icon';

/* The people on the fees tracker, the way the finance team reads it:
 * blocked, behind, payment due, up to date, not active. Straight from the
 * tracker sheet (all its tabs), refreshed every 30 seconds while open. */

interface TrackerRow { key: string; name: string; email: string; phone: string; fields: Record<string, string> }

type Stage = 'all' | 'blocked' | 'behind' | 'due' | 'paid' | 'inactive' | 'unknown';
const STAGES: { id: Stage; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'blocked', label: 'Blocked' }, { id: 'behind', label: 'Behind' }, { id: 'due', label: 'Payment due' },
  { id: 'paid', label: 'Up to date' }, { id: 'inactive', label: 'Not active' }, { id: 'unknown', label: 'Not clear' },
];
const BADGE: Record<Exclude<Stage, 'all'>, { cls: string; label: string }> = {
  blocked: { cls: 'badge-bad', label: 'Blocked' },
  behind: { cls: 'badge-warn', label: 'Behind' },
  due: { cls: 'badge-soft', label: 'Payment due' },
  paid: { cls: 'badge-good', label: 'Up to date' },
  inactive: { cls: 'badge-mute', label: 'Not active' },
  unknown: { cls: 'badge-mute', label: 'Not clear' },
};

const BLOCKED = /\bblocked\b/i; // "Unblocked" does not match

function stageOf(f: Record<string, string>): Exclude<Stage, 'all'> {
  if ([f.blocked_status, f.payment_status, f.student_status, f.account_comments].some((v) => BLOCKED.test(v || ''))) return 'blocked';
  switch (f.payment_state) {
    case 'overdue': return 'behind';
    case 'due': case 'arrangement': return 'due';
    case 'paid': return 'paid';
    case 'inactive': return 'inactive';
    default: return 'unknown';
  }
}

const ORDER: Exclude<Stage, 'all'>[] = ['blocked', 'behind', 'due', 'unknown', 'paid', 'inactive'];

export default function FeesPanel() {
  const [rows, setRows] = useState<TrackerRow[] | null>(null);
  const [stage, setStage] = useState<Stage>('all');
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/departments?records=src_tracker&limit=2000', { cache: 'no-store' })
      .then((r) => r.json()).then((j) => { if (live) setRows(j.records || []); }).catch(() => { if (live) setRows([]); });
    load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const withStage = useMemo(() => (rows || []).map((r) => ({ r, st: stageOf(r.fields) }))
    .sort((a, b) => ORDER.indexOf(a.st) - ORDER.indexOf(b.st) || a.r.name.localeCompare(b.r.name)), [rows]);
  const counts = useMemo(() => {
    const c: Record<Stage, number> = { all: 0, blocked: 0, behind: 0, due: 0, paid: 0, inactive: 0, unknown: 0 };
    for (const x of withStage) { c.all++; c[x.st]++; }
    return c;
  }, [withStage]);

  if (!rows) return <div className="feed-empty">Loading the fees tracker…</div>;
  if (!rows.length) return <div className="feed-empty">No one from the fees tracker yet. Connect the tracker sheet in Agents &amp; Workflows → Data sources.</div>;

  const shown = withStage
    .filter((x) => stage === 'all' || x.st === stage)
    .filter((x) => !q || `${x.r.name} ${x.r.email} ${x.r.phone}`.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 150);

  return (
    <div className="list">
      <div className="seg" style={{ flexWrap: 'wrap' }}>
        {STAGES.map((s) => (
          <button key={s.id} type="button" className={stage === s.id ? 'on' : ''} onClick={() => setStage(s.id)}>
            {s.label} <span className="faint">{counts[s.id]}</span>
          </button>
        ))}
      </div>
      <input className="in" placeholder="Search a name, email or number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the fees tracker" />
      {!shown.length && <div className="feed-empty">Nobody here.</div>}
      {shown.map(({ r, st }) => {
        const f = r.fields;
        const owed = f.outstanding_balance || f.amount_due_display || '';
        return (
          <div key={r.key} className={`lrow fee-row is-${st}`}>
            <div className="lrow-t"><b>{r.name}</b><span>{[f.course_duration || f.programme, f.payment_plan].filter(Boolean).join(' · ') || r.email}</span></div>
            <span className={`badge ${BADGE[st].cls}`}><span className="dot" />{BADGE[st].label}</span>
            <div className="lrow-stats">
              {owed && <span>Outstanding <b>{owed}</b></span>}
              {f.amount_due_display && st !== 'paid' && <span>Due <b>{f.amount_due_display}</b>{f.due_date_display ? ` · ${f.due_date_display}` : ''}</span>}
              {f.last_payment_date && <span>Last paid <b>{f.last_payment_date}</b></span>}
            </div>
            {(f.payment_status || f.account_comments) && (
              <div className="lrow-ev"><Icon name="wallet" size={12} />{[f.payment_status, f.account_comments].filter((v, i, a) => v && a.indexOf(v) === i).join(' · ')}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
