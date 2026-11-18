'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { WorldState } from '@/lib/types';

/** A floor in the switcher: a department (or, on older screens, a workflow). */
export interface FloorItem { id: string; name: string; officeName: string }
import Icon from '@/components/Icon';
import { LogoMark } from '@/components/Logo';

export default function GoalBar({
  state,
  stage,
  onExitStage,
  right,
  afterBrand,
  workflows = [],
  selectedFloorId = '__all__',
  onSelectFloor,
  viewMode = 'skyscraper',
  onToggleViewMode,
  onRunFloor,
  runningFloor = false,
  floorHref = (id: string) => `/workflows/${encodeURIComponent(id)}`,
  floorLinkLabel = 'Canvas',
  floorNoun = 'Floors',
}: {
  state: WorldState;
  stage: boolean;
  onExitStage: () => void;
  right?: ReactNode;
  /** Next to the floor picker (e.g. the Building | List switch). */
  afterBrand?: ReactNode;
  workflows?: FloorItem[];
  selectedFloorId?: string;
  onSelectFloor?: (id: string) => void;
  viewMode?: 'skyscraper' | 'interior';
  onToggleViewMode?: (mode: 'skyscraper' | 'interior') => void;
  onRunFloor?: (workflowId: string) => void;
  runningFloor?: boolean;
  /** Where the floor's link goes (default: the workflow canvas). */
  floorHref?: (id: string) => string;
  floorLinkLabel?: string;
  floorNoun?: string;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const checkTheme = () => {
      setIsDark(document.documentElement.getAttribute('data-theme') === 'dark');
    };
    checkTheme();
    const obs = new MutationObserver(checkTheme);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!dropdownOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [dropdownOpen]);

  const running = state.tasks.find((t) => t.status === 'running') || null;
  const selectedFloorIdx = workflows.findIndex((w) => w.id === selectedFloorId);
  const selectedWf = selectedFloorIdx >= 0 ? workflows[selectedFloorIdx] : null;
  const companyName = state.tenant?.name || 'Melsoft Academy';
  const companyLogo = state.tenant?.building?.logoUrl;

  return (
    <div className="cmd-bar goal-bar" style={{ justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      {/* Left: Clean Brand & Custom High-Contrast Floor Switcher Dropdown */}
      <div
        ref={dropdownRef}
        className="cmd-group goal-brand"
        style={{ position: 'relative', gap: 10, paddingRight: 10 }}
      >
        {viewMode === 'interior' && (
          <button
            type="button"
            className="cmd-btn"
            onClick={() => {
              onSelectFloor?.('__all__');
              onToggleViewMode?.('skyscraper');
            }}
            title="Return to full 3D Skyscraper view"
            style={{
              height: 28,
              padding: '0 10px',
              fontSize: 11.5,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <Icon name="building" size={13} />
            <span>← Skyscraper</span>
          </button>
        )}

        {companyLogo ? (
          <img
            src={companyLogo}
            alt={companyName}
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              objectFit: 'contain',
              background: '#fff',
              padding: 2,
            }}
          />
        ) : (
          <LogoMark size={26} />
        )}

        <button
          type="button"
          onClick={() => setDropdownOpen((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'transparent',
            border: 'none',
            padding: '2px 4px',
            cursor: 'pointer',
            color: 'inherit',
            textAlign: 'left',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.2 }}>
              {selectedWf && viewMode === 'interior'
                ? `Floor ${selectedFloorIdx + 1} · ${selectedWf.name}`
                : `${companyName} · ${workflows.length || 1} ${floorNoun}`}
            </span>
            <em style={{ fontSize: 10.5, fontStyle: 'normal', color: '#64748b' }}>
              {selectedWf && viewMode === 'interior'
                ? `${selectedWf.officeName} · Click to switch floor`
                : 'Click to jump to any floor or interior'}
            </em>
          </div>
          <span
            style={{
              fontSize: 11,
              opacity: 0.7,
              transform: dropdownOpen ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s ease',
            }}
          >
            ▾
          </span>
        </button>

        {/* Quick Run & Canvas actions when inside a specific floor */}
        {selectedWf && viewMode === 'interior' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 4 }}>
            {onRunFloor && (
              <button
                type="button"
                className="cmd-btn"
                onClick={() => onRunFloor(selectedWf.id)}
                disabled={Boolean(running || runningFloor)}
                style={{ height: 26, padding: '0 9px', fontSize: 11.5, fontWeight: 700 }}
              >
                <Icon name="play" size={12} />
                <span>{runningFloor ? 'Running…' : 'Run'}</span>
              </button>
            )}
            <Link
              href={floorHref(selectedWf.id)}
              className="cmd-btn"
              style={{ height: 26, padding: '0 9px', fontSize: 11.5, textDecoration: 'none' }}
            >
              <Icon name="flow" size={12} />
              <span>{floorLinkLabel}</span>
            </Link>
          </span>
        )}

        {/* Active working indicator only when a task is running */}
        {(running || runningFloor) && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 9px',
              borderRadius: 999,
              background: 'rgba(114, 0, 117, 0.18)',
              border: '1px solid rgba(114, 0, 117, 0.45)',
              fontSize: 11,
              fontWeight: 700,
              color: isDark ? '#f0abfc' : '#720075',
            }}
          >
            <i className="live-dot" style={{ background: '#d946ef' }} />
            Working…
          </span>
        )}

        {/* Custom High-Contrast Dropdown Menu (Readable in both Dark & Light Mode) */}
        {dropdownOpen && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              left: 0,
              minWidth: 320,
              maxWidth: 380,
              zIndex: 100,
              padding: 6,
              borderRadius: 14,
              background: isDark ? '#0f172a' : '#ffffff',
              border: isDark ? '1px solid #334155' : '1px solid #cbd5e1',
              boxShadow: '0 18px 42px rgba(2, 6, 23, 0.45)',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            <button
              type="button"
              onClick={() => {
                onSelectFloor?.('__all__');
                onToggleViewMode?.('skyscraper');
                setDropdownOpen(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 9,
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                background:
                  viewMode === 'skyscraper' && selectedFloorId === '__all__'
                    ? '#2563eb'
                    : 'transparent',
                color:
                  viewMode === 'skyscraper' && selectedFloorId === '__all__'
                    ? '#ffffff'
                    : isDark
                    ? '#f8fafc'
                    : '#0f172a',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    padding: '2px 6px',
                    borderRadius: 6,
                    fontSize: 10,
                    fontWeight: 800,
                    background:
                      viewMode === 'skyscraper' && selectedFloorId === '__all__'
                        ? 'rgba(255,255,255,0.22)'
                        : isDark
                        ? '#1e293b'
                        : '#e2e8f0',
                    color:
                      viewMode === 'skyscraper' && selectedFloorId === '__all__'
                        ? '#ffffff'
                        : isDark
                        ? '#93c5fd'
                        : '#1d4ed8',
                  }}
                >
                  3D
                </span>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 800 }}>
                    {companyName} · Full 3D Skyscraper
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      color:
                        viewMode === 'skyscraper' && selectedFloorId === '__all__'
                          ? 'rgba(255,255,255,0.8)'
                          : isDark
                          ? '#94a3b8'
                          : '#64748b',
                    }}
                  >
                    Exterior view of all {workflows.length || 1} {floorNoun.toLowerCase()}
                  </div>
                </div>
              </div>
            </button>

            <div
              style={{
                height: 1,
                background: isDark ? '#1e293b' : '#f1f5f9',
                margin: '2px 4px',
              }}
            />

            {workflows.map((wf, idx) => {
              const isSelected = selectedFloorId === wf.id && viewMode === 'interior';
              return (
                <button
                  key={wf.id}
                  type="button"
                  onClick={() => {
                    onSelectFloor?.(wf.id);
                    setDropdownOpen(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '7px 10px',
                    borderRadius: 9,
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    background: isSelected ? '#2563eb' : 'transparent',
                    color: isSelected ? '#ffffff' : isDark ? '#f1f5f9' : '#0f172a',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span
                      style={{
                        minWidth: 26,
                        height: 22,
                        borderRadius: 6,
                        fontSize: 10.5,
                        fontWeight: 800,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: isSelected
                          ? 'rgba(255,255,255,0.22)'
                          : isDark
                          ? '#1e293b'
                          : '#f1f5f9',
                        color: isSelected ? '#ffffff' : isDark ? '#cbd5e1' : '#334155',
                      }}
                    >
                      F{idx + 1}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {wf.name}
                      </div>
                      <div
                        style={{
                          fontSize: 10.5,
                          color: isSelected
                            ? 'rgba(255,255,255,0.8)'
                            : isDark
                            ? '#94a3b8'
                            : '#64748b',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {wf.officeName}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {afterBrand}
      </div>

      {/* Right: Workspace Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {right}
        {stage && (
          <button type="button" className="cmd-group cmd-btn cmd-exit" onClick={onExitStage}>
            <Icon name="shrink" size={14} />
            Exit stage
          </button>
        )}
      </div>
    </div>
  );
}
