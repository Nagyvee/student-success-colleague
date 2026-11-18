'use client';

import type { Deliverable, DeliverableKind, DeliverableStatus } from '@/lib/types';
import Icon, { type IconName } from '@/components/Icon';

export const KIND_ICON: Record<DeliverableKind, IconName> = { catchup_plan: 'clipboard', remedial_quiz: 'book', checkin_message: 'mail', agent_message: 'mail' };
export const KIND_LABEL: Record<DeliverableKind, string> = { catchup_plan: 'Catch-up plan', remedial_quiz: 'Catch-up quiz', checkin_message: 'Check-in', agent_message: 'Agent message' };

export function StatusBadge({ status }: { status: DeliverableStatus }) {
  const map: Record<DeliverableStatus, { cls: string; label: string }> = {
    drafting: { cls: 'badge-mute', label: 'Drafting' }, draft: { cls: 'badge-soft', label: 'Draft' }, under_review: { cls: 'badge-gold', label: 'Under review' },
    rejected: { cls: 'badge-bad', label: 'Sent back' }, revised: { cls: 'badge-warn', label: 'Revised · resubmitted' }, approved: { cls: 'badge-good', label: 'Approved' }, awaiting_approval: { cls: 'badge-warn', label: 'Awaiting approval' }, dispatched: { cls: 'badge-cta', label: 'Sent' },
  };
  const m = map[status];
  return <span className={`badge ${m.cls}`}><span className="dot" />{m.label}</span>;
}

export default function DeliverablesPanel({ deliverables, onInspect }: { deliverables: Deliverable[]; onInspect: (id: string) => void }) {
  if (!deliverables.length) return <div className="feed-empty">Nothing yet. Every plan, quiz and check-in the colleague writes lands here, with the Reviewer's full trail.</div>;
  const sorted = [...deliverables].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="list">
      {sorted.map((d) => {
        const fails = d.audit.filter((a) => a.verdict === 'fail').length;
        return (
          <div key={d.id} className="dcard">
            <span className="dcard-ico"><Icon name={KIND_ICON[d.kind]} size={20} strokeWidth={1.8} /></span>
            <div className="dcard-t">
              <b>{KIND_LABEL[d.kind]} · v{d.version}</b>
              <span>{d.subject}</span>
              <div className="dcard-meta">
                <StatusBadge status={d.status} />
                {fails > 0 && <span className="badge badge-mute"><Icon name="wrench" size={10} />{fails} correction{fails === 1 ? '' : 's'}</span>}
                {d.kind === 'remedial_quiz' && (d.content as { status?: string }).status === 'completed' && <span className="badge badge-good"><Icon name="award" size={10} />Completed by learner</span>}
              </div>
            </div>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => onInspect(d.id)}><Icon name="eye" size={13} />Inspect</button>
          </div>
        );
      })}
    </div>
  );
}
