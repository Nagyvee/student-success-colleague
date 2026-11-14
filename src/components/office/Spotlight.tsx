'use client';

import { useEffect, useState } from 'react';
import type { Spotlight as Spot } from '@/lib/types';
import { AGENT_BY_ID } from '@/lib/office/layout';
import Icon from '@/components/Icon';

/* The moment the Reviewer stops the line.
 *
 * When a draft fails review, a card drops over the floor: the rule that was
 * broken, what was wrong, and the offending text struck through. When the
 * fixed version passes, the card turns green and shows the old line beside
 * the new one. Each card holds long enough for a room to read it, with a
 * thin bar counting down so the presenter knows when it will go. */

export default function Spotlight({ spot }: { spot: Spot | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, []);
  if (!spot) return null;
  const left = spot.ts + spot.holdMs - now;
  if (left <= 0) return null;
  const caught = spot.kind === 'caught';
  const owner = AGENT_BY_ID[spot.owner];
  if (spot.kind === 'call') {
    return (
      <div className="spot-wrap" aria-live="assertive">
        <div key={spot.id} className="spot is-call">
          <div className="spot-head">
            <span className="spot-ico"><Icon name="phoneCall" size={18} /></span>
            <div><b>{spot.title}</b><span>{spot.subject}</span></div>
          </div>
          <div className="spot-body">
            <div className="spot-row"><em>Opening line</em><p className="spot-say">“{spot.problem}”</p></div>
            <div className="spot-row"><em>Then</em><p>A short, kind conversation, under a minute. The result lands in the activity feed.</p></div>
          </div>
          <i className="spot-timer" style={{ animationDuration: `${spot.holdMs}ms` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="spot-wrap" aria-live="assertive">
      <div key={spot.id} className={`spot is-${spot.kind}`}>
        <div className="spot-head">
          <span className="spot-ico"><Icon name={caught ? 'warn' : 'badgeCheck'} size={18} /></span>
          <div>
            <b>{caught ? 'Mistake caught by Musa, the Reviewer' : `Fixed by ${owner.name} · re-checked and approved`}</b>
            <span>{spot.title} · {spot.subject}</span>
          </div>
        </div>
        {caught ? (
          <div className="spot-body">
            <div className="spot-row"><em>Rule</em><p>{spot.rule}</p></div>
            <div className="spot-row"><em>What was wrong</em><p>{spot.problem}</p></div>
            {spot.before && <div className="spot-row"><em>Rejected</em><p className="spot-old">{spot.before}</p></div>}
            <div className="spot-row"><em>Next</em><p>Sent back to {owner.name}. Nothing reaches the learner until it passes.</p></div>
          </div>
        ) : (
          <div className="spot-body">
            {spot.before && <div className="spot-row"><em>Before</em><p className="spot-old">{spot.before}</p></div>}
            {spot.after && <div className="spot-row"><em>After</em><p className="spot-new">{spot.after}</p></div>}
            <div className="spot-row"><em>Result</em><p>{spot.problem}. Cleared to send.</p></div>
          </div>
        )}
        <i className="spot-timer" style={{ animationDuration: `${spot.holdMs}ms` }} />
      </div>
    </div>
  );
}
