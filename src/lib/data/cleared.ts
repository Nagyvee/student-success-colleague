import type { DataRecord } from '@/lib/types';
import { tenantDoc } from '@/lib/engine/tenantDoc';
import { currentTenantId } from '@/lib/auth/tenantContext';

/* Leads cleared from a list (Lead Nurturing → Leads → Clean up) stay cleared:
 * the sheet and dialer readers skip them, unless the person enquires again
 * (a new form submission or dialer row looks different). */

/** sourceId → record key → what their row looked like when cleared. */
const clearedDoc = tenantDoc<Record<string, Record<string, string>>>('cleared-leads', () => ({}));

/** What tells a new enquiry from the same old row: the form's lead id or time, the dialer's row. */
export function enquirySignature(fields: Record<string, string>): string {
  return String(fields.agent_dialer_row_id || fields.dialer_row_id || fields.id || fields.lead_id || fields.created_time || fields.created_at || fields.timestamp || fields.submitted_at || '').trim();
}

/** A row that was cleared and has not changed since: the readers skip it. */
export function isCleared(sourceId: string, rec: Pick<DataRecord, 'key' | 'fields'>, tenantId = currentTenantId()): boolean {
  const bucket = clearedDoc.get(tenantId)[sourceId];
  const was = bucket?.[rec.key];
  if (was === undefined) return false;
  const now = enquirySignature(rec.fields);
  if (!was || !now || now === was) return true;
  // They enquired again: welcome back.
  delete bucket[rec.key];
  clearedDoc.save(tenantId);
  return false;
}

/** Remember these as cleared. */
export function markCleared(sourceId: string, recs: Pick<DataRecord, 'key' | 'fields'>[], tenantId = currentTenantId()): void {
  const doc = clearedDoc.get(tenantId);
  const bucket = (doc[sourceId] ||= {});
  for (const r of recs) bucket[r.key] = enquirySignature(r.fields);
  clearedDoc.save(tenantId);
}

/** How many are remembered as cleared. */
export function clearedCount(sourceId: string, tenantId = currentTenantId()): number {
  return Object.keys(clearedDoc.get(tenantId)[sourceId] || {}).length;
}
