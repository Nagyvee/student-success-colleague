import type {
  CheckInMessage,
  CustomAgentDef,
  FlowRunLog,
  FollowUpCase,
  OfficeDef,
  RemedialQuiz,
  WorkflowDef,
  WorldState,
} from '@/lib/types';

/* What happened across all offices and floors, for a period: workflow floor runs,
 * student interventions, quality audits, follow-ups, and pending approvals. One
 * pure function used by the Reports page and the Operations Report writer. */

export type Period = 'today' | 'week' | 'all';

export interface ReportExtras {
  workflows?: WorkflowDef[];
  offices?: OfficeDef[];
  customAgents?: CustomAgentDef[];
  flowRuns?: FlowRunLog[];
  followUps?: FollowUpCase[];
}

export interface FloorSummary {
  workflowId: string;
  workflowName: string;
  officeName: string;
  domain: string;
  agentName: string;
  enabled: boolean;
  trigger: string;
  runsInPeriod: number;
  completedRuns: number;
  activeFollowUps: number;
  pausedFollowUps: number;
  pendingApprovals: number;
  latestTarget: string | null;
  latestOutcome: string | null;
}

export function periodStart(p: Period, now = Date.now()) {
  if (p === 'all') return 0;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (p === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return d.getTime();
}

export function buildReport(s: WorldState, period: Period, extras: ReportExtras = {}) {
  const from = periodStart(period);
  const tasks = s.tasks.filter((t) => t.startedAt >= from);
  const done = tasks.filter((t) => t.status === 'done');
  const dels = s.deliverables.filter((d) => d.createdAt >= from);
  const quizzes = dels.filter((d) => d.kind === 'remedial_quiz');
  const sentQuizzes = quizzes.filter((d) => d.status === 'dispatched');
  const completed = quizzes.filter((d) => (d.content as RemedialQuiz).status === 'completed');
  const passed = completed.filter((d) => (d.content as RemedialQuiz).result?.passed);
  const checkins = dels.filter((d) => d.kind === 'checkin_message' && d.status === 'dispatched');
  const pendingApprovals = (s.pendingOutreach || []).filter((p) => p.status === 'pending');
  const mistakes = dels.flatMap((d) => d.audit.filter((a) => a.verdict === 'fail' && a.ts >= from).map((a) => ({
    at: a.ts, kind: d.kind, title: d.title, subject: d.subject, note: a.notes[0] || 'Failed review', fixed: d.audit.some((b) => b.verdict === 'pass' && b.ts > a.ts),
  }))).sort((x, y) => y.at - x.at);

  const workflows = extras.workflows || [];
  const offices = extras.offices || [];
  const customAgents = extras.customAgents || [];
  const flowRuns = (extras.flowRuns || []).filter((r) => r.startedAt >= from);
  const followUps = extras.followUps || [];

  const byTrigger = { webhook: 0, sheet: 0, schedule: 0, manager: 0, workflow: 0 } as Record<string, number>;
  for (const t of tasks) byTrigger[t.trigger?.kind || 'manager'] = (byTrigger[t.trigger?.kind || 'manager'] || 0) + 1;
  byTrigger.workflow += flowRuns.length;

  const helped = new Map<string, { name: string; what: string; office: string; at: number }>();
  for (const d of dels) {
    if (d.status !== 'dispatched') continue;
    if (d.kind === 'remedial_quiz') {
      const q = d.content as RemedialQuiz;
      helped.set(q.learner.id, {
        name: q.learner.name,
        office: 'Learning & Student Success',
        what: `Study pack, lesson and quiz on ${q.module.code} · ${q.topic}${q.status === 'completed' ? ` · scored ${q.result?.pct}%` : ''}`,
        at: d.updatedAt,
      });
    }
    if (d.kind === 'checkin_message') {
      const m = d.content as CheckInMessage;
      helped.set(m.learner.id, {
        name: m.learner.name,
        office: m.officeName || 'Student Success Office',
        what: `${m.agentName ? `${m.agentName}: ` : ''}"${m.subject}"`,
        at: d.updatedAt,
      });
    }
  }
  for (const r of flowRuns) {
    const key = r.targetEmail || r.targetName;
    if (!helped.has(key)) {
      const last = r.logs[r.logs.length - 1];
      helped.set(key, {
        name: r.targetName,
        office: r.officeName || r.workflowName,
        what: `${r.workflowName}: ${last?.detail || r.status}`,
        at: r.endedAt || r.startedAt,
      });
    }
  }

  // Build Floor / Workflow breakdown across EVERY active department & flow
  const floors: FloorSummary[] = workflows.map((wf) => {
    const wfRuns = flowRuns.filter((r) => r.workflowId === wf.id);
    const wfTasks = tasks.filter((t) => t.workflowId === wf.id);
    const wfFollowUps = followUps.filter((f) => f.workflowId === wf.id);
    const wfPending = pendingApprovals.filter((p) => p.workflowId === wf.id);
    const office = offices.find((o) => o.id === wf.officeId || o.name === wf.officeName);
    const nodeAgent = wf.nodes?.map((n) => n.data?.agent).find(Boolean);
    const officeAgent = customAgents.find((a) => a.officeId === office?.id || a.id === nodeAgent);
    const latestRun = wfRuns[0];
    const latestTask = wfTasks[0];
    return {
      workflowId: wf.id,
      workflowName: wf.name,
      officeName: wf.officeName || office?.name || 'Operations Floor',
      domain: wf.domain || office?.domain || 'custom',
      agentName: nodeAgent || officeAgent?.name || 'Thuso Team',
      enabled: wf.enabled,
      trigger: wf.trigger,
      runsInPeriod: wfRuns.length + wfTasks.length,
      completedRuns: wfRuns.filter((r) => r.status === 'completed').length + wfTasks.filter((t) => t.status === 'done').length,
      activeFollowUps: wfFollowUps.filter((f) => f.status === 'active').length,
      pausedFollowUps: wfFollowUps.filter((f) => f.status === 'paused').length,
      pendingApprovals: wfPending.length,
      latestTarget: latestRun?.targetName || latestTask?.subject || null,
      latestOutcome: latestRun?.logs[latestRun.logs.length - 1]?.detail || latestTask?.stepLabel || null,
    };
  });

  const unifiedRuns = [
    ...tasks.map((t) => ({
      id: t.id,
      at: t.startedAt,
      office: t.trigger?.label?.split('·')[0]?.trim() || 'Student Success',
      trigger: t.trigger?.label || "Manager's goal",
      status: t.status,
      detail: t.summary ? `${t.summary.checked} checked · ${t.summary.needHelp} helped · ${t.corrections} revised` : (t.stepLabel || t.status),
      ms: (t.endedAt || Date.now()) - t.startedAt,
    })),
    ...flowRuns.map((r) => {
      const last = r.logs[r.logs.length - 1];
      return {
        id: r.id,
        at: r.startedAt,
        office: r.officeName || r.workflowName,
        trigger: `${r.workflowName} → ${r.targetName}`,
        status: r.status,
        detail: `${r.logs.length} steps · ${last?.detail || r.status}`,
        ms: (r.endedAt || Date.now()) - r.startedAt,
      };
    }),
  ].sort((a, b) => b.at - a.at);

  const flowRunCheckIns = flowRuns.filter((r) => r.logs.some((l) => /dispatched|queued draft|simulated in inbox/i.test(l.detail))).length;

  return {
    period, from,
    numbers: {
      runs: tasks.length + flowRuns.length,
      flowRuns: flowRuns.length,
      checked: done.reduce((n, t) => n + (t.summary?.checked || 0), 0) + flowRuns.length,
      helped: helped.size,
      studyPacks: sentQuizzes.length,
      checkIns: checkins.length + flowRunCheckIns,
      quizzesDone: completed.length,
      passRate: completed.length ? Math.round((passed.length / completed.length) * 100) : null,
      mistakesCaught: mistakes.length,
      mistakesFixed: mistakes.filter((m) => m.fixed).length,
      pendingApprovals: pendingApprovals.length,
      activeFollowUps: followUps.filter((f) => f.status === 'active').length,
      floorsActive: workflows.filter((w) => w.enabled).length,
      humanInterventions: 0,
      minutesWorking: Math.round(unifiedRuns.reduce((n, r) => n + r.ms, 0) / 60000),
    },
    byTrigger,
    floors,
    learners: s.learners.map((l) => ({ id: l.id, name: l.name, cohort: l.cohort, status: l.status, risk: l.riskScore, lastEvent: l.lastEvent })),
    helped: [...helped.values()].sort((x, y) => y.at - x.at),
    mistakes,
    runs: unifiedRuns,
  };
}

export type Report = ReturnType<typeof buildReport>;
