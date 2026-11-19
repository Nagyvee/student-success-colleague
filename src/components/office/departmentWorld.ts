'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentId, AgentRun, AgentState, AgentStatus, Dept, Headline, Point, RoomMood, Visitor, WorldState } from '@/lib/types';
import { ENTRANCE, ROOMS, route, walkDuration } from '@/lib/office/layout';
import type { DepartmentRow } from './buildingData';

/* A department's floor, as a walk-in office.
 *
 * The same 2.5D office as the tutoring team's, furnished for one department:
 *   - Reception (by the front door) receives new work and routes it to the
 *     right agent: a case file walks in, stops at reception, and is carried to
 *     the agent's office;
 *   - the department's own agents sit at their desks in the two offices along
 *     the top (more agents share them), each with their own colour;
 *   - the Review & Approvals office checks every message: an agent walks their
 *     draft over, and approvals wait there.
 * Everything is driven by the agents' real runs; walks play when a run starts
 * or a draft is reviewed, so the floor is quiet when nothing is happening. */

const RECEPTION: AgentId = 'planner';
const REVIEWER: AgentId = 'coo';
const WORK_ROOMS: Dept[] = ['success', 'learning'];
/** Seats for extra agents sharing an office, as offsets from the room's desk. */
const SEATS: Point[] = [{ x: 0, y: 0 }, { x: 16, y: 8 }, { x: 24, y: -6 }, { x: 8, y: 13 }];
const RECENT_MS = 45_000;
const STATUS_HOLD_MS = 6_000;

type Act = { pos: Point; path: Point[] | null; walkMs: number; status: AgentStatus; thought: string | null; carrying: string | null; until: number };

const first = (name: string) => (name || '').split(/\s+/)[0] || name;
const clampPoint = (p: Point, d: Dept): Point => {
  const r = ROOMS[d];
  return { x: Math.min(r.x + r.w - 4, Math.max(r.x + 4, p.x)), y: Math.min(r.y + r.h - 5, Math.max(r.y + 6, p.y)) };
};

export interface DepartmentWorld {
  world: WorldState;
  roomLabels: Partial<Record<Dept, string>>;
}

