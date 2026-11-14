'use client';

import type { AgentStatus } from '@/lib/types';

/* The people on the floor.
 *
 * Every agent is a person with their own look and a staff lanyard; the
 * Reviewer wears a navy suit and carries the audit clipboard. All of them are
 * 40×64 SVGs with legs and arms that swing when the figure walks. */

export type FigureKind = 'person' | 'robot' | 'coo' | 'lead' | 'alert' | 'packet';

/** One look per agent: skin, top, trousers, hair. */
export const LOOKS = [
  { skin: '#7a4a2e', top: '#ffffff', trim: '#d6dde8', pants: '#24345a', hair: 'bun' },   // Zanele · Planner
  { skin: '#5b3a22', top: '#3b6fd8', trim: '#2f5bb6', pants: '#2b2f38', hair: 'short' }, // Bongani · Student Success
  { skin: '#8d5a3b', top: '#17a394', trim: '#118276', pants: '#24345a', hair: 'puff' },  // Lindiwe · Learning & Assessment
] as const;

interface Props {
  kind: FigureKind;
  accent: string;
  status?: AgentStatus;
  walking?: boolean;
  facing?: 'left' | 'right';
  carrying?: boolean;
  variant?: number;
  look?: number;
}

const SKIN = ['#8d5a3b', '#c68a5b', '#5b3a22', '#e0ac85'];
const SHIRT = ['#4b5d85', '#6c7ea6', '#3b4f7a', '#8795b5'];

