import type { CSSProperties, ReactNode } from 'react';

/* Isometric building blocks.
 *
 * The world is one div tilted with rotateX(57deg) rotateZ(-45deg) and
 * transform-style: preserve-3d. Everything inside is a plane: floors lie in
 * the XY plane, walls stand up from a line, boxes are three faces, and a
 * billboard counter-rotates so it always faces the camera. Plan positions
 * are percentages of the world; heights are in "u" pixels, a unit that the
 * floorplan sets from its own width so the whole scene scales crisply. */

export const RX = 57;
export const RZ = -45;
export const WORLD_W = 1000;
export const WORLD_H = 609;

export const u = (n: number) => `calc(var(--u) * ${n}px)`;

type Base = { className?: string; style?: CSSProperties; children?: ReactNode };

/** A rectangle lying on the floor. */
export function Floor({ x, y, w, h, z = 0, className = '', style, children, ...rest }: Base & { x: number; y: number; w: number; h: number; z?: number; 'data-room'?: string }) {
  return (
    <div {...rest} className={`floor ${className}`} style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%`, transform: z ? `translateZ(${u(z)})` : undefined, ...style }}>
      {children}
    </div>
  );
}

/** A vertical plane along the X axis, facing the viewer, rising from the line y. */
export function WallX({ x, y, w, h, z = 0, className = '', style, children }: Base & { x: number; y: number; w: number; h: number; z?: number }) {
  return (
    <div className={`wall wall-x ${className}`} style={{ left: `${x}%`, top: `calc(${y}% - ${u(h)})`, width: `${w}%`, height: u(h), transform: z ? `translateZ(${u(z)}) rotateX(-90deg)` : undefined, ...style }}>
      {children}
    </div>
  );
}

/** A vertical plane along the Y axis, facing the viewer, rising from the line x. */
export function WallY({ x, y, len, h, z = 0, className = '', style, children }: Base & { x: number; y: number; len: number; h: number; z?: number }) {
  return (
    <div className={`wall wall-y ${className}`} style={{ left: `${x}%`, top: `${y}%`, width: u(h), height: `${len}%`, transform: z ? `translateZ(${u(z)}) rotateY(-90deg)` : undefined, ...style }}>
      {children}
    </div>
  );
}

/** A solid block: top, south and west faces, shaded from one colour. */
export function Box({ x, y, w, h, z, z0 = 0, c, r = 2, className = '', style, top, south }: {
  x: number; y: number; w: number; h: number; z: number; z0?: number; c: string; r?: number; className?: string; style?: CSSProperties; top?: ReactNode; south?: ReactNode;
}) {
  const base = { ['--c' as string]: c, ['--r' as string]: u(r) } as CSSProperties;
  return (
    <>
      <WallY x={x} y={y} len={h} h={z} z={z0} className="face face-w" style={base} />
      <WallX x={x} y={y + h} w={w} h={z} z={z0} className="face face-s" style={base}>{south}</WallX>
      <Floor x={x} y={y} w={w} h={h} z={z0 + z} className={`face face-t ${className}`} style={{ ...base, ...style }}>{top}</Floor>
    </>
  );
}

/** A point in the world, optionally lifted off the floor, for billboards to hang from. */
export function Anchor({ x, y, z = 0, className = '', style, children, ...rest }: Base & { x: number; y: number; z?: number; 'data-room-anchor'?: string }) {
  return (
    <div {...rest} className={`anchor ${className}`} style={{ left: `${x}%`, top: `${y}%`, transform: z ? `translateZ(${u(z)})` : undefined, ...style }}>
      {children}
    </div>
  );
}

/** Content that always faces the camera, standing on its anchor. */
export function Billboard({ className = '', style, children }: Base) {
  return <div className={`bb ${className}`} style={style}>{children}</div>;
}

/** Where a room-relative percentage lands in the world. */
export function inRoom(r: { x: number; y: number; w: number; h: number }, px: number, py: number) {
  return { x: r.x + (px / 100) * r.w, y: r.y + (py / 100) * r.h };
}
