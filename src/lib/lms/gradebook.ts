import type { SyncedLearnerRow } from '@/lib/types';
import { tenantDoc } from '@/lib/engine/tenantDoc';
import { currentTenantId } from '@/lib/auth/tenantContext';

/* Moodle's gradebooks and roster, kept in Thuso.
 *
 * Every sync saves each course's full gradebook (every grade item, graded or
 * not: quizzes, assignments, attendance, the course total, with teacher
 * feedback) and the full student rows (courses, groups, grades, progress).
 * The Students page and the agents read these saved copies, so grades and
 * groups are there when Moodle is slow, down, or simply not synced yet.
 * Saved to .data/ and, with DATABASE_URL, to Postgres (tenant_kv). */

export interface GbItem {
  id: number;
  name: string;
  /** quiz, assign, attendance, manual, category, ... */
  kind: string;
  max: number;
  /** Pass mark as a percentage, when the teacher set one. */
  pass: number | null;
  hidden?: boolean;
}

export interface GbCell {
  /** The raw grade. */
  g: number;
  /** As a percentage of the item's range. */
  pct: number | null;
  /** Teacher feedback (plain text). */
  f?: string;
  /** When it was graded or submitted (ms). */
  at?: number;
}

export interface GbStudent {
  id: string;
  name: string;
  email: string;
  /** Moodle groups (the intake) in this course; empty when the student is in none. */
  groups: string[];
  cells: Record<string, GbCell>;
  /** Course total, %. */
  total: number | null;
}

export interface CourseGradebook {
  courseId: number;
  code: string;
  name: string;
  groups: string[];
  items: GbItem[];
  students: GbStudent[];
  syncedAt: number;
}

const books = tenantDoc<{ courses: CourseGradebook[]; syncedAt: number | null }>('moodle-gradebook', () => ({ courses: [], syncedAt: null }));
const roster = tenantDoc<{ rows: SyncedLearnerRow[]; syncedAt: number | null }>('moodle-roster', () => ({ rows: [], syncedAt: null }));

export async function hydrateLmsSaved(tenantId = currentTenantId()) {
  await Promise.all([books.hydrate(tenantId), roster.hydrate(tenantId)]);
}

/* ── Gradebooks ── */

export function listGradebooks(tenantId = currentTenantId()) {
  return books.get(tenantId);
}

/** Replace the saved gradebooks with this sync's. A course Moodle could not read this time keeps its last copy. */
export function saveGradebooks(fresh: CourseGradebook[], tenantId = currentTenantId()) {
  if (!fresh.length) return;
  const prev = books.get(tenantId).courses;
  const ids = new Set(fresh.map((c) => c.courseId));
  const kept = prev.filter((c) => !ids.has(c.courseId) && Date.now() - c.syncedAt < 30 * 86_400_000);
  books.set({ courses: [...fresh, ...kept].sort((a, b) => a.code.localeCompare(b.code)), syncedAt: Date.now() }, tenantId);
}

/** One student's full gradebook across their courses. */
export function studentGradebook(studentId: string, tenantId = currentTenantId()) {
  return books.get(tenantId).courses
    .map((c) => {
      const s = c.students.find((x) => x.id === studentId);
      if (!s) return null;
      return {
        courseId: c.courseId, code: c.code, name: c.name, groups: s.groups, total: s.total, syncedAt: c.syncedAt,
        items: c.items.map((it) => ({ ...it, cell: s.cells[String(it.id)] || null })),
      };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
}

/** Class average per item (graded students only), for the gradebook's last row. */
export function itemAverages(c: CourseGradebook, students = c.students): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const it of c.items) {
    const vals = students.map((s) => s.cells[String(it.id)]?.pct).filter((v): v is number => typeof v === 'number');
    out[String(it.id)] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  return out;
}

/** CSV of one course's gradebook (optionally one group), the way Moodle exports it. */
export function gradebookCsv(c: CourseGradebook, group?: string): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const students = c.students.filter((s) => !group || (group === '__none__' ? !s.groups.length : s.groups.includes(group)));
  const head = ['Student', 'Email', 'Group', ...c.items.map((i) => `${i.name} (/${i.max})`), 'Course total %'];
  const lines = [head.map(cell).join(',')];
  for (const s of students) {
    lines.push([s.name, s.email, s.groups.join('; '), ...c.items.map((i) => { const x = s.cells[String(i.id)]; return x ? String(x.g) : ''; }), s.total == null ? '' : String(s.total)].map(cell).join(','));
  }
  return lines.join('\n');
}

/* ── The roster ── */

export function savedRoster(tenantId = currentTenantId()) {
  return roster.get(tenantId);
}

export function saveRoster(rows: SyncedLearnerRow[], tenantId = currentTenantId()) {
  if (!rows.length) return;
  roster.set({ rows, syncedAt: Date.now() }, tenantId);
}
