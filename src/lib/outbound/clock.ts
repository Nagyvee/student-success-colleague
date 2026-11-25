/* How long is left before a date, always counted today.
 *
 * In the settings, "{time left to 1 April 2027}" becomes "4 months left" in
 * November 2026, "3 months left" in December and "closed" from that day on.
 * Months are whole calendar months after this one (South African time). */

const SAST_MS = 2 * 3_600_000;
const NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const TOKEN = /\{time left to ([^{}]{4,40})\}/gi;

/** "1 April 2027" or "2027-04-01" as 2027-04-01, or ''. */
export function dayOf(t: string): string {
  const iso = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(t);
  const said = /^\s*(\d{1,2})\s+([a-z]+)\s+(\d{4})\s*$/i.exec(t);
  const month = said ? NAMES.findIndex((n) => n === said[2].toLowerCase() || n.slice(0, 3) === said[2].toLowerCase()) + 1 : 0;
  const day = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : said && month ? `${said[3]}-${String(month).padStart(2, '0')}-${said[1].padStart(2, '0')}` : '';
  // A day that does not exist (31 April) is not a date.
  return day && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day ? day : '';
}

/** Whole months after this one before `day`; 0 in its last month; null once it has come. */
export function monthsLeft(day: string, now = Date.now()): number | null {
  const today = new Date(now + SAST_MS).toISOString().slice(0, 10);
  if (!day || today >= day) return null;
  const last = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString();
  const index = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
  return index(last) - index(today);
}

export function timeLeft(day: string, now = Date.now()): string {
  const n = monthsLeft(day, now);
  return n === null ? 'closed' : n === 0 ? 'less than a month left' : `${n} month${n === 1 ? '' : 's'} left`;
}

/** The settings' words, with the time left counted today. One that is not a date stays as it is. */
export const withTime = (text: string, now = Date.now()): string => text.replace(TOKEN, (all, d: string) => { const day = dayOf(d); return day ? timeLeft(day, now) : all; });

/** The dates counted to in these words. */
export const datesIn = (text: string): string[] => [...new Set([...text.matchAll(TOKEN)].map((m) => dayOf(m[1])).filter(Boolean))];

/** A message written when more time was left: what it says and what is true now, or ''. */
export function outOfDate(text: string, days: string[], written: number, now = Date.now()): string {
  for (const day of days) {
    const was = monthsLeft(day, written);
    const is = monthsLeft(day, now);
    if (was === null || was === is) continue;
    const said = was === 0 ? /less than a month/i : new RegExp(`\\b(${was}${WORDS[was] ? `|${WORDS[was]}` : ''})[ -]months?\\b`, 'i');
    const it = text.split(/(?<=[.!?])\s+|\n+/).find((s) => said.test(s) && /12H|left|clos|end(s|ing)\b|window|deadline|remain|before|april/i.test(s));
    if (it) return `"${said.exec(it)![0]}" was true when it was written, and it is now ${timeLeft(day, now)}`;
  }
  return '';
}
