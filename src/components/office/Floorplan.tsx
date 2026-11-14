'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { AgentState, Dept, Point, RoomState, Visitor, WorldState } from '@/lib/types';
import { ENTRANCE_INSIDE, ROOMS, ROOM_ORDER, roomAt } from '@/lib/office/layout';
import { DEFAULT_VIEW, LIMITS, buildingBox, fitCamera, roomBox, type View } from '@/lib/office/camera';
import Icon from '@/components/Icon';
import { Anchor, Billboard, Floor, WallX, WallY } from './iso';
import { AgentAvatar, VisitorAvatar } from './Avatars';
import Overlay, { SAFE_BOTTOM, SAFE_TOP, StoryBand, useSpeakers } from './Overlay';
import Furniture, { CorridorFurniture } from './Furniture';
import Spotlight from './Spotlight';

/* The floorplan, in 2.5D.
 *
 * One tilted world. A floating slab carries four glass-walled offices around
 * a corridor; the two outer walls at the back are solid with windows, every
 * other wall is a low glass partition so the audience sees inside.
 *
 * The camera frames the building between the command bar and the story
 * band, so nothing the audience needs is ever under a bar. The viewer drives
 * it (drag to turn and tilt, scroll to zoom, click an office to fly in), or
 * the director does: during a run it cuts to the room of whoever is speaking.
 * Any touch of the camera hands control back to the viewer until the next run. */

const BACK = 80;   // the building's outer back walls
const PART = 40;   // glass partitions
const DOOR = 6;    // door opening, in plan percent
const SIDE = 16;   // side margin the camera keeps
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
type Framing = { room: Dept; tight: boolean } | null;

