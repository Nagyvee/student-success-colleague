import fs from 'node:fs';
import path from 'node:path';

/* Which copy is newer: the .data files on this machine, or the database?
 *
 * Every store is kept in two places: a file under .data (always written) and
 * Postgres (when it can be reached). When the database is unreachable, for
 * example the SSH tunnel is down, changes reach only the file. On the next
 * start with the database back, the store must not load the older database
 * copy over them.
 *
 * So each time a store is saved to the database, the time is written here.
 * On start: if the local file changed after its last confirmed database save,
 * the local copy wins and is pushed up; otherwise the database copy is loaded.
 * A store with no record yet (the first start with this check): a document
 * whose database row carries its own timestamp is compared with it; any other
 * store keeps the local copy if there is one, because until the app runs on
 * the VPS this machine is the only one writing to that database. */

type Marks = Record<string, Record<string, number>>;

const FILE = () => path.join(process.cwd(), '.data', 'db-sync.json');
const g = globalThis as unknown as { __thusoSyncMarks?: Marks };

function marks(): Marks {
  if (!g.__thusoSyncMarks) {
    try { g.__thusoSyncMarks = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Marks; } catch { g.__thusoSyncMarks = {}; }
  }
  return g.__thusoSyncMarks!;
}

/** A store reached the database just now. */
export function markSynced(store: string, tenantId: string, at = Date.now()) {
  const m = marks();
  (m[tenantId] ||= {})[store] = at;
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(m), 'utf8');
  } catch { /* read-only disk */ }
}

export function confirmedAt(store: string, tenantId: string): number | null {
  return marks()[tenantId]?.[store] ?? null;
}

export function fileTime(file: string): number | null {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

/** Seconds of slack for clocks and the gap between writing the file and the database. */
const SLACK_MS = 2000;

/**
 * Should the local copy win over the database's on start?
 * @param localMs when the local file last changed (null: there is none)
 * @param confirmedMs when this store was last confirmed in the database from here (null: never recorded)
 * @param dbMs when this store's database copy last changed, if the database records it (used only when nothing is recorded here)
 */
export function localWins(localMs: number | null, confirmedMs: number | null, dbMs: number | null): boolean {
  if (localMs == null) return false;
  if (confirmedMs != null) return localMs > confirmedMs + SLACK_MS;
  if (dbMs == null) return true;
  return localMs > dbMs + SLACK_MS;
}
