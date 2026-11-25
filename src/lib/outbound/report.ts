import fs from 'node:fs';
import path from 'node:path';
import { monthsLeft } from './clock';

/* Our own copy of the skills report (July 2026, updated November 2026). It says
 * how long section 12H has left, so there is one file for each month and the
 * one that is true today is given. */

export const CLOSES = '2027-04-01';

export function reportName(now = Date.now()): string {
  const n = monthsLeft(CLOSES, now);
  return n === null ? 'skills-2026-closed.pdf' : `skills-2026-${Math.min(4, n)}.pdf`;
}

export const readReport = (now = Date.now()): Buffer => fs.readFileSync(path.join(process.cwd(), 'assets', 'skills-report', reportName(now)));
