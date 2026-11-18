'use client';

import type { CSSProperties, ReactNode } from 'react';
import Icon, { type IconName } from '@/components/Icon';
import type { DepartmentRow } from './buildingData';
import type { BuildingFloor } from './SkyscraperBuilding';

/* The building as text: one row per department (floor 1 first), with what it
 * does, its agents, whether it is at work or needs attention, and what is
 * waiting for it. A row opens the department, like a floor of the building. */

export interface DeptCounts { approvals: number; inbox: number; today: number }

export default function DepartmentList({ departments, floors, counts, onOpen, insetRight = 0, children }: {
  departments: DepartmentRow[];
  floors: BuildingFloor[];
  counts: Record<string, DeptCounts>;
  onOpen: (id: string) => void;
  insetRight?: number;
  children?: ReactNode;
}) {
  return (
    <div className={`dept-floor dept-list-view${insetRight ? ' has-drawer' : ''}`} style={{ '--inset': `${insetRight}px` } as CSSProperties}>
      {children && <div className="dept-top">{children}</div>}
      <div className="dept-scroll">
        <ol className="dl-list" aria-label="Departments">
          {departments.map((d, i) => {
            const f = floors.find((x) => x.id === d.id);
            const c = counts[d.id] || { approvals: 0, inbox: 0, today: 0 };
            const state = f?.isError ? 'bad' : f?.isWorking ? 'on' : 'idle';
            const paused = d.agents.length > 0 && d.agents.every((a) => a.workflow && a.workflow.enabled === false);
            return (
              <li key={d.id}>
                <button type="button" className={`dl-row is-${state}`} style={{ '--dept': d.color || '#2563eb' } as CSSProperties} onClick={() => onOpen(d.id)}>
                  <span className="dl-floor" aria-label={`Floor ${i + 1}`}>
                    <Icon name={(d.icon as IconName) || 'building'} size={17} />
                    <b>F{i + 1}</b>
                  </span>
                  <span className="dl-main">
                    <span className="dl-name">
                      <b>{d.name}</b>
                      <em className={`dl-state is-${paused ? 'paused' : state}`}>
                        {paused ? 'Paused' : state === 'bad' ? 'Needs attention' : state === 'on' ? 'At work' : 'Quiet'}
                      </em>
                    </span>
                    <span className="dl-purpose">{d.purpose}</span>
                    {d.agents.length > 0 && (
                      <span className="dl-agents">
                        {d.agents.map((a) => (
                          <span key={a.id} className={a.working ? 'is-on' : ''} style={{ '--ag': a.color || d.color || '#2563eb' } as CSSProperties}>
                            <i aria-hidden="true" />{a.name}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="dl-counts">
                    <span className={c.approvals ? 'is-warn' : ''}><b>{c.approvals}</b>to approve</span>
                    <span><b>{c.inbox}</b>in inbox</span>
                    <span><b>{c.today}</b>today</span>
                  </span>
                  <span className="dl-go" aria-hidden="true"><Icon name="chevronRight" size={18} /></span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
