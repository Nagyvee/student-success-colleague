import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import { kvGetRow, kvSetJson } from '@/lib/db/postgres';
import { serialWriter } from '@/lib/db/serialWriter';
import { confirmedAt, fileTime, localWins, markSynced } from '@/lib/db/syncState';

/* One persisted document per workspace.
 *
 * In memory for speed, written to .data/ so a restart keeps it, and to
 * Postgres (tenant_kv) when DATABASE_URL is set so a redeploy keeps it too.
 * Writes are debounced; hydrate() reads the database copy once on boot.
 * New stores use this instead of inventing another persistence pattern. */

interface Slot<T> { value: T; timer: ReturnType<typeof setTimeout> | null; hydrated: boolean }

export interface TenantDoc<T> {
  get(tenantId?: string): T;
  set(value: T, tenantId?: string): void;
  /** Persist after an in-place change to get()'s value. */
  save(tenantId?: string): void;
  hydrate(tenantId?: string): Promise<void>;
}

export function tenantDoc<T>(name: string, init: () => T): TenantDoc<T> {
  const g = globalThis as unknown as Record<string, Map<string, Slot<T>> | undefined>;
  const key = `__thusoDoc_${name}`;
  const map: Map<string, Slot<T>> = (g[key] ??= new Map());

  const fileFor = (tid: string) => (tid === DEFAULT_TENANT_ID
    ? path.join(process.cwd(), '.data', `${name}.json`)
    : path.join(process.cwd(), '.data', 'tenants', tid, `${name}.json`));

  function slot(tid: string): Slot<T> {
    let s = map.get(tid);
    if (!s) {
      let value: T;
      try { value = JSON.parse(fs.readFileSync(fileFor(tid), 'utf8')) as T; } catch { value = init(); }
      s = { value, timer: null, hydrated: false };
      map.set(tid, s);
    }
    return s;
  }

  const mark = `doc:${name}`;

  function writeFile(tid: string) {
    const file = fileFor(tid);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(slot(tid).value), 'utf8');
    } catch { /* read-only disk: the database copy still holds it */ }
  }

  // One copy at a time to the database, the newest last (see serialWriter); "synced" is the time of the
  // copy the database actually holds, so a later change that reached only the file wins on the next start.
  const pushers = new Map<string, ReturnType<typeof serialWriter<string>>>();
  function pushUp(tid: string) {
    let push = pushers.get(tid);
    if (!push) {
      push = serialWriter<string>((json) => kvSetJson(name, json, tid), (takenAt) => markSynced(mark, tid, takenAt));
      pushers.set(tid, push);
    }
    void push(() => JSON.stringify(slot(tid).value));
  }
  function flush(tid: string) {
    writeFile(tid);
    pushUp(tid);
  }

  return {
    get(tid = currentTenantId()) { return slot(tid).value; },
    set(value: T, tid = currentTenantId()) { slot(tid).value = value; this.save(tid); },
    save(tid = currentTenantId()) {
      const s = slot(tid);
      if (s.timer) return;
      s.timer = setTimeout(() => { s.timer = null; flush(tid); }, 400);
    },
    async hydrate(tid = currentTenantId()) {
      const s = slot(tid);
      if (s.hydrated) return;
      s.hydrated = true;
      const row = await kvGetRow<T>(name, tid);
      // Database unreachable: keep the local copy; the next save sends it up.
      if (row === undefined) return;
      const local = fileTime(fileFor(tid));
      if (row === null || localWins(local, confirmedAt(mark, tid), row.updatedAt)) {
        // Nothing in the database yet, or this copy changed while the database was unreachable: send it up.
        if (local != null || row === null) pushUp(tid);
        return;
      }
      s.value = row.value;
      writeFile(tid);
      markSynced(mark, tid);
    },
  };
}