export default function Figure({ kind, accent, status = 'idle', walking = false, facing = 'right', carrying = false, variant = 0, look = 0 }: Props) {
  const cls = `fig is-${status}${walking ? ' is-walking' : ''}${facing === 'left' ? ' face-left' : ''}`;
  const style = { ['--accent' as string]: accent } as React.CSSProperties;

  if (kind === 'alert' || kind === 'packet') {
    return (
      <svg className={`${cls} is-token`} viewBox="0 0 40 64" style={style} aria-hidden="true">
        <g className="hover">
          {kind === 'alert' ? (
            <>
              <circle cx="20" cy="36" r="13" fill="#4a3a12" stroke="#e5a53a" strokeWidth="1.5" />
              <path d="M20 26c-4.4 0-7 3.2-7 7.5V38l-2 3h18l-2-3v-4.5c0-4.3-2.6-7.5-7-7.5z" fill="#fff1cf" />
              <circle cx="20" cy="43.5" r="2" fill="#fff1cf" />
            </>
          ) : (
            <>
              <rect x="9" y="24" width="22" height="26" rx="3" fill="#f6f8ff" stroke="#9fc5ff" strokeWidth="1.5" transform="rotate(-6 20 37)" />
              <rect x="13" y="30" width="12" height="2" rx="1" fill="#0a1733" transform="rotate(-6 20 37)" />
              <rect x="13" y="35" width="14" height="2" rx="1" fill="#3b4f7a" transform="rotate(-6 20 37)" />
              <rect x="13" y="40" width="9" height="2" rx="1" fill="#0a1733" transform="rotate(-6 20 37)" />
            </>
          )}
        </g>
      </svg>
    );
  }

  if (kind === 'person') {
    const L = LOOKS[look % LOOKS.length];
    const hair = L.hair === 'bun'
      ? <><circle cx="20" cy="3.6" r="4" fill="#1a1a1a" /><path d="M12 13c0-5.2 3.6-8.4 8-8.4s8 3.2 8 8.4c-1.5-2.6-4.2-3.9-8-3.9s-6.5 1.3-8 3.9z" fill="#1a1a1a" /></>
      : L.hair === 'puff'
        ? <path d="M10.6 14c-1.6-6.4 2.4-11.4 9.4-11.4S31 7.6 29.4 14c-1.8-3.4-5-4.8-9.4-4.8s-7.6 1.4-9.4 4.8z" fill="#1a1a1a" />
        : <path d="M12.3 12c.4-4.8 3.6-7.2 7.7-7.2s7.3 2.4 7.7 7.2c-1.7-1.9-4.3-2.6-7.7-2.6s-6 .7-7.7 2.6z" fill="#1a1a1a" />;
    return (
      <svg className={cls} viewBox="0 0 40 64" style={style} aria-hidden="true">
        <g className="leg leg-l"><rect x="12.5" y="43" width="6.5" height="17" rx="2.5" fill={L.pants} /><path d="M11 59.5h9.5v2.5H11z" fill="#1f2430" /></g>
        <g className="leg leg-r"><rect x="21" y="43" width="6.5" height="17" rx="2.5" fill={L.pants} /><path d="M19.5 59.5H29v2.5h-9.5z" fill="#1f2430" /></g>
        <g className="body">
          <g className="arm arm-l"><rect x="5" y="25.5" width="5.5" height="17" rx="2.7" fill={L.top} stroke={L.trim} strokeWidth=".6" /><circle cx="7.8" cy="43.5" r="2.5" fill={L.skin} /></g>
          <g className="arm arm-r"><rect x="29.5" y="25.5" width="5.5" height="17" rx="2.7" fill={L.top} stroke={L.trim} strokeWidth=".6" /><circle cx="32.2" cy="43.5" r="2.5" fill={L.skin} />
            {carrying && <g transform="rotate(6 34 37)"><rect x="29.5" y="30" width="10" height="13" rx="1.2" fill="#f6f8ff" stroke="#3b4f7a" strokeWidth=".8" /><rect x="31.5" y="33" width="6" height="1.2" fill="#0a1733" /><rect x="31.5" y="35.5" width="5" height="1.2" fill="#0a1733" /></g>}
          </g>
          <rect x="10" y="24" width="20" height="21" rx="4" fill={L.top} stroke={L.trim} strokeWidth=".7" />
          <path d="M16.5 24.5l3.5 9 3.5-9" stroke="#0a1733" strokeWidth="1" fill="none" />
          <rect className="badge-card" x="18" y="33" width="4" height="5" rx=".8" fill="#ffffff" stroke="#0a1733" strokeWidth=".6" />
          <rect x="17.5" y="20" width="5" height="5" rx="1.5" fill={L.skin} />
          <circle cx="20" cy="13" r="8" fill={L.skin} />
          {hair}
          <circle cx="17" cy="14" r=".9" fill="#1b1b1b" /><circle cx="23" cy="14" r=".9" fill="#1b1b1b" />
          <path d="M17.5 17.5c1.4 1.2 3.6 1.2 5 0" stroke="#3a2414" strokeWidth=".8" fill="none" strokeLinecap="round" />
        </g>
      </svg>
    );
  }

  if (kind === 'robot') {
    return (
      <svg className={cls} viewBox="0 0 40 64" style={style} aria-hidden="true">
        <g className="leg leg-l"><rect x="12.5" y="44" width="6.5" height="16" rx="3" fill="#3b4a6b" /><ellipse cx="15.5" cy="60.5" rx="4.2" ry="2.2" fill="#242f4a" /></g>
        <g className="leg leg-r"><rect x="21" y="44" width="6.5" height="16" rx="3" fill="#3b4a6b" /><ellipse cx="24.5" cy="60.5" rx="4.2" ry="2.2" fill="#242f4a" /></g>
        <g className="body">
          <g className="arm arm-l"><rect x="4.5" y="26" width="5.5" height="16" rx="2.7" fill="#e3e8f3" stroke="#b9c4dc" strokeWidth=".6" /><circle cx="7.2" cy="42.5" r="2.6" fill="#cfd8ea" /></g>
          <g className="arm arm-r"><rect x="30" y="26" width="5.5" height="16" rx="2.7" fill="#e3e8f3" stroke="#b9c4dc" strokeWidth=".6" /><circle cx="32.8" cy="42.5" r="2.6" fill="#cfd8ea" />
            {carrying && <rect x="30" y="31" width="9" height="12" rx="1.2" fill="#f6f8ff" stroke="#3b4f7a" strokeWidth=".8" transform="rotate(8 34 37)" />}
          </g>
          <rect x="10" y="24" width="20" height="22" rx="6" fill="#f3f6fc" stroke="#c3cde2" strokeWidth=".8" />
          <rect x="13" y="27" width="14" height="9" rx="3" fill="#e5eaf5" />
          <circle className="chest" cx="20" cy="38.5" r="2.6" />
          <rect x="17.5" y="20.5" width="5" height="4.5" rx="1.5" fill="#c3cde2" />
          <rect x="9" y="5" width="22" height="17" rx="7" fill="#f7f9fe" stroke="#c3cde2" strokeWidth=".8" />
          <rect x="12" y="9.5" width="16" height="7.5" rx="3.75" fill="#0a1733" />
          <rect className="eye" x="15" y="12" width="3.2" height="2.4" rx="1.2" />
          <rect className="eye" x="21.8" y="12" width="3.2" height="2.4" rx="1.2" />
          <rect x="7" y="11" width="3" height="5" rx="1.2" fill="#d6dcec" />
          <rect x="30" y="11" width="3" height="5" rx="1.2" fill="#d6dcec" />
          <rect x="19.3" y="1.6" width="1.4" height="4" fill="#c3cde2" />
          <circle className="antenna-tip" cx="20" cy="1.6" r="1.7" />
        </g>
      </svg>
    );
  }

  if (kind === 'coo') {
    return (
      <svg className={cls} viewBox="0 0 40 64" style={style} aria-hidden="true">
        <g className="leg leg-l"><rect x="12.5" y="43" width="6.5" height="17" rx="2.5" fill="#101b3a" /><path d="M11 59.5h9.5v2.5H11z" fill="#0b0f1c" rx="1" /></g>
        <g className="leg leg-r"><rect x="21" y="43" width="6.5" height="17" rx="2.5" fill="#101b3a" /><path d="M19.5 59.5H29v2.5h-9.5z" fill="#0b0f1c" /></g>
        <g className="body">
          <g className="arm arm-l"><rect x="5" y="25.5" width="5.5" height="17" rx="2.7" fill="#1b2c55" /><circle cx="7.8" cy="43.5" r="2.5" fill="#8d5a3b" /></g>
          <g className="arm arm-r"><rect x="29.5" y="25.5" width="5.5" height="17" rx="2.7" fill="#1b2c55" /><circle cx="32.2" cy="43.5" r="2.5" fill="#8d5a3b" />
            {carrying && <g transform="rotate(6 34 37)"><rect x="29.5" y="30" width="10" height="13" rx="1.2" fill="#f6f8ff" stroke="#3b4f7a" strokeWidth=".8" /><rect x="31.5" y="33" width="6" height="1.2" fill="#0a1733" /><rect x="31.5" y="35.5" width="5" height="1.2" fill="#0a1733" /><rect x="31.5" y="38" width="6" height="1.2" fill="#9fc5ff" /></g>}
          </g>
          <rect x="10" y="24" width="20" height="21" rx="4" fill="#1b2c55" />
          <path d="M16 24h8l-4 12z" fill="#f7f9fe" />
          <path d="M19.2 28h1.6l1 7-1.8 2.5-1.8-2.5z" fill="#3b4f7a" />
          <path d="M10 24l6 0 2 8-4 2z" fill="#122047" /><path d="M30 24l-6 0-2 8 4 2z" fill="#122047" />
          <rect x="17.5" y="20" width="5" height="5" rx="1.5" fill="#8d5a3b" />
          <circle cx="20" cy="13" r="8" fill="#8d5a3b" />
          <path d="M12.2 12.2c.3-5 3.6-7.8 7.8-7.8s7.5 2.8 7.8 7.8c-1.6-2.2-4.3-3.2-7.8-3.2s-6.2 1-7.8 3.2z" fill="#161616" />
          <circle cx="17" cy="14" r=".9" fill="#1b1b1b" /><circle cx="23" cy="14" r=".9" fill="#1b1b1b" />
          <path d="M17.5 17.5c1.4 1.2 3.6 1.2 5 0" stroke="#4a2c17" strokeWidth=".8" fill="none" strokeLinecap="round" />
        </g>
      </svg>
    );
  }

  // a visitor
  const skin = SKIN[variant % SKIN.length];
  const shirt = SHIRT[variant % SHIRT.length];
  return (
    <svg className={cls} viewBox="0 0 40 64" style={style} aria-hidden="true">
      <g className="leg leg-l"><rect x="12.5" y="43" width="6.5" height="17" rx="2.5" fill="#3b4f7a" /><path d="M11 59.5h9.5v2.5H11z" fill="#f2f2f2" /></g>
      <g className="leg leg-r"><rect x="21" y="43" width="6.5" height="17" rx="2.5" fill="#3b4f7a" /><path d="M19.5 59.5H29v2.5h-9.5z" fill="#f2f2f2" /></g>
      <g className="body">
        <g className="arm arm-l"><rect x="5" y="25.5" width="5.5" height="17" rx="2.7" fill={shirt} /><circle cx="7.8" cy="43.5" r="2.5" fill={skin} /></g>
        <g className="arm arm-r"><rect x="29.5" y="25.5" width="5.5" height="17" rx="2.7" fill={shirt} /><circle cx="32.2" cy="43.5" r="2.5" fill={skin} />
          <rect x="31" y="36" width="8" height="10" rx="2" fill="#1b2c55" />
        </g>
        <rect x="10" y="24" width="20" height="21" rx="4" fill={shirt} />
        <rect x="17.5" y="20" width="5" height="5" rx="1.5" fill={skin} />
        <circle cx="20" cy="13" r="8" fill={skin} />
        <path d="M12.2 12.5c.3-5.3 3.6-8.1 7.8-8.1s7.5 2.8 7.8 8.1c-1.2-2.6-3.3-4-7.8-4s-6.6 1.4-7.8 4z" fill="#1a1a1a" />
        <circle cx="17" cy="14" r=".9" fill="#1b1b1b" /><circle cx="23" cy="14" r=".9" fill="#1b1b1b" />
        <path d="M17.5 17.5c1.4 1.2 3.6 1.2 5 0" stroke="#5a3a24" strokeWidth=".8" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
}