export default function Floorplan({ state, inspectId, onInspect, stage = false, onStage, insetRight = 0, children }: {
  state: WorldState; inspectId?: string | null; onInspect?: (id: string) => void;
  stage?: boolean; onStage?: () => void;
  /** Width kept clear on the right (the drawer), so the building slides aside instead of hiding under it. */
  insetRight?: number; children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [zoom, setZoom] = useState(1);
  const [frame, setFrame] = useState<Framing>(null);
  const [dragging, setDragging] = useState(false);
  const [director, setDirector] = useState(true);
  const [paused, setPaused] = useState(false);
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean; target: EventTarget | null } | null>(null);

  const agents = Object.values(state.agents);
  const speakers = useSpeakers(agents);

  useEffect(() => { try { setDirector(localStorage.getItem('ss-director') !== 'off'); } catch { /* private mode */ } }, []);
  const toggleDirector = () => setDirector((d) => {
    const n = !d;
    try { localStorage.setItem('ss-director', n ? 'on' : 'off'); } catch { /* ignore */ }
    if (n) setPaused(false); else setFrame(null);
    return n;
  });

  // The camera: fit the frame between the bars, from the current angle.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const W = el.clientWidth, H = el.clientHeight;
      if (!W || !H) return;
      const L = SIDE;
      const aw = Math.max(200, W - L - SIDE - insetRight), ah = Math.max(160, H - SAFE_TOP - SAFE_BOTTOM);
      const box = frame ? roomBox(frame.room, view) : buildingBox(view);
      const cam = fitCamera(box, aw, ah, frame ? (frame.tight ? 0.9 : 0.6) : 1, zoom);
      el.style.setProperty('--u', String(cam.u));
      el.style.setProperty('--cam-x', `${cam.left + L}px`);
      el.style.setProperty('--cam-y', `${cam.top + SAFE_TOP}px`);
      el.style.setProperty('--rx', `${view.rx}deg`);
      el.style.setProperty('--rz', `${view.rz}deg`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frame, view, zoom, insetRight]);

  // The director: cut to the speaker's room, never faster than every 2.4 s,
  // and back to the whole floor a moment after the run ends.
  const running = state.tasks.find((t) => t.status === 'running') || null;
  const runId = running?.id || null;
  const lead = speakers[0] ? state.agents[speakers[0]] : null;
  const leadRoom = lead ? roomAt(lead.pos) : null;
  const lastCut = useRef(0);
  useEffect(() => { if (runId) setPaused(false); }, [runId]);
  useEffect(() => {
    if (!director || paused) return;
    if (!runId) {
      const t = setTimeout(() => setFrame((f) => (f && !f.tight ? null : f)), 3000);
      return () => clearTimeout(t);
    }
    if (!leadRoom) return;
    const wait = Math.max(0, 2400 - (Date.now() - lastCut.current));
    const t = setTimeout(() => {
      lastCut.current = Date.now();
      setZoom(1);
      setFrame((f) => (f && f.room === leadRoom && !f.tight ? f : { room: leadRoom, tight: false }));
    }, wait);
    return () => clearTimeout(t);
  }, [director, paused, runId, leadRoom]);

  const takeOver = useCallback(() => { setPaused(true); }, []);

  // Scroll to zoom; the page itself must not scroll under the floor.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); setPaused(true); setZoom((z) => clamp(z * Math.exp(-e.deltaY * 0.0012), 0.75, 2.6)); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const flyTo = useCallback((d: Dept | null) => { setFrame(d ? { room: d, tight: true } : null); setZoom(1); }, []);
  const reset = () => { setFrame(null); setZoom(1); setView(DEFAULT_VIEW); };
  const turn = (deg: number) => { takeOver(); setView((v) => ({ ...v, rz: clamp(v.rz + deg, LIMITS.rzMin, LIMITS.rzMax) })); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /input|textarea|select/i.test(t.tagName)) return;
      if (e.key === 'Escape' && !document.querySelector('.gate')) { setPaused(true); flyTo(null); }
      if (e.key === 'ArrowLeft') turn(-6);
      if (e.key === 'ArrowRight') turn(6);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, a, select, label, input, .floor-ui, .cmd-bar, .plan-card, .story')) return;
    drag.current = { x: e.clientX, y: e.clientY, view, moved: false, target: e.target };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) { d.moved = true; setDragging(true); takeOver(); (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }
    setView({ rz: clamp(d.view.rz - dx * 0.28, LIMITS.rzMin, LIMITS.rzMax), rx: clamp(d.view.rx - dy * 0.18, LIMITS.rxMin, LIMITS.rxMax) });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d || d.moved) return;
    const t = d.target as HTMLElement | null;
    const room = t?.closest<HTMLElement>('[data-room]')?.dataset.room as Dept | undefined;
    if (room) { takeOver(); flyTo(frame?.room === room && frame.tight ? null : room); }
    else if (t?.closest('.iso-world')) { takeOver(); flyTo(null); }
  };

  const walks = [
    ...agents.filter((a) => a.path && a.path.length > 1).map((a) => ({ id: a.id, path: a.path as Point[], coo: a.id === 'coo' })),
    ...state.visitors.filter((v) => v.path && v.path.length > 1).map((v) => ({ id: v.id, path: v.path as Point[], coo: false })),
  ];
  const changed = frame !== null || zoom !== 1 || view.rx !== DEFAULT_VIEW.rx || view.rz !== DEFAULT_VIEW.rz;
  const following = director && !paused && Boolean(runId);

  return (
    <div className={`office${frame ? ' is-focused' : ''}${dragging ? ' is-dragging' : ''}${insetRight ? ' has-drawer' : ''}`} ref={ref}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      role="img" aria-label="Live isometric office floorplan. Drag to rotate, scroll to zoom, click an office to fly in.">
      <div className="office-sky" />
      <div className="office-grid" />
      <div className="iso-world">
        <Floor className="ground-shadow" x={-12} y={-10} w={126} h={124} />
        <Floor className="slab" x={-1} y={-1} w={102} h={102} />
        <WallX className="slab-face" x={-1} y={101} w={102} h={16} />
        <WallY className="slab-face slab-face-w" x={-1} y={-1} len={102} h={16} />
        <Floor className="slab apron" x={-9.5} y={72} w={9} h={16} />
        <WallX className="slab-face" x={-9.5} y={88} w={9} h={16} />
        <WallY className="slab-face slab-face-w" x={-9.5} y={72} len={16} h={16} />
        <Floor className="path-lights" x={-9} y={77} w={8} h={6} z={0.3} />

        <Floor className="corridor-floor" x={2} y={43} w={96} h={14}><span className="corridor-line" /></Floor>
        <CorridorFurniture />

        <Floor className="threshold" x={1.6} y={ENTRANCE_INSIDE.y - DOOR / 2} w={0.9} h={DOOR} z={0.4} />
        <WallY className="door-frame door-entrance" x={2} y={ENTRANCE_INSIDE.y - DOOR / 2} len={DOOR} h={PART} />

        {ROOM_ORDER.map((id) => (
          <Room key={id} id={id} room={state.rooms[id]} focused={frame?.room === id && frame.tight} label={ROOMS[id].name} />
        ))}

        {walks.length > 0 && (
          <Floor className="trails" x={0} y={0} w={100} h={100} z={0.8}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {walks.map((w) => {
                const pts = w.path.map((p) => `${p.x},${p.y}`).join(' ');
                const end = w.path[w.path.length - 1];
                return (
                  <g key={w.id} className={w.coo ? 'is-coo' : ''}>
                    <polyline points={pts} className="trail-glow" vectorEffect="non-scaling-stroke" />
                    <polyline points={pts} className="trail" vectorEffect="non-scaling-stroke" />
                    <ellipse cx={end.x} cy={end.y} rx={1.1} ry={1.8} className="trail-end" vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}
            </svg>
          </Floor>
        )}

        {state.visitors.map((v: Visitor) => <VisitorAvatar key={v.id} visitor={v} />)}
        {agents.map((a: AgentState) => <AgentAvatar key={a.id} agent={a} speaking={speakers[0] === a.id} />)}
      </div>
      <div className="office-vignette" />
      <Overlay agents={agents} visitors={state.visitors} rooms={state.rooms} speakers={speakers} />

      <Spotlight spot={state.spotlight} />
      <div className="floor-top">{children}</div>

      <div className="floor-ui view-ctrl" aria-label="Camera">
        <button type="button" className={`dir-btn${director ? ' on' : ''}${following ? ' is-live' : ''}`} onClick={toggleDirector}
          title={director ? 'Director on: the camera follows whoever is speaking. Click to turn off.' : 'Director off. Click to let the camera follow the action.'} aria-pressed={director}>
          <Icon name="video" size={15} /><span>{following ? 'Following' : 'Follow'}</span>
        </button>
        <span className="sep" />
        <button type="button" onClick={() => turn(-15)} title="Turn left (←)" aria-label="Turn left"><Icon name="rotL" size={16} /></button>
        <button type="button" onClick={() => turn(15)} title="Turn right (→)" aria-label="Turn right"><Icon name="rotR" size={16} /></button>
        <button type="button" onClick={() => { takeOver(); setZoom((z) => clamp(z * 1.2, 0.75, 2.6)); }} title="Zoom in" aria-label="Zoom in"><Icon name="zoomIn" size={16} /></button>
        <button type="button" onClick={() => { takeOver(); setZoom((z) => clamp(z / 1.2, 0.75, 2.6)); }} title="Zoom out" aria-label="Zoom out"><Icon name="zoomOut" size={16} /></button>
        <button type="button" onClick={() => { takeOver(); reset(); }} disabled={!changed} title="Whole floor" aria-label="Back to the whole floor"><Icon name="locate" size={15} /></button>
        {onStage && <span className="sep" />}
        {onStage && <button type="button" onClick={onStage} title={stage ? 'Leave stage mode' : 'Stage mode: full screen for presenting'} aria-label="Toggle stage mode"><Icon name={stage ? 'shrink' : 'expand'} size={15} /></button>}
      </div>
      {frame?.tight && (
        <div className="floor-ui focus-chip">
          <span>{ROOMS[frame.room].name}</span>
          <button type="button" onClick={() => flyTo(null)} aria-label="Back to the whole floor"><Icon name="x" size={13} /></button>
        </div>
      )}

      <StoryBand state={state} speaker={lead} inspectId={inspectId} onInspect={onInspect} />
    </div>
  );
}

function Room({ id, room, focused, label }: { id: Dept; room: RoomState; focused: boolean; label: string }) {
  const r = ROOMS[id];
  const topRow = r.y < 50;
  const rightCol = r.x + r.w > 90;
  const dx = r.door.x;
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  const doorY = topRow ? y1 : r.y;
  const live = room.mood !== 'calm';

  return (
    <>
      <Floor className={`room-floor is-${room.mood}${focused ? ' is-focus' : ''}`} x={r.x} y={r.y} w={r.w} h={r.h} data-room={id}>
        {room.mood === 'scan' && <i className="floor-scan" />}
        <i className="ceiling-light" style={{ left: '30%', top: '35%' }} /><i className="ceiling-light" style={{ left: '70%', top: '65%' }} />
      </Floor>
      <Floor className="threshold" x={dx - DOOR / 2} y={doorY - 0.5} w={DOOR} h={1} z={0.4} />

      {topRow ? (
        <WallX className="wall-back" x={r.x} y={r.y} w={r.w} h={BACK}>
          <i className="win" style={{ left: '8%', width: '22%' }} /><i className="win" style={{ left: '39%', width: '22%' }} /><i className="win" style={{ left: '70%', width: '22%' }} />
          <i className="frame" style={{ left: '32%', width: '5%' }} /><i className="frame" style={{ left: '63%', width: '5%' }} />
          {id === 'success' && <i className="clock" style={{ left: '94%' }} />}
        </WallX>
      ) : (
        <>
          <WallX className="glass" x={r.x} y={r.y} w={dx - DOOR / 2 - r.x} h={PART} />
          <WallX className="door-frame" x={dx - DOOR / 2} y={r.y} w={DOOR} h={PART} />
          <WallX className="glass" x={dx + DOOR / 2} y={r.y} w={x1 - dx - DOOR / 2} h={PART} />
        </>
      )}

      {topRow ? (
        <>
          <WallX className="glass" x={r.x} y={y1} w={dx - DOOR / 2 - r.x} h={PART} />
          <WallX className="door-frame" x={dx - DOOR / 2} y={y1} w={DOOR} h={PART} />
          <WallX className="glass" x={dx + DOOR / 2} y={y1} w={x1 - dx - DOOR / 2} h={PART} />
        </>
      ) : (
        <WallX className="glass" x={r.x} y={y1} w={r.w} h={PART} />
      )}

      {id === 'planning' ? (
        <>
          <WallY className="glass" x={r.x} y={r.y} len={ENTRANCE_INSIDE.y - DOOR / 2 - r.y} h={PART} />
          <WallY className="glass" x={r.x} y={ENTRANCE_INSIDE.y + DOOR / 2} len={y1 - ENTRANCE_INSIDE.y - DOOR / 2} h={PART} />
        </>
      ) : (
        <WallY className="glass" x={r.x} y={r.y} len={r.h} h={PART} />
      )}

      {rightCol ? (
        <WallY className="wall-back" x={x1} y={r.y} len={r.h} h={BACK}>
          <i className="win win-y" style={{ top: '10%', height: '24%' }} /><i className="win win-y" style={{ top: '40%', height: '24%' }} /><i className="win win-y" style={{ top: '70%', height: '22%' }} />
          <i className="frame frame-y" style={{ top: '35.5%', height: '3.5%' }} /><i className="frame frame-y" style={{ top: '65.5%', height: '3.5%' }} />
        </WallY>
      ) : (
        <WallY className="glass" x={x1} y={r.y} len={r.h} h={PART} />
      )}

      <Furniture dept={id} live={live} />

      <Anchor x={r.x + r.w * (id === 'review' ? 0.3 : 0.5)} y={r.y + 10} z={106}>
        <Billboard className="bb-sign">
          <span className={`wall-sign${live ? ' is-live' : ''}`}><i />{label}</span>
        </Billboard>
      </Anchor>
      {id === 'review' && (
        <Anchor x={r.x + r.w * 0.72} y={r.y + 10} z={106}>
          <Billboard className="bb-sign">
            <a href="/reports" className="wall-sign wall-link" title="Musa's reports"><i />Reports</a>
          </Billboard>
        </Anchor>
      )}
      {/* Where the room's approval or revise stamp is drawn, flat, by the overlay. */}
      <Anchor x={r.x + r.w * 0.55} y={r.y + r.h * 0.7} z={56} className="room-anchor" data-room-anchor={id} />
    </>
  );
}
