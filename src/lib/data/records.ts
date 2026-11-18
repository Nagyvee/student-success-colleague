import type { DataRecord } from '@/lib/types';
import { tenantDoc } from '@/lib/engine/tenantDoc';

/* Every record the agents work on: tracker rows, fee rows, leads, prospects.
 *
 * Keyed by data source, then by a stable key (email, else id, else row). A
 * sheet is the source of truth for its columns; fields the agents write
 * (lead_score, research_brief, last_contacted) are kept across re-reads. */

type RecordsDoc = Record<string, Record<string, DataRecord>>;

const doc = tenantDoc<RecordsDoc>('records', () => ({}));

/** Fields an agent wrote, kept when the sheet is read again. */
const AGENT_FIELD_PREFIX = 'agent_';

export function hydrateRecords(tenantId?: string) {
  return doc.hydrate(tenantId);
}

export function listRecords(sourceId?: string): DataRecord[] {
  const all = doc.get();
  if (sourceId) return Object.values(all[sourceId] || {});
  return Object.values(all).flatMap((m) => Object.values(m));
}

export function countRecords(sourceId: string): number {
  return Object.keys(doc.get()[sourceId] || {}).length;
}

export function getRecord(sourceId: string | null | undefined, key: string): DataRecord | null {
  if (!sourceId) return findRecordByKey(key);
  return doc.get()[sourceId]?.[key] || null;
}

export function findRecordByKey(key: string): DataRecord | null {
  for (const m of Object.values(doc.get())) if (m[key]) return m[key];
  return null;
}

export function findRecordsByEmail(email: string): DataRecord[] {
  const e = email.trim().toLowerCase();
  if (!e) return [];
  return listRecords().filter((r) => r.email.toLowerCase() === e);
}

export function recordKey(input: { email?: string; id?: string; row?: number }): string {
  const email = (input.email || '').trim().toLowerCase();
  if (email && email.includes('@')) return email;
  const id = (input.id || '').trim();
  if (id) return `id:${id}`;
  return `row:${input.row ?? Date.now()}`;
}

export interface UpsertResult { record: DataRecord; created: boolean; changed: string[] }

/** Insert or update a record. Agent-written fields survive a sheet re-read. */
export function upsertRecord(sourceId: string, input: Omit<DataRecord, 'sourceId' | 'firstSeenAt' | 'updatedAt'>): UpsertResult {
  const all = doc.get();
  const bucket = (all[sourceId] ||= {});
  const prev = bucket[input.key];
  const now = Date.now();
  if (!prev) {
    const record: DataRecord = { ...input, sourceId, firstSeenAt: now, updatedAt: now };
    bucket[input.key] = record;
    doc.save();
    return { record, created: true, changed: [] };
  }
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(prev.fields)) {
    if (!k.startsWith(AGENT_FIELD_PREFIX)) continue;
    kept[k] = v;
    // and its plain alias (lead_score for agent_lead_score), unless the sheet has that column
    const alias = k.slice(AGENT_FIELD_PREFIX.length);
    if (!(alias in input.fields)) kept[alias] = v;
  }
  const fields = { ...kept, ...input.fields };
  const changed: string[] = [];
  for (const k of new Set([...Object.keys(prev.fields), ...Object.keys(fields)])) {
    if (k.startsWith(AGENT_FIELD_PREFIX)) continue;
    if ((prev.fields[k] ?? '') !== (fields[k] ?? '')) changed.push(k);
  }
  if (prev.name !== input.name) changed.push('name');
  if (prev.email !== input.email) changed.push('email');
  if (prev.phone !== input.phone) changed.push('phone');
  if (!changed.length) return { record: prev, created: false, changed };
  const record: DataRecord = { ...prev, ...input, fields, sourceId, updatedAt: now };
  bucket[input.key] = record;
  doc.save();
  return { record, created: false, changed: [...new Set(changed)] };
}

/** An agent writes a field on a record (stored as agent_<field> unless it is a sheet column). */
export function setRecordField(sourceId: string | null, key: string, field: string, value: string): DataRecord | null {
  const rec = getRecord(sourceId, key);
  if (!rec) return null;
  const isColumn = field in rec.fields && !field.startsWith(AGENT_FIELD_PREFIX);
  const name = isColumn ? field : field.startsWith(AGENT_FIELD_PREFIX) ? field : `${AGENT_FIELD_PREFIX}${field}`;
  rec.fields[name] = value;
  // Also expose it under its plain name so conditions and templates can use either.
  if (!isColumn) rec.fields[field.replace(new RegExp(`^${AGENT_FIELD_PREFIX}`), '')] = value;
  rec.updatedAt = Date.now();
  doc.save();
  return rec;
}

export interface Turn { w: 'them' | 'us'; t: string; ts: number; by?: string }

/** The conversation with a person, newest last (kept short: the agents read it before they reply). */
export function getConversation(rec: Pick<DataRecord, 'fields'> | null | undefined): Turn[] {
  try {
    const list = JSON.parse(rec?.fields.conversation || '[]');
    return Array.isArray(list) ? (list as Turn[]).filter((x) => x && (x.w === 'them' || x.w === 'us') && typeof x.t === 'string') : [];
  } catch {
    return [];
  }
}

/** Add a turn: what they wrote, or what we sent. */
export function appendConversation(sourceId: string | null, key: string, who: Turn['w'], text: string, by?: string, max = 10): void {
  const rec = getRecord(sourceId, key);
  if (!rec || !text.trim()) return;
  const list = [...getConversation(rec), { w: who, t: text.replace(/\s+/g, ' ').trim().slice(0, 500), ts: Date.now(), ...(by ? { by } : {}) }];
  setRecordField(rec.sourceId, rec.key, 'conversation', JSON.stringify(list.slice(-max)));
}

export function removeSourceRecords(sourceId: string) {
  const all = doc.get();
  if (all[sourceId]) {
    delete all[sourceId];
    doc.save();
  }
}
