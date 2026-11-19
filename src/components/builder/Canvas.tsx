'use client';

import { type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronUp, CircleCheck, CopyPlus, Plus, Repeat, Trash2 } from 'lucide-react';
import type { AgentStep, AgentTrigger, DataSource } from '@/lib/types';
import { STEP_META, metaOf, fmtHours, ruleText, stepSummary, triggerSummary, type InsertAt, type Lane } from './model';
import { StepIcon, TriggerIcon } from './ui';

/* The flow, top to bottom: the trigger, then each step joined by a line
 * with a "+" to insert between any two steps. A condition splits into Yes
 * and No lanes that merge again; a follow-up loop is a bracket around the
 * steps it repeats. */

export type Selection = 'trigger' | string | null;

export interface CanvasProps {
  trigger: AgentTrigger | undefined;
  steps: AgentStep[];
  sources: DataSource[];
  labels?: Record<string, string>;
  selected?: Selection;
  readonly?: boolean;
  onSelect?: (s: Selection) => void;
  onInsert?: (at: InsertAt) => void;
  onMove?: (id: string, dir: -1 | 1) => void;
  onDuplicate?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export default function Canvas(p: CanvasProps) {
  return (
    <div className={`wb-flow${p.readonly ? ' is-ro' : ''}`}>
      <button
        type="button"
        className={`wb-card wb-trig-card${p.selected === 'trigger' ? ' is-sel' : ''}`}
        onClick={(e) => { e.stopPropagation(); p.onSelect?.('trigger'); }}
        disabled={p.readonly}
      >
        <TriggerIcon kind={p.trigger?.kind} />
        <span className="wb-card-t">
          <span className="wb-card-k">When</span>
          <b>{triggerSummary(p.trigger, p.sources, p.labels)}</b>
          {p.trigger?.cooldownHours ? <em>Not the same person again within {fmtHours(p.trigger.cooldownHours)}</em> : null}
        </span>
      </button>
      <StepList steps={p.steps} parentId={null} lane="root" p={p} />
      <div className="wb-end"><CircleCheck size={14} /> Done</div>
    </div>
  );
}

function Connector({ at, p, tail }: { at: InsertAt; p: CanvasProps; tail?: boolean }) {
  return (
    <div className={`wb-conn${tail ? ' is-tail' : ''}`}>
      {!p.readonly && (
        <button type="button" className="wb-plus" aria-label="Add a step here" title="Add a step here" onClick={(e) => { e.stopPropagation(); p.onInsert?.(at); }}>
          <Plus size={14} strokeWidth={2.6} />
        </button>
      )}
    </div>
  );
}

function StepList({ steps, parentId, lane, p }: { steps: AgentStep[]; parentId: string | null; lane: Lane; p: CanvasProps }) {
  return (
    <>
      <AnimatePresence initial={false}>
        {steps.map((s, i) => (
          <motion.div
            key={s.id}
            className="wb-item"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.14 } }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <Connector at={{ parentId, lane, index: i }} p={p} />
            <StepNode step={s} index={i} total={steps.length} p={p} />
          </motion.div>
        ))}
      </AnimatePresence>
      <Connector at={{ parentId, lane, index: steps.length }} p={p} tail />
    </>
  );
}

function Card({ step, index, total, p, children, className = '' }: { step: AgentStep; index: number; total: number; p: CanvasProps; children?: ReactNode; className?: string }) {
  const meta = metaOf(step.kind);
  const sel = p.selected === step.id;
  return (
    <div
      className={`wb-card${sel ? ' is-sel' : ''} ${className}`}
      style={{ ['--k' as string]: meta.color }}
      onClick={(e) => { e.stopPropagation(); p.onSelect?.(step.id); }}
      role={p.readonly ? undefined : 'button'}
      tabIndex={p.readonly ? undefined : 0}
      onKeyDown={(e) => { if (e.key === 'Enter') p.onSelect?.(step.id); }}
    >
      <StepIcon kind={step.kind} />
      <span className="wb-card-t">
        <span className="wb-card-k">{meta.label}</span>
        <b>{step.title}</b>
        <em>{stepSummary(step, p.labels)}</em>
      </span>
      {!p.readonly && (
        <span className="wb-card-acts" onClick={(e) => e.stopPropagation()}>
          <button type="button" title="Move up" disabled={index === 0} onClick={() => p.onMove?.(step.id, -1)}><ChevronUp size={14} /></button>
          <button type="button" title="Move down" disabled={index >= total - 1} onClick={() => p.onMove?.(step.id, 1)}><ChevronDown size={14} /></button>
          <button type="button" title="Duplicate" onClick={() => p.onDuplicate?.(step.id)}><CopyPlus size={14} /></button>
          <button type="button" title="Delete" className="is-danger" onClick={() => p.onDelete?.(step.id)}><Trash2 size={14} /></button>
        </span>
      )}
      {children}
    </div>
  );
}

function StepNode({ step, index, total, p }: { step: AgentStep; index: number; total: number; p: CanvasProps }) {
  if (step.kind === 'condition') {
    return (
      <div className="wb-node">
        <Card step={step} index={index} total={total} p={p} />
        <div className="wb-stem" />
        <div className="wb-split">
          <Branch label="Yes" tone="yes" p={p}>
            <StepList steps={step.yes || []} parentId={step.id} lane="yes" p={p} />
          </Branch>
          <Branch label="No" tone="no" p={p}>
            <StepList steps={step.no || []} parentId={step.id} lane="no" p={p} />
          </Branch>
        </div>
      </div>
    );
  }
  if (step.kind === 'repeat') {
    const color = STEP_META.repeat.color;
    return (
      <div className={`wb-loop${p.selected === step.id ? ' is-sel' : ''}`} style={{ ['--k' as string]: color }}>
        <Card step={step} index={index} total={total} p={p} className="wb-loop-card" />
        <div className="wb-loop-body">
          <StepList steps={step.steps || []} parentId={step.id} lane="steps" p={p} />
        </div>
        <div className="wb-loop-foot">
          <Repeat size={13} />
          <span>Back to the top every {fmtHours(step.hours)}, up to {step.maxTimes ?? 3} times{step.condition ? `, until ${ruleText(step.condition, p.labels)}` : ''}</span>
        </div>
      </div>
    );
  }
  return <Card step={step} index={index} total={total} p={p} />;
}

function Branch({ label, tone, children }: { label: string; tone: 'yes' | 'no'; p: CanvasProps; children: ReactNode }) {
  return (
    <div className={`wb-branch is-${tone}`}>
      <i className="wb-drop" />
      <div className="wb-branch-in">
        <span className="wb-lane-tag">{label}</span>
        {children}
      </div>
      <div className="wb-fill" />
    </div>
  );
}
