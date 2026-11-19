'use client';

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import type { AgentRun, AgentRunLog, DataSource } from '@/lib/types';
import Icon, { type IconName } from '@/components/Icon';
import {
  ACTIVE_STATUSES,
  RUN_STATUS_LABEL,
  agentNow,
  agoLabel,
  initials,
  triggerLabel,
  whenLabel,
  type DepartmentRow,
} from './buildingData';

/* Inside a floor: one department at work.
 *
 * The department's purpose and what it is responsible for, each agent at a
 * desk with what it is doing right now (from its latest run), the sheets the
 * department reads, and a live list of the department's recent runs. A desk
 * opens that agent's workflow in the builder. */

interface Props {
  department: DepartmentRow;
  floorNumber: number;
  totalFloors: number;
  sources: DataSource[];
  /** This department's runs, newest first (light: last few log lines). */
  runs: AgentRun[];
  /** Messages from this department waiting for a person to approve. */
  pendingApprovals: number;
  /** Back to the walk-in office. */
  onOpenLiveRoom?: () => void;
  insetRight?: number;
  children?: ReactNode;
}

const ICONS: Record<string, IconName> = {
  chat: 'chat', send: 'send', users: 'users', book: 'book', chart: 'chart', building: 'building', wallet: 'wallet', graduation: 'graduation',
};

const MOOD_LABEL: Record<string, string> = {
  working: 'At work', waiting: 'Waiting', approval: 'Needs approval', idle: 'Idle', error: 'Error', done: 'Just finished',
};

const LOG_ICON: Record<AgentRunLog['status'], IconName> = { ok: 'ok', info: 'circle', wait: 'clock', fail: 'warn', skip: 'chevronRight' };

