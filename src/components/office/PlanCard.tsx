'use client';

import type { AgentId, Task } from '@/lib/types';
import { AGENT_BY_ID } from '@/lib/office/layout';
import Icon from '@/components/Icon';

/* The Planner's plan, as it wrote it, ticking off as the team works.
 *
 * The step texts are the model's words for this goal; the owners are the
 * agents who run each stage; the result under a finished step is what
 * actually happened. When the goal is done, the plan closes with the
 * numbers that matter, human interventions among them. */

const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

const owner = (id: AgentId) => `${AGENT_BY_ID[id].name} · ${AGENT_BY_ID[id].title}`;

export default function PlanCard({ task, open, onToggle, flat = false }: { task: Task; open: boolean; onToggle: () => void; flat?: boolean }) {
  const plan = task.plan;
  if (!plan) return null;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const sum = task.summary;
  return (
    <aside className={`plan-card${flat ? ' is-flat' : ''}${open ? '' : ' is-folded'}${task.status === 'running' ? ' is-running' : ''}`} aria-label="The Planner's plan">
      {!flat && <button type="button" className="plan-head" onClick={onToggle} aria-expanded={open}>
        <span className="plan-kick"><Icon name="list" size={14} />Plan · by Zanele{plan.viaAi ? '' : ' (playbook)'}</span>
        <span className="plan-count">{done}/{plan.steps.length}</span>
        <Icon name="chevronRight" size={14} style={{ transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform .2s' }} />
      </button>}
      {flat && <span className="plan-kick">By Zanele, the Planner{plan.viaAi ? '' : ' (playbook)'} · {done} of {plan.steps.length} done</span>}
      {open && (
        <>
          {sum ? (
            <div className="plan-sum">
              <span className="plan-done"><Icon name="badgeCheck" size={14} />Goal complete in {fmtDur(sum.durationMs)}</span>
              <div className="plan-nums">
                <div><b>{sum.checked}</b><span>checked</span></div>
                <div><b>{sum.needHelp}</b><span>helped</span></div>
                <div><b>{sum.errorsFixed}</b><span>errors fixed</span></div>
                <div className="is-zero"><b>{sum.humanInterventions}</b><span>human steps</span></div>
              </div>
            </div>
          ) : <p className="plan-reading" title={plan.reading}>{plan.reading}</p>}
          <ol className="plan-steps">
            {plan.steps.map((s, i) => (
              <li key={s.key} className={`is-${s.status}`}>
                <span className="ps-ico">
                  {s.status === 'done' ? <Icon name="check" size={12} strokeWidth={3} /> : s.status === 'doing' ? <Icon name="spinner" size={12} className="spin" /> : <i>{i + 1}</i>}
                </span>
                <span className="ps-t">
                  <b>{s.text}</b>
                  <em>{owner(s.owner)}{s.result ? <> · <strong>{s.result}</strong></> : null}</em>
                </span>
              </li>
            ))}
          </ol>
          {!sum && <p className="plan-crit" title={plan.successCriteria}><Icon name="target" size={12} />Done when: {plan.successCriteria}</p>}
        </>
      )}
    </aside>
  );
}
