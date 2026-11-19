'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { AgentId, AgentState, Capabilities, Dept, FeedActor, Headline, RoomState, Task, Visitor, WorldState } from '@/lib/types';
import { AGENT_BY_ID } from '@/lib/office/layout';
import Icon, { type IconName } from '@/components/Icon';

/* Drawn flat over the 3D world, so nothing here is ever hidden by a wall or
 * a desk, and nothing here ever lands on top of anything else.
 *
 * Name tags follow every person's head and say what they are doing. Only the
 * agent who is speaking (and the one who spoke just before, for a sense of
 * dialogue) gets a note. Room stamps show the Reviewer's verdict, and stay up long
 * enough to be read. Every frame, tags are laid out first, then notes (which
 * keep clear of tags and room signs), then stamps.
 *
 * The story band: one large caption at the bottom of the floor with the
 * run's progress under it, so a room full of people can follow every
 * handoff without reading the feed. */

const NOTE_MAX = 110;
const STAMP_MS = 5000;
/** Bands the overlay keeps clear: the command bar on top, the story band below. */
export const SAFE_TOP = 70;
export const SAFE_BOTTOM = 100;

export const ACTOR: Record<FeedActor, { label: string; icon: IconName }> = {
  planner: { label: 'Zanele · Planner', icon: 'list' },
  success: { label: 'Bongani · Student Success', icon: 'users' },
  learning: { label: 'Lindiwe · Learning & Assessment', icon: 'book' },
  coo: { label: 'Musa · Reviewer', icon: 'shield' },
  system: { label: 'Colleague', icon: 'radio' },
  lms: { label: 'LMS', icon: 'database' },
  student: { label: 'Learner', icon: 'graduation' },
  person: { label: 'You', icon: 'target' },
};

const DOING: Partial<Record<AgentState['status'], string>> = { thinking: 'thinking', working: 'working', reviewing: 'auditing', revising: 'revising', celebrating: 'done' };

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** Who spoke last, and who spoke just before them (if it was recent). */
export function useSpeakers(agents: AgentState[]): AgentId[] {
  const seen = useRef(new Map<string, { text: string; at: number }>());
  const now = Date.now();
  for (const a of agents) {
    const t = a.thought || '';
    const prev = seen.current.get(a.id);
    if (!prev || prev.text !== t) seen.current.set(a.id, { text: t, at: t ? now : 0 });
  }
  const talking = agents
    .filter((a) => a.thought && a.status !== 'walking' && a.status !== 'idle')
    .map((a) => ({ id: a.id, at: seen.current.get(a.id)?.at || 0 }))
    .sort((p, q) => q.at - p.at);
  if (!talking.length) return [];
  const out: AgentId[] = [talking[0].id];
  if (talking[1] && talking[0].at - talking[1].at < 6000) out.push(talking[1].id);
  return out;
}

type Held = { mood: 'green' | 'amber'; caption: string | null; until: number };

/** A room's verdict stays on screen at least STAMP_MS, even if the room calms sooner. */
function useStickyStamps(rooms: Record<Dept, RoomState> | undefined) {
  const held = useRef(new Map<Dept, Held>());
  const now = useNow(500);
  if (rooms) {
    for (const [id, r] of Object.entries(rooms) as [Dept, RoomState][]) {
      if (r.mood !== 'green' && r.mood !== 'amber') continue;
      const cur = held.current.get(id);
      if (!cur || cur.mood !== r.mood || cur.caption !== r.caption) held.current.set(id, { mood: r.mood, caption: r.caption, until: now + STAMP_MS });
      else cur.until = Math.max(cur.until, now + 800);
    }
  }
  const out: [Dept, Held][] = [];
  for (const [id, h] of held.current) {
    if (h.until < now) { held.current.delete(id); continue; }
    out.push([id, h]);
  }
  return out;
}

