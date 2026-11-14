import { Fragment } from 'react';
import type { Dept, Point } from '@/lib/types';
import { ROOMS } from '@/lib/office/layout';
import { Anchor, Billboard, Box, Floor, WallX } from './iso';

/* What stands in each office.
 *
 * Desks are placed from the same anchors the agents stand at, so a desk is
 * always in front of its agent and hides their legs the way a desk does.
 * Everything is a block or a standing plane; nothing is a picture. */

const NAVY = '#e8ecf2';   // desk tops: white laminate
const WOOD = '#a0714a';
const DARK = '#2e3d60';   // chairs
const STEEL = '#c3cbd8';  // cabinets

function Chair({ x, y, c = DARK, back = true }: { x: number; y: number; c?: string; back?: boolean }) {
  return (
    <>
      <Box x={x - 1.6} y={y - 1.5} w={3.2} h={3} z={18} c={c} r={8} />
      {back && <WallX x={x - 1.9} y={y - 1.3} w={3.8} h={24} className="chair-back" />}
    </>
  );
}

function Desk({ at, w = 14, screens = 1, accent, c = NAVY, chair = true, live = false }: { at: Point; w?: number; screens?: number; accent: string; c?: string; chair?: boolean; live?: boolean }) {
  const x = at.x - w / 2;
  const y = at.y + 1.3;
  const first = at.x - 2 - (screens - 1) * 2.4;
  return (
    <>
      {chair && <Chair x={at.x} y={at.y - 2.3} />}
      <Box x={x} y={y} w={w} h={6} z={26} c={c} r={3} />
      {Array.from({ length: screens }).map((_, i) => (
        <Fragment key={i}>
          <Box x={first + i * 4.8 + 1.3} y={y + 2.7} w={1.4} h={0.8} z0={26} z={2.2} c="#aeb9d6" r={2} />
          <WallX x={first + i * 4.8} y={y + 2.3} w={4} h={14} z={26} className={`screen${live ? ' is-live' : ''}`} style={{ ['--accent' as string]: accent, ['--d' as string]: `${i * 0.45}s` }} />
        </Fragment>
      ))}
      <Floor x={at.x - 2.2} y={y + 3.7} w={4.4} h={1.1} z={26.4} className="kb" />
      <Box x={at.x + 2.9} y={y + 3.8} w={0.9} h={1.1} z0={26} z={1.2} c="#dfe6f5" r={6} />
      <Floor x={x + 1.1} y={y + 1.2} w={2.6} h={2} z={26.4} className="paper" />
      <Box x={x + w - 2} y={y + 1.5} w={0.9} h={0.9} z0={26} z={4} c="#e8edf7" r={99} />
    </>
  );
}

function Plant({ x, y, size = 1 }: { x: number; y: number; size?: number }) {
  const s = 2.6 * size;
  return (
    <>
      <Box x={x - s / 2} y={y - s / 2} w={s} h={s} z={11 * size} c="#d8dde6" r={4} />
      <Anchor x={x} y={y} z={11 * size}>
        <Billboard><span className="leaves" style={{ transform: `scale(${size})` }}><i /><i /><i /><i /></span></Billboard>
      </Anchor>
    </>
  );
}

function Cabinet({ x, y, w = 4, z = 38 }: { x: number; y: number; w?: number; z?: number }) {
  return <Box x={x} y={y} w={w} h={3} z={z} c={STEEL} south={<><i className="cab-drawer" /><i className="cab-drawer" /></>} />;
}

function Shelf({ x, y, w = 10 }: { x: number; y: number; w?: number }) {
  return <Box x={x} y={y} w={w} h={2.6} z={44} c="#8a6440" south={<i className="books" />} />;
}

function MeetingTable({ x, y, w = 8, h = 4.5, c = '#e8ecf2' }: { x: number; y: number; w?: number; h?: number; c?: string }) {
  return (
    <>
      <Chair x={x + w * 0.3} y={y - 1.2} back={false} />
      <Chair x={x + w * 0.7} y={y - 1.2} back={false} />
      <Box x={x} y={y} w={w} h={h} z={24} c={c} r={6} />
      <Floor x={x + w / 2 - 1.2} y={y + h / 2 - 0.9} w={2.4} h={1.8} z={24.4} className="paper" />
      <Chair x={x + w * 0.3} y={y + h + 2} back={false} />
      <Chair x={x + w * 0.7} y={y + h + 2} back={false} />
    </>
  );
}

/** The welcome totem by the front door. */
function Kiosk({ x, y }: { x: number; y: number }) {
  return (
    <>
      <Box x={x} y={y} w={1.6} h={1} z={40} c="#1f2b4e" r={2} />
      <WallX x={x} y={y + 1.05} w={1.6} h={9} z={29} className="screen" style={{ ['--accent' as string]: '#9fc5ff' }} />
    </>
  );
}

