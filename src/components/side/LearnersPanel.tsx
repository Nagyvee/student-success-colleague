'use client';

import type { LearnerCard, LearnerStatus } from '@/lib/types';
import Icon from '@/components/Icon';

/* The cohort, as the Student Success agent sees it. */

const STATUS: Record<LearnerStatus, { cls: string; label: string }> = {
  on_track: { cls: 'badge-good', label: 'On track' },
  at_risk: { cls: 'badge-bad', label: 'At risk' },
  intervention: { cls: 'badge-warn', label: 'Intervention · quiz sent' },
  recovered: { cls: 'badge-good', label: 'On track · recovered' },
};

export default function LearnersPanel({ learners }: { learners: LearnerCard[] }) {
  const sorted = [...learners].sort((a, b) => b.riskScore - a.riskScore);
  return (
    <div className="list">
      {sorted.map((l) => (
        <div key={l.id} className={`lrow is-${l.status}`}>
          <div className="lrow-t"><b>{l.name}</b><span>{l.id} · {l.cohort} · {l.programme}</span></div>
          <span className={`badge ${STATUS[l.status].cls}`}><span className="dot" />{STATUS[l.status].label}</span>
          <div className="lrow-risk">
            <span className={`meter ${l.riskScore >= 60 ? 'is-bad' : l.riskScore >= 35 ? 'is-warn' : 'is-good'}`}><span style={{ width: `${l.riskScore}%` }} /></span>
            <b className="num">{l.riskScore}</b>
          </div>
          <div className="lrow-stats">
            <span>Last login <b>{l.lastLoginDays === 0 ? 'today' : `${l.lastLoginDays}d ago`}</b></span>
            <span>Completion <b>{l.completion}%</b></span>
            <span>Quiz avg <b>{l.quizAvg}%</b></span>
            {l.weakTopic && <span>Weak <b>{l.weakTopic}</b></span>}
          </div>
          {l.lastEvent && <div className="lrow-ev"><Icon name={l.status === 'recovered' ? 'badgeCheck' : 'activity'} size={12} />{l.lastEvent}</div>}
        </div>
      ))}
    </div>
  );
}
