'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import Icon, { type IconName } from '@/components/Icon';
import type { CheckGroup, CheckState } from '@/lib/readiness';

type Data = { groups: CheckGroup[]; summary: { ok: number; todo: number; optional: number }; testPhase: boolean };

const STATE: Record<CheckState, { icon: IconName; label: string }> = {
  ok: { icon: 'ok', label: 'Ready' },
  todo: { icon: 'warn', label: 'To do' },
  optional: { icon: 'circle', label: 'Optional' },
  info: { icon: 'shield', label: 'Note' },
};

export default function GoLiveClient() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/golive', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The list to paste into a note: only what still needs doing, grouped.
  const asNote = () => {
    if (!data) return '';
    const lines: string[] = ['Thuso go-live: what still needs connecting', ''];
    for (const g of data.groups) {
      const todo = g.checks.filter((c) => c.state === 'todo' || c.state === 'optional');
      if (!todo.length) continue;
      lines.push(g.title);
      for (const c of todo) lines.push(`[ ] ${c.label}${c.state === 'optional' ? ' (optional)' : ''}: ${c.fix || c.detail}`);
      lines.push('');
    }
    return lines.join('\n').trim();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asNote());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked */ }
  };

  if (error) return <div className="pg-err"><Icon name="warn" size={15} /> Could not read the checklist: {error}</div>;
  if (!data) return <div className="gl-loading"><Icon name="spinner" size={16} className="spin" /> Reading the workspace…</div>;

  const total = data.summary.ok + data.summary.todo;
  const pct = total ? Math.round((data.summary.ok / total) * 100) : 0;

  return (
    <div className="gl">
      <section className="gl-head pg-card">
        <div className="gl-score">
          <div className="gl-ring" style={{ ['--p' as string]: `${pct}` }} aria-label={`${pct}% ready`}><b>{pct}%</b></div>
          <div>
            <h2>{data.summary.todo ? `${data.summary.todo} thing${data.summary.todo === 1 ? '' : 's'} to connect` : 'Everything required is connected'}</h2>
            <p className="pg-sub">{data.summary.ok} ready · {data.summary.optional} optional. {data.testPhase ? 'Test phase: agents work, and every message to a student or lead waits for a person to approve it.' : 'Agents send approved messages by themselves.'}</p>
          </div>
        </div>
        <div className="pg-actions">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}><Icon name="refresh" size={13} /> Check again</button>
          <button type="button" className="btn btn-cta btn-sm" onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy the to-do list'}</button>
        </div>
      </section>

      {data.groups.map((g) => {
        const todo = g.checks.filter((c) => c.state === 'todo').length;
        return (
          <section key={g.id} className="pg-card gl-group">
            <div className="pg-card-h">
              <div>
                <h2>{g.title}</h2>
                <p className="pg-sub">{g.purpose}</p>
              </div>
              <span className={`gl-pill ${todo ? 'is-todo' : 'is-ok'}`}>{todo ? `${todo} to do` : 'Ready'}</span>
            </div>
            <ul className="gl-list">
              {g.checks.map((c) => (
                <li key={c.id} className={`gl-item is-${c.state}`}>
                  <span className="gl-ic" title={STATE[c.state].label}><Icon name={STATE[c.state].icon} size={17} /></span>
                  <div className="gl-body">
                    <b>{c.label}</b>
                    <span className="gl-detail">{c.detail}</span>
                    {c.fix && c.state !== 'ok' && <span className="gl-fix">{c.fix}</span>}
                  </div>
                  {c.href && c.state !== 'ok' && <Link className="btn btn-ghost btn-sm gl-go" href={c.href}>Open <Icon name="arrowRight" size={12} /></Link>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
