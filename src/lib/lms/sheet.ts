import fs from 'node:fs';
import path from 'node:path';
import { sandboxAdapter } from './lmsAdapter';
import { MODULES, SEED } from './sandboxData';

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

export const COLUMNS = ['learner_id', 'name', 'email', 'cohort', 'programme', 'current_module', 'checkpoint_score', 'days_since_login', 'status', 'last_update'] as const;

export interface SheetRow { id: string; name: string; email: string; cohort: string; programme: string; module: string; score: number | null; days: number | null }

export interface SheetChange {
  row: SheetRow;
  kind: 'added' | 'score' | 'days';
  from: number | null;
  to: number | null;
}

type Hub = { url: string | null; csv: string | null; last: Map<string, SheetRow> | null; timer: ReturnType<typeof setInterval> | null; lastReadAt: number | null; lastError: string | null; rows: number; lastChangeAt: number | null };
const g = globalThis as unknown as { __ssSheet?: Hub };
const CONFIG = path.join(process.cwd(), '.data', 'sheet.json');

function hub(): Hub {
  if (!g.__ssSheet) {
    let url = process.env.GOOGLE_SHEET_URL || null;
    try { url = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).url || url; } catch { /* none saved */ }
    g.__ssSheet = { url, csv: url ? toCsvUrl(url) : null, last: null, timer: null, lastReadAt: null, lastError: null, rows: 0, lastChangeAt: null };
  }
  return g.__ssSheet;
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

export function setSheetUrl(url: string | null) {
  const h = hub();
  const csv = url ? toCsvUrl(url.trim()) : null;
  if (url && !csv) throw new Error('That is not a Google Sheets link.');
  h.url = url ? url.trim() : null; h.csv = csv; h.last = null; h.rows = 0; h.lastError = null;
  try { fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify({ url: h.url })); } catch { /* read-only disk: keep it in memory */ }
}

/* ── CSV ──────────────────────────────────────────────────────────────────── */

function parseCsv(text: string): string[][] {
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

function toRows(text: string): SheetRow[] {
  const [head, ...body] = parseCsv(text);
  if (!head) return [];
  const idx = (...names: string[]) => head.findIndex((h) => names.includes(h.trim().toLowerCase().replace(/\s+/g, '_')));
  const c = {
    id: idx('learner_id', 'id', 'student_id'), name: idx('name', 'learner', 'student'), email: idx('email'), cohort: idx('cohort', 'class'),
    programme: idx('programme', 'program', 'course'), module: idx('current_module', 'module'),
    score: idx('checkpoint_score', 'score', 'mark', 'checkpoint'), days: idx('days_since_login', 'days_quiet', 'days_since_last_login'),
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
  })).filter((r) => r.name);
}

/** Make the sandbox match the sheet for one row. */
function apply(r: SheetRow) {
  const lms = sandboxAdapter();
  if (!lms.knows(r.id)) lms.addLearner({ id: r.id, name: r.name, email: r.email || `${r.name.toLowerCase().replace(/[^a-z]+/g, '.')}@student.example.com`, cohort: r.cohort, programme: r.programme, module: r.module });
  lms.override(r.id, { name: r.name, ...(r.email ? { email: r.email } : {}), cohort: r.cohort });
  const patch: { checkpoint?: number; daysQuiet?: number } = {};
  if (r.score !== null) patch.checkpoint = Math.max(0, Math.min(100, r.score));
  if (r.days !== null) patch.daysQuiet = Math.max(0, Math.round(r.days));
  if (Object.keys(patch).length) lms.edit(r.id, patch);
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
    const now = new Map(rows.map((r) => [r.id, r]));
    const changes: SheetChange[] = [];
    if (!h.last) {
      for (const r of rows) apply(r);              // the baseline: the sheet becomes the record
    } else {
      for (const r of rows) {
        const was = h.last.get(r.id);
        if (!was) { apply(r); changes.push({ row: r, kind: 'added', from: null, to: r.score }); continue; }
        if (r.score !== was.score) { apply(r); changes.push({ row: r, kind: 'score', from: was.score, to: r.score }); }
        else if (r.days !== was.days) { apply(r); changes.push({ row: r, kind: 'days', from: was.days, to: r.days }); }
        else if (r.name !== was.name || r.email !== was.email) apply(r);
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
    lines.push([s.profile.id, s.profile.name, s.profile.email, s.profile.cohort, s.profile.programme, cur, cp ? cp.scorePct : '', s.engagement.daysSinceLastLogin, 'on_track', ''].map(esc).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Tell the sheet what happened, if a write-back web app is configured. */
export async function writeBack(id: string, status: string, note: string) {
  const url = process.env.SHEET_WRITEBACK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ learner_id: id, status, last_update: note }), redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch { return false; }
}

export const MODULE_CODES = MODULES.map((m) => m.code);
