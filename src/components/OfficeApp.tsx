'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useOfficeStream } from '@/hooks/useOfficeStream';
import type { AgentId, AgentRun, PlanStep, StageKey, Task, WorldState } from '@/lib/types';
import Icon from '@/components/Icon';
import Floorplan from './office/Floorplan';
import SkyscraperBuilding, { type BuildingFloor } from './office/SkyscraperBuilding';
import CustomOfficeStage from './office/CustomOfficeStage';
import GoalBar, { type FloorItem } from './office/GoalBar';
import Sidebar, { TABS, type SideTab } from './side/Sidebar';
import DeliverableModal from './inspect/DeliverableModal';
import MailModal from './inspect/MailModal';
import { useDepartmentWorld } from './office/departmentWorld';
import { postDepartments, sortedFloors, useBuildingData, type DepartmentRow } from './office/buildingData';
import DepartmentList, { type DeptCounts } from './office/DepartmentList';
import { buildDeptIndex, deptOfFeed, deptOfMail, deptOfPending, scopeState, tagger } from './office/deptScope';

/* The live office: the building from outside (one floor per department), and
 * each floor from inside (its agents at their desks and their work). Student
 * Success and Learning floors can also show the live tutoring room, where the
 * team builds lessons and tests. The drawers (plan, feed, deliverables, inbox,
 * learners) follow the floor you are on: on the building they show every
 * department (with a filter and a label per item), inside a department only
 * that department's. The building can also be read as a list. */

const DRAWER_W = 384;

/** An agent run as a task, so the Plan drawer can show the steps an agent took. */
function agentRunToTask(run: AgentRun): Task {
  const stageKeys: StageKey[] = ['scan', 'diagnose', 'act', 'review', 'deliver', 'follow_up'];
  const owners: AgentId[] = ['planner', 'success', 'learning', 'coo'];
  const steps: PlanStep[] = (run.logs || []).map((l, idx) => ({
    key: stageKeys[Math.min(idx, stageKeys.length - 1)],
    owner: owners[idx % owners.length],
    text: l.title,
    status: l.status === 'wait' ? 'doing' : 'done',
    result: l.detail,
  }));
  const status: Task['status'] = run.status === 'running' ? 'running' : run.status === 'failed' ? 'failed' : 'done';
  return {
    id: run.id,
    workflowId: run.workflowId,
    scenario: 'goal',
    title: `${run.agentName} · ${run.record.name}`,
    subject: run.record.name,
    status,
    step: steps.length,
    totalSteps: Math.max(1, steps.length),
    stepLabel: steps[steps.length - 1]?.result || run.workflowName,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    deliverableIds: [],
    corrections: 0,
    goal: `${run.workflowName} for ${run.record.name}`,
    trigger: { kind: 'workflow', label: `${run.departmentName} · ${run.agentName}` },
    plan: {
      goal: `${run.workflowName} · ${run.record.name}`,
      reading: `${run.agentName} (${run.departmentName}) is working on ${run.record.name}, started by ${run.trigger}.`,
      scope: { cohorts: [run.departmentName], limit: 1, language: 'en' },
      successCriteria: run.workflowName,
      steps,
      viaAi: true,
    },
  };
}

/* A floor's signals, as the building always showed them:
 *  - working (the #720075 strip, green roof light): an agent of this floor is at work right now,
 *    or the tutoring team is building something for one of them;
 *  - error (red glass, red roof light): an agent's latest run failed or hit a failed step,
 *    or a tutoring run for this floor failed, in the last day. */
