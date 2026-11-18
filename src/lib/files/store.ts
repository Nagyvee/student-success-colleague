import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { fileDeleteDb, fileGetDb, filePutDb } from '@/lib/db/postgres';

/* Files people upload (PDF guides for parents, a prospectus, WhatsApp chat
 * exports). Kept on disk under .data/files and, when DATABASE_URL is set, in
 * Postgres too, so a redeploy on a host with a throwaway disk keeps them.
 * Reads try the disk first and refill it from the database. */

export const MAX_FILE_BYTES = 12 * 1024 * 1024;
/** Footage (short video clips) may be larger. */
export const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'x';
const dirFor = (tenantId: string) => path.join(process.cwd(), '.data', 'files', safe(tenantId));

export interface StoredFile { id: string; name: string; mime: string; size: number }

export async function putFile(input: { name: string; mime: string; data: Buffer; maxBytes?: number }, tenantId = currentTenantId()): Promise<StoredFile> {
  const max = input.maxBytes || MAX_FILE_BYTES;
  if (input.data.length > max) throw new Error(`That file is ${(input.data.length / 1048576).toFixed(1)} MB; the limit is ${Math.round(max / 1048576)} MB.`);
  const id = `f_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
  const name = input.name.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 140) || 'file';
  const dir = dirFor(tenantId);
  let onDisk = false;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, id), input.data);
    await fs.promises.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ name, mime: input.mime }));
    onDisk = true;
  } catch { /* read-only disk: the database copy is the only one */ }
  const inDb = await filePutDb({ id, name, mime: input.mime, data: input.data }, tenantId);
  if (!onDisk && !inDb) throw new Error('The file could not be stored (no writable disk and no database).');
  return { id, name, mime: input.mime, size: input.data.length };
}

export async function getFile(id: string, tenantId = currentTenantId()): Promise<{ name: string; mime: string; data: Buffer } | null> {
  if (!/^f_[a-z0-9]+$/.test(id)) return null;
  const dir = dirFor(tenantId);
  try {
    const data = await fs.promises.readFile(path.join(dir, id));
    const meta = JSON.parse(await fs.promises.readFile(path.join(dir, `${id}.json`), 'utf8')) as { name: string; mime: string };
    return { name: meta.name, mime: meta.mime, data };
  } catch { /* not on this disk */ }
  const row = await fileGetDb(id, tenantId);
  if (!row) return null;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, id), row.data);
    await fs.promises.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ name: row.name, mime: row.mime }));
  } catch { /* serve it anyway */ }
  return row;
}

export async function deleteFile(id: string, tenantId = currentTenantId()): Promise<void> {
  if (!/^f_[a-z0-9]+$/.test(id)) return;
  const dir = dirFor(tenantId);
  await fs.promises.rm(path.join(dir, id), { force: true }).catch(() => {});
  await fs.promises.rm(path.join(dir, `${id}.json`), { force: true }).catch(() => {});
  await fileDeleteDb(id, tenantId);
}
