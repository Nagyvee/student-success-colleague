'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { CopyPlus, Info, Plus, Trash2, X } from 'lucide-react';
import type { AgentStep, AgentTrigger, AgentTriggerKind, DataSource, MessageChannel, StepCondition, WorkflowTrigger } from '@/lib/types';
import { CHANNEL_LABEL, LMS_EVENTS, STEP_META, metaOf, TRIGGER_CHOICES, WEEKDAYS, fieldSuggestions } from './model';
import { ConditionEditor, StepIcon, Toggle, TriggerIcon } from './ui';

/* The right-hand panel: edit whatever is selected on the canvas. */

const NEEDS_SOURCE: AgentTriggerKind[] = ['record.added', 'record.changed', 'record.match', 'lead.created', 'reply.received', 'schedule'];
const HAS_RULES: AgentTriggerKind[] = ['record.added', 'record.changed', 'record.match', 'lead.created', 'lms.event'];
const HAS_SCHEDULE: AgentTriggerKind[] = ['record.match', 'schedule'];

function Section({ title, children, hint }: { title?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="wb-sec">
      {title && <h4>{title}</h4>}
      {children}
      {hint && <p className="wb-hint"><Info size={12} /> {hint}</p>}
    </section>
  );
}

/* ── Saved message (the library) ──────────────────────────────────────────── */

const STAGES: { id: NonNullable<AgentStep['stage']>; label: string }[] = [
  { id: 'welcome', label: 'Welcome' }, { id: 'learn', label: 'Learn' }, { id: 'trust', label: 'Trust' },
  { id: 'offer', label: 'Offer' }, { id: 'decide', label: 'Decide' }, { id: 'reengage', label: 'Re-engage' }, { id: 'ongoing', label: 'Keep in touch' },
];

interface LibMsg { id: string; name: string; stage: string; status: string }

function LibraryStepEditor({ step, onChange }: { step: AgentStep; onChange: (p: Partial<AgentStep>) => void }) {
  const [msgs, setMsgs] = useState<LibMsg[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/nurture?messages=1', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setMsgs(Array.isArray(d?.messages) ? d.messages : []); })
      .catch(() => { if (live) setMsgs([]); });
    return () => { live = false; };
  }, []);
  const mode = step.messageId ? 'one' : 'best';
  return (
    <>
      <Section title="Which message" hint="Messages are written and approved once in Lead Nurturing → Messages. Sending one costs no AI.">
        <div className="wb-seg">
          <button type="button" className={mode === 'best' ? 'on' : ''} onClick={() => onChange({ messageId: undefined, stage: step.stage || 'learn' })}>Best fit for them</button>
          <button type="button" className={mode === 'one' ? 'on' : ''} onClick={() => onChange({ messageId: msgs?.find((m) => m.status === 'approved')?.id || msgs?.[0]?.id || undefined, stage: undefined })} disabled={!msgs?.length}>One message</button>
        </div>
      </Section>
      {mode === 'best' ? (
        <Section title="From the stage" hint="Picks the approved message of this stage they have not had yet, matching their programme and who they are (a parent, a school leaver).">
          <div className="wb-seg wb-seg-wrap">
            {STAGES.map((x) => (
              <button key={x.id} type="button" className={(step.stage || 'learn') === x.id ? 'on' : ''} onClick={() => onChange({ stage: x.id })}>{x.label}</button>
            ))}
          </div>
        </Section>
      ) : (
        <Section title="Message">
          <select className="wb-input" value={step.messageId || ''} onChange={(e) => onChange({ messageId: e.target.value || undefined })}>
            {(msgs || []).map((m) => <option key={m.id} value={m.id}>{m.name} · {m.stage}{m.status !== 'approved' ? ` (${m.status})` : ''}</option>)}
          </select>
        </Section>
      )}
      <Section title="Send by">
        <div className="wb-seg">
          {([undefined, 'email', 'whatsapp', 'email_whatsapp'] as (MessageChannel | undefined)[]).map((c) => (
            <button key={c || 'msg'} type="button" className={step.channel === c ? 'on' : ''} onClick={() => onChange({ channel: c })}>{c ? CHANNEL_LABEL[c] : 'As saved'}</button>
          ))}
        </div>
      </Section>
      <Section hint="One short AI sentence about what they wrote on the form, added after the greeting. Costs a little per person; leave it off for big lists.">
        <Toggle on={Boolean(step.personalLine)} onChange={(v) => onChange({ personalLine: v || undefined })} label="Add a personal line" />
      </Section>
    </>
  );
}