function useTypewriter(text: string | null, cps = 48) {
  const [shown, setShown] = useState('');
  useEffect(() => {
    if (!text) { setShown(''); return; }
    let i = 0;
    setShown('');
    const t = setInterval(() => { i += 2; setShown(text.slice(0, i)); if (i >= text.length) clearInterval(t); }, Math.max(14, 2000 / cps));
    return () => clearInterval(t);
  }, [text, cps]);
  return shown;
}

function shorten(t: string) {
  const one = t.replace(/\s+/g, ' ').trim();
  if (one.length <= NOTE_MAX) return one;
  const slice = one.slice(0, NOTE_MAX - 1);
  const cut = slice.lastIndexOf(' ');
  return `${(cut > 40 ? slice.slice(0, cut) : slice).trimEnd()}…`;
}

const TONE: Partial<Record<AgentState['status'], string>> = { revising: ' is-warn', reviewing: ' is-review', celebrating: ' is-good' };

/** Any agent on the floor: the tutoring team's four, or a department's own agents. */
const specOf = (a: AgentState) => AGENT_BY_ID[a.id] || { name: a.name, title: a.title || '' };

function Note({ agent, lead }: { agent: AgentState; lead: boolean }) {
  const spec = specOf(agent);
  const text = agent.thought ? shorten(agent.thought) : null;
  const shown = useTypewriter(text);
  if (!text) return null;
  return (
    <div data-note={agent.id} className={`note${TONE[agent.status] || ''}${lead ? ' is-lead' : ' is-prev'}`}>
      <span className="note-who"><i />{agent.name || spec.name}<em>{(agent.title || spec.title).split('·')[0].trim()}</em></span>
      <span className="note-t">{shown}</span>
    </div>
  );
}

