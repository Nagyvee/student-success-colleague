'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Building2, CircleAlert, Pencil, Plus, Power, ShieldCheck, Users, Wifi, Zap } from 'lucide-react';
import type { DataSource } from '@/lib/types';
import {
  AGENT_COLORS, ApiError, ago, api, countSteps, isActive, triggerSummary,
  type AgentCardData, type DepartmentData, type LightRun, type Overview,
} from '@/components/builder/model';
import { Avatar, Empty, Modal, StatusChip, Toggle, TriggerIcon } from '@/components/builder/ui';
import './builder.css';

/* Agents & Workflows: the building's floors (departments), the agents on each
 * floor, and what each one does in plain words. Click an agent to open its
 * step builder. */

const DEPT_KEY = 'thuso-wb-dept';

export default function WorkflowsClient() {
  const router = useRouter();
  const params = useSearchParams();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [deptId, setDeptId] = useState<string | null>(null);
  const [agentModal, setAgentModal] = useState(false);
  const [deptModal, setDeptModal] = useState<DepartmentData | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<Overview>();
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const floors = useMemo(() => [...(data?.departments || [])].sort((a, b) => (b.floor ?? 0) - (a.floor ?? 0)), [data]);

  // ?department=<id> (from the building and floor interiors) wins whenever it changes;
  // otherwise keep the current floor, then the last one used, then the ground floor.
  const wanted = params.get('department') || params.get('dept');
  const appliedParam = useRef<string | null>(null);
  useEffect(() => {
    if (!floors.length) return;
    if (wanted && wanted !== appliedParam.current && floors.some((f) => f.id === wanted)) {
      appliedParam.current = wanted;
      setDeptId(wanted);
      return;
    }
    if (deptId && floors.some((f) => f.id === deptId)) return;
    let saved: string | null = null;
    try { saved = localStorage.getItem(DEPT_KEY); } catch { /* private mode */ }
    const pick = floors.find((f) => f.id === saved) || floors[floors.length - 1];
    setDeptId(pick.id);
  }, [floors, deptId, wanted]);

  const choose = (id: string) => {
    setDeptId(id);
    try { localStorage.setItem(DEPT_KEY, id); } catch { /* private mode */ }
  };

  const dept = floors.find((f) => f.id === deptId) || null;

  const flash = (tone: 'ok' | 'bad', text: string) => {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 5000);
  };

  const act = async (key: string, body: Record<string, unknown>, ok?: string) => {
    setBusy(key);
    try {
      const r = await api<Record<string, unknown>>(body);
      if (ok) flash('ok', ok);
      await load();
      return r;
    } catch (e) {
      flash('bad', (e as ApiError).message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (error && !data) {
    return (
      <div className="wb-wrap">
        <Empty icon={<CircleAlert size={22} />} title="Could not load the building">{error}</Empty>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="wb-wrap">
        <div className="wb-skel-strip" />
        <div className="wb-layout">
          <div className="wb-skel" style={{ height: 420 }} />
          <div className="wb-skel" style={{ height: 420 }} />
        </div>
      </div>
    );
  }

  const totalAgents = floors.reduce((n, f) => n + f.agents.length, 0);
  const working = floors.reduce((n, f) => n + f.agents.reduce((m, a) => m + a.activeRuns, 0), 0);

  return (
    <div className="wb-wrap">
      <AnimatePresence>
        {notice && (
          <motion.div className={`wb-toast is-${notice.tone}`} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            {notice.text}
          </motion.div>
        )}
      </AnimatePresence>

      {/* The strip: autopilot, safety switches, the building in numbers */}
      <section className="wb-strip">
        <div className={`wb-auto${data.autopilot ? ' is-on' : ''}`}>
          <div className="wb-auto-ico"><Zap size={18} /></div>
          <div className="wb-auto-t">
            <b>Autopilot {data.autopilot ? 'on' : 'off'}</b>
            <span>{data.autopilot
              ? 'Agents start by themselves when a lead arrives, a sheet changes, the LMS sends an event, or their schedule comes round.'
              : 'Off: agents only run when you press Run. Turn it on to let them start by themselves.'}</span>
          </div>
          <Toggle on={data.autopilot} disabled={busy === 'auto' || data.canManage === false} onChange={(on) => void act('auto', { action: 'setAutopilot', on }, on ? 'Autopilot is on. Agents now start by themselves.' : 'Autopilot paused.')} />
        </div>
        <div className="wb-pills">
          <Link href="/settings" className={`wb-pill ${data.requireApproval ? 'is-warn' : 'is-live'}`} title="Change in Settings">
            <ShieldCheck size={14} />
            <span><b>Approval Mode {data.requireApproval ? 'on' : 'off'}</b><em>{data.requireApproval ? 'You approve each message before it goes' : 'Reviewed messages go straight out'}</em></span>
          </Link>
          <Link href="/settings" className={`wb-pill ${data.liveOutreach ? 'is-live' : 'is-safe'}`} title="Change in Settings">
            <Wifi size={14} />
            <span><b>{data.sendingPaused ? 'Sending paused' : data.liveOutreach ? 'Live outreach' : 'Safe Test Mode'}</b><em>{data.sendingPaused ? 'Test phase: nothing leaves the building; see the Inbox' : data.liveOutreach ? 'Emails and WhatsApps really send' : 'Nothing leaves the app; see the Inbox'}</em></span>
          </Link>
          <div className="wb-pill is-plain">
            <Users size={14} />
            <span><b>{totalAgents} agents · {floors.length} floors</b><em>{working ? `${working} job${working === 1 ? '' : 's'} in progress` : 'All quiet right now'}</em></span>
          </div>
        </div>
      </section>

      <div className="wb-layout">
        {/* The elevator: one button per floor, top floor first */}
        <nav className="wb-rail" aria-label="Departments">
          <div className="wb-rail-h">
            <span><Building2 size={14} /> Floors</span>
            <button type="button" className="wb-link-btn" onClick={() => setDeptModal('new')}><Plus size={13} /> Add</button>
          </div>
          {floors.map((f) => {
            const active = f.agents.reduce((n, a) => n + a.activeRuns, 0);
            return (
              <button key={f.id} type="button" className={`wb-floor${f.id === deptId ? ' is-sel' : ''}`} style={{ ['--d' as string]: f.color }} onClick={() => choose(f.id)}>
                <span className="wb-floor-n">{f.floor ?? '·'}</span>
                <span className="wb-floor-t">
                  <b>{f.name}</b>
                  <em>{f.agents.length} agent{f.agents.length === 1 ? '' : 's'}{active ? ` · ${active} working` : ''}</em>
                </span>
                {active > 0 && <i className="wb-live-dot" />}
              </button>
            );
          })}
        </nav>

        {/* The selected floor */}
        <main className="wb-main">
          {dept ? (
            <motion.div key={dept.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
              <header className="wb-dept" style={{ ['--d' as string]: dept.color }}>
                <div className="wb-dept-top">
                  <div>
                    <span className="wb-eyebrow">Floor {dept.floor ?? '–'}</span>
                    <h2>{dept.name}</h2>
                    <p>{dept.purpose}</p>
                  </div>
                  <div className="wb-dept-acts">
                    {data.canManage !== false && <button type="button" className="btn btn-outline btn-sm" onClick={() => setDeptModal(dept)}><Pencil size={13} /> Edit department</button>}
                    {data.canManage !== false && <button type="button" className="btn wb-btn-primary btn-sm" onClick={() => setAgentModal(true)}><Plus size={14} /> New agent</button>}
                  </div>
                </div>
                {!!dept.responsibilities?.length && (
                  <div className="wb-resp">{dept.responsibilities.map((r) => <span key={r}>{r}</span>)}</div>
                )}
              </header>

              {dept.agents.length ? (
                <div className="wb-agents">
                  <AnimatePresence initial={false}>
                    {dept.agents.map((a, i) => (
                      <motion.div key={a.id} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0, transition: { delay: i * 0.03 } }} exit={{ opacity: 0, scale: 0.97 }}>
                        <AgentCard
                          agent={a}
                          sources={data.sources}
                          labels={data.fieldLabels}
                          busy={busy === `t:${a.id}`}
                          onOpen={() => a.workflow && router.push(`/workflows/${a.workflow.id}`)}
                          onToggle={(on) => a.workflow && void act(`t:${a.id}`, { action: 'saveWorkflow', id: a.workflow.id, enabled: on }, `${a.name} is ${on ? 'on' : 'paused'}.`)}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              ) : (
                <Empty icon={<Users size={22} />} title="No agents on this floor yet">
                  Add an agent, give it a job in plain words, and the AI builds the steps.
                  <br /><button type="button" className="btn wb-btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => setAgentModal(true)}><Plus size={14} /> New agent</button>
                </Empty>
              )}
            </motion.div>
          ) : (
            <Empty icon={<Building2 size={22} />} title="No departments yet">Add a department to give the building its first floor.</Empty>
          )}
        </main>

        <aside className="wb-activity">
          <div className="wb-rail-h"><span><Power size={14} /> Recent activity</span></div>
          <Activity runs={data.runs} floors={floors} />
        </aside>
      </div>

      <NewAgentModal
        open={agentModal}
        floors={floors}
        defaultDept={deptId}
        onClose={() => setAgentModal(false)}
        onCreated={(wfId) => { setAgentModal(false); router.push(`/workflows/${wfId}`); }}
        onError={(m) => flash('bad', m)}
      />
      <DepartmentModal
        value={deptModal}
        floors={floors}
        onClose={() => setDeptModal(null)}
        onSaved={async (id) => { setDeptModal(null); await load(); if (id) choose(id); flash('ok', 'Department saved.'); }}
        onDeleted={async () => { setDeptModal(null); setDeptId(null); await load(); flash('ok', 'Department removed.'); }}
        onError={(m) => flash('bad', m)}
      />
    </div>
  );
}

function sourceWarning(a: AgentCardData, sources: DataSource[]): string | null {
  const t = a.workflow?.agentTrigger;
  if (!t?.sourceId) return null;
  const s = sources.find((x) => x.id === t.sourceId);
  if (!s) return 'Its sheet was removed';
  if (s.id === 'src_moodle') return (s.rows ?? 0) > 0 ? null : 'Starts after the first Moodle sync';
  if (s.kind !== 'leads' && !s.url) return `Connect "${s.name}" to start`;
  if (s.lastError) return `${s.name}: ${s.lastError}`;
  return null;
}

function AgentCard({ agent: a, sources, labels, busy, onOpen, onToggle }: {
  agent: AgentCardData; sources: DataSource[]; labels: Record<string, string>; busy: boolean;
  onOpen: () => void; onToggle: (on: boolean) => void;
}) {
  const wf = a.workflow;
  const steps = countSteps(wf?.steps);
  const warn = sourceWarning(a, sources);
  const color = a.color || AGENT_COLORS[(a.name.charCodeAt(0) || 0) % AGENT_COLORS.length];
  return (
    <article className={`wb-agent${wf?.enabled === false ? ' is-paused' : ''}`} style={{ ['--a' as string]: color }} onClick={onOpen} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <div className="wb-agent-top">
        <Avatar name={a.name} color={color} size={42} />
        <div className="wb-agent-id">
          <b>{a.name}</b>
          <span>{a.title}</span>
        </div>
        {wf && <Toggle on={wf.enabled !== false} disabled={busy} onChange={onToggle} />}
      </div>
      {wf && <h3 className="wb-agent-job">{wf.name}</h3>}
      {!!a.responsibilities?.length && (
        <ul className="wb-agent-resp">{a.responsibilities.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
      )}
      <div className="wb-agent-trig">
        <TriggerIcon kind={wf?.agentTrigger?.kind} size={14} />
        <span>{triggerSummary(wf?.agentTrigger, sources, labels)}</span>
      </div>
      {warn && <div className="wb-agent-warn"><CircleAlert size={13} /> {warn}</div>}
      <footer className="wb-agent-foot">
        <span className="wb-meta">{steps ? `${steps} step${steps === 1 ? '' : 's'}` : 'No steps yet'}</span>
        {a.activeRuns > 0 && <span className="wb-chip wb-chip-run"><i />{a.activeRuns} in progress</span>}
        {a.lastRun && !a.activeRuns && <StatusChip run={a.lastRun} />}
        {a.lastRun && <span className="wb-meta wb-push">{ago(a.lastRun.updatedAt)}</span>}
        {!a.lastRun && <span className="wb-meta wb-push">Open <ArrowRight size={12} /></span>}
      </footer>
    </article>
  );
}

function Activity({ runs, floors }: { runs: LightRun[]; floors: DepartmentData[] }) {
  if (!runs.length) return <p className="wb-quiet">Nothing yet. When an agent picks someone up, it shows here.</p>;
  const color = (id: string | null) => floors.find((f) => f.id === id)?.color || '#64748b';
  return (
    <ul className="wb-acts">
      {runs.slice(0, 18).map((r) => (
        <li key={r.id}>
          <Link href={`/workflows/${r.workflowId}?run=${r.id}`} className="wb-act" style={{ ['--d' as string]: color(r.departmentId) }}>
            <i className={`wb-act-dot${isActive(r) ? ' is-live' : ''}`} />
            <span className="wb-act-t">
              <b>{r.agentName} → {r.record.name}</b>
              <em>{r.logs[r.logs.length - 1]?.detail || r.workflowName}</em>
            </span>
            <span className="wb-act-r">
              <StatusChip run={{ status: r.status }} />
              <em>{ago(r.updatedAt)}</em>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function NewAgentModal({ open, floors, defaultDept, onClose, onCreated, onError }: {
  open: boolean; floors: DepartmentData[]; defaultDept: string | null;
  onClose: () => void; onCreated: (workflowId: string) => void; onError: (m: string) => void;
}) {
  const [f, setF] = useState({ name: '', title: '', officeId: '', persona: '', instructions: '', jobName: '' });
  const [saving, setSaving] = useState(false);
  // Reset only when the modal opens (the floors list refreshes every few seconds).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) setF({ name: '', title: '', officeId: defaultDept || floors[0]?.id || '', persona: '', instructions: '', jobName: '' }); }, [open]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const create = async () => {
    setSaving(true);
    try {
      const r = await api<{ workflow: { id: string } }>({
        action: 'saveAgent', name: f.name, title: f.title, officeId: f.officeId, persona: f.persona, instructions: f.instructions,
        jobName: f.jobName || undefined, color: AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)],
      });
      onCreated(r.workflow.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New agent" sub="Give them a name and a role. Next you'll build their job, step by step or by describing it."
      footer={<>
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>Cancel</button>
        <button type="button" className="btn wb-btn-primary btn-sm" disabled={saving || !f.name.trim() || !f.officeId} onClick={() => void create()}>
          {saving ? 'Creating…' : <>Create and build <ArrowRight size={14} /></>}
        </button>
      </>}>
      <div className="wb-grid2">
        <label className="wb-f"><span>Name</span><input autoFocus value={f.name} onChange={set('name')} placeholder="e.g. Naledi" /></label>
        <label className="wb-f"><span>Role</span><input value={f.title} onChange={set('title')} placeholder="e.g. Lead Nurturer" /></label>
      </div>
      <label className="wb-f"><span>Department (floor)</span>
        <select value={f.officeId} onChange={set('officeId')}>
          {[...floors].sort((a, b) => (a.floor ?? 0) - (b.floor ?? 0)).map((d) => <option key={d.id} value={d.id}>Floor {d.floor ?? '–'} · {d.name}</option>)}
        </select>
      </label>
      <label className="wb-f"><span>Their job, in a few words</span><input value={f.jobName} onChange={set('jobName')} placeholder="e.g. Follow up overdue accounts" /></label>
      <label className="wb-f"><span>Personality</span><textarea rows={2} value={f.persona} onChange={set('persona')} placeholder="e.g. Warm, precise, never pushy." /></label>
      <label className="wb-f"><span>Standing instructions</span><textarea rows={3} value={f.instructions} onChange={set('instructions')} placeholder="Rules they always follow, e.g. Always offer a payment arrangement." /></label>
    </Modal>
  );
}

const DEPT_COLORS = ['#7c3aed', '#0891b2', '#2563eb', '#059669', '#d97706', '#db2777', '#4f46e5', '#dc2626', '#0d9488'];

function DepartmentModal({ value, floors, onClose, onSaved, onDeleted, onError }: {
  value: DepartmentData | 'new' | null; floors: DepartmentData[];
  onClose: () => void; onSaved: (id: string | null) => void; onDeleted: () => void; onError: (m: string) => void;
}) {
  const isNew = value === 'new';
  const d = value && value !== 'new' ? value : null;
  const [f, setF] = useState({ name: '', purpose: '', color: DEPT_COLORS[0], floor: 1, resp: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!value) return;
    if (d) setF({ name: d.name, purpose: d.purpose || '', color: d.color || DEPT_COLORS[0], floor: d.floor ?? 1, resp: (d.responsibilities || []).join('\n') });
    else setF({ name: '', purpose: '', color: DEPT_COLORS[floors.length % DEPT_COLORS.length], floor: Math.max(0, ...floors.map((x) => x.floor ?? 0)) + 1, resp: '' });
  // Reset only when a different department is opened (the floors list refreshes every few seconds).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api<{ department: { id: string } }>({
        action: 'saveDepartment', id: d?.id, name: f.name, purpose: f.purpose, color: f.color, floor: Number(f.floor) || undefined,
        responsibilities: f.resp.split(/\n|,/).map((x) => x.trim()).filter(Boolean),
      });
      onSaved(r.department?.id || null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!d || !window.confirm(`Remove the ${d.name} department? This cannot be undone.`)) return;
    try {
      await api({ action: 'deleteDepartment', id: d.id });
      onDeleted();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <Modal open={Boolean(value)} onClose={onClose} title={isNew ? 'New department' : `Edit ${d?.name || 'department'}`} sub="A department is one floor of the building."
      footer={<>
        {d && <button type="button" className="btn wb-btn-danger btn-sm wb-push-r" onClick={() => void remove()} disabled={d.agents.length > 0} title={d.agents.length ? 'Move or delete its agents first' : undefined}>Remove</button>}
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>Cancel</button>
        <button type="button" className="btn wb-btn-primary btn-sm" disabled={saving || !f.name.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
      </>}>
      <div className="wb-grid2">
        <label className="wb-f"><span>Name</span><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Alumni Relations" /></label>
        <label className="wb-f"><span>Floor</span><input type="number" min={1} max={50} value={f.floor} onChange={(e) => setF({ ...f, floor: Number(e.target.value) })} /></label>
      </div>
      <label className="wb-f"><span>What this department does</span><textarea rows={2} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></label>
      <label className="wb-f"><span>Responsibilities (one per line)</span><textarea rows={4} value={f.resp} onChange={(e) => setF({ ...f, resp: e.target.value })} placeholder={'Lead qualification\nStudent enquiries'} /></label>
      <div className="wb-f"><span>Colour</span>
        <div className="wb-swatches">
          {DEPT_COLORS.map((c) => <button key={c} type="button" aria-label={c} className={c === f.color ? 'on' : ''} style={{ background: c }} onClick={() => setF({ ...f, color: c })} />)}
        </div>
      </div>
    </Modal>
  );
}
