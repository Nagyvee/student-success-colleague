'use client';

import type { WorldState } from '@/lib/types';
import Icon, { type IconName } from '@/components/Icon';
import PlanCard from '@/components/office/PlanCard';
import AuditFeed from './AuditFeed';
import DeliverablesPanel from './DeliverablesPanel';
import InboxPanel from './InboxPanel';
import LearnersPanel from './LearnersPanel';

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

export default function Sidebar({ state, tab, onInspect, onOpenMail, onClose }: {
  state: WorldState | null; tab: SideTab; onInspect: (id: string) => void; onOpenMail: (id: string) => void; onClose: () => void;
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
        {tab === 'feed' && <AuditFeed feed={state?.feed || []} onInspect={onInspect} />}
        {tab === 'deliverables' && <DeliverablesPanel deliverables={state?.deliverables || []} onInspect={onInspect} />}
        {tab === 'inbox' && <InboxPanel inbox={state?.inbox || []} onOpen={onOpenMail} onInspect={onInspect} />}
        {tab === 'learners' && <LearnersPanel learners={state?.learners || []} />}
      </div>
    </div>
  );
}
