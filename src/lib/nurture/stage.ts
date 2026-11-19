/* A lead's stage: one definition for Lead Nurturing, the office's Leads drawer
 * and every count (they used to differ, so a qualified lead looked "cold" on
 * one screen and "qualified" on the other).
 *
 *   stopped (unsubscribed) > applied (or enrolled) > qualified (handed to the
 *   sales team) > hot > warming up > new
 *
 * Pure: safe to use on the server and in the browser. */

export type LeadStage = 'opted_out' | 'applied' | 'qualified' | 'hot' | 'warm' | 'cold';

export const LEAD_STAGE_LABEL: Record<LeadStage, string> = {
  qualified: 'Qualified', hot: 'Hot', warm: 'Warming up', cold: 'New', applied: 'Applied', opted_out: 'Stopped',
};

export function leadStage(l: { optedOut?: boolean; status?: string; qualified?: boolean; engagement?: string }): LeadStage {
  if (l.optedOut) return 'opted_out';
  if (/^(applied|enrolled|registered|student)$/i.test(l.status || '')) return 'applied';
  if (l.qualified) return 'qualified';
  return l.engagement === 'hot' ? 'hot' : l.engagement === 'warm' ? 'warm' : 'cold';
}