function floorFor(d: DepartmentRow, runs: AgentRun[], state: WorldState | null): BuildingFloor {
  const wfIds = new Set(d.agents.map((a) => a.workflow?.id).filter(Boolean) as string[]);
  const mine = runs.filter((r) => r.departmentId === d.id || wfIds.has(r.workflowId));
  const dayAgo = Date.now() - 86_400_000;
  const tutoringBusy = Boolean(state?.tasks.some((t) => t.status === 'running' && t.workflowId && wfIds.has(t.workflowId)));
  const tutoringFailed = Boolean(state?.tasks.some((t) => t.status === 'failed' && t.workflowId && wfIds.has(t.workflowId) && (t.endedAt || t.startedAt) > dayAgo));
  return {
    id: d.id,
    name: d.name,
    officeName: d.name,
    purpose: d.purpose,
    color: d.color || '#2563eb',
    agentColors: d.agents.length ? d.agents.map((a) => a.color || d.color || '#2563eb') : [d.color || '#2563eb'],
    isWorking: tutoringBusy || d.agents.some((a) => a.working) || mine.some((r) => r.status === 'running'),
    isError: tutoringFailed || d.agents.some((a) => a.hasError) || mine.some((r) => r.status === 'failed' && (r.endedAt || r.updatedAt) > dayAgo),
  };
}

