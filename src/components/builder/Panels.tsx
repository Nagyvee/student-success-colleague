'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { CircleCheck, CircleDot, CircleMinus, CircleX, Clock, LoaderCircle, Play, Search, Square, StepForward, Users, X } from 'lucide-react';
import type { AgentRun, AgentRunLog, AgentTrigger, DataSource, StepKind } from '@/lib/types';
import { ApiError, STEP_META, metaOf, STEP_ORDER, VALUE_HINTS, ago, api, isActive, when, type RecordRow, type StepGroup } from './model';
import { Modal, StatusChip, StepIcon } from './ui';

/* ── Step picker ──────────────────────────────────────────────────────────── */

export function StepPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (k: StepKind) => void }) {
  const groups: StepGroup[] = ['AI actions', 'Logic', 'Data & team'];
  return (
    <Modal open={open} onClose={onClose} title="Add a step" sub="Every step is carried out by the agent." wide>
      {groups.map((g) => (
        <div key={g} className="wb-pick-g">
          <h4>{g}</h4>
          <div className="wb-pick-grid">
            {STEP_ORDER.filter((k) => STEP_META[k].group === g).map((k) => (
              <button key={k} type="button" className="wb-pick" style={{ ['--k' as string]: STEP_META[k].color }} onClick={() => onPick(k)}>
                <StepIcon kind={k} />
                <span><b>{STEP_META[k].label}</b><em>{STEP_META[k].hint}</em></span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  );
}

/* ── Run timeline ─────────────────────────────────────────────────────────── */

const LOG_ICON: Record<AgentRunLog['status'], typeof CircleCheck> = { ok: CircleCheck, info: CircleDot, wait: Clock, fail: CircleX, skip: CircleMinus };

export function RunDrawer({ runId, onClose, onChanged }: { runId: string | null; onClose: () => void; onChanged?: () => void }) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!runId) { setRun(null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const d = await api<{ run: AgentRun }>(undefined, `run=${encodeURIComponent(runId)}`);
        if (!alive) return;
        setRun(d.run); setErr(null);
        timer = setTimeout(load, isActive(d.run) ? 2000 : 10000);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    setRun(null);
    void load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [runId]);

  const logCount = run?.logs.length || 0;
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [logCount]);

  const act = async (action: 'resumeRun' | 'stopRun') => {
    if (!run) return;
    if (action === 'stopRun' && !window.confirm(`Stop this run for ${run.record.name}? Nothing more is sent.`)) return;
    setBusy(true);
    try {
      await api({ action, runId: run.id });
      const d = await api<{ run: AgentRun }>(undefined, `run=${encodeURIComponent(run.id)}`);
      setRun(d.run);
      onChanged?.();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {runId && (
        <>
          <motion.div className="wb-drawer-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside className="wb-drawer" initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
            <header className="wb-drawer-h">
              <div>
                <span className="wb-eyebrow">{run ? `${run.agentName} · ${run.departmentName}` : 'Run'}</span>
                <h3>{run?.record.name || 'Loading…'}</h3>
                {run && <p>{[run.record.email, run.record.phone].filter(Boolean).join(' · ') || 'No contact details'}</p>}
              </div>
              <button type="button" className="wb-x" onClick={onClose} aria-label="Close"><X size={18} /></button>
            </header>
            {err && <div className="wb-alert">{err}</div>}
            {run && (
              <>
                <div className="wb-drawer-meta">
                  <StatusChip run={run} />
                  <span>Started {ago(run.startedAt)} by {run.trigger}</span>
                </div>
                {run.status === 'awaiting_approval' && (
                  <div className="wb-alert is-appr">The message is waiting for approval. <Link href="/">Approve it in the Live Office inbox</Link> and the agent carries on.</div>
                )}
                {(run.status === 'waiting' || isActive(run)) && (
                  <div className="wb-drawer-acts">
                    {run.status === 'waiting' && <button type="button" className="btn wb-btn-primary btn-sm" disabled={busy} onClick={() => void act('resumeRun')}><StepForward size={14} /> Continue now</button>}
                    <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void act('stopRun')}><Square size={12} /> Stop</button>
                  </div>
                )}
                <ol className="wb-tl">
                  {run.logs.map((l, i) => {
                    const I = LOG_ICON[l.status] || CircleDot;
                    const step = l.stepId ? findKind(run, l.stepId) : null;
                    return (
                      <motion.li key={`${l.ts}-${i}`} className={`is-${l.status}`} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }}>
                        <span className="wb-tl-ico"><I size={15} /></span>
                        <div className="wb-tl-b">
                          <div className="wb-tl-top">
                            {step ? <span className="wb-tl-step" style={{ ['--k' as string]: metaOf(step).color }}>{l.title}</span> : <span className="wb-tl-step">{l.title}</span>}
                            <time>{new Date(l.ts).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>
                          </div>
                          <p>{l.detail}</p>
                          {l.output && <div className="wb-bubble">{l.output}</div>}
                        </div>
                      </motion.li>
                    );
                  })}
                  {run.status === 'running' && <li className="is-live"><span className="wb-tl-ico"><LoaderCircle size={15} className="wb-spin" /></span><div className="wb-tl-b"><p>Working…</p></div></li>}
                  {run.status === 'waiting' && run.resumeAt && <li className="is-wait"><span className="wb-tl-ico"><Clock size={15} /></span><div className="wb-tl-b"><p>Carries on {when(run.resumeAt)}.</p></div></li>}
                </ol>
                <div ref={endRef} />
                {run.record.sourceId && <RecordEdit sourceId={run.record.sourceId} recordKey={run.record.key} name={run.record.name} onDone={(m) => { setErr(null); setNote(m); onChanged?.(); }} onError={setErr} />}
                {note && <div className="wb-alert is-ok">{note}</div>}
              </>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

/** Staff set a field on the person's record (e.g. a lead is now "applied"); agents waiting on it react. */
function RecordEdit({ sourceId, recordKey, name, onDone, onError }: { sourceId: string; recordKey: string; name: string; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [field, setField] = useState('status');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ agentsStarted?: number }>({ action: 'updateRecord', sourceId, key: recordKey, field, value });
      onDone(`Saved ${field.replace(/_/g, ' ')} = "${value}" for ${name.split(' ')[0]}${r.agentsStarted ? `; ${r.agentsStarted} agent${r.agentsStarted === 1 ? '' : 's'} started` : ''}.`);
      setValue('');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wb-recedit">
      <h4>Update {name.split(' ')[0]}&apos;s record</h4>
      <div className="wb-row">
        <input className="wb-input" list="wb-rec-fields" value={field} onChange={(e) => setField(e.target.value)} aria-label="Field" />
        <input className="wb-input" list={`wb-rec-vals-${field}`} value={value} placeholder="e.g. applied" onChange={(e) => setValue(e.target.value)} aria-label="Value" />
        <button type="button" className="btn btn-outline btn-sm" disabled={busy || !field.trim()} onClick={() => void save()}>Save</button>
      </div>
      <datalist id="wb-rec-fields">{['status', 'payment_status', 'notes', 'owner'].map((f) => <option key={f} value={f} />)}</datalist>
      <datalist id={`wb-rec-vals-${field}`}>{(VALUE_HINTS[field] || []).map((v) => <option key={v} value={v} />)}</datalist>
      <p className="wb-hint">Agents whose trigger waits on this field (e.g. "status becomes applied") start straight away.</p>
    </div>
  );
}

function findKind(run: AgentRun, id: string): StepKind | null {
  const walk = (list: AgentRun['steps']): StepKind | null => {
    for (const s of list || []) {
      if (s.id === id) return s.kind;
      const k = walk(s.yes || []) || walk(s.no || []) || walk(s.steps || []);
      if (k) return k;
    }
    return null;
  };
  return walk(run.steps);
}

/* ── Test run ─────────────────────────────────────────────────────────────── */

const QUICK_FIELDS = ['amount_due', 'due_date', 'interest', 'programme', 'status', 'company'];

export function TestRunModal({ open, onClose, workflowId, trigger, sources, matchCount, dirty, onBeforeRun, onStarted }: {
  open: boolean; onClose: () => void; workflowId: string; trigger: AgentTrigger | undefined; sources: DataSource[];
  matchCount: number; dirty: boolean; onBeforeRun: () => Promise<boolean>;
  onStarted: (runId: string | null, message: string) => void;
}) {
  const kind = trigger?.kind || 'manual';
  const canAll = ['record.match', 'record.added', 'record.changed', 'lead.created'].includes(kind);
  const isReport = kind === 'schedule';
  const [tab, setTab] = useState<'record' | 'contact' | 'all'>('record');
  const [sourceId, setSourceId] = useState<string>('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<RecordRow | null>(null);
  const [contact, setContact] = useState({ name: '', email: '', phone: '' });
  const [extra, setExtra] = useState<{ k: string; v: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const withRows = useMemo(() => sources.filter((s) => (s.rows || 0) > 0 || s.kind === 'leads'), [sources]);

  useEffect(() => {
    if (!open) return;
    setErr(null); setPicked(null); setQ('');
    const preferred = trigger?.sourceId && sources.some((s) => s.id === trigger.sourceId) ? trigger.sourceId : (withRows[0]?.id || sources[0]?.id || '');
    setSourceId(preferred);
    setTab(withRows.length ? 'record' : 'contact');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || tab !== 'record' || !sourceId) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const d = await api<{ records: RecordRow[] }>(undefined, `records=${encodeURIComponent(sourceId)}&q=${encodeURIComponent(q)}`);
        if (alive) setRows(d.records);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [open, tab, sourceId, q]);

  const start = async (body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try {
      if (dirty && !(await onBeforeRun())) { setBusy(false); return; }
      const r = await api<{ run?: AgentRun; started?: number; matched?: number; more?: boolean }>({ action: 'runAgent', workflowId, ...body });
      if (r.run) onStarted(r.run.id, `Started for ${r.run.record.name}.`);
      else onStarted(null, `Started ${r.started ?? 0} run${r.started === 1 ? '' : 's'} (${r.matched ?? 0} matching${r.more ? '; the rest follow at the next check' : ''}).`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const keyFields = (f: Record<string, string>) => ['payment_state', 'amount_due_display', 'due_date_display', 'status', 'interest', 'programme', 'company']
    .filter((k) => f[k]).slice(0, 3).map((k) => f[k]);

  return (
    <Modal open={open} onClose={onClose} wide title="Test run" sub={dirty ? 'Your unsaved changes are saved first.' : 'Runs the saved workflow now, for real (Safe Test Mode and Approval Mode still apply).'}
      footer={
        isReport ? <button type="button" className="btn wb-btn-primary btn-sm" disabled={busy} onClick={() => void start({})}><Play size={13} /> Run the report now</button>
          : tab === 'record' ? <button type="button" className="btn wb-btn-primary btn-sm" disabled={busy || !picked} onClick={() => picked && void start({ recordKey: picked.key, sourceId: picked.sourceId })}><Play size={13} /> {picked ? `Run for ${picked.name.split(' ')[0]}` : 'Pick someone'}</button>
            : tab === 'contact' ? <button type="button" className="btn wb-btn-primary btn-sm" disabled={busy || !(contact.email || contact.phone)} onClick={() => void start({ custom: { ...contact, fields: Object.fromEntries(extra.filter((x) => x.k.trim()).map((x) => [x.k.trim(), x.v])) } })}><Play size={13} /> Run for this contact</button>
              : <button type="button" className="btn wb-btn-primary btn-sm" disabled={busy || !matchCount} onClick={() => void start({ allMatching: true })}><Users size={13} /> Run for everyone matching</button>
      }>
      {err && <div className="wb-alert">{err}</div>}
      {isReport ? (
        <p className="wb-quiet">This agent writes a report for the team, so it doesn&apos;t need a person to run for. It uses {sources.find((s) => s.id === trigger?.sourceId)?.name || 'no data source'}.</p>
      ) : (
        <>
          <div className="wb-seg wb-seg-full">
            <button type="button" className={tab === 'record' ? 'on' : ''} onClick={() => setTab('record')}>Someone on a sheet</button>
            <button type="button" className={tab === 'contact' ? 'on' : ''} onClick={() => setTab('contact')}>A test contact</button>
            {canAll && <button type="button" className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>Everyone matching ({matchCount})</button>}
          </div>

          {tab === 'record' && (
            <div className="wb-test-rec">
              <div className="wb-row">
                <select className="wb-input" value={sourceId} onChange={(e) => { setSourceId(e.target.value); setPicked(null); }}>
                  {sources.map((s) => <option key={s.id} value={s.id}>{s.name}{s.rows ? ` (${s.rows})` : ''}</option>)}
                </select>
                <div className="wb-search"><Search size={14} /><input value={q} placeholder="Search name, email or phone" onChange={(e) => setQ(e.target.value)} /></div>
              </div>
              <div className="wb-recs">
                {loading && !rows.length ? <p className="wb-quiet">Loading…</p> : !rows.length ? (
                  <p className="wb-quiet">No records here yet. Connect the sheet in <Link href="/workspace">Channels &amp; API</Link>, or use a test contact.</p>
                ) : rows.map((r) => (
                  <button key={r.key} type="button" className={`wb-rec${picked?.key === r.key ? ' on' : ''}`} onClick={() => setPicked(r)}>
                    <b>{r.name}</b>
                    <span>{r.email || r.phone || 'No contact details'}</span>
                    <em>{keyFields(r.fields).join(' · ')}</em>
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === 'contact' && (
            <div className="wb-test-contact">
              <div className="wb-grid3">
                <label className="wb-f"><span>Name</span><input value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} placeholder="Thandi Mokoena" /></label>
                <label className="wb-f"><span>Email</span><input type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} placeholder="you@example.com" /></label>
                <label className="wb-f"><span>Phone / WhatsApp</span><input value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} placeholder="082 123 4567" /></label>
              </div>
              <div className="wb-f"><span>Extra facts the agent can use</span>
                {extra.map((x, i) => (
                  <div key={i} className="wb-row">
                    <input className="wb-input" value={x.k} placeholder="field" onChange={(e) => setExtra(extra.map((y, j) => (j === i ? { ...y, k: e.target.value } : y)))} />
                    <input className="wb-input" value={x.v} placeholder="value" onChange={(e) => setExtra(extra.map((y, j) => (j === i ? { ...y, v: e.target.value } : y)))} />
                    <button type="button" className="wb-icon-btn" onClick={() => setExtra(extra.filter((_, j) => j !== i))}><X size={14} /></button>
                  </div>
                ))}
                <div className="wb-quick">
                  {QUICK_FIELDS.filter((k) => !extra.some((x) => x.k === k)).map((k) => (
                    <button key={k} type="button" onClick={() => setExtra([...extra, { k, v: k === 'due_date' ? new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) : '' }])}>+ {k.replace(/_/g, ' ')}</button>
                  ))}
                </div>
              </div>
              <p className="wb-hint">Use your own email to see exactly what a person would receive.</p>
            </div>
          )}

          {tab === 'all' && (
            <p className="wb-quiet">Starts the agent for everyone who matches its trigger and rules right now ({matchCount} at the last count). People it handled recently are skipped, and it starts at most 20 at a time.</p>
          )}
        </>
      )}
    </Modal>
  );
}