interface VOffer { id: string; name: string; status: string; value: number; kind: string }

function VoucherStepEditor({ step, onChange }: { step: AgentStep; onChange: (p: Partial<AgentStep>) => void }) {
  const [offers, setOffers] = useState<VOffer[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/nurture?offers=1', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setOffers(Array.isArray(d?.offers) ? d.offers : []); })
      .catch(() => { if (live) setOffers([]); });
    return () => { live = false; };
  }, []);
  return (
    <Section title="Which voucher" hint="Offers are set up and made active by a person in Lead Nurturing → Vouchers. The code is made by the system, never by AI, and each lead gets an offer once.">
      <select className="wb-input" value={step.voucherOfferId || ''} onChange={(e) => onChange({ voucherOfferId: e.target.value || undefined })}>
        <option value="">The best active one for them</option>
        {(offers || []).map((o) => <option key={o.id} value={o.id}>{o.name} ({o.kind === 'percent' ? `${o.value}%` : `R${o.value}`}){o.status !== 'active' ? ` · ${o.status}` : ''}</option>)}
      </select>
    </Section>
  );
}

/* ── Trigger ──────────────────────────────────────────────────────────────── */

export function TriggerEditor({ value, onChange, sources, labels }: {
  value: AgentTrigger | undefined;
  onChange: (t: AgentTrigger) => void;
  sources: DataSource[];
  labels?: Record<string, string>;
}) {
  const t: AgentTrigger = value || { kind: 'manual' };
  const set = (patch: Partial<AgentTrigger>) => onChange({ ...t, ...patch });
  const fields = fieldSuggestions(sources, t.sourceId);
  const src = sources.find((s) => s.id === t.sourceId);
  const sched = t.schedule || { every: 'day' as const, hour: 8 };

  const pickKind = (kind: AgentTriggerKind) => {
    const next: AgentTrigger = { kind, cooldownHours: t.cooldownHours };
    if (NEEDS_SOURCE.includes(kind)) next.sourceId = kind === 'lead.created' ? (sources.find((s) => s.kind === 'leads')?.id || t.sourceId) : t.sourceId;
    if (HAS_RULES.includes(kind)) next.match = t.match;
    if (HAS_SCHEDULE.includes(kind)) next.schedule = t.schedule || { every: kind === 'schedule' ? 'week' : 'day', hour: 8, ...(kind === 'schedule' ? { weekday: 1 } : {}) };
    if (kind === 'lms.event') next.lmsEvent = t.lmsEvent || 'quiz.failed';
    if (kind === 'record.changed') next.field = t.field || 'status';
    onChange(next);
  };

  return (
    <div className="wb-insp">
      <header className="wb-insp-h">
        <TriggerIcon kind={t.kind} />
        <div><b>What starts this agent</b><span>Pick the moment the agent picks someone up.</span></div>
      </header>

      <Section>
        <div className="wb-choices">
          {TRIGGER_CHOICES.map((c) => (
            <button key={c.kind} type="button" className={`wb-choice${t.kind === c.kind ? ' on' : ''}`} onClick={() => pickKind(c.kind)}>
              <b>{c.label}</b>
              <span>{c.hint}</span>
            </button>
          ))}
        </div>
      </Section>

      {NEEDS_SOURCE.includes(t.kind) && (
        <Section title={t.kind === 'schedule' ? 'Report on (optional)' : 'Which sheet or list'} hint={src && src.kind !== 'leads' && !src.url ? <>"{src.name}" has no sheet link yet. Connect it in <a href="/workspace">Channels &amp; API</a>.</> : undefined}>
          <select className="wb-input" value={t.sourceId || ''} onChange={(e) => set({ sourceId: e.target.value || undefined })}>
            <option value="">{t.kind === 'schedule' ? 'No data, just run' : 'Any sheet'}</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}{s.kind === 'leads' ? ' (from ads & forms)' : !s.url ? ' (not connected)' : ''}</option>)}
          </select>
        </Section>
      )}

      {t.kind === 'record.changed' && (
        <Section title="When this field changes" hint="Leave empty to react to any change on the row.">
          <input className="wb-input" list="wb-trig-fields" value={t.field || ''} placeholder="e.g. status" onChange={(e) => set({ field: e.target.value || undefined })} />
          <datalist id="wb-trig-fields">{fields.map((f) => <option key={f} value={f} />)}</datalist>
        </Section>
      )}

      {t.kind === 'lms.event' && (
        <Section title="When a student…">
          <select className="wb-input" value={t.lmsEvent || 'quiz.failed'} onChange={(e) => set({ lmsEvent: e.target.value as WorkflowTrigger })}>
            {LMS_EVENTS.map((e) => <option key={e.ev} value={e.ev}>{e.label}</option>)}
          </select>
        </Section>
      )}

      {HAS_SCHEDULE.includes(t.kind) && (
        <Section title="How often" hint={t.kind === 'record.match' ? 'At each check, the agent picks up everyone who matches the rules below (people it handled recently are skipped).' : 'Runs once each time, for the team.'}>
          <div className="wb-row">
            <select className="wb-input" value={sched.every} onChange={(e) => set({ schedule: { ...sched, every: e.target.value as 'hour' | 'day' | 'week', ...(e.target.value === 'week' ? { weekday: sched.weekday ?? 1 } : {}) } })}>
              <option value="hour">Every hour</option>
              <option value="day">Every day</option>
              <option value="week">Every week</option>
            </select>
            {sched.every === 'week' && (
              <select className="wb-input" value={sched.weekday ?? 1} onChange={(e) => set({ schedule: { ...sched, weekday: Number(e.target.value) } })}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            )}
            {sched.every !== 'hour' && (
              <select className="wb-input" value={sched.hour ?? 8} onChange={(e) => set({ schedule: { ...sched, hour: Number(e.target.value) } })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            )}
          </div>
        </Section>
      )}

      {HAS_RULES.includes(t.kind) && (
        <Section title="Only when" hint={t.match?.length ? 'All of these must be true.' : 'No rules: everyone who matches the trigger is picked up.'}>
          <div className="wb-rules">
            {(t.match || []).map((m, i) => (
              <div key={i} className="wb-rule-row">
                <ConditionEditor value={m} allowAi={false} fields={fields} labels={labels} onChange={(c) => set({ match: (t.match || []).map((x, j) => (j === i ? c : x)) })} />
                <button type="button" className="wb-icon-btn" title="Remove rule" onClick={() => set({ match: (t.match || []).filter((_, j) => j !== i) })}><X size={14} /></button>
              </div>
            ))}
            <button type="button" className="wb-link-btn" onClick={() => set({ match: [...(t.match || []), { mode: 'rule', field: t.kind === 'record.match' ? 'payment_state' : 'status', op: 'eq', value: '' }] })}>
              <Plus size={13} /> Add a rule
            </button>
          </div>
        </Section>
      )}

      {t.kind !== 'manual' && t.kind !== 'schedule' && (
        <Section title="Breathing room" hint="So nobody is messaged twice for the same thing.">
          <label className="wb-inline">
            Don&apos;t pick the same person up again within
            <input className="wb-input wb-num" type="number" min={0} max={365} step={1} value={Math.round(((t.cooldownHours ?? 72) / 24) * 10) / 10} onChange={(e) => set({ cooldownHours: Math.max(0, Number(e.target.value) || 0) * 24 })} />
            days
          </label>
        </Section>
      )}
    </div>
  );
}

