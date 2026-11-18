'use client';

import { useEffect, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BellRing, Bolt, Brain, CircleStop, Clock, Database, GitBranch, GraduationCap, Hourglass, LoaderCircle, MessageSquareText,
  Circle, Clapperboard, Library, PhoneCall, Ticket, UserCheck, Repeat, ShieldCheck, Webhook, X, type LucideIcon,
} from 'lucide-react';
import type { AgentRun, AgentTriggerKind, ConditionOp, StepCondition, StepKind } from '@/lib/types';
import { OP_CHOICES, RUN_STATUS, STEP_META, metaOf, VALUE_HINTS, when } from './model';

/* Small pieces the overview and the builder share. */

export const STEP_ICON: Record<StepKind, LucideIcon> = {
  ai_message: MessageSquareText, send_library: Library, ai_video: Clapperboard, send_voucher: Ticket, take_over: UserCheck, ai_task: Brain, ai_lesson: GraduationCap, ai_call: PhoneCall,
  condition: GitBranch, wait: Hourglass, repeat: Repeat, stop: CircleStop,
  update_record: Database, notify_team: BellRing, webhook: Webhook,
};

export function StepIcon({ kind, size = 17 }: { kind: StepKind; size?: number }) {
  const I = STEP_ICON[kind] || Circle;
  return (
    <span className="wb-kico" style={{ ['--k' as string]: metaOf(kind).color || '#64748b' }}>
      <I size={size} strokeWidth={2.1} />
    </span>
  );
}

export function TriggerIcon({ kind, size = 17 }: { kind: AgentTriggerKind | undefined; size?: number }) {
  const I = kind === 'record.match' || kind === 'schedule' ? Clock : kind === 'manual' ? ShieldCheck : Bolt;
  return <span className="wb-kico wb-kico-trig"><I size={size} strokeWidth={2.1} /></span>;
}

export function StatusChip({ run }: { run: { status: AgentRun['status']; resumeAt?: number | null } }) {
  const m = RUN_STATUS[run.status] || { label: run.status, tone: 'mute' };
  return (
    <span className={`wb-chip wb-chip-${m.tone}`} title={run.status === 'waiting' && run.resumeAt ? `Carries on ${when(run.resumeAt)}` : undefined}>
      {run.status === 'running' ? <LoaderCircle size={11} className="wb-spin" /> : <i />}
      {m.label}{run.status === 'waiting' && run.resumeAt ? ` · until ${when(run.resumeAt)}` : ''}
    </span>
  );
}

export function Avatar({ name, color, size = 40 }: { name: string; color?: string; size?: number }) {
  return (
    <span className="wb-ava" style={{ width: size, height: size, fontSize: size * 0.42, ['--a' as string]: color || '#2563eb' }}>
      {(name || '?').trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function Modal({ open, onClose, title, sub, children, footer, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean | 'xl';
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="wb-modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
          <motion.div
            className={`wb-modal${wide === 'xl' ? ' is-xl' : wide ? ' is-wide' : ''}`}
            role="dialog" aria-modal="true"
            initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <header className="wb-modal-head">
              <div>
                <h2>{title}</h2>
                {sub && <p>{sub}</p>}
              </div>
              <button type="button" className="wb-x" onClick={onClose} aria-label="Close"><X size={18} /></button>
            </header>
            <div className="wb-modal-body">{children}</div>
            {footer && <footer className="wb-modal-foot">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`wb-toggle${on ? ' is-on' : ''}${disabled ? ' is-off' : ''}`} onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <i />
      {label && <span>{label}</span>}
    </label>
  );
}

/** Field / operator / value, or "let the agent decide" with a question. */
export function ConditionEditor({ value, onChange, fields, allowAi = true, labels }: {
  value: StepCondition | undefined;
  onChange: (c: StepCondition) => void;
  fields: string[];
  allowAi?: boolean;
  labels?: Record<string, string>;
}) {
  const c: StepCondition = value || { mode: 'rule', field: 'status', op: 'eq', value: '' };
  const listId = `wb-fields-${Math.abs(hash(fields.join('|')))}`;
  const valId = `wb-vals-${c.field || 'x'}`;
  const noValue = c.op === 'empty' || c.op === 'not_empty';
  return (
    <div className="wb-cond">
      {allowAi && (
        <div className="wb-seg">
          <button type="button" className={c.mode !== 'ai' ? 'on' : ''} onClick={() => onChange({ mode: 'rule', field: c.field || 'status', op: c.op || 'eq', value: c.value || '' })}>A rule</button>
          <button type="button" className={c.mode === 'ai' ? 'on' : ''} onClick={() => onChange({ mode: 'ai', question: c.question || '' })}>Let the agent decide</button>
        </div>
      )}
      {c.mode === 'ai' ? (
        <label className="wb-f">
          <span>The question the agent answers (yes or no)</span>
          <textarea rows={3} value={c.question || ''} placeholder="e.g. Has this lead shown they are ready to apply?" onChange={(e) => onChange({ ...c, question: e.target.value })} />
          <em>The agent answers from the record and what has happened so far. If it can&apos;t tell, the answer is no.</em>
        </label>
      ) : (
        <div className="wb-rule">
          <input list={listId} value={c.field || ''} placeholder="field" aria-label="Field" onChange={(e) => onChange({ ...c, field: e.target.value })} />
          <select value={c.op || 'eq'} aria-label="Comparison" onChange={(e) => onChange({ ...c, op: e.target.value as ConditionOp })}>
            {OP_CHOICES.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
          </select>
          {!noValue && <input list={valId} value={c.value || ''} placeholder="value" aria-label="Value" onChange={(e) => onChange({ ...c, value: e.target.value })} />}
          <datalist id={listId}>{fields.map((f) => <option key={f} value={f}>{labels?.[f] || f.replace(/_/g, ' ')}</option>)}</datalist>
          <datalist id={valId}>{(VALUE_HINTS[c.field || ''] || []).map((v) => <option key={v} value={v} />)}</datalist>
        </div>
      )}
    </div>
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="wb-empty">
      {icon && <div className="wb-empty-ico">{icon}</div>}
      <b>{title}</b>
      {children && <p>{children}</p>}
    </div>
  );
}
