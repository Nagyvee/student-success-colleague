'use client';

import React, { useState, useMemo, useEffect } from 'react';
import type {
  BuildingConfig,
  CustomAgentDef,
  FlowRunLog,
  WorkflowDef,
  WorldState,
} from '@/lib/types';
import Icon from '@/components/Icon';
import ElevatorTransition from './ElevatorTransition';

export interface SkyscraperBuildingProps {
  state: WorldState;
  workflows: WorkflowDef[];
  customAgents: CustomAgentDef[];
  flowRuns: FlowRunLog[];
  selectedFloorId: string;
  onSelectFloor: (id: string) => void;
  onEnterFloorInterior: (id: string) => void;
  onRunFloor: (workflowId: string) => void;
  runningFloor: boolean | string | null;
  pendingEnterFloorId?: string | null;
  onClearPendingEnterFloor?: () => void;
  insetRight?: number;
  children?: React.ReactNode;
  /** Departments as floors (floor 1 first). When given, they replace the workflow-derived floors. */
  floors?: BuildingFloor[];
}

/** One floor of the building: a department, its agents' colours and whether anyone is at work. */
export type BuildingFloor = DerivedFloor;

interface DerivedFloor {
  id: string;
  name: string;
  officeName: string;
  purpose: string;
  color: string;
  agentColors: string[];
  isWorking: boolean;
  isError: boolean;
}

const FLOOR_PALETTE = ['#2563eb', '#7c3aed', '#0891b2', '#059669', '#d97706', '#e11d48'];
const LOCAL_STORAGE_KEY = 'thuso_skyscraper_building_cfg_v2';

function getTenantInitials(name?: string): string {
  if (!name) return 'M';
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'M';
  return words[0][0].toUpperCase();
}

function getShortBrandLabel(name?: string): string {
  if (!name) return 'Melsoft';
  const trimmed = name.trim();
  if (trimmed.length <= 12) return trimmed;
  // Shorten "Melsoft Academy" -> "Melsoft" if it's long, or keep compact
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1 && parts[0].length >= 4) {
    return parts[0];
  }
  return trimmed.slice(0, 12);
}

