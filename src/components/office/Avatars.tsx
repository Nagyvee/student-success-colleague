'use client';

import { useEffect, useRef } from 'react';
import { useAnimate } from 'framer-motion';
import type { AgentState, Point, Visitor } from '@/lib/types';
import { ROOMS, pathTimes } from '@/lib/office/layout';
import Icon from '@/components/Icon';
import { Billboard } from './iso';
import Figure from './Figure';

/* People who walk.
 *
 * A walker is a point on the floor that the server moves along a path; the
 * client plays the path as keyframes, once per walk, so the stream's many
 * re-renders never restart a stride. The figure and its name tag stand on
 * that point inside a billboard that always faces the camera; the thought
 * bubble is drawn flat over the world by Overlay, following the head. */

function useWalk(pos: Point, path: Point[] | null, walkMs: number) {
  const [scope, animate] = useAnimate();
  // Where the element first mounted: rendered as the inline style every time,
  // so React never rewrites left/top and the animation owns them.
  const initial = useRef<Point>(path && path.length ? path[0] : pos);
  const key = path ? `${path.map((p) => `${p.x},${p.y}`).join('|')}:${walkMs}` : `at:${pos.x},${pos.y}`;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!scope.current || lastKey.current === key) return;
    lastKey.current = key;
    if (path && path.length > 1 && walkMs > 0) {
      const times = pathTimes(path);
      animate(scope.current, { left: path.map((p) => `${p.x}%`), top: path.map((p) => `${p.y}%`) }, { duration: walkMs / 1000, ease: 'linear', times });
    } else {
      animate(scope.current, { left: `${pos.x}%`, top: `${pos.y}%` }, { duration: 0.35, ease: 'easeOut' });
    }
  }, [key, path, pos.x, pos.y, walkMs, animate, scope]);
  return { scope, initial: initial.current };
}

/** Which way the figure looks: along the last walk, in screen terms. */
function useFacing(path: Point[] | null) {
  const facing = useRef<'left' | 'right'>('right');
  if (path && path.length > 1) {
    const a = path[0];
    const b = path[path.length - 1];
    // Plan +X points up-right on screen and plan +Y points down-right, so the
    // screen-x component of a move is the sum of both deltas.
    const sx = (b.x - a.x) + (b.y - a.y);
    if (Math.abs(sx) > 0.5) facing.current = sx >= 0 ? 'right' : 'left';
  }
  return facing.current;
}

const LOOK_OF: Partial<Record<AgentState['id'], number>> = { planner: 0, success: 1, learning: 2 };

/** Name tags are drawn by the flat overlay (Overlay.tsx), where nothing can hide them. */
const lookFor = (id: string) => LOOK_OF[id as AgentState['id']] ?? (id.split('').reduce((n, c) => n + c.charCodeAt(0), 0) % 3);

export function AgentAvatar({ agent, speaking = false }: { agent: AgentState; speaking?: boolean }) {
  const isCoo = agent.id === 'coo';
  const accent = agent.color || (isCoo ? '#e6edff' : ROOMS[agent.dept]?.accent || '#9fc5ff');
  const { scope, initial } = useWalk(agent.pos, agent.path, agent.walkMs);
  const facing = useFacing(agent.path);
  const walking = agent.status === 'walking';
  // At their own desk a worker sits: the figure drops a little and the desk hides the legs.
  const seated = !walking && Math.abs(agent.pos.x - agent.home.x) < 0.5 && Math.abs(agent.pos.y - agent.home.y) < 0.5;
  return (
    <div ref={scope} data-walker={agent.id} className={`walker is-${agent.status}${isCoo ? ' is-coo' : ''}${seated ? ' is-seated' : ''}${speaking ? ' is-speaking' : ''}`} style={{ left: `${initial.x}%`, top: `${initial.y}%`, ['--accent' as string]: accent }}>
      <span className="walker-shadow" />
      <span className="walker-ring" />
      <Billboard className="bb-walker">
        {agent.carrying && <span className="carry-tag"><Icon name="file" size={9} />{agent.carrying}</span>}
        <Figure kind={isCoo ? 'coo' : 'person'} look={lookFor(agent.id)} accent={accent} status={agent.status} walking={walking} facing={facing} carrying={Boolean(agent.carrying) || (isCoo && agent.status === 'reviewing')} />
      </Billboard>
    </div>
  );
}

export function VisitorAvatar({ visitor }: { visitor: Visitor }) {
  const { scope, initial } = useWalk(visitor.pos, visitor.path, visitor.walkMs);
  const facing = useFacing(visitor.path);
  const walking = Boolean(visitor.path);
  const variant = visitor.id.split('').reduce((n, c) => n + c.charCodeAt(0), 0);
  const accent = visitor.kind === 'alert' ? '#e5a53a' : '#9fc5ff';
  const kind = visitor.kind === 'goal' ? 'packet' : visitor.kind;
  return (
    <div ref={scope} data-visitor={visitor.id} className={`walker visitor is-${visitor.kind}${walking ? ' is-walking' : ''}`} style={{ left: `${initial.x}%`, top: `${initial.y}%`, ['--accent' as string]: accent }}>
      <span className="walker-shadow" />
      <Billboard className="bb-walker">
        <Figure kind={kind} accent={accent} status={walking ? 'walking' : 'idle'} walking={walking} facing={facing} variant={variant} />
      </Billboard>
    </div>
  );
}
