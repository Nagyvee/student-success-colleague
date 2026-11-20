import { listRecords, setRecordField } from '@/lib/data/records';
import { LEADS_SOURCE_ID } from '@/lib/data/sources';
import { SCORE, engagementFor, pointsOf } from './track';

/* Scores the old field bug pulled back, rebuilt from what each lead did.
 *
 * Until 20 Nov 2026 a field Thuso wrote a second time (a score going from 1 to
 * 4) was put back to its first value by the next read of the dialer, so most
 * scores sat at 1. What survived is each kind of action's first trace: they
 * opened (nurture_opens), clicked (nurture_clicks, last_clicked), took the quiz
 * (fit_done, fit_track), replied (replied). A lead's score becomes at least the
 * points those are worth (what is listed in nurture_seen, plus anything listed
 * nowhere else). Scores only go up; a lead already right is left alone. Runs
 * when the server starts. */

const n = (v: string | undefined) => { const x = Number(v || 0); return Number.isFinite(x) ? x : 0; };

/** The score a lead has at least earned, from the traces their actions left. Pure. */
export function earnedScore(f: Record<string, string>): number {
  const { items, total } = pointsOf(f);
  const count = (k: string) => items.filter((i) => i.kind === k).length;
  let est = total;
  est += Math.max(0, n(f.nurture_opens) - count('open')) * SCORE.open;
  if (!count('click') && (n(f.nurture_clicks) > 0 || f.last_clicked)) est += SCORE.click;
  if (!count('quiz') && (f.fit_done === 'yes' || f.fit_track)) est += SCORE.quiz;
  if (!count('reply') && f.replied === 'yes') est += SCORE.reply;
  return est;
}

/** Raises each lead's score to what they earned. Returns how many changed. */
export function repairLeadScores(): number {
  let changed = 0;
  for (const r of listRecords(LEADS_SOURCE_ID)) {
    if (r.fields.preview === 'yes') continue;
    const est = earnedScore(r.fields);
    if (est <= n(r.fields.engagement_score)) continue;
    setRecordField(r.sourceId, r.key, 'engagement_score', String(est));
    setRecordField(r.sourceId, r.key, 'engagement', engagementFor(est));
    changed++;
  }
  return changed;
}
