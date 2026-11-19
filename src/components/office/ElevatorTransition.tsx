'use client';

import React, { useEffect, useState } from 'react';

export interface ElevatorTransitionProps {
  floorName: string;
  floorIndex: number; // 0-based bottom-to-top index
  totalFloors: number;
  floorColor: string;
  isDark: boolean;
}

type LiftPhase = 'approach' | 'boarding' | 'doorsClose' | 'ascending' | 'arrived';

/**
 * 3-Second First-Person POV Elevator Walkthrough (~3000ms synced with SkyscraperBuilding):
 *  - Act 1 (0.00s - 0.95s): Walk down ground-floor lobby toward elevator bank; chime & doors open for you; step inside
 *  - Act 2 (0.95s - 1.35s): Inside cabin looking out through glass doors as brushed-steel doors glide shut
 *  - Act 3 (1.35s - 2.30s): Ascent through glass shaft — floors rush downward outside while F1..FN counts up cleanly
 *  - Act 4 (2.30s - 3.00s): Arrived at target floor — doors part open onto the destination office & camera glides onto the floor
 */
export default function ElevatorTransition({
  floorName,
  floorIndex,
  totalFloors,
  floorColor,
  isDark,
}: ElevatorTransitionProps) {
  const targetFloorNum = Math.max(1, floorIndex + 1);
  const maxShown = Math.max(4, Math.min(8, totalFloors));
  const [phase, setPhase] = useState<LiftPhase>('approach');
  const [activeFloorNum, setActiveFloorNum] = useState(1);

  useEffect(() => {
    setPhase('approach');
    setActiveFloorNum(1);
    const timers: number[] = [];

    // Doors open as you walk up to the elevator bank
    timers.push(window.setTimeout(() => setPhase('boarding'), 260));

    // Inside cabin — doors close smoothly
    timers.push(window.setTimeout(() => setPhase('doorsClose'), 950));

    // Ascend shaft & tick floor display F1 -> Ftarget
    timers.push(window.setTimeout(() => setPhase('ascending'), 1350));

    if (targetFloorNum > 1) {
      const rideMs = 860;
      const stepMs = rideMs / (targetFloorNum - 1);
      for (let f = 2; f <= targetFloorNum; f++) {
        timers.push(
          window.setTimeout(() => setActiveFloorNum(f), Math.round(1380 + (f - 1) * stepMs))
        );
      }
    }

    // Arrive -> doors open onto destination office -> walk out
    timers.push(window.setTimeout(() => {
      setActiveFloorNum(targetFloorNum);
      setPhase('arrived');
    }, 2300));

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [targetFloorNum]);

  const doorsOpen = phase === 'boarding' || phase === 'arrived';
  const insideCabin = phase === 'doorsClose' || phase === 'ascending' || phase === 'arrived';
  const showDestinationBackdrop = phase === 'arrived';
  const showShaftBackdrop = phase === 'doorsClose' || phase === 'ascending';

  // Smooth camera zoom/walk transform across the 4 acts
  const cameraTransform =
    phase === 'approach'
      ? 'scale(0.94) translate3d(0px, 12px, 0px)'
      : phase === 'boarding'
        ? 'scale(1.12) translate3d(0px, 2px, 0px)'
        : phase === 'doorsClose'
          ? 'scale(1.14) translate3d(0px, 0px, 0px)'
          : phase === 'ascending'
            ? 'scale(1.14) translate3d(0px, -2px, 0px)'
            : 'scale(1.36) translate3d(0px, 0px, 0px)';

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 42,
        pointerEvents: 'none',
        overflow: 'hidden',
        background: isDark ? '#050912' : '#d5dfed',
        animation: 'liftOverlayIn 0.22s ease-out forwards',
      }}
    >
      <style>{`
        @keyframes liftOverlayIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes liftWalkBob {
          0%, 100% { transform: translateY(0px) rotate(0deg); }
          25% { transform: translateY(-4px) rotate(-0.35deg); }
          50% { transform: translateY(1.5px) rotate(0deg); }
          75% { transform: translateY(-3.5px) rotate(0.35deg); }
        }
        @keyframes liftAscentVib {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-1.5px); }
        }
        @keyframes liftShaftScroll {
          0% { transform: translateY(-320px); }
          100% { transform: translateY(160px); }
        }
        @keyframes liftExitFade {
          0%, 84% { opacity: 1; }
          100% { opacity: 0.12; }
        }
        .lift-cam-dolly {
          width: 100%;
          height: 100%;
          transform-origin: 50% 52%;
          transition: transform 0.65s cubic-bezier(0.22, 0.78, 0.25, 1);
          animation: liftExitFade 3.0s ease-in forwards;
        }
        .lift-cam-bob {
          width: 100%;
          height: 100%;
          animation: liftWalkBob 0.56s ease-in-out infinite;
        }
        .lift-cam-ride {
          width: 100%;
          height: 100%;
          animation: liftAscentVib 0.18s linear infinite;
        }
        .lift-shaft-loop {
          animation: liftShaftScroll 0.72s linear infinite;
        }
      `}</style>

      {/* Master First-Person Camera Rig */}
      <div className="lift-cam-dolly" style={{ transform: cameraTransform }}>
        <div
          className={
            phase === 'approach' || phase === 'boarding' || phase === 'arrived'
              ? 'lift-cam-bob'
              : 'lift-cam-ride'
          }
          style={{ position: 'relative', width: '100%', height: '100%' }}
        >
          {/* =================================================================
              LAYER 1: VIEW THROUGH THE ELEVATOR PORTAL
              - Act 1 (approach / boarding): Warm interior cabin waiting inside
              - Act 2 & 3 (doorsClose / ascending): Panoramic glass shaft + rising floor slabs
              - Act 4 (arrived): Destination office lobby with desks & glass walls
             ================================================================= */}
          <div
            style={{
              position: 'absolute',
              inset: '11% 24% 10% 24%',
              overflow: 'hidden',
              borderRadius: 6,
              background: showShaftBackdrop
                ? '#070e1c'
                : isDark
                  ? '#0e172a'
                  : '#eef3fa',
            }}
          >
            <svg viewBox="0 0 600 520" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
              <defs>
                <linearGradient id="cabinWallL" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor={isDark ? '#1e293b' : '#475569'} />
                  <stop offset="100%" stopColor={isDark ? '#0f172a' : '#334155'} />
                </linearGradient>
                <linearGradient id="cabinWallR" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor={isDark ? '#0f172a' : '#334155'} />
                  <stop offset="100%" stopColor={isDark ? '#1e293b' : '#475569'} />
                </linearGradient>
                <linearGradient id="oakFloor" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={isDark ? '#5c3c20' : '#cfa87e'} />
                  <stop offset="100%" stopColor={isDark ? '#3a2412' : '#b2875c'} />
                </linearGradient>
              </defs>

              {/* ACT 1 VIEW (Looking into waiting cabin from ground lobby) */}
              {!showShaftBackdrop && !showDestinationBackdrop && (
                <g>
                  {/* Cabin ceiling & recessed warm LED bar */}
                  <polygon points="0,0 600,0 490,92 110,92" fill={isDark ? '#162033' : '#e2e8f0'} />
                  <polygon points="180,30 420,30 400,56 200,56" fill="#fef08a" opacity="0.92" />
                  {/* Left & Right interior steel cabin walls */}
                  <polygon points="0,0 110,92 110,415 0,520" fill="url(#cabinWallL)" />
                  <polygon points="600,0 490,92 490,415 600,520" fill="url(#cabinWallR)" />
                  {/* Cabin warm wood/stone floor */}
                  <polygon points="0,520 110,415 490,415 600,520" fill="url(#oakFloor)" />
                  {/* Brushed back cabin panel + panoramic rear slit window */}
                  <rect x="110" y="92" width="380" height="323" fill={isDark ? '#0f172a' : '#1e293b'} />
                  <rect
                    x="150"
                    y="122"
                    width="300"
                    height="195"
                    rx="6"
                    fill={isDark ? '#172554' : '#bae6fd'}
                    fillOpacity="0.34"
                    stroke="#64748b"
                    strokeWidth="3"
                  />
                  {/* Rear handrail */}
                  <line x1="145" y1="348" x2="455" y2="348" stroke="#cbd5e1" strokeWidth="9" strokeLinecap="round" />
                  <line x1="145" y1="346" x2="455" y2="346" stroke="#ffffff" strokeWidth="2.5" opacity="0.65" />
                </g>
              )}

              {/* ACT 2 & 3 VIEW (Inside cabin looking through closed glass doors as shaft floors pass downward) */}
              {showShaftBackdrop && (
                <g>
                  <rect x="0" y="0" width="600" height="520" fill="#060d1b" />
                  {/* Vertical shaft guide rails */}
                  <rect x="34" y="0" width="12" height="520" fill="#1e293b" />
                  <rect x="554" y="0" width="12" height="520" fill="#1e293b" />
                  <line x1="46" y1="0" x2="46" y2="520" stroke="#475569" strokeWidth="2" />
                  <line x1="554" y1="0" x2="554" y2="520" stroke="#475569" strokeWidth="2" />

                  {/* Scrolling concrete & glass floor levels rushing down as cabin rises */}
                  <g className={phase === 'ascending' ? 'lift-shaft-loop' : undefined}>
                    {[-160, 0, 160, 320, 480].map((sy, idx) => (
                      <g key={sy}>
                        {/* Glowing atrium office window band */}
                        <rect
                          x="48"
                          y={sy + 26}
                          width="504"
                          height="108"
                          fill={idx % 2 === 0 ? '#172554' : '#1e3a5f'}
                          opacity="0.58"
                        />
                        {/* Interior warm office glow strips seen through glass */}
                        <rect x="85" y={sy + 48} width="190" height="14" rx="4" fill="#fef08a" opacity="0.34" />
                        <rect x="325" y={sy + 48} width="190" height="14" rx="4" fill="#fef08a" opacity="0.34" />
                        {/* Structural floor slab edge */}
                        <rect x="30" y={sy} width="540" height="26" fill="#0f172a" stroke="#334155" strokeWidth="2" />
                        <line x1="48" y1={sy + 2} x2="552" y2={sy + 2} stroke={floorColor} strokeWidth="2.5" opacity="0.65" />
                      </g>
                    ))}
                  </g>
                </g>
              )}

              {/* ACT 4 VIEW (Arrived at destination floor — doors glide open onto office corridor & desks) */}
              {showDestinationBackdrop && (
                <g>
                  {/* Office ceiling + linear warm light fixtures */}
                  <polygon points="0,0 600,0 475,115 125,115" fill={isDark ? '#1e293b' : '#f1f5f9'} />
                  <polygon points="180,24 420,24 395,52 205,52" fill="#fef08a" opacity="0.9" />
                  <polygon points="200,72 400,72 380,92 220,92" fill="#fef08a" opacity="0.7" />

                  {/* Glass-walled office rooms on left & right */}
                  <polygon
                    points="0,0 125,115 125,385 0,520"
                    fill={isDark ? '#1e3a5f' : '#bae6fd'}
                    fillOpacity="0.4"
                    stroke="#475569"
                    strokeWidth="3"
                  />
                  <polygon
                    points="600,0 475,115 475,385 600,520"
                    fill={isDark ? '#1e3a5f' : '#bae6fd'}
                    fillOpacity="0.4"
                    stroke="#475569"
                    strokeWidth="3"
                  />

                  {/* Warm hardwood corridor floor */}
                  <polygon
                    points="0,520 125,385 475,385 600,520"
                    fill="url(#oakFloor)"
                    stroke={isDark ? '#475569' : '#a8845d'}
                    strokeWidth="2"
                  />
                  {/* Welcome path runner leading onto the floor */}
                  <polygon
                    points="190,520 245,385 355,385 410,520"
                    fill={floorColor}
                    fillOpacity="0.28"
                  />

                  {/* Office Interior Straight Ahead */}
                  <rect
                    x="125"
                    y="115"
                    width="350"
                    height="270"
                    fill={isDark ? '#0f172a' : '#f8fafc'}
                    stroke="#475569"
                    strokeWidth="3"
                  />
                  {/* Floor skyline windows */}
                  {[150, 260, 370].map((wx) => (
                    <rect
                      key={wx}
                      x={wx}
                      y="142"
                      width="84"
                      height="88"
                      rx="4"
                      fill={isDark ? '#1d3466' : '#bfdbfe'}
                      stroke="#64748b"
                      strokeWidth="2.5"
                    />
                  ))}
                  {/* Desks & dual monitors waiting on floor */}
                  {[155, 265, 375].map((dx, i) => (
                    <g key={dx}>
                      <rect x={dx} y="305" width="70" height="36" rx="4" fill={isDark ? '#334155' : '#e2d9ce'} />
                      <rect x={dx + 18} y="278" width="34" height="24" rx="2" fill="#93c5fd" stroke="#1e293b" strokeWidth="2.5" />
                      {i === 1 && <circle cx={dx + 35} cy="264" r="10" fill={floorColor} />}
                    </g>
                  ))}

                  {/* Destination Floor Welcome Sign over corridor */}
                  <rect x="195" y="132" width="210" height="32" rx="8" fill="#0f172a" stroke={floorColor} strokeWidth="2" />
                  <text
                    x="300"
                    y="153"
                    textAnchor="middle"
                    fill="#f8fafc"
                    fontSize="12"
                    fontWeight="800"
                  >
                    {`F${targetFloorNum} · ${floorName.slice(0, 24)}`}
                  </text>
                </g>
              )}
            </svg>
          </div>

          {/* =================================================================
              LAYER 2: SLIDING BRUSHED-STEEL & GLASS ELEVATOR DOORS
             ================================================================= */}
          <div
            style={{
              position: 'absolute',
              inset: '11% 24% 10% 24%',
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            {/* Left Sliding Door */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: '50.2%',
                transform: doorsOpen ? 'translateX(-96%)' : 'translateX(0%)',
                transition: 'transform 0.48s cubic-bezier(0.32, 0.72, 0, 1)',
                background: isDark
                  ? 'linear-gradient(90deg, rgba(30,41,59,0.95) 0%, rgba(51,65,85,0.88) 85%, rgba(148,163,184,0.62) 100%)'
                  : 'linear-gradient(90deg, rgba(148,163,184,0.92) 0%, rgba(203,213,225,0.88) 86%, rgba(241,245,249,0.96) 100%)',
                borderRight: '3px solid #0f172a',
                boxShadow: 'inset 0 0 28px rgba(15, 23, 42, 0.42)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: '48%',
                  height: '66%',
                  borderRadius: 5,
                  border: '2px solid rgba(15,23,42,0.5)',
                  background: 'linear-gradient(135deg, rgba(186,230,253,0.28), rgba(15,23,42,0.2))',
                }}
              />
            </div>

            {/* Right Sliding Door */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                right: 0,
                width: '50.2%',
                transform: doorsOpen ? 'translateX(96%)' : 'translateX(0%)',
                transition: 'transform 0.48s cubic-bezier(0.32, 0.72, 0, 1)',
                background: isDark
                  ? 'linear-gradient(270deg, rgba(30,41,59,0.95) 0%, rgba(51,65,85,0.88) 85%, rgba(148,163,184,0.62) 100%)'
                  : 'linear-gradient(270deg, rgba(148,163,184,0.92) 0%, rgba(203,213,225,0.88) 86%, rgba(241,245,249,0.96) 100%)',
                borderLeft: '3px solid #0f172a',
                boxShadow: 'inset 0 0 28px rgba(15, 23, 42, 0.42)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: '48%',
                  height: '66%',
                  borderRadius: 5,
                  border: '2px solid rgba(15,23,42,0.5)',
                  background: 'linear-gradient(225deg, rgba(186,230,253,0.28), rgba(15,23,42,0.2))',
                }}
              />
            </div>
          </div>

          {/* =================================================================
              LAYER 3: SURROUND ARCHITECTURE
              - Act 1 (outside in lobby): Lobby walls, plants, floor sill, overhead transom sign & hall call panel
              - Act 2-4 (inside cabin): Cabin surround walls, chrome handrails & live illuminated floor buttons
             ================================================================= */}
          <svg
            viewBox="0 0 1000 660"
            preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          >
            {/* Top Header Architrave */}
            <polygon points="0,0 1000,0 760,72 240,72" fill={isDark ? '#0f172a' : '#334155'} />
            <polygon points="240,72 760,72 760,92 240,92" fill="#0f172a" />

            {/* Overhead Brushed Steel Transom Floor Indicator */}
            <rect x="415" y="24" width="170" height="36" rx="8" fill="#050b18" stroke={insideCabin ? floorColor : '#475569'} strokeWidth="2" />
            <text x="500" y="48" textAnchor="middle" fill="#f8fafc" fontSize="16" fontWeight="900" letterSpacing="2">
              {phase === 'ascending' ? `▲ F${activeFloorNum}` : phase === 'arrived' ? `✓ F${targetFloorNum}` : `▲ F${activeFloorNum}`}
            </text>

            {/* Left & Right Walls */}
            <polygon
              points="0,0 240,72 240,594 0,660"
              fill={
                insideCabin
                  ? (isDark ? '#1e293b' : '#475569')
                  : (isDark ? '#162238' : '#cbd5e1')
              }
              stroke="#0f172a"
              strokeWidth="2"
            />
            <polygon
              points="1000,0 760,72 760,594 1000,660"
              fill={
                insideCabin
                  ? (isDark ? '#1e293b' : '#475569')
                  : (isDark ? '#162238' : '#cbd5e1')
              }
              stroke="#0f172a"
              strokeWidth="2"
            />

            {/* Steel Door Jamb Pillars */}
            <rect x="224" y="72" width="16" height="522" fill="#1e293b" stroke="#0f172a" strokeWidth="2" />
            <rect x="760" y="72" width="16" height="522" fill="#1e293b" stroke="#0f172a" strokeWidth="2" />

            {/* Floor Perspective Leading Through the Threshold */}
            <polygon
              points="0,660 240,594 760,594 1000,660"
              fill={isDark ? '#4a311a' : '#cfa87e'}
              stroke="#785333"
              strokeWidth="2"
            />
            {/* Brushed Steel Elevator Sill Strip */}
            <line x1="238" y1="594" x2="762" y2="594" stroke="#e2e8f0" strokeWidth="5" />

            {/* Lobby Hall Details (Outside before boarding) */}
            {!insideCabin && (
              <g>
                {/* Warm Wall Sconces & Decorative Framed Accent */}
                <line x1="90" y1="150" x2="90" y2="390" stroke="#fde047" strokeWidth="5" opacity="0.85" strokeLinecap="round" />
                <line x1="910" y1="150" x2="910" y2="390" stroke="#fde047" strokeWidth="5" opacity="0.85" strokeLinecap="round" />
                {/* Hallway Floor Call Button Panel beside right jamb */}
                <rect x="786" y="295" width="38" height="72" rx="6" fill="#0f172a" stroke="#64748b" strokeWidth="2" />
                <circle
                  cx="805"
                  cy="318"
                  r="8"
                  fill={phase === 'boarding' ? '#22c55e' : floorColor}
                  stroke="#ffffff"
                  strokeWidth="1.5"
                />
                <text x="805" y="321.5" textAnchor="middle" fill="#ffffff" fontSize="9" fontWeight="900">▲</text>
                <circle cx="805" cy="346" r="7" fill="#1e293b" stroke="#475569" strokeWidth="1.5" />
                <text x="805" y="349.5" textAnchor="middle" fill="#94a3b8" fontSize="8" fontWeight="800">▼</text>
              </g>
            )}

            {/* Inside-Cabin Details (Chrome handrails + Live F1..FN Panel) */}
            {insideCabin && (
              <g>
                <line x1="48" y1="438" x2="215" y2="412" stroke="#cbd5e1" strokeWidth="8" strokeLinecap="round" />
                <line x1="952" y1="438" x2="785" y2="412" stroke="#cbd5e1" strokeWidth="8" strokeLinecap="round" />
                {/* Cabin Floor Button Panel */}
                <polygon
                  points="790,192 858,176 858,412 790,428"
                  fill="#0b1324"
                  stroke="#64748b"
                  strokeWidth="2"
                />
                {Array.from({ length: maxShown }, (_, idx) => {
                  const num = maxShown - idx;
                  const y = 205 + idx * 25;
                  const isActive = num === activeFloorNum;
                  const isDest = num === targetFloorNum;
                  return (
                    <g key={num}>
                      <circle
                        cx="824"
                        cy={y}
                        r="9"
                        fill={isActive ? floorColor : isDest ? 'rgba(255,255,255,0.2)' : '#1e293b'}
                        stroke={isActive ? '#ffffff' : isDest ? floorColor : '#475569'}
                        strokeWidth="1.6"
                      />
                      <text
                        x="824"
                        y={y + 3.2}
                        textAnchor="middle"
                        fill={isActive ? '#ffffff' : '#94a3b8'}
                        fontSize="9"
                        fontWeight="800"
                      >
                        {num}
                      </text>
                    </g>
                  );
                })}
              </g>
            )}
          </svg>
        </div>
      </div>

      {/* Subtle First-Person Video Camera Corners & Live Lift Status Pill */}
      <div style={{ position: 'absolute', inset: 20, pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, width: 20, height: 20, borderTop: '2px solid rgba(255,255,255,0.5)', borderLeft: '2px solid rgba(255,255,255,0.5)' }} />
        <div style={{ position: 'absolute', top: 0, right: 0, width: 20, height: 20, borderTop: '2px solid rgba(255,255,255,0.5)', borderRight: '2px solid rgba(255,255,255,0.5)' }} />
        <div style={{ position: 'absolute', bottom: 0, left: 0, width: 20, height: 20, borderBottom: '2px solid rgba(255,255,255,0.5)', borderLeft: '2px solid rgba(255,255,255,0.5)' }} />
        <div style={{ position: 'absolute', bottom: 0, right: 0, width: 20, height: 20, borderBottom: '2px solid rgba(255,255,255,0.5)', borderRight: '2px solid rgba(255,255,255,0.5)' }} />

        <div
          style={{
            position: 'absolute',
            bottom: 14,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '8px 18px',
            borderRadius: 999,
            background: 'rgba(10, 17, 36, 0.9)',
            border: `1.5px solid ${phase === 'arrived' ? '#10b981' : floorColor}`,
            color: '#f8fafc',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            boxShadow: '0 12px 30px rgba(0, 0, 0, 0.42)',
            whiteSpace: 'nowrap',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: phase === 'arrived' ? '#10b981' : floorColor,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 12, fontWeight: 900, letterSpacing: '0.05em' }}>
            F{activeFloorNum} / F{totalFloors}
          </span>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>·</span>
          <span style={{ fontSize: 12, fontWeight: 700 }}>
            {phase === 'approach' && `Walking to elevator · Floor ${targetFloorNum}`}
            {phase === 'boarding' && `Doors opening · Stepping inside`}
            {phase === 'doorsClose' && `Doors closing · Bound for Floor ${targetFloorNum}`}
            {phase === 'ascending' && `Going up to Floor ${targetFloorNum} (${floorName})`}
            {phase === 'arrived' && `Arrived at ${floorName} · Stepping onto floor`}
          </span>
        </div>
      </div>
    </div>
  );
}