function Stamp({ id, mood, caption }: { id: Dept; mood: 'green' | 'amber'; caption: string | null }) {
  const bad = mood === 'amber';
  const sub = bad && caption ? caption.replace(/^Review:\s*/i, '').replace(/\s*—\s*revising$/i, '').replace(/^Error spotted · /i, '') : null;
  return (
    <div data-stamp={id} className={`stamp2${bad ? ' is-bad' : ''}`}>
      <b><Icon name={bad ? 'warn' : 'stamp'} size={13} />{bad ? 'Sent back · revise' : caption && !/^Approved/i.test(caption) ? caption : 'Reviewer approved'}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

interface Box { x: number; y: number; w: number; h: number }
const hit = (a: Box, b: Box, gap = 6) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

export default function Overlay({ agents = [], visitors = [], rooms, speakers = [] }: {
  agents?: AgentState[]; visitors?: Visitor[]; rooms?: Record<Dept, RoomState>; speakers?: AgentId[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const talkers = speakers.map((id) => byId.get(id)).filter((a): a is AgentState => Boolean(a));
  const stamps = useStickyStamps(rooms);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const host = ref.current;
      const office = host?.parentElement;
      if (host && office) {
        const ob = office.getBoundingClientRect();
        const top = SAFE_TOP, bottom = ob.height - SAFE_BOTTOM;
        const local = (r: DOMRect): Box => ({ x: r.left - ob.left, y: r.top - ob.top, w: r.width, h: r.height });
        const inView = (cx: number, cy: number) => cx > -20 && cx < ob.width + 20 && cy > top - 30 && cy < bottom + 10;

        // 1 · Name tags, each just above its figure's head; neighbours push each other up.
        const tags = new Map<string, Box>();
        const feet = new Map<string, number>();
        const tagBoxes: Box[] = [];
        for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-tag]'))) {
          const id = el.dataset.tag as string;
          const fig = office.querySelector<HTMLElement>(`[data-walker="${id}"] .fig, [data-visitor="${id}"] .fig`);
          if (!fig) { el.style.visibility = 'hidden'; continue; }
          const f = local(fig.getBoundingClientRect());
          const cx = f.x + f.w / 2;
          if (!inView(cx, f.y)) { el.style.visibility = 'hidden'; continue; }
          el.style.visibility = 'visible';
          const b: Box = { x: cx - el.offsetWidth / 2, y: f.y - el.offsetHeight - 4, w: el.offsetWidth, h: el.offsetHeight };
          for (let i = 0; i < 4; i++) { const o = tagBoxes.find((p) => hit(b, p, 3)); if (!o) break; b.y = o.y - b.h - 3; }
          if (b.y < top - 2 || b.y + b.h > bottom) { el.style.visibility = 'hidden'; continue; }
          tagBoxes.push(b);
          tags.set(id, b);
          feet.set(id, f.y + f.h);
          el.style.transform = `translate3d(${Math.round(b.x)}px, ${Math.round(b.y)}px, 0)`;
        }

        // Obstacles for notes and stamps: the tags just placed, and every room sign.
        const placed: Box[] = [...tagBoxes];
        for (const s of Array.from(office.querySelectorAll<HTMLElement>('.wall-sign, .plan-card'))) placed.push(local(s.getBoundingClientRect()));
        const settle = (want: Box, below: boolean) => {
          const b = { ...want };
          b.x = Math.max(10, Math.min(ob.width - b.w - 10, b.x));
          for (let i = 0; i < 8; i++) {
            const other = placed.find((p) => hit(b, p));
            if (!other) break;
            b.y = below ? other.y + other.h + 8 : other.y - b.h - 8;
          }
          const fits = b.y >= top && b.y + b.h <= bottom && !placed.some((p) => hit(b, p));
          return { b, fits };
        };
        const place = (el: HTMLElement, want: Box, anchorX: number, below: boolean, flipY?: number) => {
          let { b, fits } = settle(want, below);
          if (!fits && flipY !== undefined) {
            const alt = settle({ ...want, y: flipY }, !below);
            if (alt.fits) { b = alt.b; fits = true; below = !below; }
          }
          if (b.y < top) b.y = top;
          if (b.y + b.h > bottom) b.y = Math.max(top, bottom - b.h);
          placed.push(b);
          el.style.transform = `translate3d(${Math.round(b.x)}px, ${Math.round(b.y)}px, 0)`;
          el.style.setProperty('--tail', `${Math.max(14, Math.min(b.w - 14, anchorX - b.x))}px`);
          el.classList.toggle('is-below', below);
        };

        // 2 · Notes, above their speaker's tag.
        for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-note]'))) {
          const t = tags.get(el.dataset.note as string);
          if (!t) { el.style.visibility = 'hidden'; continue; }
          el.style.visibility = 'visible';
          const cx = t.x + t.w / 2;
          const w = el.offsetWidth, h = el.offsetHeight;
          const under = (feet.get(el.dataset.note as string) ?? t.y + t.h + 70) + 8;
          let y = t.y - h - 10;
          let below = false;
          if (y < top) { y = under; below = true; }
          place(el, { x: cx - w / 2, y, w, h }, cx, below, below ? undefined : under);
        }

        // 3 · Stamps, on their room.
        for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-stamp]'))) {
          const a = office.querySelector<HTMLElement>(`[data-room-anchor="${el.dataset.stamp}"]`);
          if (!a) continue;
          const r = a.getBoundingClientRect();
          const cx = r.left - ob.left, cy = r.top - ob.top;
          if (!inView(cx, cy)) { el.style.visibility = 'hidden'; continue; }
          el.style.visibility = 'visible';
          const w = el.offsetWidth, h = el.offsetHeight;
          place(el, { x: cx - w / 2, y: cy - h / 2, w, h }, cx, true);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const lead = speakers[0];
  return (
    <div ref={ref} className="office-overlay">
      {visitors.map((v) => (
        <span key={v.id} data-tag={v.id} className={`otag is-visitor is-${v.kind}`}>
          {v.label}
        </span>
      ))}
      {agents.map((a) => {
        const doing = DOING[a.status];
        // Name only; the verb only for the beats the room must not miss.
        const verb = a.status === 'reviewing' || a.status === 'revising' ? doing : null;
        return (
          <span key={a.id} data-tag={a.id} className={`otag is-${a.status}${doing ? ' is-active' : ''}${lead === a.id ? ' is-speaking' : ''}`} title={a.title || specOf(a).title}>
            {doing && <s />}{a.name || specOf(a).name}{verb && <i> · {verb}</i>}
          </span>
        );
      })}
      {stamps.map(([id, h]) => <Stamp key={`s-${id}-${h.mood}`} id={id} mood={h.mood} caption={h.caption} />)}
      {talkers.slice(0, 1).map((a) => <Note key={a.id} agent={a} lead />)}
    </div>
  );
}

