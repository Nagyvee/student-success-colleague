'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft, CircleAlert, Info, LoaderCircle, Minus, PanelRightOpen, Play, Plus, PenLine, Save, Settings2, Trash2, UserRound, Users, X, Zap,
} from 'lucide-react';
import type { AgentStep, AgentTrigger, StepKind } from '@/lib/types';
import Canvas, { type Selection } from '@/components/builder/Canvas';
import { StepEditor, TriggerEditor } from '@/components/builder/Inspector';
import { RunDrawer, StepPicker, TestRunModal } from '@/components/builder/Panels';
import { Avatar, Empty, Modal, StatusChip, Toggle } from '@/components/builder/ui';
import {
  AGENT_COLORS, ApiError, ago, api, countSteps, duplicateStep, findStep, insertStep, isActive, moveStep, newStep, removeStep,
  triggerSummary, updateStep, type InsertAt, type WorkflowView,
} from '@/components/builder/model';
import '../builder.css';

/* One agent's job, built like a chat-flow builder but every step is done by
 * the AI: a trigger at the top, steps below, branches and follow-up loops,
 * and an inspector on the right. Runs show what the agent actually did. */

interface Draft { name: string; description: string; agentTrigger: AgentTrigger | undefined; steps: AgentStep[] }

const snapshot = (d: Draft) => JSON.stringify(d);

