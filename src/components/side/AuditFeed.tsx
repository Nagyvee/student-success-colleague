'use client';

import { useEffect, useRef, useState } from 'react';
import type { FeedActor, FeedEntry, FeedLevel } from '@/lib/types';
import { AGENT_BY_ID } from '@/lib/office/layout';
import Icon, { type IconName } from '@/components/Icon';

/* Every thought, draft, critique, fix and dispatch, as it happens. */

const ACTOR_LABEL: Record<FeedActor, string> = {
  planner: 'Planner', success: 'Student Success', learning: 'Learning & Assessment', coo: 'Reviewer',
  system: 'Colleague', lms: 'LMS', student: 'Learner', person: 'You',
};

const LEVEL_ICON: Record<FeedLevel, IconName> = {
  system: 'radio', think: 'brain', info: 'chat', route: 'arrowRight', plan: 'list', draft: 'file', audit: 'scanSearch', error: 'warn', fix: 'wrench',
  approve: 'badgeCheck', dispatch: 'send', lms: 'database', email: 'mail', score: 'award',
};

const LEVEL_TAG: Partial<Record<FeedLevel, string>> = { plan: 'Plan', error: 'Sent back', approve: 'Approved', fix: 'Self-corrected', dispatch: 'Sent', score: 'Score synced' };

const fmt = (ts: number) => new Date(ts).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function AuditFeed({ feed, onInspect }: { feed: FeedEntry[]; onInspect: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const [filter, setFilter] = useState<'all' | 'coo' | 'issues'>('all');
  const [showJson, setShowJson] = useState(false);
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const el = ref.current?.parentElement; // .side-body scrolls
    if (!el) return;
    const onScroll = () => setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (el && stuck) el.scrollTop = el.scrollHeight;
  }, [feed.length, stuck, filter]);

  const shown = feed.filter((f) => filter === 'all' ? true : filter === 'coo' ? f.actor === 'coo' : ['error', 'fix', 'approve', 'score'].includes(f.level));

  return (
    <div ref={ref} className="feed">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
        <div className="seg">
          <button type="button" className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
          <button type="button" className={filter === 'coo' ? 'on' : ''} onClick={() => setFilter('coo')}>Reviewer</button>
          <button type="button" className={filter === 'issues' ? 'on' : ''} onClick={() => setFilter('issues')}>Errors &amp; fixes</button>
        </div>
        <button type="button" className={`fi-json-toggle${showJson ? ' on' : ''}`} onClick={() => setShowJson((v) => !v)} title="Show raw JSON tool calls behind each step">
          {'{ } JSON'}
        </button>
      </div>
      {shown.length === 0 && <div className="feed-empty">Nothing yet. Run a scenario from the playbook and watch the office work.</div>}
      {shown.map((f) => {
        const jsonOpen = Boolean(f.toolCall && (showJson || openIds[f.id]));
        return (
          <div key={f.id} className={`fi is-${f.level}`}>
            <span className="fi-time">{fmt(f.ts)}</span>
            <div>
              <div className="fi-head">
                <Icon name={LEVEL_ICON[f.level]} size={12} strokeWidth={2.4} />
                <span>{f.actor in AGENT_BY_ID ? `${AGENT_BY_ID[f.actor as keyof typeof AGENT_BY_ID].name} · ${ACTOR_LABEL[f.actor]}` : ACTOR_LABEL[f.actor]}</span>
                {LEVEL_TAG[f.level] && <span className="fi-tag">{LEVEL_TAG[f.level]}</span>}
              </div>
              <div className="fi-text">{linkify(f.text)}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {f.deliverableId && (f.level === 'draft' || f.level === 'approve' || f.level === 'error' || f.level === 'fix' || f.level === 'dispatch' || f.level === 'score') && (
                  <button type="button" className="fi-act" onClick={() => onInspect(f.deliverableId as string)}><Icon name="eye" size={12} />Inspect deliverable</button>
                )}
                {f.toolCall && (
                  <button type="button" className="fi-tool-btn" onClick={() => setOpenIds((m) => ({ ...m, [f.id]: !jsonOpen }))}>
                    {'{ } '}{f.toolCall.tool}
                  </button>
                )}
              </div>
              {jsonOpen && f.toolCall && (
                <pre className="fi-json">{JSON.stringify({ tool: f.toolCall.tool, ...(typeof f.toolCall.payload === 'object' && f.toolCall.payload ? f.toolCall.payload : { data: f.toolCall.payload }) }, null, 2)}</pre>
              )}
            </div>
          </div>
        );
      })}
      {!stuck && shown.length > 6 && (
        <button type="button" className="feed-jump" onClick={() => { const el = ref.current?.parentElement; if (el) el.scrollTop = el.scrollHeight; setStuck(true); }}>
          <Icon name="chevronRight" size={12} style={{ transform: 'rotate(90deg)' }} />Jump to latest
        </button>
      )}
    </div>
  );
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s"]+)/g);
  return parts.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer">{p.replace(/^https?:\/\//, '')}</a> : <span key={i}>{p}</span>));
}
