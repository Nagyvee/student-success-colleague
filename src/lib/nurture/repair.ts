import type { DataRecord } from '@/lib/types';
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

/* Old rows that came in before they were marked.
 *
 * The first read of a sheet imports everyone already on it quietly: nobody is
 * messaged, and they are old, not new. That mark (imported_quietly) only exists
 * since the evening of 19 Nov 2026, after the leads sheet was first read, so
 * its rows looked new to the clean-up and the WhatsApp follow-ups. They are
 * recognised by how they came in: many in the same minute, which real new
 * leads never do. Runs when the server starts; a lead already marked, or who
 * came in later, is left alone. */

const MARKED_SINCE = Date.parse('2026-11-19T22:00:00Z');
const TOGETHER_MS = 60_000;
const AT_LEAST = 20;

/** The leads that came in together, before rows were marked. Pure. */
export function importedTogether(recs: Pick<DataRecord, 'key' | 'firstSeenAt' | 'fields'>[]): Set<string> {
  const early = recs.filter((r) => r.firstSeenAt < MARKED_SINCE && r.fields.preview !== 'yes').sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  const out = new Set<string>();
  for (let i = 0, j = 0; i < early.length; i++) {
    while (early[i].firstSeenAt - early[j].firstSeenAt > TOGETHER_MS) j++;
    if (i - j + 1 >= AT_LEAST) for (let k = j; k <= i; k++) out.add(early[k].key);
  }
  return out;
}

/** Marks them as old rows. Returns how many were marked now. */
export function markOldImports(): number {
  const recs = listRecords(LEADS_SOURCE_ID);
  const old = importedTogether(recs);
  let marked = 0;
  for (const r of recs) {
    if (!old.has(r.key) || r.fields.imported_quietly === 'yes') continue;
    setRecordField(r.sourceId, r.key, 'imported_quietly', 'yes');
    marked++;
  }
  return marked;
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