export default function AgentBuilderClient({ id }: { id: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [view, setView] = useState<WorkflowView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [sel, setSel] = useState<Selection>(null);
  const [tab, setTab] = useState<'edit' | 'runs' | 'who'>('edit');
  const [picker, setPicker] = useState<InsertAt | null>(null);
  const [drawerRun, setDrawerRun] = useState<string | null>(params.get('run'));
  const [testOpen, setTestOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const loaded = useRef(false);

  const flash = useCallback((tone: 'ok' | 'bad', text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 5000);
  }, []);

  const fetchView = useCallback(async (initial = false) => {
    try {
      const v = await api<WorkflowView>(undefined, `workflow=${encodeURIComponent(id)}`);
      setView(v);
      setLoadErr(null);
      if (initial || !loaded.current) {
        loaded.current = true;
        const d: Draft = { name: v.workflow.name, description: v.workflow.description || '', agentTrigger: v.workflow.agentTrigger || { kind: 'manual' }, steps: v.workflow.steps || [] };
        setDraft(d);
        setBaseline(snapshot(d));
      }
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void fetchView(true);
    const t = setInterval(() => { if (document.visibilityState === 'visible') void fetchView(); }, 5000);
    return () => clearInterval(t);
  }, [fetchView]);

  const dirty = Boolean(draft && baseline && snapshot(draft) !== baseline);

  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [dirty]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft || !view) return false;
    setSaving(true);
    try {
      const r = await api<{ workflow: WorkflowView['workflow'] }>({
        action: 'saveWorkflow', id: view.workflow.id, name: draft.name, description: draft.description, agentTrigger: draft.agentTrigger, steps: draft.steps,
      });
      const d: Draft = { name: r.workflow.name, description: r.workflow.description || '', agentTrigger: r.workflow.agentTrigger, steps: r.workflow.steps || [] };
      setDraft(d);
      setBaseline(snapshot(d));
      setView((v) => (v ? { ...v, workflow: r.workflow } : v));
      flash('ok', 'Saved. The agent uses this from its next run.');
      return true;
    } catch (e) {
      flash('bad', (e as ApiError).message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, view, flash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty && !saving) void save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  const setSteps = (fn: (s: AgentStep[]) => AgentStep[]) => setDraft((d) => (d ? { ...d, steps: fn(d.steps) } : d));

  const select = (s: Selection) => { setSel(s); setTab('edit'); setSheet(true); };

  const insert = (kind: StepKind) => {
    if (!picker) return;
    const step = newStep(kind);
    setSteps((s) => insertStep(s, picker, step));
    setPicker(null);
    select(step.id);
  };

  const del = (sid: string) => {
    const s = draft ? findStep(draft.steps, sid) : null;
    const inner = s ? countSteps([...(s.yes || []), ...(s.no || []), ...(s.steps || [])]) : 0;
    if (inner && !window.confirm(`Delete "${s?.title}" and the ${inner} step${inner === 1 ? '' : 's'} inside it?`)) return;
    setSteps((x) => removeStep(x, sid));
    if (sel === sid) setSel(null);
  };

  const toggleEnabled = async (on: boolean) => {
    if (!view) return;
    try {
      const r = await api<{ workflow: WorkflowView['workflow'] }>({ action: 'saveWorkflow', id: view.workflow.id, enabled: on });
      setView((v) => (v ? { ...v, workflow: { ...v.workflow, enabled: r.workflow.enabled } } : v));
      flash('ok', on ? `${view.agent?.name || 'The agent'} is on.` : `${view.agent?.name || 'The agent'} is paused: nothing new starts.`);
    } catch (e) {
      flash('bad', (e as Error).message);
    }
  };

  if (loadErr && !view) {
    return (
      <div className="wb-builder">
        <div className="wb-center"><Empty icon={<CircleAlert size={22} />} title="Could not open this agent">{loadErr}<br /><Link href="/workflows" className="wb-link-btn" style={{ marginTop: 10 }}>Back to agents</Link></Empty></div>
      </div>
    );
  }
  if (!view || !draft) {
    return <div className="wb-builder"><div className="wb-center"><LoaderCircle className="wb-spin" size={22} /></div></div>;
  }

  const agent = view.agent;
  const dept = view.department;
  const selectedStep = sel && sel !== 'trigger' ? findStep(draft.steps, sel) : null;
  const active = view.runs.filter(isActive).length;
  const agentColor = agent?.color || AGENT_COLORS[0];

  return (
    <div className="wb-builder" style={{ ['--d' as string]: dept?.color || '#2563eb' }}>
      <AnimatePresence>
        {toast && (
          <motion.div className={`wb-toast is-${toast.tone}`} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>{toast.text}</motion.div>
        )}
      </AnimatePresence>

      <header className="wb-bhead">
        <Link href={`/workflows${dept ? `?department=${dept.id}` : ''}`} className="wb-back" title="All agents"><ArrowLeft size={16} /></Link>
        <button type="button" className="wb-who" onClick={() => setAgentOpen(true)} title="Agent settings">
          <Avatar name={agent?.name || draft.name} color={agentColor} size={38} />
          <span>
            <b>{agent?.name || 'Agent'} <em>{agent?.title}</em></b>
            <i style={{ ['--d' as string]: dept?.color }}>{dept ? `Floor ${dept.floor ?? '–'} · ${dept.name}` : 'No department'}</i>
          </span>
        </button>
        <div className="wb-jobname">
          <span>Job</span>
          <input value={draft.name} maxLength={80} aria-label="Job name" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="wb-bhead-acts">
          <Toggle on={view.workflow.enabled !== false} onChange={(v) => void toggleEnabled(v)} label={view.workflow.enabled !== false ? 'On' : 'Paused'} />
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setAiOpen(true)}><PenLine size={14} /> <span className="wb-hide-s">Describe it</span></button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setTestOpen(true)} disabled={!draft.steps.length}><Play size={13} /> <span className="wb-hide-s">Test run</span></button>
          <button type="button" className={`btn btn-sm wb-btn-primary${dirty ? ' is-dirty' : ''}`} onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <LoaderCircle size={14} className="wb-spin" /> : <Save size={14} />} {dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </header>

      <div className="wb-bbody">
        <div className="wb-canvas-wrap">
          <div className="wb-zoom">
            <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} aria-label="Zoom out"><Minus size={14} /></button>
            <button type="button" onClick={() => setZoom(1)} className="wb-zoom-v" title="Reset zoom">{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom((z) => Math.min(1.3, +(z + 0.1).toFixed(2)))} aria-label="Zoom in"><Plus size={14} /></button>
          </div>
          {dirty && <div className="wb-dirty-note"><Info size={13} /> Unsaved changes</div>}
          <div className="wb-canvas" onClick={() => setSel(null)}>
            <div className="wb-zoomer" style={{ zoom }}>
              <Canvas
                trigger={draft.agentTrigger}
                steps={draft.steps}
                sources={view.sources}
                labels={view.fieldLabels}
                selected={sel}
                onSelect={select}
                onInsert={setPicker}
                onMove={(sid, dir) => setSteps((s) => moveStep(s, sid, dir))}
                onDuplicate={(sid) => setSteps((s) => duplicateStep(s, sid))}
                onDelete={del}
              />
              {!draft.steps.length && (
                <div className="wb-canvas-empty">
                  <PenLine size={18} />
                  <p><b>No steps yet.</b> Press <b>+</b> above to add the first step, or <button type="button" className="wb-link-btn" onClick={(e) => { e.stopPropagation(); setAiOpen(true); }}>describe the job</button> and let the AI build it.</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className={`wb-side${sheet ? ' is-open' : ''}`}>
          <div className="wb-tabs">
            <button type="button" className={tab === 'edit' ? 'on' : ''} onClick={() => setTab('edit')}>Edit</button>
            <button type="button" className={tab === 'runs' ? 'on' : ''} onClick={() => setTab('runs')}>Runs{view.runs.length ? <em>{active ? `${active} live` : view.runs.length}</em> : null}</button>
            <button type="button" className={tab === 'who' ? 'on' : ''} onClick={() => setTab('who')}>Who&apos;s next{view.matches.length ? <em>{view.matches.length >= 25 ? '25+' : view.matches.length}</em> : null}</button>
            <button type="button" className="wb-sheet-x" onClick={() => setSheet(false)} aria-label="Close panel"><X size={16} /></button>
          </div>
          <div className="wb-side-body">
            {tab === 'edit' && (
              sel === 'trigger' ? (
                <TriggerEditor value={draft.agentTrigger} sources={view.sources} labels={view.fieldLabels} onChange={(t) => setDraft({ ...draft, agentTrigger: t })} />
              ) : selectedStep ? (
                <StepEditor
                  key={selectedStep.id}
                  step={selectedStep}
                  sources={view.sources}
                  sourceId={draft.agentTrigger?.sourceId}
                  labels={view.fieldLabels}
                  onChange={(patch) => setSteps((s) => updateStep(s, selectedStep.id, patch))}
                  onDuplicate={() => setSteps((s) => duplicateStep(s, selectedStep.id))}
                  onDelete={() => del(selectedStep.id)}
                />
              ) : (
                <Overview draft={draft} setDraft={setDraft} view={view} onPickTrigger={() => select('trigger')} />
              )
            )}
            {tab === 'runs' && (
              view.runs.length ? (
                <ul className="wb-runs">
                  {view.runs.map((r) => (
                    <li key={r.id}>
                      <button type="button" className="wb-run" onClick={() => setDrawerRun(r.id)}>
                        <span className="wb-run-t"><b>{r.record.name}</b><em>{r.logs[r.logs.length - 1]?.detail || r.trigger}</em></span>
                        <span className="wb-run-r"><StatusChip run={r} /><time>{ago(r.startedAt)}</time></span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <Empty icon={<Play size={20} />} title="No runs yet">Press Test run to try it on someone, or switch Autopilot on so it starts by itself.</Empty>
            )}
            {tab === 'who' && <WhoNext view={view} draftTrigger={draft.agentTrigger} dirty={dirty} />}
          </div>
        </aside>
        {!sheet && <button type="button" className="wb-sheet-open" onClick={() => setSheet(true)}><PanelRightOpen size={15} /> Panel</button>}
      </div>

      <StepPicker open={Boolean(picker)} onClose={() => setPicker(null)} onPick={insert} />
      <RunDrawer runId={drawerRun} onClose={() => { setDrawerRun(null); if (params.get('run')) router.replace(`/workflows/${id}`); }} onChanged={() => void fetchView()} />
      <TestRunModal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        workflowId={view.workflow.id}
        trigger={draft.agentTrigger}
        sources={view.sources}
        matchCount={view.matchCount ?? view.matches.length}
        dirty={dirty}
        onBeforeRun={save}
        onStarted={(runId, msg) => { setTestOpen(false); flash('ok', msg); void fetchView(); if (runId) setDrawerRun(runId); else setTab('runs'); }}
      />
      <AiBuildModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        workflowId={view.workflow.id}
        initial={draft.description || view.workflow.description || ''}
        current={draft}
        view={view}
        onApply={(d) => { setDraft({ ...draft, ...d }); setAiOpen(false); setSel(null); flash('ok', 'Applied. Check the steps, then press Save.'); }}
      />
      <AgentModal
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        view={view}
        onSaved={() => { setAgentOpen(false); void fetchView(); flash('ok', 'Agent saved.'); }}
        onDeleted={() => router.push(`/workflows${dept ? `?department=${dept.id}` : ''}`)}
        onError={(m) => flash('bad', m)}
      />
    </div>
  );
}

/* ── Panels ───────────────────────────────────────────────────────────────── */

function Overview({ draft, setDraft, view, onPickTrigger }: { draft: Draft; setDraft: (d: Draft) => void; view: WorkflowView; onPickTrigger: () => void }) {
  const steps = countSteps(draft.steps);
  return (
    <div className="wb-insp">
      <header className="wb-insp-h">
        <span className="wb-kico wb-kico-trig"><Zap size={17} /></span>
        <div><b>The job</b><span>Click any card on the canvas to edit it.</span></div>
      </header>
      <section className="wb-sec">
        <h4>What this agent does</h4>
        <textarea className="wb-input" rows={4} value={draft.description} placeholder="In a sentence or two: who it helps and how." onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </section>
      <section className="wb-sec">
        <h4>Starts</h4>
        <button type="button" className="wb-trig-line" onClick={onPickTrigger}>{triggerSummary(draft.agentTrigger, view.sources, view.fieldLabels)}</button>
      </section>
      <div className="wb-stats">
        <div><b>{steps}</b><span>steps</span></div>
        <div><b>{view.workflow.runs || 0}</b><span>runs so far</span></div>
        <div><b>{view.runs.filter(isActive).length}</b><span>in progress</span></div>
      </div>
      <section className="wb-sec wb-tips">
        <h4>How it works</h4>
        <ul>
          <li>The agent picks one person up at a time and works down the steps for them.</li>
          <li><b>Wait</b> and <b>Follow-up loop</b> steps pause for real days; the run carries on later by itself.</li>
          <li>Messages are written fresh for each person and checked by the reviewer before sending.</li>
          <li>With Approval Mode on, each message waits in the Live Office inbox until you approve it.</li>
          <li>Follow-ups stop by themselves when someone replies, so a person can take over.</li>
        </ul>
      </section>
    </div>
  );
}

function WhoNext({ view, draftTrigger, dirty }: { view: WorkflowView; draftTrigger: AgentTrigger | undefined; dirty: boolean }) {
  const kind = draftTrigger?.kind || 'manual';
  if (['lms.event', 'reply.received', 'manual', 'schedule'].includes(kind)) {
    const text = kind === 'lms.event' ? 'This agent reacts to LMS events as they happen, so there is no list to preview.'
      : kind === 'reply.received' ? 'This agent reacts when someone replies, so there is no list to preview.'
        : kind === 'schedule' ? 'This agent runs a report on its schedule, not for individual people.'
          : 'This agent only runs when someone presses Run.';
    return <Empty icon={<Users size={20} />} title="Nobody is queued">{text}</Empty>;
  }
  return (
    <div className="wb-who-list">
      <p className="wb-quiet">{kind === 'record.match' ? 'Everyone the next scheduled check would pick up (people handled recently are skipped then).' : 'Records in the sheet that pass the trigger rules today.'}{dirty ? ' Based on the saved version.' : ''}</p>
      {view.matches.length ? (
        <ul className="wb-runs">
          {view.matches.map((m) => (
            <li key={`${m.sourceId}:${m.key}`} className="wb-run is-static">
              <span className="wb-run-t"><b>{m.name}</b><em>{m.email || m.phone || 'No contact details'}</em></span>
              <UserRound size={14} />
            </li>
          ))}
        </ul>
      ) : <Empty icon={<Users size={20} />} title="Nobody matches right now">When someone matches the rules, they show up here.</Empty>}
    </div>
  );
}

function AiBuildModal({ open, onClose, workflowId, initial, current, view, onApply }: {
  open: boolean; onClose: () => void; workflowId: string; initial: string; current: Draft; view: WorkflowView;
  onApply: (d: Partial<Draft>) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; agentTrigger: AgentTrigger; steps: AgentStep[] } | null>(null);
  useEffect(() => { if (open) { setText(initial); setDraft(null); setErr(null); } }, [open, initial]);
  const build = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ draft: { name: string; agentTrigger: AgentTrigger; steps: AgentStep[] } }>({ action: 'buildFromWords', workflowId, description: text });
      setDraft(r.draft);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const examples = useMemo(() => [
    'Every morning, find students whose fees are overdue in the student tracker. Send a kind reminder by email and WhatsApp with the exact amount, then follow up every 3 days up to 3 times until they pay. If they still have not paid, tell the finance manager.',
    'When a new lead comes in from Facebook ads, score how ready they are, send a personal welcome about the course they asked for with the application link, and follow up every 2 days until they apply.',
    'When a student fails a quiz, send them a personal video lesson and a 10-question test. Two days later, if they passed, congratulate them; if not, offer a tutor session and tell the academic team.',
  ], []);
  return (
    <Modal open={open} onClose={onClose} wide="xl" title="Describe the job, the AI builds the steps" sub="Write it the way you would brief a new colleague. You can edit everything afterwards."
      footer={<>
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>Cancel</button>
        {draft
          ? <button type="button" className="btn wb-btn-primary btn-sm" onClick={() => onApply({ name: draft.name, agentTrigger: draft.agentTrigger, steps: draft.steps, description: text })}><PenLine size={14} /> Use the AI&apos;s version</button>
          : <button type="button" className="btn wb-btn-primary btn-sm" disabled={busy || text.trim().length < 10} onClick={() => void build()}>{busy ? <><LoaderCircle size={14} className="wb-spin" /> Building…</> : <><PenLine size={14} /> Build it</>}</button>}
      </>}>
      {!draft ? (
        <>
          <textarea className="wb-input wb-ai-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. When a new lead comes in from ads, welcome them personally and follow up until they apply." />
          {err && <div className="wb-alert">{err}</div>}
          <div className="wb-examples">
            <span>Try one of these:</span>
            {examples.map((x) => <button key={x} type="button" onClick={() => setText(x)}>{x}</button>)}
          </div>
        </>
      ) : (
        <div className="wb-compare">
          <div>
            <h4>Now</h4>
            <div className="wb-mini"><Canvas trigger={current.agentTrigger} steps={current.steps} sources={view.sources} labels={view.fieldLabels} readonly /></div>
          </div>
          <div>
            <h4>The AI&apos;s version · {draft.name}</h4>
            <div className="wb-mini is-new"><Canvas trigger={draft.agentTrigger} steps={draft.steps} sources={view.sources} labels={view.fieldLabels} readonly /></div>
            <button type="button" className="wb-link-btn" onClick={() => setDraft(null)}>Change the description</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function AgentModal({ open, onClose, view, onSaved, onDeleted, onError }: {
  open: boolean; onClose: () => void; view: WorkflowView; onSaved: () => void; onDeleted: () => void; onError: (m: string) => void;
}) {
  const a = view.agent;
  const [f, setF] = useState({ name: '', title: '', officeId: '', persona: '', instructions: '', resp: '', color: AGENT_COLORS[0] });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setF({
      name: a?.name || '', title: a?.title || '', officeId: a?.officeId || view.department?.id || '', persona: a?.persona || '',
      instructions: a?.instructions || '', resp: (a?.responsibilities || []).join('\n'), color: a?.color || AGENT_COLORS[0],
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const save = async () => {
    setBusy(true);
    try {
      await api({
        action: 'saveAgent', id: a?.id, name: f.name, title: f.title, officeId: f.officeId, persona: f.persona, instructions: f.instructions, color: f.color,
        responsibilities: f.resp.split('\n').map((x) => x.trim()).filter(Boolean),
      });
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!a || !window.confirm(`Delete ${a.name} and their workflow? Runs in progress stop. This cannot be undone.`)) return;
    try {
      await api({ action: 'deleteAgent', id: a.id });
      onDeleted();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={a ? `${a.name}, ${a.title}` : 'Agent'} sub="Who the agent is. Their personality and standing instructions go into every message they write."
      footer={<>
        {a && <button type="button" className="btn wb-btn-danger btn-sm wb-push-r" onClick={() => void remove()}><Trash2 size={13} /> Delete agent</button>}
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>Cancel</button>
        <button type="button" className="btn wb-btn-primary btn-sm" disabled={busy || !f.name.trim() || !f.officeId} onClick={() => void save()}><Settings2 size={13} /> Save agent</button>
      </>}>
      <div className="wb-grid2">
        <label className="wb-f"><span>Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="wb-f"><span>Role</span><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      </div>
      <label className="wb-f"><span>Department (floor)</span>
        <select value={f.officeId} onChange={(e) => setF({ ...f, officeId: e.target.value })}>
          {[...view.departments].sort((x, y) => (x.floor ?? 0) - (y.floor ?? 0)).map((d) => <option key={d.id} value={d.id}>Floor {d.floor ?? '–'} · {d.name}</option>)}
        </select>
      </label>
      <label className="wb-f"><span>Personality</span><textarea rows={2} value={f.persona} onChange={(e) => setF({ ...f, persona: e.target.value })} /></label>
      <label className="wb-f"><span>Standing instructions</span><textarea rows={3} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></label>
      <label className="wb-f"><span>Responsibilities (one per line)</span><textarea rows={3} value={f.resp} onChange={(e) => setF({ ...f, resp: e.target.value })} /></label>
      <div className="wb-f"><span>Colour</span>
        <div className="wb-swatches">{AGENT_COLORS.map((c) => <button key={c} type="button" aria-label={c} className={c === f.color ? 'on' : ''} style={{ background: c }} onClick={() => setF({ ...f, color: c })} />)}</div>
      </div>
    </Modal>
  );
}
