import type { Dept } from '@/lib/types';
import { ROOMS, ROOM_ORDER } from './layout';

/* The camera.
 *
 * The world is a 1000 × 609 unit box tilted by rotateX(rx) rotateZ(rz).
 * project() says where a plan point lands on screen, in units, relative to
 * the box's centre; the boxes say what to frame; fitCamera() turns a frame
 * and a panel size into the unit (--u) and the world-centre position that
 * fill the panel. The same maths frames the whole building or one office,
 * from whatever angle the viewer has dragged the building to. */

export const WORLD_W = 1000;
export const WORLD_H = 609;

export interface View { rx: number; rz: number }
export const DEFAULT_VIEW: View = { rx: 57, rz: -45 };
/** The angles the viewer may drag to: always from the front, so the solid back walls stay behind. */
export const LIMITS = { rzMin: -82, rzMax: -8, rxMin: 38, rxMax: 74 };

const D = Math.PI / 180;

/** Screen offset (in units) of a plan point from the world centre. x, y in plan percent; z in units, up. */
export function project(px: number, py: number, z = 0, v: View = DEFAULT_VIEW) {
  const cr = Math.cos(v.rx * D), sr = Math.sin(v.rx * D), cz = Math.cos(v.rz * D), sz = Math.sin(v.rz * D);
  const dx = (px / 100) * WORLD_W - WORLD_W / 2;
  const dy = (py / 100) * WORLD_H - WORLD_H / 2;
  const x1 = dx * cz - dy * sz;
  const y1 = dx * sz + dy * cz;
  return { X: x1, Y: y1 * cr - z * sr };
}

export interface ViewBox { cx: number; cy: number; w: number; h: number }

function boxOf(pts: { X: number; Y: number }[]): ViewBox {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.X); maxX = Math.max(maxX, p.X); minY = Math.min(minY, p.Y); maxY = Math.max(maxY, p.Y); }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

/** The whole building: slab, apron and the tall back walls. */
export function buildingBox(v: View = DEFAULT_VIEW): ViewBox {
  const pts: { X: number; Y: number }[] = [];
  for (const [x, y] of [[-9.5, -1], [101, -1], [101, 101], [-9.5, 101], [-9.5, 88], [-1, 101]] as const) {
    pts.push(project(x, y, 0, v), project(x, y, -16, v));
  }
  for (const id of ROOM_ORDER) {
    const r = ROOMS[id];
    pts.push(project(r.x, r.y, 80, v), project(r.x + r.w, r.y, 80, v), project(r.x + r.w, r.y + r.h, 80, v), project(r.x, r.y + r.h, 80, v));
  }
  return boxOf(pts);
}

/** One office: its floor and its walls. */
export function roomBox(id: Dept, v: View = DEFAULT_VIEW): ViewBox {
  const r = ROOMS[id];
  const pts: { X: number; Y: number }[] = [];
  for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]] as const) {
    pts.push(project(x, y, 0, v), project(x, y, 90, v));
  }
  return boxOf(pts);
}

/** The unit and the world-centre position that fit a frame into a W × H panel. */
export function fitCamera(box: ViewBox, W: number, H: number, pad: number, zoom = 1) {
  const u = Math.max(0.2, Math.min(W / box.w, H / box.h) * pad * zoom);
  return { u, left: W / 2 - u * box.cx, top: H / 2 - u * box.cy };
}
