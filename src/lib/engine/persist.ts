import fs from 'node:fs';
import path from 'node:path';
import type { WorldState } from '@/lib/types';
import { syncWorldToDb } from '@/lib/db/postgres';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';

/* Per-tenant archive across restarts (.data/world.json or .data/tenants/<id>/world.json)
 * mirrored asynchronously to PostgreSQL when DATABASE_URL is set. */

const DIR = path.join(process.cwd(), '.data');

function fileFor(tenantId = currentTenantId()): string {
  return tenantId === DEFAULT_TENANT_ID
    ? path.join(DIR, 'world.json')
    : path.join(DIR, 'tenants', tenantId, 'world.json');
}

export type Archive = Pick<WorldState, 'deliverables' | 'inbox' | 'learners' | 'metrics' | 'tasks' | 'feed' | 'pendingOutreach'>;

export function loadArchive(tenantId = currentTenantId()): Partial<Archive> | null {
  try {
    const file = fileFor(tenantId);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as Partial<Archive>;
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

const timers = new Map<string, NodeJS.Timeout>();
export function scheduleSave(get: () => WorldState, tenantId = currentTenantId()) {
  if (timers.has(tenantId)) return;
  const t = setTimeout(() => {
    timers.delete(tenantId);
    try {
      const s = get();
      const archive: Archive = {
        deliverables: s.deliverables,
        inbox: s.inbox,
        learners: s.learners,
        metrics: s.metrics,
        tasks: s.tasks,
        feed: s.feed.slice(-80),
        pendingOutreach: s.pendingOutreach || [],
      };
      const file = fileFor(tenantId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(archive), 'utf8');
      void syncWorldToDb(archive, tenantId);
    } catch {
      /* no disk, no memory: the demo still runs */
    }
  }, 600);
  timers.set(tenantId, t);
}

export function clearArchive(tenantId = currentTenantId()) {
  try {
    const file = fileFor(tenantId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* ignore */ }
}
