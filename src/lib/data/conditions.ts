import type { ConditionOp, StepCondition } from '@/lib/types';

/* Rule conditions, evaluated in code so the same record always gets the same
 * answer. AI conditions (a question the agent answers) live in agentMind. */

/** "R 1 500,00", "1,500.00", "R1500" → 1500. Empty or not a number → null. */
export function parseMoney(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  let t = String(raw).trim();
  if (!t) return null;
  t = t.replace(/[^\d,.-]/g, '');
  if (!t || t === '-' ) return null;
  // "1 500,50" or "1500,50" (comma decimal) vs "1,500.50" (comma thousands)
  if (/,\d{1,2}$/.test(t) && !/\.\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** 2026-11-20, 20/11/2026, 20-11-2026, 20 Nov 2026, Nov 20 2026 → a Date at local midnight. */
export function parseDate(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    // South African sheets write day first.
    const y = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    return new Date(y, Number(m[2]) - 1, Number(m[1]));
  }
  const month = (name: string) => MONTHS[name.slice(0, 3).toLowerCase()];
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
  if (m && month(m[2]) !== undefined) return new Date(Number(m[3]), month(m[2]), Number(m[1]));
  m = t.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && month(m[1]) !== undefined) return new Date(Number(m[3]), month(m[1]), Number(m[2]));
  if (/^\d{5}$/.test(t)) {
    // A Google Sheets serial date that came through as a number.
    const d = new Date(Date.UTC(1899, 11, 30) + Number(t) * 86_400_000);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days from today to the date (negative when it has passed). */
export function daysUntil(d: Date, now = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

const numeric = (v: string) => {
  const money = parseMoney(v);
  return money !== null ? money : (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
};

export const OP_LABEL: Record<ConditionOp, string> = {
  eq: 'is', neq: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  contains: 'contains', empty: 'is empty', not_empty: 'is not empty',
  days_until_lte: 'is due within (days)', days_since_gte: 'was at least (days) ago',
};

/** Evaluate a rule against a record's fields. AI conditions return null (the caller asks the agent). */
export function evalRule(c: StepCondition, fields: Record<string, string>, now = new Date()): boolean | null {
  if (c.mode === 'ai') return null;
  const field = (c.field || '').trim();
  const op: ConditionOp = c.op || 'eq';
  const raw = field ? String(fields[field] ?? '') : '';
  const actual = raw.trim().toLowerCase();
  const want = String(c.value ?? '').trim().toLowerCase();
  switch (op) {
    case 'empty': return actual === '';
    case 'not_empty': return actual !== '';
    case 'eq': return actual === want;
    case 'neq': return actual !== want;
    case 'contains': return want !== '' && actual.includes(want);
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = numeric(raw); const b = numeric(String(c.value ?? ''));
      if (a === null || b === null) return false;
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
    case 'days_until_lte': {
      const d = parseDate(raw); const n = Number(c.value);
      if (!d || !Number.isFinite(n)) return false;
      return daysUntil(d, now) <= n;
    }
    case 'days_since_gte': {
      const d = parseDate(raw); const n = Number(c.value);
      if (!d || !Number.isFinite(n)) return false;
      return -daysUntil(d, now) >= n;
    }
    default: return false;
  }
}

/** All rules hold (AI rules are skipped here; they are not allowed in trigger filters). */
export function matchesAll(rules: StepCondition[] | undefined, fields: Record<string, string>, now = new Date()): boolean {
  if (!rules?.length) return true;
  return rules.every((r) => r.mode === 'ai' || evalRule(r, fields, now) === true);
}

export function describeCondition(c: StepCondition | undefined): string {
  if (!c) return 'always';
  if (c.mode === 'ai') return c.question?.trim() || 'the agent decides';
  const op = OP_LABEL[c.op || 'eq'];
  return ['empty', 'not_empty'].includes(c.op || '') ? `${c.field} ${op}` : `${c.field} ${op} ${c.value ?? ''}`.trim();
}
