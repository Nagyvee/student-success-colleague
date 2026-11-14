'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { WorldState } from '@/lib/types';
import Icon from '@/components/Icon';
import { LogoMark } from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';

/* The top bar. Nothing to type: Thuso is always on. It shows what the
 * colleague is watching, the last thing that happened, and what it is doing
 * now; the learner records and settings are one click away. The planted test
 * error is labelled here, in plain sight. */

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
};

export default function GoalBar({ state, stage, onExitStage, right }: { state: WorldState; stage: boolean; onExitStage: () => void; right?: ReactNode }) {
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 5000); return () => clearInterval(t); }, []);
  const running = state.tasks.find((t) => t.status === 'running') || null;
  const a = state.automation;
  const watching = ['LMS', a?.sheet.connected && !a.sheet.lastError ? 'Google Sheet' : null].filter(Boolean).join(' + ');
  const next = a?.schedule.nextAt ? new Date(a.schedule.nextAt).toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const queued = a?.queued || 0;

  return (
    <div className="cmd-bar goal-bar">
      <div className="cmd-group goal-brand">
        <LogoMark size={26} />
        <span><b>Thuso</b><em>Student success colleague</em></span>
      </div>

      <div className={`cmd-group live-pill${running ? ' is-working' : ''}`} aria-live="polite">
        <i className="live-dot" />
        {running ? (
          <span><b>Working</b><em>{running.trigger?.label || running.subject}</em>{queued ? <em className="q">+{queued} waiting</em> : null}</span>
        ) : (
          <span>
            <b>Always on</b>
            <em>Watching the {watching}{next ? ` · weekly sweep ${next}` : ''}</em>
            {a?.lastEvent && <em className="last">Last: {a.lastEvent.learner}, {a.lastEvent.detail} · {ago(a.lastEvent.at)}</em>}
          </span>
        )}
      </div>

      <div className="cmd-group">
        <Link href="/lms" target="_blank" className="cmd-btn" title="The learner records Thuso watches. Change a mark there and Thuso starts by itself."><Icon name="database" size={14} /><span className="tab-l">Learner records</span></Link>
        <Link href="/reports" className="cmd-btn" title="Musa's reports: what happened at your school"><Icon name="chart" size={15} /><span className="tab-l">Reports</span></Link>
        <Link href="/settings" className="cmd-btn" title="Agents, triggers, email and presenting"><Icon name="gear" size={15} /><span className="tab-l">Settings</span></Link>
        <ThemeToggle className="iconbtn theme-btn" />
      </div>

      {right}
      {stage && <button type="button" className="cmd-group cmd-btn cmd-exit" onClick={onExitStage}><Icon name="shrink" size={14} />Exit stage</button>}
    </div>
  );
}