/* ── The story band ──────────────────────────────────────────────────────── */

const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

function headlineIcon(h: Headline): IconName {
  if (h.tone === 'bad') return 'warn';
  if (h.tone === 'good') return 'badgeCheck';
  if (h.tone === 'warn') return 'wrench';
  return ACTOR[h.actor]?.icon || 'radio';
}

function engineName(caps: Capabilities | undefined) {
  const ai = caps?.ai;
  if (!ai || ai.provider === 'simulation') return 'the playbook';
  if (ai.provider === 'anthropic') {
    const m = ai.model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ');
    return `Claude ${m.charAt(0).toUpperCase()}${m.slice(1)}`;
  }
  return ai.model;
}

export function StoryBand({ state, speaker, inspectId, onInspect }: { state: WorldState; speaker?: AgentState | null; inspectId?: string | null; onInspect?: (id: string) => void }) {
  const now = useNow(500);
  const running: Task | null = state.tasks.find((t) => t.status === 'running') || null;
  const task: Task | null = running || state.tasks[0] || null;
  const items = state.headlines || [];
  const latest = items[items.length - 1] || null;
  // While a run is on, the caption is its latest beat; afterwards, how it ended.
  const fresh = Boolean(latest && task && latest.ts >= task.startedAt - 2000 && (running || task.status !== 'running'));

  const tone = fresh && latest ? latest.tone : task?.status === 'done' ? 'good' : task?.status === 'failed' ? 'bad' : 'info';
  const who = fresh && latest ? (running ? ACTOR[latest.actor]?.label : `Last goal · ${ACTOR[latest.actor]?.label}`) : running ? 'Working on it' : task ? 'Last goal' : 'Ready for a goal';
  const text = fresh && latest ? latest.text
    : running ? running.stepLabel
      : task ? (task.status === 'done' ? 'Goal complete' : 'Stopped')
        : "Always listening across connected LMS courses, inbound webhooks, and scheduled automation flows.";
  const icon: IconName = fresh && latest ? headlineIcon(latest) : task?.status === 'done' ? 'badgeCheck' : running ? 'activity' : 'play';
  const key = fresh && latest ? latest.id : `${task?.id || 'idle'}-${task?.status}-${running?.step || 0}`;

  const steps = task ? Math.max(task.totalSteps, task.step) : 0;
  const elapsed = task ? (task.endedAt || now) - task.startedAt : 0;
  // A long quiet stretch in a run is the model drafting: say so, with a clock.
  const quiet = running ? now - Math.max(latest?.ts || 0, running.startedAt) : 0;
  // The engine marks the agent waiting on the model as "thinking"; credit them, not whoever spoke last.
  const waiting = (a?: AgentState | null) => a?.status === 'thinking' || a?.status === 'revising';
  const drafter = waiting(speaker) ? speaker
    : Object.values(state.agents).find((a) => waiting(a)) || (speaker?.status === 'working' ? speaker : null);
  const drafting = Boolean(running && quiet > 6000 && drafter);

  return (
    <div className={`story is-${tone}${running ? ' is-running' : ''}`} aria-live="polite">
      <div className="story-main">
        <span className="story-ico"><Icon name={icon} size={20} /></span>
        <div className="story-t">
          <motion.div key={key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .3, ease: [0.22, 1, 0.36, 1] }}>
            <span className="story-who">
              <span>{who}</span>
              {drafting && drafter && (
                <span className="story-live"><Icon name="spinner" size={11} className="spin" />{drafter.name || specOf(drafter).name} is drafting with {engineName(state.caps)} · {fmtDur(quiet)}</span>
              )}
            </span>
            <b className="story-text" title={text}>{text}</b>
          </motion.div>
        </div>
        <div className="story-side">
          {task && (
            <span className="story-meta">
              <span className="story-task">{task.subject}</span>
              <span className="story-stats">
                {task.trigger && <span className={`story-trig is-${task.trigger.kind}`}><Icon name={task.trigger.kind === 'schedule' ? 'calendar' : task.trigger.kind === 'manager' ? 'target' : task.trigger.kind === 'sheet' ? 'sheet' : 'webhook'} size={11} />{task.trigger.kind === 'schedule' ? 'Scheduled' : task.trigger.kind === 'manager' ? 'Manager' : task.trigger.kind === 'sheet' ? 'Google Sheet' : 'LMS webhook'}</span>}
                {running ? `Step ${task.step} of ${steps}` : task.status === 'done' ? 'Complete' : 'Stopped'}
                <i>·</i>{fmtDur(elapsed)}
                {task.corrections > 0 && <><i>·</i><em><Icon name="wrench" size={11} />{task.corrections} self-correction{task.corrections === 1 ? '' : 's'}</em></>}
                <i>·</i><span className="story-human">Human interventions: 0</span>
              </span>
            </span>
          )}
          {inspectId && onInspect && task && (
            <button type="button" className="story-btn" onClick={() => onInspect(inspectId)}><Icon name="eye" size={14} />Inspect output</button>
          )}
        </div>
      </div>
      {task && <LoopTrack task={task} />}
    </div>
  );
}

