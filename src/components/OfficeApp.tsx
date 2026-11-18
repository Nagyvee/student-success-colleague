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

/* The live office: the building from outside (one floor per department), and
 * each floor from inside (its agents at their desks and their work). Student
 * Success and Learning floors can also show the live tutoring room, where the
 * team builds lessons and tests. The drawers (plan, feed, deliverables, inbox,
 * learners) follow the floor you are on. */

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
  const [pendingEnterFloorId, setPendingEnterFloorId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
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

  // The world, scoped to the floor you are on.
  const floorState = useMemo<WorldState | null>(() => {
    if (!state) return null;
    const known = new Set(state.tasks.map((t) => t.id));
    if (!selectedDept) {
      const runTasks = runs.filter((r) => !known.has(r.id)).map(agentRunToTask);
      const tasks = [...state.tasks, ...runTasks].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      return { ...state, tasks };
    }
    const wfIds = new Set(selectedDept.agents.map((a) => a.workflow?.id).filter(Boolean) as string[]);
    const runIds = new Set(deptRuns.map((r) => r.id));
    const legacyTasks = state.tasks.filter((t) => t.workflowId && wfIds.has(t.workflowId));
    const taskIds = new Set([...runIds, ...legacyTasks.map((t) => t.id)]);
    const tasks = [...legacyTasks, ...deptRuns.filter((r) => !known.has(r.id)).map(agentRunToTask)]
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const prefix = `[${selectedDept.name.toLowerCase()} ·`;
    const deliverables = state.deliverables.filter((d) => taskIds.has(d.taskId));
    const deliverableIds = new Set(deliverables.map((d) => d.id));
    return {
      ...state,
      tasks,
      deliverables,
      feed: state.feed.filter((f) =>
        (f.taskId && taskIds.has(f.taskId))
        || (f.deliverableId && deliverableIds.has(f.deliverableId))
        || f.text.toLowerCase().startsWith(prefix)),
      inbox: state.inbox.filter((m) => taskIds.has(m.taskId) || (m.deliverableId && deliverableIds.has(m.deliverableId))),
      pendingOutreach: (state.pendingOutreach || []).filter((p) => (p.workflowId && wfIds.has(p.workflowId)) || taskIds.has(p.taskId)),
    };
  }, [state, selectedDept, deptRuns, runs]);

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

  async function toggleAutopilot() {
    if (!building || autoBusy) return;
    const next = !building.autopilot;
    if (next && !window.confirm('Switch on autopilot? Agents will start by themselves on new leads, sheet changes, LMS events and their schedules.' + (building.requireApproval ? ' Messages still wait for approval in the Inbox.' : ' Approval Mode is off, so messages go out without a person checking them.'))) return;
    setAutoBusy(true);
    setAutoError(null);
    try {
      const j = await postDepartments({ action: 'setAutopilot', on: next });
      if (j.error) setAutoError(j.error);
      await refreshBuilding();
    } finally {
      setAutoBusy(false);
    }
  }

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
  };
  if (drawer) seen.current[drawer] = counts[drawer];
  const badge = (t: SideTab) => {
    if (t === 'plan') return activeTask?.plan ? `${counts.plan}/${activeTask.plan.steps.length}` : null;
    if (t === 'feed') return null;
    return counts[t] ? String(counts[t]) : null;
  };
  const fresh = (t: SideTab) => drawer !== t && counts[t] > (seen.current[t] ?? 0) && t !== 'feed';

  const autopilot = building && (
    <div
      className="cmd-group auto-group"
      title={autoError || (isManager ? 'Autopilot: agents start by themselves on their triggers and schedules.' : 'Only owners and admins can switch autopilot.')}
    >
      <span className="auto-label">
        <b>Autopilot {building.autopilot ? 'on' : 'off'}</b>
        <em>{building.autopilot ? 'Agents start by themselves' : 'Agents run when you press Run'}</em>
      </span>
      <span className="auto-flags">
        {building.requireApproval && <span className="is-warn">Approvals on</span>}
        {building.sendingPaused ? <span className="is-warn">Sending paused</span> : !building.liveOutreach && <span>Test mode</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={building.autopilot}
        aria-label="Autopilot"
        className={`auto-switch${building.autopilot ? ' on' : ''}`}
        disabled={!isManager || autoBusy}
        onClick={() => void toggleAutopilot()}
      />
    </div>
  );

  const tabs = (
    <div className="cmd-group drawer-tabs" role="tablist" aria-label="Details">
      {TABS.map((t) => (
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
      right={<>{autopilot}{tabs}</>}
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
  const detailsButton = selectedDept && (
    <button
      type="button"
      className="cmd-group cmd-btn"
      style={{ height: 32, padding: '0 12px', fontSize: 12, fontWeight: 700 }}
      onClick={() => setInteriorTab('details')}
      title="Agents, what starts them, the sheets this floor reads and its recent runs"
    >
      <Icon name="list" size={13} />
      <span>{selectedDept.name} details</span>
    </button>
  );

  return (
    <div className={`shell is-solo${stage ? ' is-stage' : ''}`}>
      <main className="office-main">
        <section className="floor-wrap">
          {viewState ? (
            viewMode === 'skyscraper' ? (
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
                {detailsButton}
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