export function useDepartmentWorld(base: WorldState | null, dept: DepartmentRow | null, runs: AgentRun[], pendingApprovals: number): DepartmentWorld | null {
  // Where each department agent sits.
  const seating = useMemo(() => {
    if (!dept) return [];
    return dept.agents.map((a, i) => {
      const room = WORK_ROOMS[i % 2];
      const seat = SEATS[Math.floor(i / 2) % SEATS.length];
      const desk = ROOMS[room].desk;
      const id = (i === 0 ? 'success' : i === 1 ? 'learning' : `dx_${a.id}`) as AgentId;
      return { agent: a, id, room, home: clampPoint({ x: desk.x + seat.x, y: desk.y + seat.y }, room) };
    });
  }, [dept]);

  // Short-lived walks and moods, played when something happens.
  const acts = useRef(new Map<string, Act>());
  const visitors = useRef<Visitor[]>([]);
  const seen = useRef<Map<string, number> | null>(null);
  const [tick, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);

  useEffect(() => {
    // A new floor: forget the last floor's walks, and do not replay history.
    acts.current.clear();
    visitors.current = [];
    seen.current = null;
  }, [dept?.id]);

  useEffect(() => {
    if (!dept || !seating.length) return;
    const now = Date.now();
    const mine = runs.filter((r) => r.departmentId === dept.id || seating.some((s) => s.agent.workflow?.id === r.workflowId));
    if (!seen.current) {
      seen.current = new Map(mine.map((r) => [r.id, r.logs.length + (r.updatedAt || 0)]));
      return;
    }
    const seatOf = (r: AgentRun) => seating.find((s) => s.agent.workflow?.id === r.workflowId || s.agent.id === r.agentId);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const r of mine) {
      const sig = r.logs.length + (r.updatedAt || 0);
      const was = seen.current.get(r.id);
      seen.current.set(r.id, sig);
      if (was === sig) continue;
      const s = seatOf(r);
      if (!s) continue;
      const who = first(r.record.name);
      const last = r.logs[r.logs.length - 1];

      if (was === undefined && r.startedAt > now - 90_000) {
        // New work: a case file comes in, reception reads it and carries it to the agent.
        const recDesk = ROOMS.planning.visitor;
        const inPath = route(ENTRANCE, recDesk);
        const inMs = walkDuration(inPath, 'normal');
        const vid = `case_${r.id}`;
        visitors.current = [...visitors.current.filter((v) => v.id !== vid), { id: vid, label: who, sub: s.agent.name, kind: 'packet', pos: recDesk, path: inPath, walkMs: inMs }];
        acts.current.set(RECEPTION, { pos: ROOMS.planning.desk, path: null, walkMs: 0, status: 'thinking', thought: `New: ${who} for ${s.agent.name}. ${r.trigger}.`, carrying: null, until: now + inMs + 3500 });
        timers.push(setTimeout(() => {
          const to = ROOMS[s.room].visitor;
          const outPath = route(recDesk, to);
          const outMs = walkDuration(outPath, 'normal');
          visitors.current = visitors.current.map((v) => (v.id === vid ? { ...v, pos: to, path: outPath, walkMs: outMs } : v));
          acts.current.set(s.id, { pos: s.home, path: null, walkMs: 0, status: 'working', thought: `Picking up ${who}: ${r.workflowName.toLowerCase()}.`, carrying: null, until: Date.now() + outMs + 5000 });
          bump();
          timers.push(setTimeout(() => { visitors.current = visitors.current.filter((v) => v.id !== vid); bump(); }, outMs + 4000));
        }, inMs + 1200));
        continue;
      }

      if (!last) continue;
      if (/^Reviewer|Rewritten and re-checked|reviewed playbook/i.test(last.detail) || r.logs.slice(-3).some((l) => /^Reviewer (checked|sent)/.test(l.detail) && l.ts > now - 60_000)) {
        // The agent walks the draft to Review & Approvals, then back to their desk.
        const spot = ROOMS.review.review;
        const there = route(s.home, spot);
        const ms = walkDuration(there, 'normal');
        const caught = r.logs.slice(-3).some((l) => /sent the draft back/.test(l.detail));
        acts.current.set(s.id, { pos: spot, path: there, walkMs: ms, status: 'walking', thought: null, carrying: `${who}'s message`, until: now + ms + 3200 });
        acts.current.set(REVIEWER, { pos: ROOMS.review.desk, path: null, walkMs: 0, status: 'reviewing', thought: caught ? `Sent ${s.agent.name}'s draft back: ${last.detail.replace(/^Reviewer sent the draft back:\s*/i, '').slice(0, 120)}` : `Checked ${s.agent.name}'s message to ${who}: name, facts, tone, next step. Passes.`, carrying: null, until: now + ms + 4200 });
        timers.push(setTimeout(() => {
          const back = route(spot, s.home);
          const backMs = walkDuration(back, 'normal');
          acts.current.set(s.id, { pos: s.home, path: back, walkMs: backMs, status: 'walking', thought: null, carrying: null, until: Date.now() + backMs + 300 });
          bump();
        }, ms + 3200));
        continue;
      }
      // Anything else: the agent says what they just did.
      acts.current.set(s.id, { pos: s.home, path: null, walkMs: 0, status: last.status === 'fail' ? 'revising' : 'working', thought: `${last.detail.slice(0, 160)}`, carrying: null, until: now + STATUS_HOLD_MS });
    }
    bump();
    return () => { for (const t of timers) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, seating, dept?.id]);

  // Expire finished acts.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [k, a] of acts.current) if (a.until < now) { acts.current.delete(k); changed = true; }
      if (changed) bump();
    }, 800);
    return () => clearInterval(t);
  }, []);

  return useMemo(() => {
    if (!base || !dept) return null;
    const now = Date.now();
    const mine = runs.filter((r) => r.departmentId === dept.id || seating.some((s) => s.agent.workflow?.id === r.workflowId));
    const agents: Record<string, AgentState> = {};
    const roomBusy = new Map<Dept, string>();

    const person = (id: AgentId, name: string, title: string, room: Dept, home: Point, color: string | undefined, live: { status: AgentStatus; thought: string | null }): AgentState => {
      const act = acts.current.get(id);
      return {
        id, name, title, dept: room, home, color,
        pos: act?.pos || home,
        path: act?.path || null,
        walkMs: act?.walkMs || 0,
        status: act?.status || live.status,
        thought: act ? act.thought : live.thought,
        carrying: act?.carrying || null,
        tasksDone: 0,
      };
    };

    for (const s of seating) {
      const runsOf = mine.filter((r) => r.workflowId === s.agent.workflow?.id || r.agentId === s.agent.id);
      const latest = runsOf[0];
      const busy = runsOf.find((r) => r.status === 'running' || (r.status !== 'failed' && r.updatedAt > now - RECENT_MS));
      const failed = latest && latest.updatedAt > now - 86_400_000 && (latest.status === 'failed' || latest.logs.some((l) => l.status === 'fail'));
      let live: { status: AgentStatus; thought: string | null } = { status: 'idle', thought: null };
      if (busy) {
        const l = busy.logs[busy.logs.length - 1];
        live = { status: 'working', thought: l ? `${l.title === 'Run' ? '' : `${l.title}: `}${l.detail}`.slice(0, 170) : `Working on ${first(busy.record.name)}.` };
        roomBusy.set(s.room, `${s.agent.name} · ${first(busy.record.name)}`);
      } else if (failed) {
        const l = [...latest.logs].reverse().find((x) => x.status === 'fail');
        live = { status: 'revising', thought: `Needs a look: ${(l?.detail || 'the last run failed').slice(0, 150)}` };
      }
      if (s.agent.enabled === false) live = { status: 'idle', thought: null };
      agents[s.id] = person(s.id, s.agent.name, s.agent.title, s.room, s.home, s.agent.color || dept.color, live);
    }

    const arriving = visitors.current.length > 0;
    agents[RECEPTION] = person(RECEPTION, 'Reception', `Routes ${dept.name} work`, 'planning', ROOMS.planning.desk, dept.color, { status: 'idle', thought: null });
    agents[REVIEWER] = person(REVIEWER, 'Reviewer', 'Checks every message', 'review', ROOMS.review.desk, undefined,
      pendingApprovals > 0 ? { status: 'reviewing', thought: `${pendingApprovals} message${pendingApprovals === 1 ? '' : 's'} checked and waiting for your approval in the Inbox.` } : { status: 'idle', thought: null });

    const mood = (d: Dept): { mood: RoomMood; caption: string | null } => {
      if (d === 'planning') return arriving ? { mood: 'busy', caption: 'New work arriving' } : { mood: 'calm', caption: null };
      if (d === 'review') {
        const act = acts.current.get(REVIEWER);
        if (act) return { mood: /sent .* back/i.test(act.thought || '') ? 'amber' : 'green', caption: /sent .* back/i.test(act.thought || '') ? 'Sent back' : 'Passed review' };
        return pendingApprovals > 0 ? { mood: 'amber', caption: `${pendingApprovals} awaiting approval` } : { mood: 'calm', caption: null };
      }
      const b = roomBusy.get(d);
      return b ? { mood: 'busy', caption: b } : { mood: 'calm', caption: null };
    };

    const label = (d: Dept) => {
      const here = seating.filter((s) => s.room === d);
      if (!here.length) return 'Open desk';
      if (here.length === 1) return `${here[0].agent.name} · ${here[0].agent.title}`;
      return here.map((s) => s.agent.name).join(' · ');
    };

    // The story band narrates this floor's latest beats.
    const beats: Headline[] = mine
      .flatMap((r) => r.logs.map((l, i) => ({ r, l, i })))
      .filter(({ l }) => l.ts > now - 30 * 60_000)
      .sort((a, b) => a.l.ts - b.l.ts)
      .slice(-6)
      .map(({ r, l, i }) => ({
        id: `${r.id}-${i}-${l.ts}`,
        ts: l.ts,
        actor: 'system',
        text: `${r.agentName} · ${first(r.record.name)}: ${l.detail}`,
        tone: l.status === 'fail' ? 'bad' : l.status === 'ok' ? 'good' : l.status === 'wait' ? 'warn' : 'info',
      }));

    const spot = base.spotlight && seating.some((s) => base.spotlight?.subject.startsWith(`${s.agent.name} `)) ? base.spotlight : null;

    const world: WorldState = {
      ...base,
      busy: null,
      agents: agents as WorldState['agents'],
      visitors: visitors.current,
      rooms: { planning: mood('planning'), success: mood('success'), learning: mood('learning'), review: mood('review') },
      headlines: beats,
      spotlight: spot,
    };
    return {
      world,
      roomLabels: { planning: 'Reception', review: 'Review & approvals', success: label('success'), learning: label('learning') },
    };
    // acts/visitors are refs; `tick` changes whenever they do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, dept, runs, seating, pendingApprovals, tick]);
}