function StudentDesk({ x, y }: { x: number; y: number }) {
  return (
    <>
      <Box x={x} y={y} w={5} h={3} z={24} c={NAVY} r={3} />
      <WallX x={x + 1.2} y={y + 1.2} w={2.6} h={9} z={24} className="screen" style={{ ['--accent' as string]: '#9fc5ff' }} />
      <Box x={x + 1.7} y={y + 4.2} w={1.6} h={1.6} z={14} c={DARK} r={8} />
    </>
  );
}

/** What stands in the corridor. */
export function CorridorFurniture() {
  return (
    <>
      <Plant x={10} y={45.3} size={.8} />
      <Box x={40} y={45} w={1.8} h={1.8} z={30} c="#3f4e74" r={3} />
      <Box x={40.2} y={45.2} w={1.4} h={1.4} z={40} c="#c9dcff" r={6} />
      <Box x={52} y={44.4} w={7} h={1.5} z={13} c="#2a3a62" r={3} />
      <Plant x={90} y={45.3} size={.8} />
    </>
  );
}

export default function Furniture({ dept, live = false }: { dept: Dept; live?: boolean }) {
  const r = ROOMS[dept];
  const a = r.accent;
  switch (dept) {
    case 'success':
      return (
        <>
          <Floor x={20} y={26} w={16} h={13} z={0.3} className="rug" />
          <Desk at={r.desk} w={16} screens={2} accent={a} live={live} />
          <WallX x={20} y={3.6} w={13} h={24} z={28} className="board board-chart" style={{ ['--accent' as string]: a }}>
            <i style={{ height: '70%' }} /><i style={{ height: '45%' }} /><i style={{ height: '85%' }} /><i style={{ height: '30%' }} /><i style={{ height: '60%' }} /><i style={{ height: '52%' }} />
          </WallX>
          <WallX x={5} y={3.6} w={9} h={20} z={30} className="board pinboard"><i /><i /><i /><i /><i /><i /></WallX>
          <MeetingTable x={38} y={13} w={8} h={4.5} />
          <Cabinet x={39} y={4.6} />
          <Cabinet x={43.5} y={4.6} />
          <Plant x={4.5} y={40} />
          <Plant x={46.5} y={40} />
        </>
      );
    case 'learning':
      return (
        <>
          <Floor x={68} y={26} w={14} h={12} z={0.3} className="rug" />
          <Desk at={r.desk} w={16} screens={2} accent={a} live={live} />
          <WallX x={68} y={3.6} w={13} h={26} z={26} className="board"><i /><i /><i /><i /></WallX>
          <Shelf x={53} y={4.2} w={10} />
          <StudentDesk x={85} y={14} />
          <StudentDesk x={91} y={14} />
          <StudentDesk x={85} y={22} />
          <Box x={94.5} y={32} w={3} h={4} z={54} c="#1d2742" r={2} south={<span className="leds"><i /><i /><i /></span>} />
          <Plant x={53.5} y={40} />
          <Plant x={96.3} y={40.5} />
        </>
      );
    case 'planning':
      return (
        <>
          <Floor x={15} y={84} w={16} h={10} z={0.3} className="rug" />
          <Box x={r.desk.x - 9} y={r.desk.y + 1.3} w={18} h={4.4} z={30} c="#2b4a8a" r={6} south={<i className="counter-stripe" />} />
          <WallX x={r.desk.x - 1} y={r.desk.y + 3.2} w={3.4} h={12} z={30} className={`screen${live ? ' is-live' : ''}`} style={{ ['--accent' as string]: a }} />
          <Floor x={r.desk.x + 4} y={r.desk.y + 2.2} w={2.2} h={1.6} z={30.4} className="paper" />
          <Chair x={r.desk.x} y={r.desk.y - 2.3} />
          <Kiosk x={6.5} y={70} />
          <MeetingTable x={37} y={64} w={7} h={4} />
          <Box x={36} y={92.4} w={9} h={2.8} z={13} c="#33497c" r={5} />
          <Box x={36} y={91.6} w={9} h={1} z={22} c="#33497c" r={4} />
          <Plant x={5} y={60} />
          <Plant x={46.5} y={94} size={.9} />
          <Floor x={-5.5} y={77.5} w={5} h={5} className="mat" />
        </>
      );
    case 'review':
      return (
        <>
          <Floor x={74} y={70} w={18} h={11} z={0.3} className="rug" />
          <Desk at={r.desk} w={18} accent={a} c={WOOD} live={live} />
          <MeetingTable x={57} y={62} w={8} h={4.5} c={WOOD} />
          <Shelf x={84} y={58.2} w={11} />
          <Cabinet x={54} y={90} />
          <Plant x={96.5} y={60.5} />
          <Plant x={58.5} y={94.5} size={.9} />
        </>
      );
  }
}