/* ── Steps ────────────────────────────────────────────────────────────────── */

const unitOf = (h: number | undefined) => ((h ?? 24) >= 24 && (h ?? 24) % 24 === 0 ? 'days' : 'hours');

function Duration({ hours, onChange, label }: { hours: number | undefined; onChange: (h: number) => void; label?: string }) {
  const [unit, setUnit] = useState<'hours' | 'days'>(unitOf(hours));
  const h = hours ?? 24;
  const n = unit === 'days' ? Math.round((h / 24) * 100) / 100 : h;
  return (
    <div className="wb-row">
      {label && <span className="wb-row-l">{label}</span>}
      <input className="wb-input wb-num" type="number" min={unit === 'days' ? 1 : 0.1} step={unit === 'days' ? 1 : 0.5} value={n}
        onChange={(e) => { const v = Math.max(0.05, Number(e.target.value) || 1); onChange(unit === 'days' ? v * 24 : v); }} />
      <select className="wb-input" value={unit} onChange={(e) => {
        const u = e.target.value as 'hours' | 'days';
        setUnit(u);
        if (u === 'days') onChange(Math.max(1, Math.round(h / 24)) * 24);
      }}>
        <option value="hours">hours</option>
        <option value="days">days</option>
      </select>
    </div>
  );
}

