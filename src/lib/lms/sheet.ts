import fs from 'node:fs';
import { sendingPaused } from '@/lib/email/pause';
import path from 'node:path';
import { sandboxAdapter } from './lmsAdapter';
import { MODULES, SEED } from './sandboxData';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { mergeLearnerPatchByEmailOrId } from '@/lib/db/postgres';
import { getState, setLearner, setLearners } from '@/lib/engine/store';

/* A Google Sheet as the live learner record.
 *
 * Share the sheet as "Anyone with the link: Viewer" and paste its link in
 * Settings (or set GOOGLE_SHEET_URL). Thuso reads it as CSV every few seconds:
 * no Google login, no API key. The first read is the baseline; after that,
 * every change to a learner's checkpoint score or days since login, and every
 * new row, becomes an event the colleague acts on, by itself.
 *
 * Optional write-back: deploy the Apps Script in the README as a web app and
 * set SHEET_WRITEBACK_URL; the colleague then writes each learner's status
 * into the sheet's status column. */

export const COLUMNS = [
  'learner_id', 'name', 'email', 'cohort', 'programme', 'current_module',
  'checkpoint_score', 'days_since_login', 'missed_classes', 'missed_assignments', 'payment_status',
  'status', 'last_update',
] as const;

export type PaymentStatus = 'ok' | 'overdue' | 'arrangement';

export interface SheetRow {
  id: string; name: string; email: string; cohort: string; programme: string; module: string;
  score: number | null; days: number | null;
  missedClasses: number | null; missedAssignments: number | null; paymentStatus: PaymentStatus | null;
}

export interface SheetChange {
  row: SheetRow;
  kind: 'added' | 'score' | 'days' | 'attendance' | 'assignment' | 'payment';
  from: number | string | null;
  to: number | string | null;
}

type Hub = { url: string | null; csv: string | null; last: Map<string, SheetRow> | null; timer: ReturnType<typeof setInterval> | null; lastReadAt: number | null; lastError: string | null; rows: number; lastChangeAt: number | null };
const g = globalThis as unknown as { __ssSheets?: Map<string, Hub> };

function configFile(tenantId = currentTenantId()): string {
  return tenantId === DEFAULT_TENANT_ID
    ? path.join(process.cwd(), '.data', 'sheet.json')
    : path.join(process.cwd(), '.data', 'tenants', tenantId, 'sheet.json');
}

function hub(tenantId = currentTenantId()): Hub {
  if (!g.__ssSheets) g.__ssSheets = new Map();
  if (!g.__ssSheets.has(tenantId)) {
    const ti = getTenantIntegrations(tenantId);
    let url = ti.googleSheetUrl || (tenantId === DEFAULT_TENANT_ID ? process.env.GOOGLE_SHEET_URL : null) || null;
    try { url = JSON.parse(fs.readFileSync(configFile(tenantId), 'utf8')).url || url; } catch { /* none saved */ }
    g.__ssSheets.set(tenantId, { url, csv: url ? toCsvUrl(url) : null, last: null, timer: null, lastReadAt: null, lastError: null, rows: 0, lastChangeAt: null });
  }
  return g.__ssSheets.get(tenantId)!;
}

/** Any Google Sheets link (edit, view or export) → its CSV export link. */
export function toCsvUrl(url: string): string | null {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return /^https?:\/\/.+\.csv(\?.*)?$/.test(url) || /output=csv|format=csv/.test(url) ? url : null;
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

export function sheetStatus() {
  const h = hub();
  return { connected: Boolean(h.csv), url: h.url, rows: h.rows, lastReadAt: h.lastReadAt, lastError: h.lastError, lastChangeAt: h.lastChangeAt };
}

export function setSheetUrl(url: string | null, tenantId = currentTenantId()) {
  const h = hub(tenantId);
  const csv = url ? toCsvUrl(url.trim()) : null;
  if (url && !csv) throw new Error('That is not a Google Sheets link.');
  h.url = url ? url.trim() : null; h.csv = csv; h.last = null; h.rows = 0; h.lastError = null;
  const file = configFile(tenantId);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ url: h.url })); } catch { /* read-only disk: keep it in memory */ }
}