/* The brief's own loop, so the judges can map every beat to their criteria:
 * Goal → Plan → Act → Check → Correct → Deliver. Correct lights only when the
 * Reviewer really sent something back. */
type Lit = 'todo' | 'doing' | 'done' | 'skip';
function LoopTrack({ task }: { task: Task }) {
  const st = (k: string) => task.plan?.steps.find((s) => s.key === k)?.status || 'todo';
  const over = task.status !== 'running';
  const act: Lit = st('act') === 'done' ? 'done' : (st('scan') !== 'todo' || st('diagnose') !== 'todo' || st('act') !== 'todo') ? 'doing' : 'todo';
  const check: Lit = st('review') === 'done' ? 'done' : st('review') === 'doing' ? 'doing' : 'todo';
  const correct: Lit = task.corrections > 0 ? (check === 'done' || over ? 'done' : 'doing') : (check === 'done' || over ? 'skip' : 'todo');
  const deliver: Lit = st('deliver') === 'done' ? 'done' : st('deliver') === 'doing' ? 'doing' : 'todo';
  const stages: [string, Lit, string?][] = [
    ['Goal', 'done'],
    ['Plan', task.plan ? 'done' : over ? 'todo' : 'doing'],
    ['Act', act],
    ['Check', check],
    ['Correct', correct, task.corrections ? `×${task.corrections}` : undefined],
    ['Deliver', deliver],
  ];
  return (
    <div className="loop-track" aria-label="Goal, plan, act, check, correct, deliver">
      {stages.map(([label, lit, extra], i) => (
        <span key={label} className={`lt is-${lit}${label === 'Correct' && task.corrections ? ' is-fix' : ''}`}>
          <i>{lit === 'done' ? <Icon name="check" size={10} strokeWidth={3.2} /> : i + 1}</i>{label}{extra && <em>{extra}</em>}
        </span>
      ))}
    </div>
  );
}