export function StepEditor({ step, onChange, onDelete, onDuplicate, sources, sourceId, labels }: {
  step: AgentStep;
  onChange: (patch: Partial<AgentStep>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  sources: DataSource[];
  sourceId?: string;
  labels?: Record<string, string>;
}) {
  const meta = metaOf(step.kind);
  const fields = fieldSuggestions(sources, sourceId);
  const instr = (label: string, placeholder: string, rows = 5, hint?: ReactNode) => (
    <Section title={label} hint={hint}>
      <textarea className="wb-input" rows={rows} value={step.instructions || ''} placeholder={placeholder} onChange={(e) => onChange({ instructions: e.target.value })} />
    </Section>
  );

  return (
    <div className="wb-insp" style={{ ['--k' as string]: meta.color }}>
      <header className="wb-insp-h">
        <StepIcon kind={step.kind} />
        <div><b>{meta.label}</b><span>{meta.hint}</span></div>
      </header>

      <Section title="Step name">
        <input className="wb-input" value={step.title} maxLength={80} onChange={(e) => onChange({ title: e.target.value })} />
      </Section>

      {step.kind === 'ai_message' && (
        <>
          <Section title="Send by">
            <div className="wb-seg">
              {(['email', 'whatsapp', 'email_whatsapp'] as MessageChannel[]).map((c) => (
                <button key={c} type="button" className={(step.channel || 'email') === c ? 'on' : ''} onClick={() => onChange({ channel: c })}>{CHANNEL_LABEL[c]}</button>
              ))}
            </div>
          </Section>
          {instr('What should the agent write?', 'e.g. Welcome them personally, speak to the course they asked about, and invite them to apply.', 6,
            'The agent writes a fresh, personal message for each person from their record and what has happened so far.')}
          <Section title="Subject idea (optional)">
            <input className="wb-input" value={step.subject || ''} placeholder="The agent writes one if empty" onChange={(e) => onChange({ subject: e.target.value })} />
          </Section>
          <Section hint="The reviewer checks tone, labels, threats, placeholders, length, and exact amounts on money messages. A draft that fails is rewritten before it goes.">
            <Toggle on={step.review !== false} onChange={(v) => onChange({ review: v })} label="Reviewer checks it before sending" />
          </Section>
        </>
      )}

      {step.kind === 'send_library' && <LibraryStepEditor step={step} onChange={onChange} />}

      {step.kind === 'send_voucher' && <VoucherStepEditor step={step} onChange={onChange} />}

      {step.kind === 'take_over' && (
        <Section hint="Put it first in a job like hot-lead attention: from here this agent owns the person, and the other agents in the department stop writing to them.">
          <p className="wb-hint">No settings.</p>
        </Section>
      )}

      {step.kind === 'ai_video' && instr('Anything to focus on (optional)', 'e.g. Answer their question about fees and show the path to a first job.', 3,
        'The video greets them by name, then two or three scenes made for them (their goal, their question, why it fits), then their programme. Put a message step after it: it gets the video as a card.')}

      {step.kind === 'ai_task' && (
        <>
          {instr('What should the agent work out?', 'e.g. Score this lead 1 to 10 for how ready they are to apply, and say why in one line.')}
          <Section title="Save the answer as" hint="Later steps and conditions can use it, e.g. a condition on lead_score.">
            <input className="wb-input" value={step.saveAs || ''} placeholder="task_result" onChange={(e) => onChange({ saveAs: e.target.value })} />
          </Section>
        </>
      )}

      {step.kind === 'ai_lesson' && (
        <>
          <Section title="Mastery test" hint="The video greets them by name, says what was noticed, and re-teaches exactly what they got wrong. Then the test; the result updates their status.">
            <div className="wb-row">
              <label className="wb-inline">Questions <input className="wb-input wb-num" type="number" min={3} max={15} value={step.questionCount ?? 10} onChange={(e) => onChange({ questionCount: Math.max(3, Math.min(15, Number(e.target.value) || 10)) })} /></label>
              <label className="wb-inline">Pass mark <input className="wb-input wb-num" type="number" min={30} max={100} value={step.passMark ?? 70} onChange={(e) => onChange({ passMark: Math.max(30, Math.min(100, Number(e.target.value) || 70)) })} />%</label>
            </div>
          </Section>
          {instr('Focus (optional)', 'e.g. Use South African examples. Keep it practical.', 3)}
        </>
      )}

      {step.kind === 'ai_call' && instr('What is the call for?', 'e.g. Check in kindly about the overdue balance and agree on a payment date.', 4,
        'Only placed when the dialer is connected, Live Outreach is on, and Approval Mode is off.')}

      {step.kind === 'condition' && (
        <Section title="Check" hint="Yes and No each get their own steps on the canvas.">
          <ConditionEditor value={step.condition} fields={fields} labels={labels} onChange={(c: StepCondition) => onChange({ condition: c })} />
        </Section>
      )}

      {step.kind === 'wait' && (
        <Section title="Wait for" hint="Real time: the run is saved and carries on later, even after a restart.">
          <Duration hours={step.hours} onChange={(h) => onChange({ hours: h })} />
        </Section>
      )}

      {step.kind === 'repeat' && (
        <>
          <Section hint="On: a reply ends the loop and a person takes over. Off: the loop waits while they are talking with us, then carries on (keep in touch for good).">
            <Toggle on={step.stopOnReply !== false} onChange={(v) => onChange({ stopOnReply: v ? undefined : false })} label="Stop when they reply" />
          </Section>
          <Section title="Repeat">
            <Duration hours={step.hours} onChange={(h) => onChange({ hours: h })} label="Every" />
            <div className="wb-row">
              <span className="wb-row-l">At most</span>
              <input className="wb-input wb-num" type="number" min={1} max={20} value={step.maxTimes ?? 3} onChange={(e) => onChange({ maxTimes: Math.max(1, Math.min(20, Number(e.target.value) || 3)) })} />
              <span className="wb-row-l">times</span>
            </div>
          </Section>
          <Section title="Stop early when" hint="Follow-ups also stop by themselves when the person replies, so a person can take over.">
            <Toggle on={Boolean(step.condition)} onChange={(v) => onChange({ condition: v ? { mode: 'rule', field: 'replied', op: 'eq', value: 'yes' } : undefined })} label="Stop when a condition is true" />
            {step.condition && <div style={{ marginTop: 10 }}><ConditionEditor value={step.condition} fields={fields} labels={labels} onChange={(c) => onChange({ condition: c })} /></div>}
          </Section>
        </>
      )}

      {step.kind === 'update_record' && (
        <Section title="Set" hint={<>Use {'{{today}}'} for today&apos;s date, or {'{{field}}'} to copy another field. Written to the sheet too when write-back is set up.</>}>
          <div className="wb-row">
            <input className="wb-input" list="wb-step-fields" value={step.setField || ''} placeholder="field" onChange={(e) => onChange({ setField: e.target.value })} />
            <span className="wb-row-l">to</span>
            <input className="wb-input" value={step.setValue || ''} placeholder="value" onChange={(e) => onChange({ setValue: e.target.value })} />
          </div>
          <datalist id="wb-step-fields">{fields.map((f) => <option key={f} value={f} />)}</datalist>
        </Section>
      )}

      {step.kind === 'notify_team' && (
        <>
          {instr('What should the brief say?', 'e.g. This lead replied. Summarise what they want and recommend how to respond today.', 4)}
          <Section title="Send to (optional)" hint="Empty: the manager email in Settings.">
            <input className="wb-input" type="email" value={step.notifyEmail || ''} placeholder="finance@academy.co.za" onChange={(e) => onChange({ notifyEmail: e.target.value })} />
          </Section>
        </>
      )}

      {step.kind === 'webhook' && (
        <Section title="Address" hint="The record and what the agent found are posted as JSON (e.g. a CRM, Zapier or Make webhook).">
          <input className="wb-input" type="url" value={step.url || ''} placeholder="https://hooks.zapier.com/…" onChange={(e) => onChange({ url: e.target.value })} />
        </Section>
      )}

      {step.kind === 'stop' && <Section hint="The run ends here. Anything after it on this path is skipped."><span /></Section>}

      <footer className="wb-insp-foot">
        <button type="button" className="btn btn-outline btn-sm" onClick={onDuplicate}><CopyPlus size={13} /> Duplicate</button>
        <button type="button" className="btn wb-btn-danger btn-sm" onClick={onDelete}><Trash2 size={13} /> Delete step</button>
      </footer>
    </div>
  );
}
