import type { AgentId, Dept, Point } from '@/lib/types';

/* The floorplan, in percent of the floor.
 *
 * Four offices around one corridor: the two workers along the top, the
 * Planner (by the front door) and the Reviewer along the bottom. Every walk
 * leaves a room through its door onto the corridor and enters the next room
 * through its own door, so people never cross walls. The same table drives
 * the server's routing and the client's drawing. */

export interface RoomSpec {
  id: Dept;
  name: string;
  short: string;
  x: number; y: number; w: number; h: number;
  /** where the door sits on the corridor edge */
  door: Point;
  desk: Point;      // the agent's seat
  visitor: Point;   // where a visitor or case file stands
  review: Point;    // where the Reviewer stands to audit
  accent: string;   // the room's colour
}

export const CORRIDOR_Y = 50;
export const ENTRANCE: Point = { x: -6, y: 80 };
export const ENTRANCE_INSIDE: Point = { x: 6, y: 80 };

export const ROOMS: Record<Dept, RoomSpec> = {
  success: { id: 'success', name: 'Student Success', short: 'Student Success', x: 2, y: 3, w: 47, h: 40,
    door: { x: 30, y: 43 }, desk: { x: 15, y: 22 }, visitor: { x: 25, y: 31 }, review: { x: 33, y: 31 }, accent: '#9fc5ff' },
  learning: { id: 'learning', name: 'Learning & Assessment', short: 'Learning & Assessment', x: 51, y: 3, w: 47, h: 40,
    door: { x: 70, y: 43 }, desk: { x: 64, y: 22 }, visitor: { x: 74, y: 31 }, review: { x: 82, y: 31 }, accent: '#9fc5ff' },
  planning: { id: 'planning', name: 'Planning Desk', short: 'Planner', x: 2, y: 57, w: 47, h: 40,
    door: { x: 30, y: 57 }, desk: { x: 22, y: 76 }, visitor: { x: 24, y: 88 }, review: { x: 38, y: 72 }, accent: '#9fc5ff' },
  review: { id: 'review', name: 'Review Office', short: 'Reviewer', x: 51, y: 57, w: 47, h: 40,
    door: { x: 70, y: 57 }, desk: { x: 82, y: 76 }, visitor: { x: 64, y: 88 }, review: { x: 66, y: 72 }, accent: '#9fc5ff' },
};

export const ROOM_ORDER: Dept[] = ['success', 'learning', 'planning', 'review'];

/** The brief's three roles, so the floor reads the way the judges' loop does. */
export type Role = 'Planner' | 'Worker' | 'Reviewer';

export interface AgentSpec { id: AgentId; name: string; title: string; role: Role; dept: Dept; home: Point; initials: string }

export const AGENTS: AgentSpec[] = [
  { id: 'planner', name: 'Zanele', title: 'Planner', role: 'Planner', dept: 'planning', home: ROOMS.planning.desk, initials: 'ZA' },
  { id: 'success', name: 'Bongani', title: 'Student Success', role: 'Worker', dept: 'success', home: ROOMS.success.desk, initials: 'BO' },
  { id: 'learning', name: 'Lindiwe', title: 'Learning & Assessment', role: 'Worker', dept: 'learning', home: ROOMS.learning.desk, initials: 'LI' },
  { id: 'coo', name: 'Musa', title: 'Reviewer', role: 'Reviewer', dept: 'review', home: ROOMS.review.desk, initials: 'MU' },
];

export const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a])) as Record<AgentId, AgentSpec>;

export function roomAt(p: Point): Dept | null {
  for (const r of Object.values(ROOMS)) {
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return r.id;
  }
  return null;
}

/** The floor is drawn wider than tall, so a vertical unit is a shorter walk. */
function dist(a: Point, b: Point) { return Math.hypot(a.x - b.x, (a.y - b.y) * 0.6); }

export function pathLength(path: Point[]) {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += dist(path[i - 1], path[i]);
  return n;
}

/** The walk from one point to another, through doors and the corridor. */
export function route(from: Point, to: Point): Point[] {
  const a = roomAt(from);
  const b = roomAt(to);
  if (a && a === b) return [from, to];
  const pts: Point[] = [from];
  const fromStreet = from.x < 0;
  const toStreet = to.x < 0;

  if (fromStreet) {
    pts.push(ENTRANCE_INSIDE);
    if (b === 'planning') { pts.push(to); return dedupe(pts); }
  } else if (a) {
    const d = ROOMS[a].door;
    pts.push(d, { x: d.x, y: CORRIDOR_Y });
  }

  if (toStreet) {
    // Out through the planning desk and the front door.
    const d = ROOMS.planning.door;
    const last = pts[pts.length - 1];
    if (a !== 'planning') {
      if (Math.abs(last.y - CORRIDOR_Y) > 0.5) pts.push({ x: last.x, y: CORRIDOR_Y });
      pts.push({ x: d.x, y: CORRIDOR_Y }, d);
    }
    pts.push(ENTRANCE_INSIDE, to);
    return dedupe(pts);
  }

  if (b) {
    const d = ROOMS[b].door;
    const last = pts[pts.length - 1];
    if (Math.abs(last.y - CORRIDOR_Y) > 0.5) pts.push({ x: last.x, y: CORRIDOR_Y });
    pts.push({ x: d.x, y: CORRIDOR_Y }, d, to);
  } else {
    pts.push(to);
  }
  return dedupe(pts);
}

function dedupe(pts: Point[]) {
  return pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 0.2);
}

/** Milliseconds for a walk, from its length. */
export function walkDuration(path: Point[], speed: 'normal' | 'fast') {
  const perUnit = speed === 'fast' ? 24 : 58;
  return Math.max(450, Math.round(pathLength(path) * perUnit));
}

/** Where the time fraction of each waypoint falls, for keyframe animation. */
export function pathTimes(path: Point[]) {
  const total = pathLength(path) || 1;
  let acc = 0;
  return path.map((p, i) => { if (i > 0) acc += dist(path[i - 1], p); return Math.min(1, acc / total); });
}