export default function OfficeApp() {
  const { state } = useOfficeStream();
  const { data: building, refresh: refreshBuilding } = useBuildingData(10_000);
  const [drawer, setDrawer] = useState<SideTab | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openMail, setOpenMail] = useState<string | null>(null);
  const [stage, setStage] = useState(false);
  const [viewMode, setViewMode] = useState<'skyscraper' | 'interior'>('skyscraper');
  // Inside a floor: the walk-in office (default), or the floor's details.
  const [interiorTab, setInteriorTab] = useState<'office' | 'details'>('office');
  const [selectedFloorId, setSelectedFloorId] = useState<string>('__all__');
  // The building drawn, or as a list of departments (remembered on this browser).
  const [layout, setLayout] = useState<'building' | 'list'>('building');
  useEffect(() => {
    try { if (window.localStorage.getItem('thuso.buildingLayout') === 'list') setLayout('list'); } catch { /* private window */ }
  }, []);
  const chooseLayout = (l: 'building' | 'list') => {
    setLayout(l);
    try { window.localStorage.setItem('thuso.buildingLayout', l); } catch { /* private window */ }
  };
  const [pendingEnterFloorId, setPendingEnterFloorId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const params = useSearchParams();
  const appliedParams = useRef(false);

  useEffect(() => {
    fetch('/api/auth', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setRole(j?.user?.role || null))
      .catch(() => setRole(null));
  }, []);

  const departments = useMemo(() => sortedFloors(building?.departments || []), [building]);
  const runs = useMemo(() => building?.runs || [], [building]);
  const selectedDept = departments.find((d) => d.id === selectedFloorId) || null;
  const floorNumber = selectedDept ? departments.indexOf(selectedDept) + 1 : 0;
  // Each department's people: Admissions its leads, Finance the fees tracker, the rest the learners.
  const peopleTab: SideTab | null = !selectedDept ? 'learners'
    : selectedDept.kind === 'admissions' ? 'leads'
      : selectedDept.kind === 'finance' ? 'fees'
        : selectedDept.kind === 'b2b_sales' ? null
          : 'learners';
  const PEOPLE: SideTab[] = ['learners', 'leads', 'fees'];
  const isManager = role === 'owner' || role === 'admin';

  // ?floor=<department> (or ?office=) opens that floor; ?open=<deliverable> opens a deliverable.
  useEffect(() => {
    const o = params.get('open');
    if (o) setOpenId(o);
    if (appliedParams.current || !departments.length) return;
    const q = params.get('floor') || params.get('office') || params.get('department');
    if (q) {
      const d = departments.find((x) => x.id === q || x.name.toLowerCase() === q.toLowerCase());
      if (d) {
        setSelectedFloorId(d.id);
        setViewMode('interior');
        setInteriorTab('office');
      }
    }
    appliedParams.current = true;
  }, [params, departments]);

  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) setStage(false);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleStage = () => {
    if (!stage) {
      setStage(true);
      try { void document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* ignore */ }
    } else {
      setStage(false);
      if (document.fullscreenElement) {
        try { void document.exitFullscreen().catch(() => {}); } catch { /* ignore */ }
      }
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openId || openMail) {
        setOpenId(null);
        setOpenMail(null);
      } else {
        setDrawer(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, openMail]);

  const floors = useMemo<BuildingFloor[] | undefined>(
    () => (departments.length ? departments.map((d) => floorFor(d, runs, state)) : undefined),
    [departments, runs, state],
  );

  const floorItems = useMemo<FloorItem[]>(
    () => departments.map((d) => ({
      id: d.id,
      name: d.name,
      officeName: `${d.agents.length} agent${d.agents.length === 1 ? '' : 's'} · ${(d.responsibilities || []).slice(0, 2).join(' · ') || d.purpose}`,
    })),
    [departments],
  );

  const deptRuns = useMemo(() => {
    if (!selectedDept) return [];
    const wfIds = new Set(selectedDept.agents.map((a) => a.workflow?.id).filter(Boolean) as string[]);
    return runs.filter((r) => r.departmentId === selectedDept.id || wfIds.has(r.workflowId));
  }, [runs, selectedDept]);

  // Which department each task, mail, approval and activity line belongs to.
  const deptIndex = useMemo(() => buildDeptIndex(departments, building?.runDepartments, state), [departments, building?.runDepartments, state]);

  // The world, scoped to the floor you are on (everything on the building, unless a department is picked).
  const floorState = useMemo<WorldState | null>(() => {
    if (!state) return null;
    const known = new Set(state.tasks.map((t) => t.id));
    const runTasks = runs.filter((r) => !known.has(r.id)).map(agentRunToTask);
    const all = { ...state, tasks: [...state.tasks, ...runTasks].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)) };
    return selectedDept ? scopeState(all, deptIndex, selectedDept.id) : all;
  }, [state, selectedDept, runs, deptIndex]);

  // What waits for each department (the list view and its counts).
  const deptCounts = useMemo<Record<string, DeptCounts>>(() => {
    const out: Record<string, DeptCounts> = Object.fromEntries(departments.map((d) => [d.id, { approvals: 0, inbox: 0, today: 0 }]));
    if (!state) return out;
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    for (const p of state.pendingOutreach || []) { if (p.status !== 'pending') continue; const d = deptOfPending(deptIndex, p); if (d && out[d]) out[d].approvals++; }
    for (const m of state.inbox) { const d = deptOfMail(deptIndex, m); if (d && out[d]) out[d].inbox++; }
    for (const f of state.feed) { if (f.ts < dayStart.getTime()) continue; const d = deptOfFeed(deptIndex, f); if (d && out[d]) out[d].today++; }
    return out;
  }, [state, departments, deptIndex]);

  const tagOf = useMemo(() => tagger(deptIndex, departments), [deptIndex, departments]);

  // The walk-in office for the floor you are on: its own agents at their desks, reception and review.
  // While the tutoring team is building a lesson for this floor, you watch them work instead.
  const deptWorld = useDepartmentWorld(floorState, selectedDept, deptRuns, (floorState?.pendingOutreach || []).filter((p) => p.status === 'pending').length);
  const tutoringHere = Boolean(selectedDept && floorState?.tasks.some((t) => t.status === 'running' && !t.id.startsWith('run_')));
  const officeState = selectedDept && !tutoringHere ? deptWorld?.world || null : null;

  // The office reacts as soon as an agent logs something, not on the next poll.
  const feedLen = state?.feed.length || 0;
  useEffect(() => {
    if (viewMode !== 'interior') return;
    const t = setTimeout(() => { void refreshBuilding(); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedLen, viewMode]);

  function selectFloor(id: string) {
    setSelectedFloorId(id);
    setInteriorTab('office');
    if (id === '__all__') {
      setPendingEnterFloorId(null);
      setViewMode('skyscraper');
    } else if (viewMode === 'skyscraper') {
      setPendingEnterFloorId(id);
    } else {
      setViewMode('interior');
    }
  }

  // Moving floors with a people drawer open shows that floor's people.
  useEffect(() => {
    if (drawer && PEOPLE.includes(drawer) && drawer !== peopleTab) setDrawer(peopleTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer, peopleTab]);

  const viewState = floorState || state;
  const activeTask = viewState?.tasks.find((t) => t.status === 'running') || viewState?.tasks[0] || null;
  const deliverable = state?.deliverables.find((d) => d.id === openId) || null;
  const mail = state?.inbox.find((m) => m.id === openMail) || null;
  const inspectId =
    activeTask?.deliverableIds[activeTask.deliverableIds.length - 1] ||
    viewState?.deliverables[0]?.id ||
    null;

  const seen = useRef<Record<string, number>>({});
  const counts: Record<SideTab, number> = {
    plan: activeTask?.plan ? activeTask.plan.steps.filter((s) => s.status === 'done').length : 0,
    feed: viewState?.feed.length || 0,
    deliverables: viewState?.deliverables.length || 0,
    inbox:
      (viewState?.inbox.length || 0) +
      (viewState?.pendingOutreach?.filter((p) => p.status === 'pending').length || 0),
    learners: viewState?.learners.filter((l) => l.status !== 'on_track').length || 0,
    leads: 0,
    fees: 0,
  };
  if (drawer) seen.current[drawer] = counts[drawer];
  const badge = (t: SideTab) => {
    if (t === 'plan') return activeTask?.plan ? `${counts.plan}/${activeTask.plan.steps.length}` : null;
    if (t === 'feed' || t === 'leads' || t === 'fees') return null;
    return counts[t] ? String(counts[t]) : null;
  };
  const fresh = (t: SideTab) => drawer !== t && counts[t] > (seen.current[t] ?? 0) && t !== 'feed';

  // One small switch: the picture (the building, or the department's office) or a list.
  const inside = viewMode === 'interior' && Boolean(selectedDept);
  const picture = inside ? interiorTab === 'office' : layout === 'building';
  const setPicture = (on: boolean) => (inside ? setInteriorTab(on ? 'office' : 'details') : chooseLayout(on ? 'building' : 'list'));
  const layoutSwitch = departments.length > 0 && (viewMode === 'skyscraper' || inside) && (
    <div className="cmd-group layout-switch" role="radiogroup" aria-label={inside ? 'Show the department as' : 'Show the departments as'}>
      <button type="button" role="radio" aria-checked={picture} className={picture ? 'on' : ''} onClick={() => setPicture(true)}
        title={inside ? 'The office' : 'The building'} aria-label={inside ? 'The office' : 'The building'}>
        <Icon name={inside ? 'door' : 'building'} size={14} />
      </button>
      <button type="button" role="radio" aria-checked={!picture} className={!picture ? 'on' : ''} onClick={() => setPicture(false)}
        title={inside ? `${selectedDept?.name}: agents, sheets and runs` : 'The departments as a list'} aria-label={inside ? 'As a list' : 'The departments as a list'}>
        <Icon name="list" size={14} />
      </button>
    </div>
  );

  const visibleTabs = TABS.filter((t) => !PEOPLE.includes(t.id) || t.id === peopleTab);

  const tabs = (
    <div className="cmd-group drawer-tabs" role="tablist" aria-label="Details">
      {visibleTabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          title={t.label}
          aria-label={t.label}
          aria-selected={drawer === t.id}
          className={`cmd-btn${drawer === t.id ? ' is-open' : ''}${fresh(t.id) ? ' is-fresh' : ''}`}
          onClick={() => setDrawer((d) => (d === t.id ? null : t.id))}
        >
          <Icon name={t.icon} size={14} />
          <span className="tab-l">{t.label}</span>
          {badge(t.id) && <em>{badge(t.id)}</em>}
        </button>
      ))}
    </div>
  );

  const topGoalBar = viewState && (
    <GoalBar
      state={viewState}
      stage={stage}
      onExitStage={toggleStage}
      right={tabs}
      afterBrand={layoutSwitch || undefined}
      workflows={floorItems}
      selectedFloorId={selectedFloorId}
      onSelectFloor={selectFloor}
      viewMode={viewMode}
      onToggleViewMode={setViewMode}
      floorHref={(id) => `/workflows?department=${encodeURIComponent(id)}`}
      floorLinkLabel="Agents"
      floorNoun="Departments"
    />
  );

  const pendingHere = (floorState?.pendingOutreach || []).filter((p) => p.status === 'pending').length;
  const showOffice = viewMode === 'interior' && (!selectedDept || interiorTab === 'office');
  return (
    <div className={`shell is-solo${stage ? ' is-stage' : ''}`}>
      <main className="office-main">
        <section className="floor-wrap">
          {viewState ? (
            viewMode === 'skyscraper' && layout === 'list' ? (
              <DepartmentList
                departments={departments}
                floors={floors || []}
                counts={deptCounts}
                onOpen={(id) => {
                  setSelectedFloorId(id);
                  setInteriorTab('office');
                  setViewMode('interior');
                }}
                insetRight={drawer ? DRAWER_W + 12 : 0}
              >
                {topGoalBar}
              </DepartmentList>
            ) : viewMode === 'skyscraper' ? (
              <SkyscraperBuilding
                state={viewState}
                workflows={[]}
                customAgents={[]}
                flowRuns={[]}
                floors={floors}
                selectedFloorId={selectedFloorId}
                onSelectFloor={(id) => {
                  setSelectedFloorId(id);
                  setDrawer((d) => d ?? 'plan');
                }}
                onEnterFloorInterior={(id) => {
                  setPendingEnterFloorId(null);
                  setSelectedFloorId(id);
                  setInteriorTab('office');
                  setViewMode('interior');
                }}
                onRunFloor={(id) => selectFloor(id)}
                runningFloor={null}
                pendingEnterFloorId={pendingEnterFloorId}
                onClearPendingEnterFloor={() => setPendingEnterFloorId(null)}
                insetRight={drawer ? DRAWER_W + 12 : 0}
              >
                {topGoalBar}
              </SkyscraperBuilding>
            ) : showOffice ? (
              <Floorplan
                state={officeState || viewState}
                inspectId={inspectId}
                onInspect={setOpenId}
                stage={stage}
                onStage={toggleStage}
                insetRight={drawer ? DRAWER_W + 12 : 0}
                roomLabels={officeState && deptWorld ? deptWorld.roomLabels : undefined}
              >
                {topGoalBar}
              </Floorplan>
            ) : selectedDept ? (
              <CustomOfficeStage
                department={selectedDept}
                floorNumber={floorNumber}
                totalFloors={departments.length}
                sources={building?.sources || []}
                runs={deptRuns}
                pendingApprovals={pendingHere}
                onOpenLiveRoom={() => setInteriorTab('office')}
                insetRight={drawer ? DRAWER_W + 12 : 0}
              >
                {topGoalBar}
              </CustomOfficeStage>
            ) : null
          ) : (
            <div
              className="office"
              aria-busy="true"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontSize: 13, color: '#5b6478' }}
            >
              <span>Opening the office…</span>
            </div>
          )}
          {drawer && (
            <aside className="drawer-wrap" style={{ width: DRAWER_W }}>
              <Sidebar
                state={viewState}
                tab={drawer}
                onInspect={setOpenId}
                onOpenMail={setOpenMail}
                onClose={() => setDrawer(null)}
                scope={departments.length ? {
                  departments: departments.map((d) => ({ id: d.id, name: d.name, color: d.color || '#64748b' })),
                  current: selectedDept?.id || null,
                  // Inside a department, the drawer is that department's; on the building you choose.
                  locked: viewMode === 'interior' && Boolean(selectedDept),
                  onPick: (id) => setSelectedFloorId(id || '__all__'),
                } : undefined}
                tagOf={selectedDept ? undefined : tagOf}
              />
            </aside>
          )}
        </section>
      </main>
      {deliverable && viewState && (
        <DeliverableModal deliverable={deliverable} state={viewState} onClose={() => setOpenId(null)} />
      )}
      {mail && (
        <MailModal
          mail={mail}
          onClose={() => setOpenMail(null)}
          onInspect={(id) => {
            setOpenMail(null);
            setOpenId(id);
          }}
        />
      )}
    </div>
  );
}