export async function testSheetConnection(url: string): Promise<{ ok: true; rows: number; columns: string[] } | { ok: false; error: string }> {
  const csv = toCsvUrl(url.trim());
  if (!csv) return { ok: false, error: 'That is not a valid Google Sheets or CSV link.' };
  try {
    const res = await fetch(`${csv}${csv.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, error: `Google answered HTTP ${res.status}. Share the sheet as "Anyone with the link: Viewer".` };
    const text = await res.text();
    if (/^\s*<!DOCTYPE html|<html/i.test(text)) return { ok: false, error: 'Google returned a sign-in page instead of CSV. Set sharing to "Anyone with the link: Viewer".' };
    const parsed = parseCsv(text);
    const columns = (parsed[0] || []).map((c) => c.trim()).filter(Boolean);
    const rows = toRows(text);
    return { ok: true, rows: rows.length, columns };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/* ── CSV ──────────────────────────────────────────────────────────────────── */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const num = (s: string | undefined) => { const n = Number(String(s ?? '').replace('%', '').trim()); return s !== undefined && String(s).trim() !== '' && Number.isFinite(n) ? n : null; };

const pay = (s: string | undefined): PaymentStatus | null => {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v) return null;
  if (/overdue|unpaid|missed|late|arrears|owing|hold/.test(v)) return 'overdue';
  if (/arrang|plan|partial/.test(v)) return 'arrangement';
  if (/ok|paid|clear|current/.test(v)) return 'ok';
  return null;
};

function toRows(text: string): SheetRow[] {
  const [head, ...body] = parseCsv(text);
  if (!head) return [];
  const idx = (...names: string[]) => head.findIndex((h) => names.includes(h.trim().toLowerCase().replace(/\s+/g, '_')));
  const c = {
    id: idx('learner_id', 'id', 'student_id'), name: idx('name', 'learner', 'student'), email: idx('email'), cohort: idx('cohort', 'class'),
    programme: idx('programme', 'program', 'course'), module: idx('current_module', 'module'),
    score: idx('checkpoint_score', 'score', 'mark', 'checkpoint'), days: idx('days_since_login', 'days_quiet', 'days_since_last_login'),
    missedClasses: idx('missed_classes', 'absences', 'classes_missed', 'attendance_missed'),
    missedAssignments: idx('missed_assignments', 'overdue_assignments', 'missing_submissions'),
    paymentStatus: idx('payment_status', 'fees_status', 'billing_status', 'tuition_status'),
  };
  return body.map((r, i) => ({
    id: (c.id >= 0 && r[c.id]?.trim()) || `ROW-${i + 2}`,
    name: (c.name >= 0 && r[c.name]?.trim()) || `Learner ${i + 1}`,
    email: (c.email >= 0 && r[c.email]?.trim()) || '',
    cohort: (c.cohort >= 0 && r[c.cohort]?.trim()) || 'FSWD-2026-Q3',
    programme: (c.programme >= 0 && r[c.programme]?.trim()) || '',
    module: ((c.module >= 0 && r[c.module]?.trim()) || '').toUpperCase(),
    score: c.score >= 0 ? num(r[c.score]) : null,
    days: c.days >= 0 ? num(r[c.days]) : null,
    missedClasses: c.missedClasses >= 0 ? num(r[c.missedClasses]) : null,
    missedAssignments: c.missedAssignments >= 0 ? num(r[c.missedAssignments]) : null,
    paymentStatus: c.paymentStatus >= 0 ? pay(r[c.paymentStatus]) : null,
  })).filter((r) => r.name);
}

/** Match existing PostgreSQL/LMS learner by email or id and merge sheet fields without creating duplicates. */
async function apply(r: SheetRow, isChange: boolean): Promise<string> {
  const cleanEmail = r.email.trim().toLowerCase();
  const state = getState();
  const inMemory = state.learners.find(
    (l) => l.id === r.id || (cleanEmail && l.email.trim().toLowerCase() === cleanEmail),
  );
  const targetIdHint = inMemory?.id || r.id;

  const { row: merged, created } = await mergeLearnerPatchByEmailOrId({
    id: targetIdHint,
    name: r.name,
    email: r.email || undefined,
    cohort: r.cohort,
    programme: r.programme,
    module: r.module || undefined,
    checkpoint: r.score,
    daysSinceLogin: r.days,
    missedClasses: r.missedClasses,
    missedAssignments: r.missedAssignments,
    paymentStatus: r.paymentStatus,
    lastEvent: isChange ? 'Google Sheet updated' : undefined,
    source: inMemory ? undefined : 'sheet',
  });

  r.id = merged.id;
  if (inMemory) {
    setLearner(merged.id, {
      riskScore: merged.riskScore ?? inMemory.riskScore,
      quizAvg: merged.avgScore ?? merged.checkpoint ?? inMemory.quizAvg,
      lastLoginDays: merged.daysSinceLogin ?? inMemory.lastLoginDays,
      weakTopic: merged.weakTopic ?? inMemory.weakTopic,
      status:
        merged.status === 'at_risk' || merged.status === 'intervention' || merged.status === 'recovered'
          ? merged.status
          : inMemory.status,
      lastEvent: merged.lastEvent ?? inMemory.lastEvent,
    });
  } else if (created || !state.learners.some((l) => l.id === merged.id)) {
    setLearners([
      ...state.learners,
      {
        id: merged.id,
        name: merged.name,
        email: merged.email,
        cohort: merged.cohort,
        programme: merged.programme || 'Enrolled Programme',
        status:
          merged.status === 'at_risk' || merged.status === 'intervention' || merged.status === 'recovered'
            ? merged.status
            : 'on_track',
        riskScore: merged.riskScore ?? 10,
        weakTopic: merged.weakTopic || null,
        lastLoginDays: merged.daysSinceLogin ?? 0,
        completion: merged.completionPct ?? 50,
        quizAvg: merged.avgScore ?? merged.checkpoint ?? 0,
        lastEvent: merged.lastEvent || null,
      },
    ]);
  }

  // Keep sandbox adapter mirrored on the canonical ID for stage/fallback consistency
  const lms = sandboxAdapter();
  if (!lms.knows(merged.id)) {
    lms.addLearner({
      id: merged.id,
      name: merged.name,
      email: merged.email || `${merged.name.toLowerCase().replace(/[^a-z]+/g, '.')}@student.example.com`,
      cohort: merged.cohort,
      programme: merged.programme,
      module: r.module,
    });
  }
  lms.override(merged.id, { name: merged.name, ...(merged.email ? { email: merged.email } : {}), cohort: merged.cohort });
  const patch: { checkpoint?: number; daysQuiet?: number; missedClasses?: number; missedAssignments?: number; paymentStatus?: PaymentStatus } = {};
  if (r.score !== null) patch.checkpoint = Math.max(0, Math.min(100, r.score));
  if (r.days !== null) patch.daysQuiet = Math.max(0, Math.round(r.days));
  if (r.missedClasses !== null) patch.missedClasses = Math.max(0, Math.round(r.missedClasses));
  if (r.missedAssignments !== null) patch.missedAssignments = Math.max(0, Math.round(r.missedAssignments));
  if (r.paymentStatus !== null) patch.paymentStatus = r.paymentStatus;
  if (Object.keys(patch).length) lms.edit(merged.id, patch);
  return merged.id;
}

/** Read the sheet once. Returns the changes since the last read (none on the first). */
export async function readSheet(): Promise<SheetChange[]> {
  const h = hub();
  if (!h.csv) return [];
  try {
    const res = await fetch(`${h.csv}${h.csv.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Google answered ${res.status}. Is the sheet shared as "Anyone with the link"?`);
    const text = await res.text();
    if (/^\s*<!DOCTYPE html|<html/i.test(text)) throw new Error('Google returned a sign-in page. Share the sheet as "Anyone with the link: Viewer".');
    const rows = toRows(text);
    h.lastReadAt = Date.now(); h.lastError = null; h.rows = rows.length;
    const keyFor = (r: SheetRow) => (r.email ? r.email.trim().toLowerCase() : r.id);
    const now = new Map<string, SheetRow>();
    const changes: SheetChange[] = [];
    if (!h.last) {
      for (const r of rows) {
        await apply(r, false);
        now.set(keyFor(r), r);
      }
    } else {
      for (const r of rows) {
        const k = keyFor(r);
        const was = h.last.get(k) || h.last.get(r.id);
        if (!was) {
          await apply(r, true);
          now.set(keyFor(r), r);
          changes.push({ row: r, kind: 'added', from: null, to: r.score });
          continue;
        }
        if (r.score !== was.score) { await apply(r, true); changes.push({ row: r, kind: 'score', from: was.score, to: r.score }); }
        else if (r.missedClasses !== was.missedClasses && (r.missedClasses ?? 0) > (was.missedClasses ?? 0)) { await apply(r, true); changes.push({ row: r, kind: 'attendance', from: was.missedClasses, to: r.missedClasses }); }
        else if (r.missedAssignments !== was.missedAssignments && (r.missedAssignments ?? 0) > (was.missedAssignments ?? 0)) { await apply(r, true); changes.push({ row: r, kind: 'assignment', from: was.missedAssignments, to: r.missedAssignments }); }
        else if (r.paymentStatus !== was.paymentStatus && r.paymentStatus === 'overdue') { await apply(r, true); changes.push({ row: r, kind: 'payment', from: was.paymentStatus, to: r.paymentStatus }); }
        else if (r.days !== was.days) { await apply(r, true); changes.push({ row: r, kind: 'days', from: was.days, to: r.days }); }
        else if (r.name !== was.name || r.email !== was.email) await apply(r, false);
        now.set(keyFor(r), r);
      }
    }
    h.last = now;
    if (changes.length) h.lastChangeAt = Date.now();
    return changes;
  } catch (e) {
    h.lastError = (e as Error).message;
    return [];
  }
}

/** The starter sheet: every sandbox learner as a row, ready to import into Google Sheets. */
export function templateCsv() {
  const esc = (v: unknown) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const lines = [COLUMNS.join(',')];
  for (const s of SEED) {
    const cur = s.engagement.currentModule.code;
    const cp = [...s.assessments].reverse().find((a) => a.moduleCode === cur && a.kind === 'quiz');
    lines.push([s.profile.id, s.profile.name, s.profile.email, s.profile.cohort, s.profile.programme, cur, cp ? cp.scorePct : '', s.engagement.daysSinceLastLogin, 0, 0, 'ok', 'on_track', ''].map(esc).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Tell the sheet what happened, if a write-back web app is configured. */
export async function writeBack(id: string, status: string, note: string) {
  const ti = getTenantIntegrations(currentTenantId());
  const url = ti.sheetWritebackUrl || (currentTenantId() === DEFAULT_TENANT_ID ? process.env.SHEET_WRITEBACK_URL : '');
  if (!url || sendingPaused()) return false;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ learner_id: id, status, last_update: note }), redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch { return false; }
}

export const MODULE_CODES = MODULES.map((m) => m.code);