function extractYouTubeId(url?: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  const regExp = /^.*(?:youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|shorts\/|live\/)([^#&?]*).*/;
  const match = trimmed.match(regExp);
  if (match && match[1] && match[1].length === 11) {
    return match[1];
  }
  return null;
}

/**
 * 2.5D Axonometric Projector calibrated 1:1 to the reference architectural illustration:
 * - +X axis (Front-Left Main Facade, 450 units) slopes down-and-right: (+1.00, +0.284)
 * - +Y axis (Front-Right Side Facade, 180 units) slopes up-and-right:   (+0.622, -0.444)
 * - +Z axis (Vertical elevation, 408..505 units) rises straight up:     (0, -1.00)
 */
function createProjector(
  originX: number,
  originY: number,
  yawDeg: number,
  pitchDeg: number,
  cx: number,
  cy: number
) {
  const rad = (yawDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const pitchFactor = Math.max(0.55, Math.min(1.35, 1 + (pitchDeg - 26) * 0.018));

  return (x: number, y: number, z: number): [number, number] => {
    const dx = x - cx;
    const dy = (y - cy) * 1.65;
    const rx = cx + (dx * cos - dy * sin);
    const ry = cy + (dx * sin + dy * cos) / 1.65;

    const u = originX + rx * 1.0 + ry * 0.622;
    const v = originY + (rx * 0.284 - ry * 0.444) * pitchFactor - z;
    return [Number(u.toFixed(1)), Number(v.toFixed(1))];
  };
}

function pts(coords: [number, number][]): string {
  return coords.map(([x, y]) => `${x},${y}`).join(' ');
}

/**
 * Renders a detailed 2.5D architectural deciduous tree with branching limbs,
 * directional ground shadow, and layered foliage clusters.
 */
function renderLushTree(
  key: string,
  tx: number,
  ty: number,
  scale: number,
  isDark: boolean,
  iso: (x: number, y: number, z: number) => [number, number]
) {
  const [bx, by] = iso(tx, ty, 0);
  const s = scale;
  const shadowFill = isDark ? 'rgba(2, 6, 23, 0.6)' : 'rgba(15, 23, 42, 0.24)';
  const trunkDark = isDark ? '#3e2723' : '#4a3222';
  const trunkLight = isDark ? '#5d4037' : '#6d4c3d';

  const cDeep = isDark ? '#132a10' : '#1f3a08';
  const cShadow = isDark ? '#1c3f16' : '#365314';
  const cMid = isDark ? '#28591e' : '#4d7c0f';
  const cBright = isDark ? '#3b7528' : '#65a30d';
  const cSun = isDark ? '#529435' : '#84cc16';
  const cTip = isDark ? '#6cb546' : '#a3e635';

  const puffs: [number, number, number, string][] = [
    [6, -34, 15, cDeep],
    [-14, -36, 14, cDeep],
    [18, -38, 13, cDeep],
    [0, -48, 18, cDeep],
    [-22, -40, 12, cShadow],
    [-10, -34, 13, cShadow],
    [12, -33, 13, cShadow],
    [22, -42, 12, cShadow],
    [-18, -52, 14, cShadow],
    [16, -54, 14, cShadow],
    [4, -64, 15, cShadow],
    [-24, -46, 11, cMid],
    [-12, -46, 15, cMid],
    [4, -44, 16, cMid],
    [18, -47, 12, cMid],
    [-16, -58, 13, cMid],
    [0, -58, 16, cMid],
    [14, -60, 12, cMid],
    [-6, -68, 13, cMid],
    [8, -68, 11, cMid],
    [-20, -48, 9, cBright],
    [-8, -42, 11, cBright],
    [8, -42, 10, cBright],
    [-14, -56, 11, cBright],
    [2, -54, 12, cBright],
    [12, -54, 9, cBright],
    [-6, -65, 10, cBright],
    [4, -66, 9, cBright],
    [-16, -52, 7.5, cSun],
    [-6, -48, 8.5, cSun],
    [-10, -60, 8, cSun],
    [0, -62, 7.5, cSun],
    [-4, -69, 6.5, cSun],
    [6, -50, 6.5, cSun],
    [-25, -43, 4.5, cTip],
    [-19, -59, 4.5, cTip],
    [-9, -71, 4.5, cTip],
    [3, -72, 4, cTip],
    [-11, -40, 4.5, cTip],
    [15, -63, 4, cBright],
    [24, -45, 4, cMid],
  ];

  return (
    <g key={key} style={{ pointerEvents: 'none' }}>
      <ellipse cx={bx + 15 * s} cy={by + 3 * s} rx={25 * s} ry={10 * s} fill={shadowFill} />
      <ellipse cx={bx + 4 * s} cy={by + 1 * s} rx={12 * s} ry={5 * s} fill={shadowFill} />
      <path
        d={`M ${bx - 3.2 * s} ${by}
            L ${bx - 2.2 * s} ${by - 24 * s}
            L ${bx - 12 * s} ${by - 36 * s}
            L ${bx - 9 * s} ${by - 38 * s}
            L ${bx - 1 * s} ${by - 28 * s}
            L ${bx + 1 * s} ${by - 40 * s}
            L ${bx + 3.5 * s} ${by - 40 * s}
            L ${bx + 2.2 * s} ${by - 26 * s}
            L ${bx + 11 * s} ${by - 35 * s}
            L ${bx + 13 * s} ${by - 33 * s}
            L ${bx + 2.8 * s} ${by - 21 * s}
            L ${bx + 3.6 * s} ${by} Z`}
        fill={trunkDark}
      />
      <path
        d={`M ${bx - 2.6 * s} ${by}
            L ${bx - 1.6 * s} ${by - 25 * s}
            L ${bx + 0.4 * s} ${by - 25 * s}
            L ${bx + 0.6 * s} ${by} Z`}
        fill={trunkLight}
      />
      {puffs.map(([dx, dy, r, fill], idx) => (
        <circle key={idx} cx={bx + dx * s} cy={by + dy * s} r={r * s} fill={fill} />
      ))}
    </g>
  );
}

/**
 * Renders a 3D stone planter box with manicured boxwood hedges.
 */
function renderHedgePlanter(
  key: string,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  curbH: number,
  hedgeH: number,
  isDark: boolean,
  iso: (x: number, y: number, z: number) => [number, number]
) {
  const cFront = isDark ? '#475569' : '#d6cfc7';
  const cRight = isDark ? '#334155' : '#b8afa6';
  const cTop = isDark ? '#64748b' : '#ebe5de';

  const hDark = isDark ? '#193814' : '#2d4c0e';
  const hMid = isDark ? '#27541d' : '#4d7c0f';
  const hLight = isDark ? '#3a752b' : '#65a30d';
  const hSun = isDark ? '#4f9639' : '#84cc16';

  const pad = 4;
  const hx0 = x0 + pad;
  const hx1 = x1 - pad;
  const hy0 = y0 + pad;
  const hy1 = y1 - pad;

  const steps = Math.max(4, Math.round((hx1 - hx0) / 10));
  const leafDots: [number, number, number, string][] = [];
  for (let i = 0; i <= steps; i++) {
    const lx = hx0 + ((hx1 - hx0) * i) / steps;
    const [pu, pv] = iso(lx, (hy0 + hy1) / 2, curbH + hedgeH);
    leafDots.push([pu, pv + (i % 2 === 0 ? -1.5 : 1), 5.5, i % 2 === 0 ? hLight : hMid]);
    leafDots.push([pu - 2, pv - 2.5, 3.5, hSun]);
  }

  return (
    <g key={key} style={{ pointerEvents: 'none' }}>
      <polygon
        points={pts([
          iso(x1, y0, 0),
          iso(x1 + 12, y0, 0),
          iso(x1 + 12, y1, 0),
          iso(x1, y1, 0),
        ])}
        fill={isDark ? 'rgba(2,6,23,0.5)' : 'rgba(15,23,42,0.18)'}
      />
      <polygon
        points={pts([iso(x0, y0, 0), iso(x1, y0, 0), iso(x1, y0, curbH), iso(x0, y0, curbH)])}
        fill={cFront}
        stroke="#64748b"
        strokeWidth="0.6"
      />
      <polygon
        points={pts([iso(x1, y0, 0), iso(x1, y1, 0), iso(x1, y1, curbH), iso(x1, y0, curbH)])}
        fill={cRight}
        stroke="#64748b"
        strokeWidth="0.6"
      />
      <polygon
        points={pts([iso(x0, y0, curbH), iso(x1, y0, curbH), iso(x1, y1, curbH), iso(x0, y1, curbH)])}
        fill={cTop}
        stroke="#94a3b8"
        strokeWidth="0.6"
      />
      <polygon
        points={pts([
          iso(hx0, hy0, curbH),
          iso(hx1, hy0, curbH),
          iso(hx1, hy0, curbH + hedgeH),
          iso(hx0, hy0, curbH + hedgeH),
        ])}
        fill={hMid}
      />
      <polygon
        points={pts([
          iso(hx1, hy0, curbH),
          iso(hx1, hy1, curbH),
          iso(hx1, hy1, curbH + hedgeH),
          iso(hx1, hy0, curbH + hedgeH),
        ])}
        fill={hDark}
      />
      <polygon
        points={pts([
          iso(hx0, hy0, curbH + hedgeH),
          iso(hx1, hy0, curbH + hedgeH),
          iso(hx1, hy1, curbH + hedgeH),
          iso(hx0, hy1, curbH + hedgeH),
        ])}
        fill={hLight}
      />
      {leafDots.map(([cx, cy, r, fill], idx) => (
        <circle key={idx} cx={cx} cy={cy} r={r} fill={fill} />
      ))}
    </g>
  );
}

/**
 * Renders a stainless-steel cylindrical bollard with dark cap and directional shadow.
 */
function renderBollard(
  key: string,
  bx: number,
  by: number,
  isDark: boolean,
  iso: (x: number, y: number, z: number) => [number, number]
) {
  const [u0, v0] = iso(bx, by, 0);
  const [u1, v1] = iso(bx, by, 16);
  return (
    <g key={key} style={{ pointerEvents: 'none' }}>
      <line
        x1={u0}
        y1={v0}
        x2={u0 + 12}
        y2={v0 - 3}
        stroke={isDark ? 'rgba(2,6,23,0.6)' : 'rgba(15,23,42,0.24)'}
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <line
        x1={u0}
        y1={v0}
        x2={u1}
        y2={v1}
        stroke={isDark ? '#94a3b8' : '#64748b'}
        strokeWidth="4.4"
        strokeLinecap="round"
      />
      <line
        x1={u0 - 0.8}
        y1={v0}
        x2={u1 - 0.8}
        y2={v1}
        stroke={isDark ? '#cbd5e1' : '#e2e8f0'}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <ellipse cx={u1} cy={v1} rx="2.3" ry="1.2" fill="#0f172a" />
    </g>
  );
}

/**
 * Renders a realistic 2.5D office workstation cluster inside a floor bay
 * BEFORE the semi-transparent blue-tinted glass overlay is drawn over it.
 */
function renderRealisticWorkstation(
  key: string,
  u: number,
  v: number,
  floorH: number,
  isRightFacade: boolean,
  isWorking: boolean,
  showPerson: boolean,
  personColor: string,
  isDark: boolean
) {
  const slopeY = isRightFacade ? -5.5 : 4.2;
  return (
    <g key={key} style={{ pointerEvents: 'none' }}>
      <ellipse
        cx={u + 10}
        cy={v - floorH * 0.62}
        rx="11"
        ry="2.4"
        fill="#fef9c3"
        opacity={isDark ? 0.92 : 0.78}
      />
      <polygon
        points={`${u + 1},${v - floorH * 0.6} ${u + 19},${v - floorH * 0.6} ${u + 26},${v + 6} ${u - 6},${v + 6}`}
        fill="url(#warmLightCone)"
      />
      <polygon
        points={`${u - 4},${v - 10} ${u + 14},${v - 10 + slopeY * 0.5} ${u + 14},${v - 2 + slopeY * 0.5} ${u - 4},${v - 2}`}
        fill="#475569"
        opacity="0.7"
      />
      <polygon
        points={`${u},${v - 2} ${u + 22},${v - 2 + slopeY} ${u + 22},${v + 5 + slopeY} ${u},${v + 5}`}
        fill="#92400e"
        opacity="0.9"
      />
      <polygon
        points={`${u - 2},${v - 4} ${u + 20},${v - 4 + slopeY} ${u + 24},${v - 1 + slopeY} ${u + 2},${v - 1}`}
        fill="#f59e0b"
        stroke="#b45309"
        strokeWidth="0.4"
      />
      <rect
        x={u + 4}
        y={v - 10 + slopeY * 0.25}
        width="6.5"
        height="4.8"
        rx="0.6"
        fill={isWorking ? '#38bdf8' : '#0f172a'}
        stroke="#cbd5e1"
        strokeWidth="0.4"
      />
      <rect
        x={u + 12}
        y={v - 10 + slopeY * 0.55}
        width="6.5"
        height="4.8"
        rx="0.6"
        fill={isWorking ? '#60a5fa' : '#1e293b'}
        stroke="#cbd5e1"
        strokeWidth="0.4"
      />
      {showPerson && (
        <g className={isWorking ? 'sky-worker-bob' : undefined}>
          <circle cx={u + 8} cy={v - 12 + slopeY * 0.3} r="2.6" fill="#451a03" />
          <path
            d={`M ${u + 4.5} ${v - 4 + slopeY * 0.3} Q ${u + 8} ${v - 10 + slopeY * 0.3} ${u + 11.5} ${v - 4 + slopeY * 0.3} Z`}
            fill={personColor}
          />
        </g>
      )}
      <rect
        x={u + 5.5}
        y={v - 7 + slopeY * 0.3}
        width="5.2"
        height="6.5"
        rx="1.6"
        fill="#0f172a"
      />
      <line
        x1={u + 8}
        y1={v - 0.5 + slopeY * 0.3}
        x2={u + 8}
        y2={v + 3.5 + slopeY * 0.3}
        stroke="#1e293b"
        strokeWidth="1.4"
      />
    </g>
  );
}

export function SkyscraperBuilding({
  state,
  workflows,
  customAgents,
  flowRuns,
  onEnterFloorInterior,
  runningFloor,
  pendingEnterFloorId,
  onClearPendingEnterFloor,
  children,
  floors,
}: SkyscraperBuildingProps) {
  // Default zoom 0.78 gives comfortable breathing room around the building
  const DEFAULT_ZOOM = 0.78;
  const DEFAULT_YAW = 0;
  const DEFAULT_PITCH = 26;

  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const checkTheme = () => {
      const attr = document.documentElement.getAttribute('data-theme');
      setIsDark(attr === 'dark');
    };
    checkTheme();
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    return () => observer.disconnect();
  }, []);

  const tenantName = state.tenant?.name || 'Melsoft Academy';
  const serverBuildingConfig = state.tenant?.building;

  const [hoveredFloorId, setHoveredFloorId] = useState<string | null>(null);
  const [enteringOfficeId, setEnteringOfficeId] = useState<string | null>(null);
  const [simulatingRedFloorId, setSimulatingRedFloorId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [yawDeg, setYawDeg] = useState<number>(DEFAULT_YAW);
  const [pitchDeg, setPitchDeg] = useState<number>(DEFAULT_PITCH);
  const [dragState, setDragState] = useState<{
    mode: 'pan' | 'rotate';
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [savedLocalConfig, setSavedLocalConfig] = useState<BuildingConfig | null>(null);
  const [draftConfig, setDraftConfig] = useState<BuildingConfig>(() => ({
    facadeStyle: serverBuildingConfig?.facadeStyle ?? 'sculpted',
    brandColor: serverBuildingConfig?.brandColor ?? '#2563eb',
    activeFloorColor: serverBuildingConfig?.activeFloorColor ?? '#720075',
    showBillboard: serverBuildingConfig?.showBillboard ?? true,
    billboardText: serverBuildingConfig?.billboardText ?? '',
    billboardImageUrl: serverBuildingConfig?.billboardImageUrl ?? '',
    videoUrl: serverBuildingConfig?.videoUrl ?? '',
    logoUrl: serverBuildingConfig?.logoUrl ?? '',
    hideCanopyName: serverBuildingConfig?.hideCanopyName ?? false,
    showTrees: serverBuildingConfig?.showTrees ?? true,
    showBollards: serverBuildingConfig?.showBollards ?? true,
    showRoofChillers: serverBuildingConfig?.showRoofChillers ?? true,
    showStreetLamps: serverBuildingConfig?.showStreetLamps ?? true,
  }));
  const [savingCfg, setSavingCfg] = useState(false);
  const [saveToast, setSaveToast] = useState<string | null>(null);

  // Load any locally saved building config on mount
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as BuildingConfig;
        setSavedLocalConfig(parsed);
        setDraftConfig((prev) => ({ ...prev, ...parsed }));
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  // Merge server building config when it arrives, without wiping local logo/video edits
  useEffect(() => {
    if (serverBuildingConfig) {
      setDraftConfig((prev) => ({
        ...prev,
        ...serverBuildingConfig,
        logoUrl: serverBuildingConfig.logoUrl || prev.logoUrl,
        videoUrl: serverBuildingConfig.videoUrl || prev.videoUrl,
      }));
    }
  }, [serverBuildingConfig]);

  // Active config reflects draft immediately while editing, and preserves saved config when closed
  const cfg: BuildingConfig = useMemo(
    () => ({
      ...serverBuildingConfig,
      ...savedLocalConfig,
      ...draftConfig,
    }),
    [serverBuildingConfig, savedLocalConfig, draftConfig]
  );

  const activeHighlightColor = cfg.activeFloorColor || '#720075';
  const brandColor = cfg.brandColor || '#2563eb';

  // Derive interactive floors from workflows
  const floorsBottomToTop: DerivedFloor[] = useMemo(() => {
    const anyAgentBusy = Object.values(state.agents || {}).some(
      (ag) => ag.status && ag.status !== 'idle'
    );
    if (floors && floors.length > 0) {
      return floors.map((f) => ({ ...f, isError: f.isError || simulatingRedFloorId === f.id }));
    }
    if (workflows.length > 0) {
      return workflows.map((wf, idx) => {
        const wfRuns = flowRuns.filter((r) => r.workflowId === wf.id);
        const hasFailedRun = wfRuns.some((r) => r.status === 'failed');
        const hasRunningRun =
          runningFloor === wf.id ||
          wfRuns.some((r) => r.status === 'running') ||
          (idx === 0 && Boolean(state.busy || anyAgentBusy));
        const officeAgents = customAgents.filter((ca) => ca.officeId === wf.officeId);
        return {
          id: wf.id,
          name: wf.officeName || wf.name,
          officeName: wf.officeName || wf.name,
          purpose: wf.description || wf.trigger,
          color: FLOOR_PALETTE[idx % FLOOR_PALETTE.length],
          agentColors:
            officeAgents.length > 0
              ? officeAgents.map((_, i) => FLOOR_PALETTE[(idx + i) % FLOOR_PALETTE.length])
              : [FLOOR_PALETTE[idx % FLOOR_PALETTE.length]],
          isWorking: hasRunningRun,
          isError: hasFailedRun || simulatingRedFloorId === wf.id,
        };
      });
    }
    return [
      {
        id: 'floor-1',
        name: 'Reception & Risk Triage',
        officeName: 'Reception & Risk Triage',
        purpose: 'Learner intake & cohort risk diagnostics',
        color: '#2563eb',
        agentColors: ['#2563eb', '#0891b2'],
        isWorking: Boolean(state.busy || anyAgentBusy),
        isError: simulatingRedFloorId === 'floor-1',
      },
      {
        id: 'floor-2',
        name: 'Academic Mastery Studio',
        officeName: 'Academic Mastery Studio',
        purpose: 'Remedial quizzes & personalized study plans',
        color: '#7c3aed',
        agentColors: ['#7c3aed', '#9333ea'],
        isWorking: false,
        isError: simulatingRedFloorId === 'floor-2',
      },
      {
        id: 'floor-3',
        name: 'Attendance & Engagement Hub',
        officeName: 'Attendance & Engagement Hub',
        purpose: 'Proactive check-ins & attendance follow-ups',
        color: '#059669',
        agentColors: ['#059669', '#0891b2'],
        isWorking: false,
        isError: simulatingRedFloorId === 'floor-3',
      },
      {
        id: 'floor-4',
        name: 'Accounts & Billing Suite',
        officeName: 'Accounts & Billing Suite',
        purpose: 'Tuition reminders & payment plan support',
        color: '#d97706',
        agentColors: ['#d97706', '#ea580c'],
        isWorking: false,
        isError: simulatingRedFloorId === 'floor-4',
      },
      {
        id: 'floor-5',
        name: 'Executive Review & Escalations',
        officeName: 'Executive Review & Escalations',
        purpose: 'Quality assurance & advisor escalations',
        color: '#e11d48',
        agentColors: ['#e11d48', '#7c3aed'],
        isWorking: false,
        isError: simulatingRedFloorId === 'floor-5',
      },
    ];
  }, [floors, workflows, flowRuns, runningFloor, state.busy, state.agents, customAgents, simulatingRedFloorId]);

  const totalFloors = Math.max(1, floorsBottomToTop.length);
  const anyFloorWorking = useMemo(
    () => floorsBottomToTop.some((f) => f.isWorking),
    [floorsBottomToTop]
  );
  const anyFloorError = useMemo(
    () => floorsBottomToTop.some((f) => f.isError),
    [floorsBottomToTop]
  );

  const triggerEnterFloor = React.useCallback(
    (floorId: string) => {
      if (enteringOfficeId) return;
      setEnteringOfficeId(floorId);
      window.setTimeout(() => {
        setEnteringOfficeId(null);
        onEnterFloorInterior(floorId);
      }, 3000);
    },
    [enteringOfficeId, onEnterFloorInterior]
  );

  useEffect(() => {
    if (pendingEnterFloorId && pendingEnterFloorId !== '__all__' && !enteringOfficeId) {
      triggerEnterFloor(pendingEnterFloorId);
      onClearPendingEnterFloor?.();
    }
  }, [pendingEnterFloorId, enteringOfficeId, triggerEnterFloor, onClearPendingEnterFloor]);

  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>, field: 'logoUrl' | 'billboardImageUrl') => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const dataUrl = reader.result as string;
        setDraftConfig((prev) => {
          const next = { ...prev, [field]: dataUrl };
          try {
            window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(next));
          } catch {
            // ignore quota
          }
          setSavedLocalConfig(next);
          return next;
        });
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSaveCustomization = async () => {
    setSavingCfg(true);
    try {
      setSavedLocalConfig(draftConfig);
      try {
        window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(draftConfig));
      } catch {
        // ignore storage quota
      }
      await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'saveIntegrations',
          integrations: {
            building: draftConfig,
          },
        }),
      });
      setSaveToast('Building & logo saved!');
      window.setTimeout(() => setSaveToast(null), 2600);
      setCustomizeOpen(false);
    } finally {
      setSavingCfg(false);
    }
  };

  const TOTAL_X = 450;
  const TOTAL_Y = 180;
  const TOTAL_Z = 408;
  const FLOOR_H = TOTAL_Z / totalFloors;
  /** The window bars sit exactly between departments: every department is one row of windows, never one and a half. */
  const floorLines = Array.from({ length: totalFloors }, (_, i) => (i + 1) * FLOOR_H);

  const ORIGIN_X = 236;
  const ORIGIN_Y = 466;
  const CENTER_X = TOTAL_X / 2;
  const CENTER_Y = TOTAL_Y / 2;

  const iso = useMemo(
    () => createProjector(ORIGIN_X, ORIGIN_Y, yawDeg, pitchDeg, CENTER_X, CENTER_Y),
    [yawDeg, pitchDeg, CENTER_X, CENTER_Y]
  );

  // Trackpad pinch-to-zoom and two-finger scroll zoom
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const factor = e.ctrlKey ? 0.0045 : 0.0018;
    const delta = -e.deltaY * factor;
    setZoom((z) => Math.max(0.45, Math.min(2.2, Number((z + delta).toFixed(3)))));
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as HTMLElement).closest('[data-floor-interactive="true"]')) return;
    const isRotate = e.shiftKey || e.button === 2 || e.altKey;
    setDragState({
      mode: isRotate ? 'rotate' : 'pan',
      startX: e.clientX,
      startY: e.clientY,
      origX: isRotate ? yawDeg : pan.x,
      origY: isRotate ? pitchDeg : pan.y,
    });
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (dragState.mode === 'rotate') {
      const nextYaw = Math.max(-45, Math.min(45, dragState.origX + dx * 0.25));
      const nextPitch = Math.max(14, Math.min(38, dragState.origY - dy * 0.12));
      setYawDeg(nextYaw);
      setPitchDeg(nextPitch);
    } else {
      setPan({
        x: dragState.origX + dx,
        y: dragState.origY + dy,
      });
    }
  };

  const handlePointerUp = () => setDragState(null);

  const hoveredFloor = useMemo(
    () => floorsBottomToTop.find((f) => f.id === hoveredFloorId) || null,
    [floorsBottomToTop, hoveredFloorId]
  );
  const hoveredFloorIdx = useMemo(
    () => (hoveredFloorId ? floorsBottomToTop.findIndex((f) => f.id === hoveredFloorId) : -1),
    [floorsBottomToTop, hoveredFloorId]
  );
  const hoveredFloorNum = hoveredFloorIdx >= 0 ? hoveredFloorIdx + 1 : 0;

  const enteringFloorIndex = useMemo(
    () => (enteringOfficeId ? floorsBottomToTop.findIndex((f) => f.id === enteringOfficeId) : -1),
    [floorsBottomToTop, enteringOfficeId]
  );
  const enteringFloor = enteringFloorIndex >= 0 ? floorsBottomToTop[enteringFloorIndex] : null;

  const [doorCenterX, doorCenterY] = iso(352, -6, 36);
  const targetSlabZ = enteringFloorIndex >= 0 ? (enteringFloorIndex + 0.5) * FLOOR_H : 36;
  const [, targetElevY] = iso(352, 0, targetSlabZ);

  const cameraStyle: React.CSSProperties = enteringOfficeId
    ? {
        transformOrigin: `${doorCenterX}px ${doorCenterY}px`,
        transform: `translate(${(512 - doorCenterX) * 0.62}px, ${(360 - targetElevY) * 0.72}px) scale(2.85)`,
        transition: 'transform 1.85s cubic-bezier(0.22, 1, 0.36, 1)',
      }
    : {
        transform: `translate(${pan.x}px, ${pan.y + 18}px) scale(${zoom})`,
        transformOrigin: '512px 370px',
        transition: dragState ? 'none' : 'transform 0.2s ease-out',
      };

  const tenantInitials = getTenantInitials(tenantName);
  const shortBrandText = getShortBrandLabel(tenantName);
  const youtubeId = extractYouTubeId(cfg.videoUrl);

  const renderStructuralBeam = (
    key: string,
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    width: number
  ) => {
    const [u1, v1] = iso(x1, y1, z1);
    const [u2, v2] = iso(x2, y2, z2);
    return (
      <g key={key} style={{ pointerEvents: 'none' }}>
        <line
          x1={u1}
          y1={v1 + 1.4}
          x2={u2}
          y2={v2 + 1.4}
          stroke="rgba(255,255,255,0.82)"
          strokeWidth={width + 1.4}
          strokeLinecap="square"
        />
        <line
          x1={u1}
          y1={v1}
          x2={u2}
          y2={v2}
          stroke="#1e293b"
          strokeWidth={width}
          strokeLinecap="square"
        />
        <line
          x1={u1}
          y1={v1 - width * 0.28}
          x2={u2}
          y2={v2 - width * 0.28}
          stroke="#0f172a"
          strokeWidth={Math.max(1.2, width * 0.32)}
          strokeLinecap="square"
        />
      </g>
    );
  };

  /**
   * Exact 4-corner parallelogram metrics for the Widescreen TV inner screen:
   * Raised slightly (z in [134, 202]) so the taller Entrance Canopy below has generous height.
   */
  const [tvTLx, tvTLy] = iso(232, -27, 202);
  const [tvTRx, tvTRy] = iso(384, -27, 202);
  const [tvBLx, tvBLy] = iso(232, -27, 134);
  const tvParallelogramW = Math.max(40, tvTRx - tvTLx);
  const tvParallelogramH = Math.max(30, tvBLy - tvTLy);
  const tvSlopeDY = tvTRy - tvTLy;
  const tvSkewDeg = Number(((Math.atan2(tvSlopeDY, tvParallelogramW) * 180) / Math.PI).toFixed(2));
  const tvFoY = tvSlopeDY >= 0 ? tvTLy : tvTLy + tvSlopeDY;
  const tvFoHeight = tvParallelogramH + Math.abs(tvSlopeDY) + 4;

  /**
   * Exact 4-corner parallelogram metrics for the Taller White Entrance Canopy:
   * Bounded cleanly to (x in [272, 418], z in [60, 114]) for generous logo spacing.
   */
  const [canTLx, canTLy] = iso(272, -28, 114);
  const [canTRx, canTRy] = iso(418, -28, 114);
  const [canBLx, canBLy] = iso(272, -28, 60);
  const canParallelogramW = Math.max(40, canTRx - canTLx);
  const canParallelogramH = Math.max(20, canBLy - canTLy);
  const canSlopeDY = canTRy - canTLy;
  const canSkewDeg = Number(((Math.atan2(canSlopeDY, canParallelogramW) * 180) / Math.PI).toFixed(2));
  const canFoY = canSlopeDY >= 0 ? canTLy : canTLy + canSlopeDY;
  const canFoHeight = canParallelogramH + Math.abs(canSlopeDY) + 4;

  return (
    <div
      className="sky-stage"
      data-theme={isDark ? 'dark' : 'light'}
      onWheel={handleWheel}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        userSelect: 'none',
        background: isDark
          ? 'radial-gradient(ellipse at 50% 28%, #162238 0%, #0b1324 58%, #050912 100%)'
          : 'radial-gradient(ellipse at 50% 30%, #e4ebf5 0%, #d5dfed 62%, #c5d1e3 100%)',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Top GoalBar slot passed from OfficeApp */}
      {children}

      {/* Save Toast Notification */}
      {saveToast && (
        <div
          style={{
            position: 'absolute',
            top: 68,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 55,
            padding: '7px 16px',
            borderRadius: 999,
            background: '#10b981',
            color: '#ffffff',
            fontSize: 12,
            fontWeight: 800,
            boxShadow: '0 8px 24px rgba(16, 185, 129, 0.35)',
          }}
        >
          ✓ {saveToast}
        </div>
      )}

      {/* Slide-over Building Customization Studio Drawer (Anchored above bottom-right dock) */}
      {customizeOpen && (
        <div
          style={{
            position: 'absolute',
            bottom: 66,
            right: 18,
            width: 345,
            maxHeight: 'calc(100% - 140px)',
            overflowY: 'auto',
            zIndex: 45,
            padding: 16,
            borderRadius: 16,
            background: isDark ? 'rgba(15, 23, 42, 0.96)' : 'rgba(255, 255, 255, 0.98)',
            border: isDark ? '1px solid rgba(148, 163, 184, 0.25)' : '1px solid rgba(15, 23, 42, 0.12)',
            boxShadow: '0 20px 50px rgba(15, 23, 42, 0.45)',
            backdropFilter: 'blur(16px)',
            color: isDark ? '#f8fafc' : '#0f172a',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800 }}>Building &amp; TV Studio</div>
              <div style={{ fontSize: 11, color: isDark ? '#94a3b8' : '#64748b' }}>
                Customize logo, muted YouTube TV screen &amp; campus details
              </div>
            </div>
            <button
              type="button"
              onClick={() => setCustomizeOpen(false)}
              style={{
                background: 'transparent',
                border: 'none',
                color: isDark ? '#94a3b8' : '#64748b',
                cursor: 'pointer',
                fontSize: 16,
                fontWeight: 700,
              }}
            >
              ×
            </button>
          </div>

          {/* Company Logo Upload / URL with Live Preview */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: isDark ? '#cbd5e1' : '#334155' }}>
              Company Logo (Entrance Canopy Sign)
            </label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {draftConfig.logoUrl && (
                <img
                  src={draftConfig.logoUrl}
                  alt="Uploaded Logo"
                  style={{
                    width: 32,
                    height: 32,
                    objectFit: 'contain',
                    borderRadius: 6,
                    background: '#ffffff',
                    padding: 2,
                    border: '1px solid #cbd5e1',
                    flexShrink: 0,
                  }}
                />
              )}
              <input
                type="text"
                placeholder="Paste Logo Image URL or click Upload..."
                value={draftConfig.logoUrl ? (draftConfig.logoUrl.startsWith('data:') ? 'Uploaded image file' : draftConfig.logoUrl) : ''}
                onChange={(e) => setDraftConfig((p) => ({ ...p, logoUrl: e.target.value }))}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '6px 9px',
                  borderRadius: 8,
                  fontSize: 11.5,
                  border: isDark ? '1px solid #334155' : '1px solid #cbd5e1',
                  background: isDark ? '#0f172a' : '#f8fafc',
                  color: 'inherit',
                }}
              />
              <label
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  fontSize: 11,
                  fontWeight: 700,
                  background: brandColor,
                  color: '#ffffff',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                Upload
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleLogoFileChange(e, 'logoUrl')}
                  style={{ display: 'none' }}
                />
              </label>
              {draftConfig.logoUrl && (
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...draftConfig, logoUrl: '' };
                    setDraftConfig(next);
                    setSavedLocalConfig(next);
                    try {
                      window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(next));
                    } catch {
                      // ignore
                    }
                  }}
                  style={{
                    padding: '6px 8px',
                    borderRadius: 8,
                    fontSize: 10.5,
                    fontWeight: 700,
                    border: 'none',
                    background: isDark ? '#1e293b' : '#e2e8f0',
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: isDark ? '#cbd5e1' : '#475569',
                cursor: 'pointer',
                marginTop: 2,
              }}
            >
              <input
                type="checkbox"
                checked={Boolean(draftConfig.hideCanopyName)}
                onChange={(e) => {
                  const next = { ...draftConfig, hideCanopyName: e.target.checked };
                  setDraftConfig(next);
                  setSavedLocalConfig(next);
                  try {
                    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(next));
                  } catch {
                    // ignore
                  }
                }}
              />
              Hide text name on entrance sign (center logo only)
            </label>
          </div>

          {/* YouTube Video URL for Widescreen TV */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: isDark ? '#cbd5e1' : '#334155' }}>
              Building TV Video (YouTube Link — Plays Muted)
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                placeholder="Leave blank for Blue/Red graphic or paste YouTube URL..."
                value={draftConfig.videoUrl || ''}
                onChange={(e) => setDraftConfig((p) => ({ ...p, videoUrl: e.target.value }))}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '6px 9px',
                  borderRadius: 8,
                  fontSize: 11.5,
                  border: isDark ? '1px solid #334155' : '1px solid #cbd5e1',
                  background: isDark ? '#0f172a' : '#f8fafc',
                  color: 'inherit',
                }}
              />
              {draftConfig.videoUrl ? (
                <button
                  type="button"
                  onClick={() => setDraftConfig((p) => ({ ...p, videoUrl: '' }))}
                  style={{
                    padding: '6px 8px',
                    borderRadius: 8,
                    fontSize: 10.5,
                    fontWeight: 700,
                    border: 'none',
                    background: isDark ? '#1e293b' : '#e2e8f0',
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  Graphic
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    setDraftConfig((p) => ({
                      ...p,
                      videoUrl: 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
                    }))
                  }
                  style={{
                    padding: '6px 8px',
                    borderRadius: 8,
                    fontSize: 10.5,
                    fontWeight: 700,
                    border: 'none',
                    background: isDark ? '#1e293b' : '#e2e8f0',
                    color: 'inherit',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Sample Video
                </button>
              )}
            </div>
          </div>

          {/* Colors: Brand Accent & Active Floor Bottom Line */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: isDark ? '#cbd5e1' : '#334155' }}>
                Brand Accent
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="color"
                  value={draftConfig.brandColor || '#2563eb'}
                  onChange={(e) => setDraftConfig((p) => ({ ...p, brandColor: e.target.value }))}
                  style={{ width: 30, height: 26, border: 'none', background: 'none', cursor: 'pointer' }}
                />
                <span style={{ fontSize: 11, fontFamily: 'monospace' }}>
                  {draftConfig.brandColor || '#2563eb'}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: isDark ? '#cbd5e1' : '#334155' }}>
                Active Floor Edge
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="color"
                  value={draftConfig.activeFloorColor || '#720075'}
                  onChange={(e) => setDraftConfig((p) => ({ ...p, activeFloorColor: e.target.value }))}
                  style={{ width: 30, height: 26, border: 'none', background: 'none', cursor: 'pointer' }}
                />
                <span style={{ fontSize: 11, fontFamily: 'monospace' }}>
                  {draftConfig.activeFloorColor || '#720075'}
                </span>
              </div>
            </div>
          </div>

          {/* Architectural Elements Toggles */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: isDark ? '#cbd5e1' : '#334155' }}>
              Building &amp; Exterior Elements
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 11.5 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={draftConfig.showBillboard !== false}
                  onChange={(e) => setDraftConfig((p) => ({ ...p, showBillboard: e.target.checked }))}
                />
                Widescreen TV
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={draftConfig.showTrees !== false}
                  onChange={(e) => setDraftConfig((p) => ({ ...p, showTrees: e.target.checked }))}
                />
                Trees &amp; Hedges
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={draftConfig.showBollards !== false}
                  onChange={(e) => setDraftConfig((p) => ({ ...p, showBollards: e.target.checked }))}
                />
                Street Bollards
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={draftConfig.showRoofChillers !== false}
                  onChange={(e) => setDraftConfig((p) => ({ ...p, showRoofChillers: e.target.checked }))}
                />
                Roof HVAC Units
              </label>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              onClick={() => setCustomizeOpen(false)}
              style={{
                padding: '7px 12px',
                borderRadius: 8,
                fontSize: 11.5,
                fontWeight: 600,
                border: isDark ? '1px solid #334155' : '1px solid #cbd5e1',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleSaveCustomization}
              disabled={savingCfg}
              style={{
                padding: '7px 14px',
                borderRadius: 8,
                fontSize: 11.5,
                fontWeight: 700,
                border: 'none',
                background: brandColor,
                color: '#ffffff',
                cursor: 'pointer',
              }}
            >
              {savingCfg ? 'Saving...' : 'Save Building'}
            </button>
          </div>
        </div>
      )}

      {/* Main 2.5D Architectural SVG Viewport (1024 x 720) */}
      <svg
        viewBox="0 0 1024 720"
        className="sky-svg"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          width: '100%',
          height: '100%',
          cursor: dragState
            ? 'grabbing'
            : enteringOfficeId
            ? 'default'
            : 'grab',
        }}
      >
        <defs>
          <style>{`
            @keyframes skyTwinkle {
              0%, 100% { opacity: 0.25; transform: scale(0.85); }
              50% { opacity: 0.95; transform: scale(1.15); }
            }
            @keyframes skyCloudDrift {
              0%, 100% { transform: translateX(0px); }
              50% { transform: translateX(14px); }
            }
            @keyframes skyActiveEdgeFlow {
              0% { stroke-dashoffset: 36; }
              100% { stroke-dashoffset: 0; }
            }
            @keyframes skyErrorRoomPulse {
              0%, 100% { opacity: 0.62; }
              50% { opacity: 0.9; }
            }
            @keyframes skyBeaconPulse {
              0%, 100% { opacity: 0.45; transform: scale(0.95); }
              50% { opacity: 0.95; transform: scale(1.22); }
            }
            @keyframes skyWorkerBob {
              0%, 100% { transform: translate(0px, 0px); }
              50% { transform: translate(2.5px, -0.8px); }
            }
            .sky-star { animation: skyTwinkle 3.6s ease-in-out infinite; }
            .sky-cloud { animation: skyCloudDrift 18s ease-in-out infinite; }
            .sky-active-edge {
              stroke-dasharray: 12 6;
              animation: skyActiveEdgeFlow 0.85s linear infinite;
            }
            .sky-error-pulse { animation: skyErrorRoomPulse 1.6s ease-in-out infinite; }
            .sky-beacon-pulse { animation: skyBeaconPulse 1.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
            .sky-worker-bob { animation: skyWorkerBob 3.2s ease-in-out infinite; }
          `}</style>

          <filter id="panelShadow" x="-15%" y="-15%" width="140%" height="140%">
            <feDropShadow dx="4" dy="6" stdDeviation="5" floodColor="#0f172a" floodOpacity={isDark ? 0.55 : 0.28} />
          </filter>

          <linearGradient id="whiteSunlit" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={isDark ? '#eef4fc' : '#ffffff'} />
            <stop offset="50%" stopColor={isDark ? '#d5e0f0' : '#f8fafc'} />
            <stop offset="100%" stopColor={isDark ? '#b4c5dc' : '#e2e8f0'} />
          </linearGradient>

          <linearGradient id="whiteMidFacet" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={isDark ? '#dce6f5' : '#f8fafc'} />
            <stop offset="100%" stopColor={isDark ? '#9fb3ce' : '#d5dfe9'} />
          </linearGradient>

          <linearGradient id="whiteRightWall" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={isDark ? '#b8cae0' : '#e6edf5'} />
            <stop offset="100%" stopColor={isDark ? '#8398b5' : '#c6d3e1'} />
          </linearGradient>

          <linearGradient id="whiteBevelShade" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={isDark ? '#8ba0bd' : '#cbd5e1'} />
            <stop offset="100%" stopColor={isDark ? '#5c718f' : '#94a3b8'} />
          </linearGradient>

          <linearGradient id="roomBackWall" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={isDark ? '#3b4963' : '#1e3a5f'} />
            <stop offset="55%" stopColor={isDark ? '#4f5d75' : '#2c5282'} />
            <stop offset="100%" stopColor={isDark ? '#2b3548' : '#1a365d'} />
          </linearGradient>

          <linearGradient id="warmLightCone" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#fef08a" stopOpacity={isDark ? 0.55 : 0.38} />
            <stop offset="65%" stopColor="#f59e0b" stopOpacity={isDark ? 0.32 : 0.2} />
            <stop offset="100%" stopColor="#d97706" stopOpacity="0.05" />
          </linearGradient>

          <linearGradient id="blueGlassVeil" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#0c2d57" stopOpacity={isDark ? 0.42 : 0.58} />
            <stop offset="40%" stopColor="#1e5696" stopOpacity={isDark ? 0.36 : 0.48} />
            <stop offset="75%" stopColor="#38bdf8" stopOpacity={isDark ? 0.28 : 0.42} />
            <stop offset="100%" stopColor="#153e70" stopOpacity={isDark ? 0.45 : 0.56} />
          </linearGradient>

          <linearGradient id="blueGlassCurtain" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#102f54" />
            <stop offset="40%" stopColor="#1e5696" />
            <stop offset="75%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#173f6e" />
          </linearGradient>

          <linearGradient id="warmLobbyGlow" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#fef08a" stopOpacity={isDark ? 0.96 : 0.9} />
            <stop offset="55%" stopColor="#f59e0b" stopOpacity={isDark ? 0.88 : 0.78} />
            <stop offset="100%" stopColor="#b45309" stopOpacity="0.72" />
          </linearGradient>

          <linearGradient id="plazaStoneGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={isDark ? '#3b4759' : '#eadbcf'} />
            <stop offset="55%" stopColor={isDark ? '#2c3748' : '#dcc9b8'} />
            <stop offset="100%" stopColor={isDark ? '#1e293b' : '#c8b29e'} />
          </linearGradient>

          <linearGradient id="asphaltRoadGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={isDark ? '#1e293b' : '#525c6a'} />
            <stop offset="100%" stopColor={isDark ? '#0f172a' : '#3b4452'} />
          </linearGradient>

          <clipPath id="clipLeftHighPeak">
            <polygon
              points={pts([
                iso(40, -12, 285),
                iso(116, -12, 475),
                iso(146, -12, 86),
                iso(40, -12, 225),
              ])}
            />
          </clipPath>

          <clipPath id="clipLeftOuterWing">
            <polygon
              points={pts([
                iso(0, -12, 142),
                iso(108, -12, 82),
                iso(108, -12, 295),
                iso(0, -12, 385),
              ])}
            />
          </clipPath>

          <clipPath id="clipCenterDiamondPod">
            <polygon
              points={pts([
                iso(180, -26, 258),
                iso(382, -26, 502),
                iso(408, -26, 365),
                iso(405, -26, 212),
                iso(222, -26, 175),
              ])}
            />
          </clipPath>

          <clipPath id="clipRightFacadeWall">
            <polygon
              points={pts([
                iso(450, 56, 88),
                iso(450, 180, 88),
                iso(450, 180, 415),
                iso(450, 56, 415),
              ])}
            />
          </clipPath>

          <clipPath id="tvScreenClip">
            <polygon
              points={pts([
                iso(232, -27, 202),
                iso(384, -27, 202),
                iso(384, -27, 134),
                iso(232, -27, 134),
              ])}
            />
          </clipPath>
        </defs>

        {/* ==================== SKY LAYER: SUN / CLOUDS (LIGHT) OR MOON / STARS (DARK) ==================== */}
        {isDark ? (
          <g style={{ pointerEvents: 'none' }}>
            {[
              [85, 95, 1.5, '0s'],
              [165, 76, 1.9, '0.7s'],
              [265, 108, 1.3, '1.4s'],
              [420, 72, 1.6, '0.3s'],
              [785, 88, 2.0, '1.1s'],
              [865, 112, 1.4, '2.0s'],
              [935, 84, 1.7, '0.5s'],
              [970, 148, 1.3, '1.6s'],
              [64, 185, 1.4, '2.2s'],
              [725, 68, 1.5, '0.9s'],
            ].map(([sx, sy, sr, delay], idx) => (
              <circle
                key={idx}
                cx={Number(sx)}
                cy={Number(sy)}
                r={Number(sr)}
                fill="#f8fafc"
                className="sky-star"
                style={{ animationDelay: String(delay) }}
              />
            ))}
            <g transform="translate(135, 125)">
              <circle cx="0" cy="0" r="46" fill="rgba(253, 224, 71, 0.1)" />
              <circle cx="0" cy="0" r="30" fill="rgba(253, 224, 71, 0.2)" />
              <circle cx="0" cy="0" r="20" fill="#fef08a" />
              <circle cx="-6" cy="-4" r="3.2" fill="#fde047" opacity="0.65" />
              <circle cx="6" cy="5" r="4.2" fill="#fde047" opacity="0.55" />
              <circle cx="3" cy="-7" r="2.2" fill="#fde047" opacity="0.55" />
            </g>
          </g>
        ) : (
          <g style={{ pointerEvents: 'none' }}>
            <g transform="translate(135, 125)">
              <circle cx="0" cy="0" r="46" fill="rgba(251, 191, 36, 0.14)" />
              <circle cx="0" cy="0" r="28" fill="rgba(251, 191, 36, 0.24)" />
              <circle cx="0" cy="0" r="18" fill="#fbbf24" />
            </g>
            <g className="sky-cloud" opacity="0.7" fill="#ffffff">
              <ellipse cx="215" cy="114" rx="28" ry="10" />
              <ellipse cx="230" cy="109" rx="18" ry="11" />
              <ellipse cx="855" cy="112" rx="32" ry="10" />
              <ellipse cx="872" cy="106" rx="20" ry="11" />
            </g>
          </g>
        )}

        {/* ==================== MAIN CAMERA GROUP ==================== */}
        <g style={cameraStyle}>
          {/* 1. DIRECTIONAL GROUND & BUILDING DROP SHADOWS */}
          <polygon
            points={pts([
              iso(-98, -214, -18),
              iso(512, -214, -18),
              iso(575, 242, -18),
              iso(-98, 242, -18),
            ])}
            fill={isDark ? 'rgba(2, 6, 23, 0.65)' : 'rgba(15, 23, 42, 0.18)'}
          />
          <polygon
            points={pts([
              iso(450, -15, 0),
              iso(605, 42, 0),
              iso(595, 238, 0),
              iso(450, 180, 0),
            ])}
            fill={isDark ? 'rgba(2, 6, 23, 0.5)' : 'rgba(15, 23, 42, 0.2)'}
          />

          {/* 2. TILED WARM BEIGE SIDEWALK PLAZA BASE */}
          <g>
            <polygon
              points={pts([
                iso(-95, -105, 0),
                iso(505, -105, 0),
                iso(505, 225, 0),
                iso(-95, 225, 0),
              ])}
              fill="url(#plazaStoneGrad)"
              stroke={isDark ? '#475569' : '#b8a38e'}
              strokeWidth="1"
            />
            <polygon
              points={pts([
                iso(505, -105, 0),
                iso(505, 225, 0),
                iso(505, 225, -14),
                iso(505, -105, -14),
              ])}
              fill={isDark ? '#1e293b' : '#8c7d70'}
            />
            <polygon
              points={pts([
                iso(-95, -105, 0),
                iso(-95, 225, 0),
                iso(-95, 225, -14),
                iso(-95, -105, -14),
              ])}
              fill={isDark ? '#334155' : '#b5a392'}
            />
            <polygon
              points={pts([
                iso(-95, -105, 0),
                iso(505, -105, 0),
                iso(505, -105, -5),
                iso(-95, -105, -5),
              ])}
              fill={isDark ? '#475569' : '#c9b8a7'}
            />

            {[-60, -20, 20, 60, 100, 140, 180, 220, 260, 300, 340, 380, 420, 460].map((tx) => {
              const [u1, v1] = iso(tx, -105, 0.2);
              const [u2, v2] = iso(tx, 225, 0.2);
              return (
                <line
                  key={`tile-x-${tx}`}
                  x1={u1}
                  y1={v1}
                  x2={u2}
                  y2={v2}
                  stroke={isDark ? 'rgba(148,163,184,0.1)' : 'rgba(120,95,72,0.18)'}
                  strokeWidth="0.7"
                />
              );
            })}
            {[-85, -60, -35, -12, 20, 60, 100, 140, 185].map((ty) => {
              const [u1, v1] = iso(-95, ty, 0.2);
              const [u2, v2] = iso(505, ty, 0.2);
              return (
                <line
                  key={`tile-y-${ty}`}
                  x1={u1}
                  y1={v1}
                  x2={u2}
                  y2={v2}
                  stroke={isDark ? 'rgba(148,163,184,0.1)' : 'rgba(120,95,72,0.18)'}
                  strokeWidth="0.7"
                />
              );
            })}

            <polygon
              points={pts([
                iso(450, 0, 0.4),
                iso(505, 0, 0.4),
                iso(505, 225, 0.4),
                iso(450, 225, 0.4),
              ])}
              fill={isDark ? 'rgba(2, 6, 23, 0.45)' : 'rgba(15, 23, 42, 0.16)'}
            />
          </g>

          {/* 3. ASPHALT ROAD & LANE MARKINGS */}
          <g>
            <polygon
              points={pts([
                iso(-95, -210, -5),
                iso(505, -210, -5),
                iso(505, -105, -5),
                iso(-95, -105, -5),
              ])}
              fill="url(#asphaltRoadGrad)"
              stroke={isDark ? '#334155' : '#64748b'}
              strokeWidth="0.8"
            />
            <polygon
              points={pts([
                iso(-95, -210, -5),
                iso(-95, -105, -5),
                iso(-95, -105, -16),
                iso(-95, -210, -16),
              ])}
              fill={isDark ? '#334155' : '#94a3b8'}
            />
            <polygon
              points={pts([
                iso(-95, -210, -5),
                iso(505, -210, -5),
                iso(505, -210, -16),
                iso(-95, -210, -16),
              ])}
              fill={isDark ? '#1e293b' : '#64748b'}
            />
            <polygon
              points={pts([
                iso(505, -210, -5),
                iso(505, -105, -5),
                iso(505, -105, -16),
                iso(505, -210, -16),
              ])}
              fill={isDark ? '#0f172a' : '#475569'}
            />

            {(() => {
              const [u1, v1] = iso(-92, -112, -4.6);
              const [u2, v2] = iso(502, -112, -4.6);
              return (
                <line
                  x1={u1}
                  y1={v1}
                  x2={u2}
                  y2={v2}
                  stroke="#eab308"
                  strokeWidth="1.6"
                  opacity="0.9"
                />
              );
            })()}

            {[-72, 12, 96, 180, 264, 348, 432].map((dx) => {
              const [u1, v1] = iso(dx, -158, -4.6);
              const [u2, v2] = iso(dx + 44, -158, -4.6);
              return (
                <line
                  key={`dash-${dx}`}
                  x1={u1}
                  y1={v1}
                  x2={u2}
                  y2={v2}
                  stroke="#f8fafc"
                  strokeWidth="2.8"
                  strokeLinecap="square"
                  opacity="0.92"
                />
              );
            })}
          </g>

          {/* 4. LAYERED BUILDING FLOORS */}
          {floorsBottomToTop.map((floor, fIdx) => {
            const z0 = fIdx * FLOOR_H;
            const z1 = (fIdx + 1) * FLOOR_H;
            const isFloorHovered = hoveredFloorId === floor.id;
            const isFloorWorking = floor.isWorking;
            const isFloorError = floor.isError;
            const isGround = fIdx === 0;

            return (
              <g
                key={floor.id}
                data-floor-interactive="true"
                onMouseEnter={() => setHoveredFloorId(floor.id)}
                onMouseLeave={() =>
                  setHoveredFloorId((prev) => (prev === floor.id ? null : prev))
                }
                onClick={() => triggerEnterFloor(floor.id)}
                style={{ cursor: 'pointer' }}
              >
                <polygon
                  points={pts([
                    iso(4, 0, z0),
                    iso(TOTAL_X, 0, z0),
                    iso(TOTAL_X, TOTAL_Y, z0),
                    iso(4, TOTAL_Y, z0),
                  ])}
                  fill={
                    isFloorError
                      ? 'rgba(153, 27, 27, 0.72)'
                      : isGround
                      ? '#fde68a'
                      : isDark
                      ? '#1e293b'
                      : '#334155'
                  }
                />

                {/* Center Curtain Wall Bay */}
                <polygon
                  points={pts([
                    iso(116, 0, z0 + 2),
                    iso(288, 0, z0 + 2),
                    iso(288, 0, z1 - 2),
                    iso(116, 0, z1 - 2),
                  ])}
                  fill={isGround ? 'url(#warmLobbyGlow)' : 'url(#roomBackWall)'}
                />
                <polygon
                  points={pts([
                    iso(118, 0, z0 + 2),
                    iso(286, 0, z0 + 2),
                    iso(286, 0, z0 + 16),
                    iso(118, 0, z0 + 16),
                  ])}
                  fill="#fbbf24"
                  opacity={isDark ? 0.45 : 0.32}
                />

                {[132, 174, 216, 252].map((dx, dIdx) => {
                  const [du, dv] = iso(dx, 0, z0 + 12);
                  const agColor =
                    floor.agentColors[dIdx % Math.max(1, floor.agentColors.length)] || floor.color;
                  return renderRealisticWorkstation(
                    `cw-ws-${fIdx}-${dIdx}`,
                    du,
                    dv,
                    FLOOR_H,
                    false,
                    isFloorWorking,
                    dIdx === fIdx % 3,
                    agColor,
                    isDark
                  );
                })}

                {!isGround && (
                  <polygon
                    points={pts([
                      iso(116, 0, z0 + 2),
                      iso(288, 0, z0 + 2),
                      iso(288, 0, z1 - 2),
                      iso(116, 0, z1 - 2),
                    ])}
                    fill="url(#blueGlassVeil)"
                  />
                )}

                {/* Right-Side Vertical Glass Bay */}
                {!isGround && (
                  <g style={{ pointerEvents: 'none' }}>
                    <polygon
                      points={pts([
                        iso(436, 4, z0 + 2),
                        iso(436, 68, z0 + 2),
                        iso(436, 68, z1 - 2),
                        iso(436, 4, z1 - 2),
                      ])}
                      fill="url(#roomBackWall)"
                    />
                    <polygon
                      points={pts([
                        iso(436, 6, z0 + 2),
                        iso(436, 66, z0 + 2),
                        iso(436, 66, z0 + 16),
                        iso(436, 6, z0 + 16),
                      ])}
                      fill="#fbbf24"
                      opacity={isDark ? 0.5 : 0.36}
                    />
                    {[14, 38].map((dy, rIdx) => {
                      const [ru, rv] = iso(436, dy, z0 + 12);
                      return renderRealisticWorkstation(
                        `rw-ws-${fIdx}-${rIdx}`,
                        ru,
                        rv,
                        FLOOR_H,
                        true,
                        isFloorWorking,
                        rIdx === 0 && fIdx % 2 === 1,
                        floor.color,
                        isDark
                      );
                    })}
                    <polygon
                      points={pts([
                        iso(436, 4, z0 + 2),
                        iso(436, 68, z0 + 2),
                        iso(436, 68, z1 - 2),
                        iso(436, 4, z1 - 2),
                      ])}
                      fill="url(#blueGlassVeil)"
                    />
                  </g>
                )}

                {/* Error Floor Darker Crimson Red Illumination Overlay */}
                {isFloorError && (
                  <g className="sky-error-pulse" style={{ pointerEvents: 'none' }}>
                    <polygon
                      points={pts([
                        iso(4, 0, z0 + 2),
                        iso(TOTAL_X, 0, z0 + 2),
                        iso(TOTAL_X, 0, z1 - 2),
                        iso(4, 0, z1 - 2),
                      ])}
                      fill="rgba(185, 28, 28, 0.68)"
                      stroke="#dc2626"
                      strokeWidth="2.2"
                    />
                    <polygon
                      points={pts([
                        iso(TOTAL_X, 0, z0 + 2),
                        iso(TOTAL_X, TOTAL_Y, z0 + 2),
                        iso(TOTAL_X, TOTAL_Y, z1 - 2),
                        iso(TOTAL_X, 0, z1 - 2),
                      ])}
                      fill="rgba(153, 27, 27, 0.62)"
                      stroke="#dc2626"
                      strokeWidth="2.2"
                    />
                    <polyline
                      points={pts([
                        iso(0, -4, z0 + 2),
                        iso(TOTAL_X, -4, z0 + 2),
                        iso(TOTAL_X, TOTAL_Y, z0 + 2),
                      ])}
                      fill="none"
                      stroke="#991b1b"
                      strokeWidth="4.5"
                      strokeLinecap="round"
                    />
                  </g>
                )}

                {/* Hover Highlight Outline */}
                {isFloorHovered && (
                  <g style={{ pointerEvents: 'none' }}>
                    <polygon
                      points={pts([
                        iso(116, -1, z0 + 1),
                        iso(288, -1, z0 + 1),
                        iso(288, -1, z1 - 1),
                        iso(116, -1, z1 - 1),
                      ])}
                      fill="rgba(56, 189, 248, 0.22)"
                      stroke="#38bdf8"
                      strokeWidth="2.2"
                    />
                    <polygon
                      points={pts([
                        iso(436, 4, z0 + 1),
                        iso(436, 68, z0 + 1),
                        iso(436, 68, z1 - 1),
                        iso(436, 4, z1 - 1),
                      ])}
                      fill="rgba(56, 189, 248, 0.22)"
                      stroke="#38bdf8"
                      strokeWidth="2.2"
                    />
                  </g>
                )}

                {/* Active Floor Bottom-Edge Flowing Line (#720075 darkened with deep outer contrast) */}
                {isFloorWorking && (
                  <g style={{ pointerEvents: 'none' }}>
                    <polyline
                      points={pts([
                        iso(0, -4, z0 + 2),
                        iso(TOTAL_X, -4, z0 + 2),
                        iso(TOTAL_X, TOTAL_Y, z0 + 2),
                      ])}
                      fill="none"
                      stroke="#3b003d"
                      strokeWidth="8.5"
                      strokeOpacity="0.65"
                      strokeLinecap="round"
                    />
                    <polyline
                      points={pts([
                        iso(0, -4, z0 + 2),
                        iso(TOTAL_X, -4, z0 + 2),
                        iso(TOTAL_X, TOTAL_Y, z0 + 2),
                      ])}
                      fill="none"
                      stroke={activeHighlightColor}
                      strokeWidth="4.4"
                      strokeLinecap="round"
                      className="sky-active-edge"
                    />
                  </g>
                )}
              </g>
            );
          })}

          {/* 5. GROUND FLOOR STOREFRONTS, INTERIOR WORKSTATIONS, MULLIONS & POTTED PLANTS */}
          <g style={{ pointerEvents: 'none' }}>
            <polygon
              points={pts([iso(6, 0, 0), iso(106, 0, 0), iso(106, 0, 78), iso(6, 0, 78)])}
              fill="url(#warmLobbyGlow)"
              stroke="#0f172a"
              strokeWidth="2.2"
            />
            {[22, 62].map((lx, idx) => {
              const [lu, lv] = iso(lx, 0, 12);
              return renderRealisticWorkstation(`gf-l-ws-${idx}`, lu, lv, 68, false, false, false, '#2563eb', isDark);
            })}
            {[30, 55, 80].map((mx) => {
              const [u1, v1] = iso(mx, 0, 0);
              const [u2, v2] = iso(mx, 0, 78);
              return <line key={`lf-m-${mx}`} x1={u1} y1={v1} x2={u2} y2={v2} stroke="#0f172a" strokeWidth="1.8" />;
            })}

            <polygon
              points={pts([iso(4, 0, 78), iso(108, 0, 78), iso(108, 0, 142), iso(4, 0, 142)])}
              fill="url(#roomBackWall)"
            />
            {[18, 56].map((lx, idx) => {
              const [lu, lv] = iso(lx, 0, 90);
              return renderRealisticWorkstation(`f1-l-ws-${idx}`, lu, lv, 60, false, false, false, '#2563eb', isDark);
            })}
            <polygon
              points={pts([iso(4, 0, 78), iso(108, 0, 78), iso(108, 0, 142), iso(4, 0, 142)])}
              fill="url(#blueGlassVeil)"
              stroke="#0f172a"
              strokeWidth="1.8"
            />
            {[28, 54, 80].map((mx) => {
              const [u1, v1] = iso(mx, 0, 78);
              const [u2, v2] = iso(mx, 0, 142);
              return <line key={`lf-u1-${mx}`} x1={u1} y1={v1} x2={u2} y2={v2} stroke="#0f172a" strokeWidth="1.4" />;
            })}

            <polygon
              points={pts([iso(146, 0, 70), iso(282, 0, 70), iso(282, 0, 90), iso(146, 0, 90)])}
              fill="#1e293b"
            />
            <polygon
              points={pts([iso(152, 0, 0), iso(274, 0, 0), iso(274, 0, 70), iso(152, 0, 70)])}
              fill="url(#warmLobbyGlow)"
              stroke="#0f172a"
              strokeWidth="2.2"
            />
            {[168, 220].map((cx, idx) => {
              const [cu, cv] = iso(cx, 0, 12);
              return renderRealisticWorkstation(`gf-c-ws-${idx}`, cu, cv, 64, false, false, false, '#2563eb', isDark);
            })}
            {[182, 212, 242].map((mx) => {
              const [u1, v1] = iso(mx, 0, 0);
              const [u2, v2] = iso(mx, 0, 70);
              return <line key={`cf-m-${mx}`} x1={u1} y1={v1} x2={u2} y2={v2} stroke="#0f172a" strokeWidth="2" />;
            })}
            {(() => {
              const [u1, v1] = iso(152, 0, 50);
              const [u2, v2] = iso(274, 0, 50);
              return <line x1={u1} y1={v1} x2={u2} y2={v2} stroke="#0f172a" strokeWidth="1.6" />;
            })()}

            <polygon
              points={pts([iso(292, -4, 0), iso(412, -4, 0), iso(412, -4, 68), iso(292, -4, 68)])}
              fill="url(#warmLobbyGlow)"
              stroke="#0f172a"
              strokeWidth="2.4"
            />
            {[308, 358].map((ex, idx) => {
              const [eu, ev] = iso(ex, -4, 12);
              return renderRealisticWorkstation(`gf-e-ws-${idx}`, eu, ev, 62, false, false, false, '#2563eb', isDark);
            })}
            {[322, 352, 382].map((mx) => {
              const [u1, v1] = iso(mx, -4, 0);
              const [u2, v2] = iso(mx, -4, 68);
              return <line key={`en-m-${mx}`} x1={u1} y1={v1} x2={u2} y2={v2} stroke="#0f172a" strokeWidth="2.2" />;
            })}
            {(() => {
              const [u1, v1] = iso(292, -4, 48);
              const [u2, v2] = iso(412, -4, 48);
              return <line x1={u1} y1={v1} x2={u2} y2={v2} stroke="#0f172a" strokeWidth="1.8" />;
            })()}
            <polygon
              points={pts([
                iso(260, -10, 0),
                iso(286, -10, 0),
                iso(306, -16, 102),
                iso(280, -16, 102),
              ])}
              fill="url(#whiteBevelShade)"
              stroke="#94a3b8"
              strokeWidth="0.9"
            />

            <polygon
              points={pts([
                iso(450, 18, 0),
                iso(450, 162, 0),
                iso(450, 162, 92),
                iso(450, 18, 92),
              ])}
              fill="#1e293b"
            />
            <polygon
              points={pts([
                iso(450, 32, 0),
                iso(450, 146, 0),
                iso(450, 146, 74),
                iso(450, 32, 74),
              ])}
              fill="url(#warmLobbyGlow)"
              stroke="#0f172a"
              strokeWidth="2.2"
            />
            {[46, 92].map((ry, idx) => {
              const [ru, rv] = iso(450, ry, 12);
              return renderRealisticWorkstation(`gf-r-ws-${idx}`, ru, rv, 64, true, false, false, '#2563eb', isDark);
            })}
            {[60, 88, 116].map((my) => {
              const [u1, v1] = iso(450, my, 0);
              const [u2, v2] = iso(450, my, 74);
              return <line key={`rf-m-${my}`} x1={u1} y1={v1} x2={u2} y2={v2} stroke="#0f172a" strokeWidth="2" />;
            })}

            {[156, 250].map((px, idx) => {
              const [pu, pv] = iso(px, -8, 0);
              return (
                <g key={`pot-plant-${idx}`}>
                  <polygon
                    points={`${pu - 5},${pv} ${pu + 5},${pv} ${pu + 6},${pv - 11} ${pu - 6},${pv - 11}`}
                    fill="#0f172a"
                  />
                  <circle cx={pu} cy={pv - 16} r="7" fill="#365314" />
                  <circle cx={pu - 3} cy={pv - 19} r="5.5" fill="#4d7c0f" />
                  <circle cx={pu + 3} cy={pv - 18} r="5" fill="#65a30d" />
                  <circle cx={pu - 1} cy={pv - 22} r="4" fill="#84cc16" />
                </g>
              );
            })}
          </g>

          {/* 6. LARGE BLUE-TINTED GLASS CURTAIN WALL MULLIONS, SPANDRELS & SKY REFLECTIONS */}
          <g style={{ pointerEvents: 'none' }}>
            <polygon
              points={pts([
                iso(116, 0, 398),
                iso(288, 0, 398),
                iso(116, 0, 472),
              ])}
              fill="url(#blueGlassCurtain)"
              stroke="#0f172a"
              strokeWidth="1.8"
            />
            <polygon
              points={pts([
                iso(128, 0, 110),
                iso(168, 0, 110),
                iso(232, 0, 415),
                iso(192, 0, 415),
              ])}
              fill="rgba(186, 230, 253, 0.22)"
            />
            <polygon
              points={pts([
                iso(182, 0, 110),
                iso(198, 0, 110),
                iso(258, 0, 398),
                iso(242, 0, 398),
              ])}
              fill="rgba(224, 242, 254, 0.16)"
            />

            {[152, 188, 224, 260].map((mx) => {
              const topZ = 472 - ((mx - 116) / (288 - 116)) * 74;
              const [u1, v1] = iso(mx, 0, 88);
              const [u2, v2] = iso(mx, 0, topZ);
              return (
                <line
                  key={`atrium-mullion-${mx}`}
                  x1={u1}
                  y1={v1}
                  x2={u2}
                  y2={v2}
                  stroke="#0f172a"
                  strokeWidth="2"
                />
              );
            })}
            {floorLines.map((mz) => {
              const [u1, v1] = iso(116, 0, mz);
              const [u2, v2] = iso(288, 0, mz);
              return (
                <g key={`atrium-spandrel-${mz}`}>
                  <line x1={u1} y1={v1} x2={u2} y2={v2} stroke="#0f172a" strokeWidth="4.2" />
                  <line x1={u1} y1={v1 - 1.5} x2={u2} y2={v2 - 1.5} stroke="#334155" strokeWidth="1" />
                </g>
              );
            })}
          </g>

          {/* 7. CLEANER ROOFTOP DECK, PARAPET COPING & TWO 3D HVAC CHILLER UNITS */}
          <g style={{ pointerEvents: 'none' }}>
            <polygon
              points={pts([
                iso(82, 12, TOTAL_Z),
                iso(442, 12, TOTAL_Z),
                iso(442, 174, TOTAL_Z),
                iso(82, 174, TOTAL_Z),
              ])}
              fill={isDark ? '#1e293b' : '#3b4759'}
              stroke="#cbd5e1"
              strokeWidth="2"
            />
            <polygon
              points={pts([
                iso(82, 174, TOTAL_Z),
                iso(442, 174, TOTAL_Z),
                iso(442, 180, TOTAL_Z + 12),
                iso(82, 180, TOTAL_Z + 12),
              ])}
              fill="url(#whiteSunlit)"
              stroke="#94a3b8"
              strokeWidth="1"
            />
            <polygon
              points={pts([
                iso(442, 12, TOTAL_Z),
                iso(442, 174, TOTAL_Z),
                iso(450, 180, TOTAL_Z + 12),
                iso(450, 12, TOTAL_Z + 12),
              ])}
              fill="url(#whiteMidFacet)"
              stroke="#94a3b8"
              strokeWidth="1"
            />

            {cfg.showRoofChillers !== false && (
              <g>
                <polygon
                  points={pts([
                    iso(185, 95, TOTAL_Z),
                    iso(275, 95, TOTAL_Z),
                    iso(275, 95, TOTAL_Z + 44),
                    iso(185, 95, TOTAL_Z + 44),
                  ])}
                  fill={isDark ? '#94a3b8' : '#d5dfe9'}
                  stroke="#64748b"
                  strokeWidth="0.9"
                />
                <polygon
                  points={pts([
                    iso(192, 95, TOTAL_Z + 5),
                    iso(252, 95, TOTAL_Z + 5),
                    iso(252, 95, TOTAL_Z + 38),
                    iso(192, 95, TOTAL_Z + 38),
                  ])}
                  fill="#1e293b"
                />
                {[11, 17, 23, 29, 35].map((dz) => {
                  const [u1, v1] = iso(194, 95, TOTAL_Z + dz);
                  const [u2, v2] = iso(250, 95, TOTAL_Z + dz);
                  return <line key={`c1-l-${dz}`} x1={u1} y1={v1} x2={u2} y2={v2} stroke="#94a3b8" strokeWidth="0.9" />;
                })}
                <polygon
                  points={pts([
                    iso(275, 95, TOTAL_Z),
                    iso(275, 155, TOTAL_Z),
                    iso(275, 155, TOTAL_Z + 44),
                    iso(275, 95, TOTAL_Z + 44),
                  ])}
                  fill={isDark ? '#64748b' : '#94a3b8'}
                  stroke="#64748b"
                  strokeWidth="0.9"
                />
                <polygon
                  points={pts([
                    iso(185, 95, TOTAL_Z + 44),
                    iso(275, 95, TOTAL_Z + 44),
                    iso(275, 155, TOTAL_Z + 44),
                    iso(185, 155, TOTAL_Z + 44),
                  ])}
                  fill="#f8fafc"
                  stroke="#94a3b8"
                  strokeWidth="0.9"
                />

                <polygon
                  points={pts([
                    iso(295, 42, TOTAL_Z),
                    iso(398, 42, TOTAL_Z),
                    iso(398, 42, TOTAL_Z + 46),
                    iso(295, 42, TOTAL_Z + 46),
                  ])}
                  fill={isDark ? '#94a3b8' : '#d5dfe9'}
                  stroke="#64748b"
                  strokeWidth="0.9"
                />
                <polygon
                  points={pts([
                    iso(305, 42, TOTAL_Z + 6),
                    iso(388, 42, TOTAL_Z + 6),
                    iso(388, 42, TOTAL_Z + 38),
                    iso(305, 42, TOTAL_Z + 38),
                  ])}
                  fill="#1e293b"
                />
                {[12, 18, 24, 30, 35].map((dz) => {
                  const [u1, v1] = iso(307, 42, TOTAL_Z + dz);
                  const [u2, v2] = iso(386, 42, TOTAL_Z + dz);
                  return <line key={`c2-l-${dz}`} x1={u1} y1={v1} x2={u2} y2={v2} stroke="#94a3b8" strokeWidth="0.9" />;
                })}
                <polygon
                  points={pts([
                    iso(398, 42, TOTAL_Z),
                    iso(398, 112, TOTAL_Z),
                    iso(398, 112, TOTAL_Z + 46),
                    iso(398, 42, TOTAL_Z + 46),
                  ])}
                  fill={isDark ? '#64748b' : '#94a3b8'}
                  stroke="#64748b"
                  strokeWidth="0.9"
                />
                <polygon
                  points={pts([
                    iso(295, 42, TOTAL_Z + 46),
                    iso(398, 42, TOTAL_Z + 46),
                    iso(398, 112, TOTAL_Z + 46),
                    iso(295, 112, TOTAL_Z + 46),
                  ])}
                  fill="#f8fafc"
                  stroke="#94a3b8"
                  strokeWidth="0.9"
                />
                <polygon
                  points={pts([
                    iso(306, 50, TOTAL_Z + 46.5),
                    iso(346, 50, TOTAL_Z + 46.5),
                    iso(346, 104, TOTAL_Z + 46.5),
                    iso(306, 104, TOTAL_Z + 46.5),
                  ])}
                  fill="#0f172a"
                  stroke="#475569"
                  strokeWidth="0.6"
                />
                <polygon
                  points={pts([
                    iso(352, 50, TOTAL_Z + 46.5),
                    iso(390, 50, TOTAL_Z + 46.5),
                    iso(390, 104, TOTAL_Z + 46.5),
                    iso(352, 104, TOTAL_Z + 46.5),
                  ])}
                  fill="#0f172a"
                  stroke="#475569"
                  strokeWidth="0.6"
                />
              </g>
            )}

            {/* ROOFTOP STATUS SENSOR BEACON LIGHTS (Left: Green Active Agents · Right: Red Floor Alert) */}
            {(() => {
              const baseZ1 = cfg.showRoofChillers !== false ? TOTAL_Z + 44 : TOTAL_Z + 4;
              const baseZ2 = cfg.showRoofChillers !== false ? TOTAL_Z + 46 : TOTAL_Z + 4;
              const [gX, gY] = iso(206, 126, baseZ1);
              const [gTopX, gTopY] = iso(206, 126, baseZ1 + 14);
              const [rX, rY] = iso(374, 78, baseZ2);
              const [rTopX, rTopY] = iso(374, 78, baseZ2 + 14);
              const greenOn = anyFloorWorking;
              const redOn = anyFloorError;

              return (
                <g style={{ pointerEvents: 'none' }}>
                  {/* Green Agent-Working Sensor Mast & Dome (Unit 1) */}
                  <line x1={gX} y1={gY} x2={gTopX} y2={gTopY} stroke="#475569" strokeWidth="3.2" strokeLinecap="round" />
                  <ellipse cx={gX} cy={gY} rx="6" ry="2.6" fill="#334155" stroke="#64748b" strokeWidth="0.7" />
                  <circle
                    cx={gTopX}
                    cy={gTopY - 2}
                    r={greenOn ? 14 : 9}
                    fill={greenOn ? '#22c55e' : '#16a34a'}
                    opacity={greenOn ? 0.36 : 0.18}
                    className={greenOn ? 'sky-beacon-pulse' : undefined}
                  />
                  <circle
                    cx={gTopX}
                    cy={gTopY - 2}
                    r="5.2"
                    fill={greenOn ? '#22c55e' : '#15803d'}
                    stroke="#dcfce7"
                    strokeWidth="1.2"
                  >
                    <title>{greenOn ? 'Agents actively working' : 'System online · Agents ready'}</title>
                  </circle>

                  {/* Red Floor-Error Sensor Mast & Dome (Unit 2) */}
                  <line x1={rX} y1={rY} x2={rTopX} y2={rTopY} stroke="#475569" strokeWidth="3.2" strokeLinecap="round" />
                  <ellipse cx={rX} cy={rY} rx="6" ry="2.6" fill="#334155" stroke="#64748b" strokeWidth="0.7" />
                  {redOn && (
                    <circle
                      cx={rTopX}
                      cy={rTopY - 2}
                      r="16"
                      fill="#dc2626"
                      opacity="0.45"
                      className="sky-beacon-pulse"
                    />
                  )}
                  <circle
                    cx={rTopX}
                    cy={rTopY - 2}
                    r="5.2"
                    fill={redOn ? '#dc2626' : '#334155'}
                    stroke={redOn ? '#fee2e2' : '#64748b'}
                    strokeWidth="1.2"
                  >
                    <title>{redOn ? 'Floor error detected' : 'No floor errors'}</title>
                  </circle>
                </g>
              );
            })()}
          </g>

          {/* 8. FRONT-LEFT WHITE GEOMETRIC EXTERIOR PANELS & CLIPPED DARK DIAGONAL BEAMS */}
          <g style={{ pointerEvents: 'none' }} filter="url(#panelShadow)">
            <polygon
              points={pts([
                iso(116, -12, 475),
                iso(116, 0, 472),
                iso(150, 0, 86),
                iso(146, -12, 86),
              ])}
              fill="url(#whiteBevelShade)"
              stroke="#94a3b8"
              strokeWidth="1"
            />
            <polygon
              points={pts([
                iso(40, -12, 285),
                iso(116, -12, 475),
                iso(146, -12, 86),
                iso(40, -12, 225),
              ])}
              fill="url(#whiteSunlit)"
              stroke="#cbd5e1"
              strokeWidth="1"
            />
            <g clipPath="url(#clipLeftHighPeak)">
              {renderStructuralBeam('hp-b1', 35, -12, 405, 132, -12, 305, 8.5)}
              {renderStructuralBeam('hp-b2', 86, -12, 465, 110, -12, 275, 8)}
              {renderStructuralBeam('hp-b3', 42, -12, 345, 142, -12, 245, 6.5)}
            </g>

            <polygon
              points={pts([
                iso(0, -12, 142),
                iso(108, -12, 82),
                iso(108, -12, 295),
                iso(0, -12, 385),
              ])}
              fill="url(#whiteMidFacet)"
              stroke="#cbd5e1"
              strokeWidth="1"
            />
            <g clipPath="url(#clipLeftOuterWing)">
              {renderStructuralBeam('lw-b1', -6, -12, 335, 96, -12, 92, 9)}
              {renderStructuralBeam('lw-b2', 14, -12, 368, 114, -12, 118, 7.5)}
              {renderStructuralBeam('lw-b3', -6, -12, 175, 68, -12, 335, 7.5)}
              {renderStructuralBeam('lw-b4', 18, -12, 162, 106, -12, 86, 7)}
            </g>

            <polygon
              points={pts([
                iso(36, -11.5, 264),
                iso(118, -11.5, 264),
                iso(118, -11.5, 284),
                iso(36, -11.5, 284),
              ])}
              fill="url(#blueGlassCurtain)"
              stroke="#0f172a"
              strokeWidth="1.5"
            />

            <polygon
              points={pts([
                iso(18, -16, 365),
                iso(26, 0, 365),
                iso(152, 0, 0),
                iso(136, -16, 0),
              ])}
              fill="url(#whiteBevelShade)"
              stroke="#94a3b8"
              strokeWidth="0.9"
            />
            <polygon
              points={pts([
                iso(0, -16, 385),
                iso(18, -16, 365),
                iso(136, -16, 0),
                iso(112, -16, 0),
              ])}
              fill="url(#whiteSunlit)"
              stroke="#cbd5e1"
              strokeWidth="1"
            />
            {(() => {
              const [u1, v1] = iso(8, -16, 375);
              const [u2, v2] = iso(124, -16, 0);
              return <line x1={u1} y1={v1} x2={u2} y2={v2} stroke="#cbd5e1" strokeWidth="1" />;
            })()}
          </g>

          {/* 9. RIGHT-SIDE FACADE: VERTICAL BLUE GLASS BAY + WHITE GEOMETRIC X-BRACED WALL */}
          <g style={{ pointerEvents: 'none' }}>
            {[28, 48].map((my) => {
              const [u1, v1] = iso(436, my, 145);
              const [u2, v2] = iso(436, my, 412);
              return <line key={`rg-m-${my}`} x1={u1} y1={v1} x2={u2} y2={v2} stroke="#0f172a" strokeWidth="1.8" />;
            })}
            {floorLines.filter((mz) => mz > 150 && mz < 412).map((mz) => {
              const [u1, v1] = iso(436, 0, mz);
              const [u2, v2] = iso(436, 68, mz);
              return <line key={`rg-s-${mz}`} x1={u1} y1={v1} x2={u2} y2={v2} stroke="#0f172a" strokeWidth="3.6" />;
            })}

            <polygon
              points={pts([
                iso(412, -8, 0),
                iso(450, 0, 0),
                iso(450, 0, 218),
                iso(412, -8, 195),
              ])}
              fill="url(#whiteMidFacet)"
              stroke="#94a3b8"
              strokeWidth="0.9"
            />
            <polygon
              points={pts([
                iso(450, 0, 0),
                iso(450, 32, 0),
                iso(450, 56, 222),
                iso(450, 0, 218),
              ])}
              fill="url(#whiteRightWall)"
              stroke="#94a3b8"
              strokeWidth="0.9"
            />

            <polygon
              points={pts([
                iso(436, 56, 88),
                iso(450, 56, 88),
                iso(450, 56, 415),
                iso(436, 56, 415),
              ])}
              fill="url(#whiteSunlit)"
              stroke="#94a3b8"
              strokeWidth="0.9"
            />
            <polygon
              points={pts([
                iso(450, 56, 88),
                iso(450, 180, 88),
                iso(450, 180, 415),
                iso(450, 56, 415),
              ])}
              fill="url(#whiteRightWall)"
              stroke="#94a3b8"
              strokeWidth="1"
            />

            <g clipPath="url(#clipRightFacadeWall)">
              {renderStructuralBeam('rw-x1', 450, 48, 382, 450, 184, 196, 9.5)}
              {renderStructuralBeam('rw-x2', 450, 44, 96, 450, 176, 408, 9.5)}
            </g>

            {[
              [40, 166, 114, 138],
              [56, 180, 178, 202],
              [56, 180, 276, 304],
            ].map(([yA, yB, zA, zB], idx) => (
              <g key={`rw-ribbon-${idx}`}>
                <polygon
                  points={pts([
                    iso(450.2, yA, zA),
                    iso(450.2, yB, zA),
                    iso(450.2, yB, zB),
                    iso(450.2, yA, zB),
                  ])}
                  fill="url(#blueGlassCurtain)"
                  stroke="#0f172a"
                  strokeWidth="1.5"
                />
                {[88, 120, 152].map((my) => {
                  const [u1, v1] = iso(450.3, my, zA);
                  const [u2, v2] = iso(450.3, my, zB);
                  return <line key={`rw-m-${idx}-${my}`} x1={u1} y1={v1} x2={u2} y2={v2} stroke="#0f172a" strokeWidth="1.5" />;
                })}
              </g>
            ))}
          </g>

          {/* 10. CENTER-RIGHT CANTILEVERED WHITE GEOMETRIC POD + WIDESCREEN TV + CLEAN ENTRANCE CANOPY */}
          <g>
            <polygon
              points={pts([
                iso(172, 0, 244),
                iso(378, 0, 490),
                iso(296, 0, 168),
                iso(212, 0, 162),
              ])}
              fill={isDark ? 'rgba(2, 6, 23, 0.52)' : 'rgba(15, 23, 42, 0.34)'}
              style={{ pointerEvents: 'none' }}
            />

            <polygon
              points={pts([
                iso(180, -26, 258),
                iso(382, -26, 502),
                iso(386, 0, 492),
                iso(186, 0, 254),
              ])}
              fill="#ffffff"
              stroke="#cbd5e1"
              strokeWidth="1"
              style={{ pointerEvents: 'none' }}
            />
            <polygon
              points={pts([
                iso(382, -26, 502),
                iso(408, -26, 365),
                iso(408, -26, 212),
                iso(418, 0, 212),
                iso(418, 0, 368),
                iso(386, 0, 492),
              ])}
              fill="url(#whiteBevelShade)"
              stroke="#94a3b8"
              strokeWidth="1"
              style={{ pointerEvents: 'none' }}
            />

            <g filter="url(#panelShadow)" style={{ pointerEvents: 'none' }}>
              <polygon
                points={pts([
                  iso(180, -26, 258),
                  iso(382, -26, 502),
                  iso(310, -26, 290),
                  iso(222, -26, 175),
                ])}
                fill="url(#whiteSunlit)"
                stroke="#cbd5e1"
                strokeWidth="0.9"
              />
              <polygon
                points={pts([
                  iso(382, -26, 502),
                  iso(408, -26, 365),
                  iso(405, -26, 212),
                  iso(222, -26, 175),
                  iso(310, -26, 290),
                ])}
                fill="url(#whiteMidFacet)"
                stroke="#cbd5e1"
                strokeWidth="0.9"
              />
            </g>

            <g clipPath="url(#clipCenterDiamondPod)" style={{ pointerEvents: 'none' }}>
              {[
                [210, 285, 395, 385],
                [255, 345, 405, 295],
                [202, 218, 365, 445],
              ].map(([xA, zA, xB, zB], idx) => {
                const [u1, v1] = iso(xA, -26.1, zA);
                const [u2, v2] = iso(xB, -26.1, zB);
                return (
                  <line
                    key={`pod-seam-${idx}`}
                    x1={u1}
                    y1={v1}
                    x2={u2}
                    y2={v2}
                    stroke="rgba(148, 163, 184, 0.5)"
                    strokeWidth="0.8"
                  />
                );
              })}

              {renderStructuralBeam('cp-b1', 362, -26, 485, 238, -26, 168, 9.5)}
              {renderStructuralBeam('cp-b2', 392, -26, 472, 298, -26, 178, 8.5)}
              {renderStructuralBeam('cp-b3', 184, -26, 260, 348, -26, 188, 8.5)}
              {renderStructuralBeam('cp-b4', 216, -26, 316, 406, -26, 218, 8)}
              {renderStructuralBeam('cp-b5', 182, -26, 254, 378, -26, 338, 8)}
              {renderStructuralBeam('cp-b6', 282, -26, 244, 408, -26, 280, 7.5)}
            </g>

            <polygon
              points={pts([
                iso(222, -26, 114),
                iso(405, -26, 114),
                iso(415, 0, 108),
                iso(232, 0, 108),
              ])}
              fill="#475569"
              style={{ pointerEvents: 'none' }}
            />
            <polygon
              points={pts([
                iso(405, -26, 114),
                iso(415, 0, 108),
                iso(418, 0, 222),
                iso(405, -26, 222),
              ])}
              fill="url(#whiteBevelShade)"
              stroke="#94a3b8"
              strokeWidth="0.9"
              style={{ pointerEvents: 'none' }}
            />
            <polygon
              points={pts([
                iso(222, -26, 114),
                iso(405, -26, 114),
                iso(405, -26, 222),
                iso(222, -26, 185),
              ])}
              fill="url(#whiteRightWall)"
              stroke="#94a3b8"
              strokeWidth="1"
              style={{ pointerEvents: 'none' }}
            />

            {/* 10E. THE WIDESCREEN LED TV / BILLBOARD SCREEN — Perspective-Locked CSS skewY */}
            {cfg.showBillboard !== false && (
              <g>
                {/* 3D Dark Charcoal Bezel */}
                <polygon
                  points={pts([
                    iso(226, -26.5, 208),
                    iso(390, -26.5, 208),
                    iso(390, -26.5, 128),
                    iso(226, -26.5, 128),
                  ])}
                  fill="#0f172a"
                  stroke="#334155"
                  strokeWidth="1.6"
                />
                <polygon
                  points={pts([
                    iso(232, -27, 202),
                    iso(384, -27, 202),
                    iso(384, -27, 134),
                    iso(232, -27, 134),
                  ])}
                  fill="#1d4ed8"
                />

                {/* Base Blue & Red Diagonal LED Graphic */}
                <g clipPath="url(#tvScreenClip)">
                  <polygon
                    points={pts([
                      iso(230, -27, 204),
                      iso(298, -27, 204),
                      iso(242, -27, 132),
                      iso(230, -27, 132),
                    ])}
                    fill="#38bdf8"
                  />
                  <polygon
                    points={pts([
                      iso(298, -27, 204),
                      iso(358, -27, 204),
                      iso(285, -27, 132),
                      iso(242, -27, 132),
                    ])}
                    fill="#1e40af"
                  />
                  <polygon
                    points={pts([
                      iso(358, -27, 204),
                      iso(386, -27, 204),
                      iso(386, -27, 132),
                      iso(272, -27, 132),
                    ])}
                    fill="#ef4444"
                  />
                  <polygon
                    points={pts([
                      iso(338, -27, 204),
                      iso(362, -27, 204),
                      iso(296, -27, 132),
                      iso(272, -27, 132),
                    ])}
                    fill="#dc2626"
                    opacity="0.78"
                  />
                </g>

                {/* Muted YouTube Video Warped via CSS skewY to Match the Exact 3D Bezel */}
                {cfg.videoUrl && (
                  <foreignObject
                    x={tvTLx}
                    y={tvFoY}
                    width={tvParallelogramW}
                    height={tvFoHeight}
                    style={{ overflow: 'visible', pointerEvents: 'none' }}
                  >
                    <div
                      style={{
                        width: `${tvParallelogramW}px`,
                        height: `${tvParallelogramH}px`,
                        marginTop: tvSlopeDY < 0 ? `${-tvSlopeDY}px` : '0px',
                        transformOrigin: '0 0',
                        transform: `skewY(${tvSkewDeg}deg)`,
                        overflow: 'hidden',
                        background: '#000',
                        position: 'relative',
                      }}
                    >
                      {youtubeId ? (
                        <iframe
                          src={`https://www.youtube.com/embed/${youtubeId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${youtubeId}&modestbranding=1&playsinline=1&rel=0`}
                          title="Building Widescreen TV"
                          allow="autoplay; encrypted-media"
                          style={{
                            position: 'absolute',
                            top: '-18%',
                            left: '-18%',
                            width: '136%',
                            height: '136%',
                            border: 'none',
                            pointerEvents: 'none',
                          }}
                        />
                      ) : (
                        <video
                          src={cfg.videoUrl}
                          autoPlay
                          muted
                          loop
                          playsInline
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            pointerEvents: 'none',
                          }}
                        />
                      )}
                    </div>
                  </foreignObject>
                )}
              </g>
            )}

            {/* 10F. TALLER WHITE ENTRANCE CANOPY WITH CENTERED LOGO & OPTIONAL TEXT HIDING */}
            <g style={{ pointerEvents: 'none' }}>
              <polygon
                points={pts([
                  iso(418, -28, 60),
                  iso(422, -4, 58),
                  iso(422, -4, 112),
                  iso(418, -28, 114),
                ])}
                fill="url(#whiteBevelShade)"
                stroke="#94a3b8"
                strokeWidth="0.9"
              />
              <polygon
                points={pts([
                  iso(272, -28, 60),
                  iso(418, -28, 60),
                  iso(418, -28, 114),
                  iso(272, -28, 114),
                ])}
                fill="url(#whiteSunlit)"
                stroke="#cbd5e1"
                strokeWidth="1"
              />

              {/* Perspective-Aligned Canopy Sign inside <foreignObject> so Logo Centers Cleanly */}
              <foreignObject
                x={canTLx}
                y={canFoY}
                width={canParallelogramW}
                height={canFoHeight}
                style={{ overflow: 'visible', pointerEvents: 'none' }}
              >
                <div
                  style={{
                    width: `${canParallelogramW}px`,
                    height: `${canParallelogramH}px`,
                    marginTop: canSlopeDY < 0 ? `${-canSlopeDY}px` : '0px',
                    transformOrigin: '0 0',
                    transform: `skewY(${canSkewDeg}deg)`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    padding: '4px 12px',
                    overflow: 'hidden',
                    boxSizing: 'border-box',
                  }}
                >
                  {cfg.logoUrl ? (
                    <img
                      src={cfg.logoUrl}
                      alt={tenantName}
                      style={{
                        maxHeight: cfg.hideCanopyName ? '36px' : '28px',
                        maxWidth: cfg.hideCanopyName ? '118px' : '54px',
                        width: 'auto',
                        height: 'auto',
                        objectFit: 'contain',
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: cfg.hideCanopyName ? '28px' : '20px',
                        height: cfg.hideCanopyName ? '28px' : '20px',
                        borderRadius: '6px',
                        background: brandColor,
                        color: '#ffffff',
                        fontSize: cfg.hideCanopyName ? '14px' : '11.5px',
                        fontWeight: 900,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {tenantInitials}
                    </div>
                  )}
                  {!cfg.hideCanopyName && (
                    <span
                      style={{
                        color: '#0f172a',
                        fontSize: '12.5px',
                        fontWeight: 800,
                        fontFamily: 'Inter, system-ui, sans-serif',
                        letterSpacing: '-0.02em',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {shortBrandText}
                    </span>
                  )}
                </div>
              </foreignObject>
            </g>
          </g>

          {/* 11. STREET PLANTERS, HEDGES, LUSH TREES & BOLLARDS */}
          {cfg.showTrees !== false && (
            <g>
              {renderHedgePlanter('planter-front-1', -46, 36, -86, -54, 7, 13, isDark, iso)}
              {renderHedgePlanter('planter-front-2', 82, 148, -86, -56, 7, 12, isDark, iso)}
              {renderHedgePlanter('planter-front-3', 355, 452, -88, -54, 7, 14, isDark, iso)}

              {renderHedgePlanter('planter-right-1', 468, 494, -32, 36, 5, 9, isDark, iso)}
              {renderHedgePlanter('planter-right-2', 468, 494, 74, 158, 5, 11, isDark, iso)}

              {renderLushTree('tree-far-left', -6, -70, 1.32, isDark, iso)}
              {renderLushTree('tree-mid-left', 114, -70, 0.96, isDark, iso)}
              {renderLushTree('tree-front-corner', 432, -68, 0.98, isDark, iso)}
              {renderLushTree('tree-far-right', 482, 118, 1.26, isDark, iso)}
            </g>
          )}

          {cfg.showBollards !== false && (
            <g>
              {[
                [-82, -88],
                [-56, -94],
                [-12, -94],
                [46, -94],
                [72, -94],
                [158, -94],
                [215, -94],
                [272, -94],
                [335, -94],
                [402, -94],
                [470, -94],
              ].map(([bx, by], idx) => renderBollard(`bollard-${idx}`, bx, by, isDark, iso))}
            </g>
          )}

          {/* 12. PROPER IN-SCENE FLOOR HOVER BADGE (Appears right next to the hovered floor!) */}
          {hoveredFloor && !enteringOfficeId && hoveredFloorIdx >= 0 && (() => {
            const zMid = (hoveredFloorIdx + 0.5) * FLOOR_H;
            const [hu, hv] = iso(202, 0, zMid);
            return (
              <g style={{ pointerEvents: 'none' }}>
                <foreignObject
                  x={hu - 125}
                  y={hv - 24}
                  width={250}
                  height={52}
                  style={{ overflow: 'visible' }}
                >
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 12px',
                      borderRadius: '999px',
                      background: isDark ? 'rgba(15, 23, 42, 0.94)' : 'rgba(255, 255, 255, 0.96)',
                      border: `1.5px solid ${hoveredFloor.color}`,
                      boxShadow: '0 8px 24px rgba(2, 6, 23, 0.35)',
                      color: isDark ? '#f8fafc' : '#0f172a',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span
                      style={{
                        padding: '2px 7px',
                        borderRadius: '999px',
                        background: hoveredFloor.color,
                        color: '#ffffff',
                        fontSize: '10.5px',
                        fontWeight: 800,
                      }}
                    >
                      F{hoveredFloorNum}
                    </span>
                    <span style={{ fontSize: '12px', fontWeight: 800 }}>
                      {hoveredFloor.name}
                    </span>
                    <span style={{ fontSize: '10.5px', color: isDark ? '#94a3b8' : '#64748b' }}>
                      {floors && floors.length > 0
                        ? `· ${hoveredFloor.agentColors.length} agent${hoveredFloor.agentColors.length === 1 ? '' : 's'}${hoveredFloor.isWorking ? ' · at work' : ''} · Enter →`
                        : '· Enter →'}
                    </span>
                  </div>
                </foreignObject>
              </g>
            );
          })()}
        </g>
      </svg>

      {/* 3-Second 2.5D Isometric Glass Elevator Lobby Transition */}
      {enteringFloor && (
        <ElevatorTransition
          floorName={enteringFloor.name}
          floorIndex={enteringFloorIndex}
          totalFloors={totalFloors}
          floorColor={enteringFloor.color}
          isDark={isDark}
        />
      )}

      {/* Unified Bottom-Right Zoom, Rotate & Building Studio Control Dock */}
      <div
        style={{
          position: 'absolute',
          bottom: 18,
          right: 18,
          zIndex: 35,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 8px',
          borderRadius: 999,
          background: isDark ? 'rgba(15, 23, 42, 0.88)' : 'rgba(255, 255, 255, 0.94)',
          border: isDark ? '1px solid rgba(148, 163, 184, 0.24)' : '1px solid rgba(15, 23, 42, 0.12)',
          boxShadow: '0 10px 30px rgba(2, 6, 23, 0.28)',
          backdropFilter: 'blur(12px)',
          color: isDark ? '#f8fafc' : '#0f172a',
        }}
      >
        <button
          type="button"
          onClick={() => setYawDeg((y) => Math.max(-45, y - 10))}
          title="Rotate building left"
          style={{
            height: 28,
            padding: '0 9px',
            borderRadius: 999,
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          ⟲
        </button>
        <button
          type="button"
          onClick={() => setYawDeg((y) => Math.min(45, y + 10))}
          title="Rotate building right"
          style={{
            height: 28,
            padding: '0 9px',
            borderRadius: 999,
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          ⟳
        </button>

        <div style={{ width: 1, height: 16, background: isDark ? '#334155' : '#cbd5e1' }} />

        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.45, +(z - 0.12).toFixed(2)))}
          title="Zoom out (or use trackpad scroll)"
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: 'none',
            background: isDark ? '#1e293b' : '#f1f5f9',
            color: 'inherit',
            fontSize: 15,
            fontWeight: 800,
            cursor: 'pointer',
          }}
        >
          −
        </button>
        <span style={{ fontSize: 11.5, fontWeight: 700, minWidth: 38, textAlign: 'center' }}>
          {Math.round((zoom / DEFAULT_ZOOM) * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(2.2, +(z + 0.12).toFixed(2)))}
          title="Zoom in (or use trackpad scroll)"
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: 'none',
            background: isDark ? '#1e293b' : '#f1f5f9',
            color: 'inherit',
            fontSize: 15,
            fontWeight: 800,
            cursor: 'pointer',
          }}
        >
          +
        </button>

        <button
          type="button"
          onClick={() => {
            setZoom(DEFAULT_ZOOM);
            setPan({ x: 0, y: 0 });
            setYawDeg(DEFAULT_YAW);
            setPitchDeg(DEFAULT_PITCH);
          }}
          title="Reset camera"
          style={{
            height: 28,
            padding: '0 8px',
            borderRadius: 999,
            border: 'none',
            background: 'transparent',
            color: isDark ? '#94a3b8' : '#64748b',
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Reset
        </button>

        <div style={{ width: 1, height: 16, background: isDark ? '#334155' : '#cbd5e1' }} />

        {floorsBottomToTop.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const sampleId =
                floorsBottomToTop[Math.min(2, floorsBottomToTop.length - 1)]?.id ||
                floorsBottomToTop[0].id;
              setSimulatingRedFloorId((prev) => (prev === sampleId ? null : sampleId));
            }}
            title="Toggle sample red error floor illumination"
            style={{
              height: 28,
              padding: '0 10px',
              borderRadius: 999,
              border: 'none',
              background: simulatingRedFloorId ? 'rgba(185, 28, 28, 0.34)' : 'transparent',
              color: simulatingRedFloorId ? '#ef4444' : isDark ? '#cbd5e1' : '#475569',
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: simulatingRedFloorId ? '#dc2626' : '#94a3b8',
              }}
            />
            Error Sample
          </button>
        )}

        <button
          type="button"
          onClick={() => setCustomizeOpen((v) => !v)}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 999,
            border: 'none',
            background: customizeOpen ? brandColor : isDark ? '#1e293b' : '#e2e8f0',
            color: customizeOpen ? '#ffffff' : 'inherit',
            fontSize: 11.5,
            fontWeight: 700,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <Icon name="gear" size={12} />
          Edit Building
        </button>
      </div>
    </div>
  );
}

export default SkyscraperBuilding;
