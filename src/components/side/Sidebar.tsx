'use client';

import type { WorldState } from '@/lib/types';
import Icon, { type IconName } from '@/components/Icon';
import PlanCard from '@/components/office/PlanCard';
import AuditFeed from './AuditFeed';
import DeliverablesPanel from './DeliverablesPanel';
import InboxPanel from './InboxPanel';
import LearnersPanel from './LearnersPanel';
import type { CSSProperties } from 'react';
import type { TagOf } from '@/components/office/deptScope';

/** Which department the drawer shows. On the building it can be changed; inside a department it is that department. */
export interface DrawerScope {
  departments: { id: string; name: string; color: string }[];
  current: string | null;
  locked: boolean;
  onPick?: (id: string | null) => void;
}

export type SideTab = 'plan' | 'feed' | 'deliverables' | 'inbox' | 'learners';

export const TABS: { id: SideTab; label: string; icon: IconName }[] = [
  { id: 'plan', label: 'Plan', icon: 'list' },
  { id: 'feed', label: 'Activity', icon: 'activity' },
  { id: 'deliverables', label: 'Outputs', icon: 'file' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'learners', label: 'Learners', icon: 'graduation' },
];

/* One drawer, opened from the floor's tabs only when it is wanted: the
 * Planner's plan, every step the colleague took, what it wrote, what it sent,
 * and the cohort. */

export default function Sidebar({ state, tab, onInspect, onOpenMail, onClose, scope, tagOf }: {
  state: WorldState | null; tab: SideTab; onInspect: (id: string) => void; onOpenMail: (id: string) => void; onClose: () => void;
  scope?: DrawerScope;
  /** A department label per item (only when the drawer shows every department). */
  tagOf?: TagOf;
}) {
  const t = TABS.find((x) => x.id === tab) || TABS[0];
  const task = state?.tasks.find((x) => x.status === 'running') || state?.tasks[0] || null;
  const m = state?.metrics;
  return (
    <div className="side-panel drawer-panel">
      <div className="side-head">
        <span className="side-title"><Icon name={t.icon} size={15} />{t.label}</span>
        <button type="button" className="iconbtn" style={{ width: 30, height: 30 }} onClick={onClose} title="Close" aria-label="Close"><Icon name="x" size={16} /></button>
      </div>
      {scope && tab !== 'learners' && (
        scope.locked ? (
          <div className="dept-filter">
            {(() => { const d = scope.departments.find((x) => x.id === scope.current); return d ? <span className="dept-only" style={{ '--c': d.color } as CSSProperties}><i />Only {d.name}</span> : null; })()}
          </div>
        ) : (
          <div className="dept-filter" role="group" aria-label="Show department">
            <button type="button" className={!scope.current ? 'on' : ''} onClick={() => scope.onPick?.(null)}>All departments</button>
            {scope.departments.map((d) => (
              <button key={d.id} type="button" className={scope.current === d.id ? 'on' : ''} style={{ '--c': d.color } as CSSProperties} onClick={() => scope.onPick?.(d.id)}>
                <i aria-hidden="true" />{d.name}
              </button>
            ))}
          </div>
        )
      )}
      {tab === 'feed' && (
        <div className="side-stats">
          <div className="sstat"><span className="mini">Approved</span><b className="num">{m?.approved ?? 0}</b></div>
          <div className="sstat"><span className="mini">Sent back</span><b className="num">{m?.corrections ?? 0}</b></div>
          <div className="sstat"><span className="mini">Sent</span><b className="num">{m?.dispatched ?? 0}</b></div>
          <div className="sstat"><span className="mini">Quizzes done</span><b className="num">{m?.quizzesCompleted ?? 0}</b></div>
        </div>
      )}
      <div className="side-body">
        {tab === 'plan' && (task?.plan
          ? <PlanCard task={task} open onToggle={() => {}} flat />
          : <div className="feed-empty">No plan yet. Give the colleague a goal and the Planner writes one here.</div>)}
        {tab === 'feed' && <AuditFeed feed={state?.feed || []} onInspect={onInspect} tagOf={tagOf?.feed} />}
        {tab === 'deliverables' && <DeliverablesPanel deliverables={state?.deliverables || []} onInspect={onInspect} tagOf={tagOf?.deliverable} />}
        {tab === 'inbox' && <InboxPanel inbox={state?.inbox || []} pending={(state?.pendingOutreach || []).filter((p) => p.status === 'pending')} onOpen={onOpenMail} onInspect={onInspect} paused={Boolean(state?.caps.sendingPaused)} tagOf={tagOf} />}
        {tab === 'learners' && <LearnersPanel learners={state?.learners || []} />}
      </div>
    </div>
  );
}