export default function CustomOfficeStage({
  department,
  floorNumber,
  totalFloors,
  sources,
  runs,
  pendingApprovals,
  onOpenLiveRoom,
  insetRight = 0,
  children,
}: Props) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [fullLogs, setFullLogs] = useState<Record<string, AgentRunLog[]>>({});
  const [filter, setFilter] = useState<'all' | 'active' | 'done'>('all');
  const now = Date.now();
  const color = department.color || '#2563eb';
  const icon = ICONS[department.icon || ''] || 'building';

  const stats = useMemo(() => {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    return {
      working: runs.filter((r) => r.status === 'running').length,
      waiting: runs.filter((r) => r.status === 'waiting').length,
      doneToday: runs.filter((r) => r.status === 'completed' && (r.endedAt || 0) >= startOfDay.getTime()).length,
      failed: runs.filter((r) => r.status === 'failed' && (r.endedAt || r.updatedAt) > now - 86_400_000).length,
    };
  }, [runs, now]);

  const mySources = sources.filter((s) => s.departmentId === department.id || department.agents.some((a) => a.workflow?.agentTrigger?.sourceId === s.id));
  const shownRuns = runs.filter((r) => filter === 'all' || (filter === 'active' ? ACTIVE_STATUSES.includes(r.status) : !ACTIVE_STATUSES.includes(r.status))).slice(0, 40);
  const agentColor = (id: string | null) => department.agents.find((a) => a.id === id)?.color || color;

  async function toggleRun(id: string) {
    if (openRun === id) { setOpenRun(null); return; }
    setOpenRun(id);
    if (!fullLogs[id]) {
      try {
        const res = await fetch(`/api/departments?run=${encodeURIComponent(id)}`, { cache: 'no-store' });
        const j = await res.json();
        if (res.ok && j.run?.logs) setFullLogs((m) => ({ ...m, [id]: j.run.logs as AgentRunLog[] }));
      } catch { /* the short log is still shown */ }
    }
  }

  return (
    <div className={`dept-floor${insetRight ? ' has-drawer' : ''}`} style={{ '--dept': color, '--inset': `${insetRight}px` } as CSSProperties}>
      {children && <div className="dept-top">{children}</div>}

      <div className="dept-scroll">
        {/* The department */}
        <header className="dept-hero">
          <div className="dept-hero-main">
            <span className="dept-floor-badge" title={`Floor ${floorNumber} of ${totalFloors}`}>
              <Icon name={icon} size={18} />
              <b>F{floorNumber}</b>
            </span>
            <div className="dept-hero-text">
              <h1>{department.name}</h1>
              <p>{department.purpose}</p>
              {!!department.responsibilities?.length && (
                <ul className="dept-resp" aria-label="Responsibilities">
                  {department.responsibilities.map((r) => <li key={r}>{r}</li>)}
                </ul>
              )}
            </div>
          </div>
          <div className="dept-hero-side">
            <div className="dept-stats">
              <span><b>{department.agents.length}</b>agents</span>
              <span className={stats.working ? 'is-on' : ''}><b>{stats.working}</b>at work</span>
              <span><b>{stats.waiting}</b>waiting</span>
              <span className={pendingApprovals ? 'is-warn' : ''}><b>{pendingApprovals}</b>to approve</span>
              <span><b>{stats.doneToday}</b>done today</span>
              {stats.failed > 0 && <span className="is-bad"><b>{stats.failed}</b>failed</span>}
            </div>
            <div className="dept-actions">
              <Link className="btn btn-sm dept-btn-primary" href={`/workflows?department=${encodeURIComponent(department.id)}`}>
                <Icon name="flow" size={14} /> Manage agents &amp; workflows
              </Link>
              {onOpenLiveRoom && (
                <button type="button" className="btn btn-sm dept-btn-ghost" onClick={onOpenLiveRoom}>
                  <Icon name="building" size={14} /> Walk into the office
                </button>
              )}
            </div>
          </div>
        </header>

        {/* The desks */}
        <section className="dept-section" aria-label="Agents">
          <div className="dept-section-h">
            <h2><Icon name="users" size={15} /> The team on this floor</h2>
            <span className="dept-hint">Click a desk to open that agent&apos;s workflow.</span>
          </div>
          {department.agents.length === 0 ? (
            <div className="dept-empty">
              <Icon name="users" size={22} />
              <p>No agents on this floor yet.</p>
              <Link className="btn btn-sm dept-btn-primary" href={`/workflows?department=${encodeURIComponent(department.id)}`}><Icon name="plus" size={14} /> Add an agent</Link>
            </div>
          ) : (
            <div className="desk-grid">
              {department.agents.map((a) => {
                const st = agentNow(a, now);
                const href = a.workflow ? `/workflows/${encodeURIComponent(a.workflow.id)}` : `/workflows?department=${encodeURIComponent(department.id)}`;
                const steps = a.workflow?.steps?.length || 0;
                return (
                  <Link key={a.id} href={href} className={`desk mood-${st.mood}`} style={{ '--ag': a.color || color } as CSSProperties}>
                    <div className="desk-scene" aria-hidden="true">
                      <span className="desk-window" />
                      <span className="desk-monitor"><i /><i /><i /></span>
                      <span className="desk-table" />
                      <span className="desk-avatar">{initials(a.name)}</span>
                      <span className="desk-light" />
                    </div>
                    <div className="desk-body">
                      <div className="desk-name">
                        <b>{a.name}</b>
                        <span className={`desk-mood mood-${st.mood}`}>{MOOD_LABEL[st.mood]}</span>
                      </div>
                      <em className="desk-title">{a.title}</em>
                      <p className="desk-now"><i />{st.text}</p>
                      <p className="desk-trigger"><Icon name="zap" size={12} />{triggerLabel(a.workflow?.agentTrigger, sources)}</p>
                      {!!a.responsibilities?.length && (
                        <ul className="desk-resp">{a.responsibilities.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
                      )}
                      <div className="desk-foot">
                        <span>{steps} step{steps === 1 ? '' : 's'}</span>
                        <span>{a.activeRuns} active</span>
                        <span>{a.workflow?.runs || 0} run{(a.workflow?.runs || 0) === 1 ? '' : 's'}</span>
                        <span className="desk-open">Open <Icon name="arrowRight" size={12} /></span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* What the floor reads */}
        {mySources.length > 0 && (
          <section className="dept-section" aria-label="Data this department reads">
            <div className="dept-section-h">
              <h2><Icon name="sheet" size={15} /> What this floor reads</h2>
              <Link className="dept-hint dept-link" href="/workspace#data-sources">Manage data sources <Icon name="arrowRight" size={12} /></Link>
            </div>
            <div className="dept-sources">
              {mySources.map((s) => {
                const connected = Boolean(s.url) || s.id === 'src_leads' || (s.id === 'src_moodle' && (s.rows ?? 0) > 0);
                return (
                  <div key={s.id} className={`dept-source${s.lastError ? ' is-bad' : connected ? '' : ' is-off'}`}>
                    <Icon name={s.kind === 'leads' ? 'inbox' : 'sheet'} size={16} />
                    <div>
                      <b>{s.name}</b>
                      <span>
                        {s.lastError
                          ? s.lastError
                          : !connected
                            ? (s.id === 'src_moodle' ? 'Fills in by itself after the first Moodle sync' : 'Not connected yet: paste the Google Sheet link in Channels & API')
                            : `${s.rows ?? 0} ${s.id === 'src_moodle' ? 'students' : 'rows'}${s.url ? ` · read ${agoLabel(s.lastReadAt, now)}` : s.id === 'src_moodle' ? ' · from the Moodle sync' : ' · fed by the leads webhook'}`}
                      </span>
                    </div>
                    {!connected && <Link className="btn btn-sm dept-btn-ghost" href="/workspace#data-sources">Connect</Link>}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* The work */}
        <section className="dept-section" aria-label="Recent runs">
          <div className="dept-section-h">
            <h2><Icon name="activity" size={15} /> Recent work</h2>
            <div className="dept-seg" role="tablist" aria-label="Filter runs">
              {(['all', 'active', 'done'] as const).map((f) => (
                <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === 'active' ? 'In progress' : 'Finished'}
                </button>
              ))}
            </div>
          </div>
          {shownRuns.length === 0 ? (
            <div className="dept-empty">
              <Icon name="clock" size={22} />
              <p>{filter === 'active' ? 'Nothing in progress right now.' : 'No runs yet on this floor. Agents start by themselves when autopilot is on, or when someone presses Run in the builder.'}</p>
            </div>
          ) : (
            <ul className="run-list">
              {shownRuns.map((r) => {
                const logs = fullLogs[r.id] || r.logs || [];
                const last = (r.logs || [])[r.logs.length - 1];
                const open = openRun === r.id;
                return (
                  <li key={r.id} className={`run-row st-${r.status}${open ? ' is-open' : ''}`}>
                    <button type="button" className="run-head" onClick={() => void toggleRun(r.id)} aria-expanded={open}>
                      <span className="run-dot" style={{ background: agentColor(r.agentId) }}>{initials(r.agentName)}</span>
                      <span className="run-who">
                        <b>{r.record.name}</b>
                        <em>{r.agentName} · {r.workflowName}</em>
                      </span>
                      <span className="run-last">{last?.detail || r.trigger}</span>
                      <span className={`run-pill st-${r.status}`}>
                        {r.status === 'waiting' && r.resumeAt ? `Until ${whenLabel(r.resumeAt, now)}` : RUN_STATUS_LABEL[r.status]}
                      </span>
                      <span className="run-when">{agoLabel(r.updatedAt, now)}</span>
                      <Icon name="chevronRight" size={14} />
                    </button>
                    {open && (
                      <div className="run-body">
                        <p className="run-meta">
                          Started by {r.trigger} · {whenLabel(r.startedAt, now)}
                          {r.record.email ? ` · ${r.record.email}` : ''}
                          {r.record.phone ? ` · ${r.record.phone}` : ''}
                        </p>
                        <ol className="run-logs">
                          {logs.map((l, i) => (
                            <li key={`${l.ts}-${i}`} className={`lg-${l.status}`}>
                              <Icon name={LOG_ICON[l.status]} size={13} />
                              <div>
                                <b>{l.title}</b>
                                <span>{l.detail}</span>
                                {l.output && <pre>{l.output}</pre>}
                              </div>
                              <time>{whenLabel(l.ts, now)}</time>
                            </li>
                          ))}
                        </ol>
                        {r.workflowId && <Link className="dept-link" href={`/workflows/${encodeURIComponent(r.workflowId)}`}>Open this agent&apos;s workflow <Icon name="arrowRight" size={12} /></Link>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
