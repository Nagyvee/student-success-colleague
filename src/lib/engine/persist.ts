import fs from 'node:fs';
import path from 'node:path';
import type { WorldState } from '@/lib/types';

/* The office remembers its archive across restarts.
 *
 * Deliverables, the sent inbox, learner statuses and the metrics are written
 * to .data/world.json a moment after they change, and read back when the
 * server boots. Avatars always start the day at their desks. Everything here
 * fails quietly: on a read-only disk the office simply forgets on restart. */

const DIR = path.join(process.cwd(), '.data');
const FILE = path.join(DIR, 'world.json');

export type Archive = Pick<WorldState, 'deliverables' | 'inbox' | 'learners' | 'metrics' | 'tasks' | 'feed'>;

export function loadArchive(): Partial<Archive> | null {
  try {
    if (!fs.existsSync(FILE)) return null;
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw) as Partial<Archive>;
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

let timer: NodeJS.Timeout | null = null;
export function scheduleSave(get: () => WorldState) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      const s = get();
      const archive: Archive = {
        deliverables: s.deliverables,
        inbox: s.inbox,
        learners: s.learners,
        metrics: s.metrics,
        tasks: s.tasks,
        feed: s.feed.slice(-80),
      };
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(archive), 'utf8');
    } catch {
      /* no disk, no memory: the demo still runs */
    }
  }, 600);
}

export function clearArchive() {
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* ignore */ }
}
