import type { DataRecord, DataSource, DataSourceKind, RecordField } from '@/lib/types';
import { sendingPaused } from '@/lib/email/pause';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { getTenantIntegrations, updateTenantIntegrations } from '@/lib/auth/accounts';
import { parseCsv, toCsvUrl } from '@/lib/lms/sheet';
import { findSyncedLearnerByEmailOrId, mergeLearnerPatchByEmailOrId } from '@/lib/db/postgres';
import { generateJSON, obj } from '@/lib/ai/llm';
import { countRecords, listRecords, recordKey, removeSourceRecords, setRecordField, upsertRecord } from './records';
import { daysUntil, isoDate, parseDate, parseMoney } from './conditions';
import { leadProfile } from '@/lib/nurture/profile';

/* Data sources: where the agents read their records.
 *
 * A Google Sheet tab (the student tracker, the fees tracker, a leads list, a
 * prospects list), shared "Anyone with the link: Viewer", read as CSV every
 * half minute. Columns are matched to the fields the agents understand
 * automatically (and by the model when a header is unusual); the mapping can
 * be edited. Webhook-fed lists (leads from ads) have no URL.
 *
 * The first read of a sheet is the baseline: nobody gets a message because a
 * sheet was connected. After that, a new row is "added" and a changed cell is
 * "changed", and the agents whose trigger matches start by themselves. */

export const LEADS_SOURCE_ID = 'src_leads';
/** Students from Moodle: filled by every Moodle sync (no sheet). */
export const MOODLE_SOURCE_ID = 'src_moodle';

export const FIELD_LABEL: Record<RecordField, string> = {
  id: 'Student / account ID', name: 'Full name', first_name: 'First name', last_name: 'Surname', email: 'Email', phone: 'Phone / WhatsApp',
  status: 'Status', programme: 'Programme / course', cohort: 'Cohort / intake', company: 'Company', source: 'Lead source / campaign',
  interest: 'Interested in', notes: 'Notes', owner: 'Owner / consultant', amount_due: 'Amount due (balance)', amount_paid: 'Amount paid',
  total_fee: 'Total fee', due_date: 'Due date', invoice_number: 'Invoice number', payment_status: 'Payment status', last_payment_date: 'Last payment date',
};

/** Fields each kind of list is expected to have (shown first in the mapping editor). */
export const KIND_FIELDS: Record<DataSourceKind, RecordField[]> = {
  students: ['id', 'name', 'email', 'phone', 'programme', 'cohort', 'status', 'amount_due', 'due_date', 'payment_status'],
  finance: ['id', 'name', 'email', 'phone', 'programme', 'invoice_number', 'total_fee', 'amount_paid', 'amount_due', 'due_date', 'payment_status', 'last_payment_date'],
  leads: ['name', 'first_name', 'last_name', 'email', 'phone', 'interest', 'source', 'status', 'owner', 'notes'],
  prospects: ['company', 'name', 'email', 'phone', 'status', 'owner', 'notes', 'source'],
  custom: ['id', 'name', 'email', 'phone', 'status', 'notes'],
};

const ALIASES: Record<RecordField, string[]> = {
  id: ['learner_id', 'student_id', 'student_number', 'student_no', 'learner_number', 'account_number', 'account_no', 'id_number', 'id', 'reference', 'ref'],
  name: ['full_name', 'student_name', 'learner_name', 'name_and_surname', 'names_and_surname', 'contact_name', 'lead_name', 'client_name', 'name', 'learner', 'student', 'client'],
  first_name: ['first_name', 'firstname', 'given_name', 'name_first'],
  last_name: ['last_name', 'surname', 'lastname', 'family_name'],
  email: ['email_address', 'student_email', 'learner_email', 'contact_email', 'e_mail', 'email'],
  phone: ['whatsapp_number', 'cellphone_number', 'cell_number', 'mobile_number', 'phone_number', 'contact_number', 'whatsapp', 'cellphone', 'cell', 'mobile', 'phone', 'telephone', 'tel'],
  status: ['student_status', 'learner_status', 'lead_status', 'enrolment_status', 'enrollment_status', 'status', 'stage'],
  programme: ['programme_name', 'course_name', 'programme', 'program', 'course', 'qualification'],
  cohort: ['cohort', 'intake', 'class', 'group', 'batch'],
  company: ['company_name', 'company', 'organisation', 'organization', 'business', 'employer'],
  source: ['lead_source', 'utm_source', 'campaign_name', 'campaign', 'ad_name', 'source', 'platform'],
  interest: ['course_interest', 'programme_interest', 'interested_in', 'interest'],
  notes: ['notes', 'comments', 'comment', 'remarks'],
  owner: ['assigned_to', 'sales_rep', 'consultant', 'advisor', 'owner'],
  amount_due: ['outstanding_balance', 'balance_outstanding', 'amount_outstanding', 'balance_due', 'amount_due', 'amount_owing', 'due_amount', 'outstanding', 'arrears', 'balance', 'owing'],
  amount_paid: ['amount_paid', 'total_paid', 'paid_to_date', 'paid_amount', 'payments', 'paid'],
  total_fee: ['total_fees', 'total_fee', 'course_fee', 'course_fees', 'tuition_fee', 'invoice_amount', 'invoice_total', 'tuition', 'fees', 'fee', 'total'],
  due_date: ['payment_due_date', 'next_due_date', 'next_payment_date', 'instalment_date', 'installment_date', 'due_date', 'date_due', 'due'],
  invoice_number: ['invoice_number', 'invoice_no', 'invoice_ref', 'inv_no', 'invoice'],
  payment_status: ['payment_status', 'fees_status', 'fee_status', 'billing_status', 'tuition_status', 'account_status', 'paid_status'],
  last_payment_date: ['last_payment_date', 'date_last_paid', 'last_payment', 'date_paid', 'payment_date'],
};

export const snake = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Match sheet headers to fields: exact alias first, then a header that starts with an alias. */
export function autoMap(headers: string[]): Partial<Record<RecordField, string>> {
  const out: Partial<Record<RecordField, string>> = {};
  const used = new Set<string>();
  const norm = headers.map((h) => ({ h, n: snake(h) }));
  for (const pass of ['exact', 'prefix'] as const) {
    for (const field of Object.keys(ALIASES) as RecordField[]) {
      if (out[field]) continue;
      for (const alias of ALIASES[field]) {
        const hit = norm.find(({ h, n }) => !used.has(h) && (pass === 'exact' ? n === alias : (n.startsWith(`${alias}_`) || n.endsWith(`_${alias}`))));
        if (hit) { out[field] = hit.h; used.add(hit.h); break; }
      }
    }
  }
  // "Name" alone next to a "Surname" column is the first name.
  if (out.name && out.last_name && !out.first_name && snake(out.name) === 'name') {
    out.first_name = out.name;
    delete out.name;
  }
  return out;
}

/** Ask the model to place headers the aliases did not recognise. */
export async function aiMap(headers: string[], sample: string[][], kind: DataSourceKind, known: Partial<Record<RecordField, string>>): Promise<Partial<Record<RecordField, string>>> {
  const missing = KIND_FIELDS[kind].filter((f) => !known[f]);
  if (!missing.length || !headers.length) return known;
  const used = new Set(Object.values(known));
  const free = headers.filter((h) => !used.has(h));
  if (!free.length) return known;
  const res = await generateJSON<Record<string, string>>({
    system: 'You map spreadsheet columns to fields. Reply with one JSON object only: {"field": "exact header"} for fields you are confident about. Use only headers from the list. Leave a field out if no header fits.',
    prompt: `List kind: ${kind}.\nFields to place: ${missing.map((f) => `${f} (${FIELD_LABEL[f]})`).join(', ')}.\nHeaders: ${JSON.stringify(free)}.\nSample rows (same column order as the full header list ${JSON.stringify(headers)}):\n${sample.slice(0, 3).map((r) => JSON.stringify(r)).join('\n')}`,
    maxTokens: 4000,
    timeoutMs: 20000,
    validate: (x) => {
      const o = obj(x); if (!o) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && free.includes(v) && (missing as string[]).includes(k)) out[k] = v;
      return out;
    },
  });
  return { ...known, ...(res || {}) };
}

/* ── Sources (kept with the workspace's integrations) ─────────────────────── */

type Runtime = { lastReadAt: number | null; lastError: string | null; rows: number; columns: string[]; reading: boolean; nextAt: number };
const g = globalThis as unknown as { __thusoSourceRt?: Map<string, Runtime> };
const rt = (tid: string, id: string): Runtime => {
  g.__thusoSourceRt ??= new Map();
  const k = `${tid}:${id}`;
  if (!g.__thusoSourceRt.has(k)) g.__thusoSourceRt.set(k, { lastReadAt: null, lastError: null, rows: 0, columns: [], reading: false, nextAt: 0 });
  return g.__thusoSourceRt.get(k)!;
};

const BUILT_IN_LEADS = (): DataSource => ({
  id: LEADS_SOURCE_ID, name: 'Leads from ads & forms', kind: 'leads', url: '', mapping: {}, enabled: true, createdAt: 1731600000000,
});

const BUILT_IN_MOODLE = (): DataSource => ({
  id: MOODLE_SOURCE_ID, name: 'Students from Moodle', kind: 'students', url: '', departmentId: 'dep_success', mapping: {}, enabled: true, createdAt: 1731600000001,
});

/** Lists filled by Thuso itself (a webhook, the Moodle sync), not by a sheet link. */
export const FED_SOURCES = new Set([LEADS_SOURCE_ID, MOODLE_SOURCE_ID]);

/** Every source, with live read status. The leads list and the Moodle students list always exist. */
export function listSources(tenantId = currentTenantId()): DataSource[] {
  const list = [...(getTenantIntegrations(tenantId).dataSources || [])];
  if (!list.some((s) => s.id === LEADS_SOURCE_ID)) list.unshift(BUILT_IN_LEADS());
  if (!list.some((s) => s.id === MOODLE_SOURCE_ID)) list.push(BUILT_IN_MOODLE());
  return list.map((s) => {
    const r = rt(tenantId, s.id);
    return { ...s, lastReadAt: r.lastReadAt, lastError: r.lastError, rows: s.url ? r.rows || countRecords(s.id) : countRecords(s.id), columns: r.columns.length ? r.columns : s.columns };
  });
}

export function getSource(id: string | null | undefined, tenantId = currentTenantId()): DataSource | null {
  if (!id) return null;
  return listSources(tenantId).find((s) => s.id === id) || null;
}

function persist(list: DataSource[], tenantId = currentTenantId()) {
  // Runtime status is not persisted; it is rebuilt by the next read.
  const clean = list.map(({ lastReadAt: _a, lastError: _b, rows: _c, ...rest }) => rest);
  updateTenantIntegrations(tenantId, { dataSources: clean });
}

function cleanTabs(tabs: DataSource['tabs']): DataSource['tabs'] {
  const out: NonNullable<DataSource['tabs']> = [];
  for (const t of tabs || []) {
    const url = String(t?.url || '').trim();
    if (!url) continue;
    if (!toCsvUrl(url)) throw new Error(`"${t.label || url}" is not a Google Sheets link.`);
    if (!out.some((x) => x.url === url)) out.push({ url, ...(t.label ? { label: String(t.label).slice(0, 60) } : {}), ...(t.mapping ? { mapping: t.mapping } : {}) });
  }
  return out.slice(0, 12);
}

export function saveSource(input: Partial<DataSource> & { name: string; kind: DataSourceKind }, tenantId = currentTenantId()): DataSource {
  const list = (getTenantIntegrations(tenantId).dataSources || []).slice();
  const url = (input.url || '').trim();
  if (url && !toCsvUrl(url)) throw new Error('That is not a Google Sheets link. Open the tab, copy the address bar, and paste it here.');
  const idx = input.id ? list.findIndex((s) => s.id === input.id) : -1;
  const prev = idx >= 0 ? list[idx] : (input.id === LEADS_SOURCE_ID ? BUILT_IN_LEADS() : input.id === MOODLE_SOURCE_ID ? BUILT_IN_MOODLE() : null);
  const next: DataSource = {
    id: prev?.id || input.id || `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: input.name.trim().slice(0, 60) || prev?.name || 'Sheet',
    kind: input.kind || prev?.kind || 'custom',
    url: input.provider === 'dialer' ? '' : input.url !== undefined ? url : prev?.url || '',
    provider: input.provider ?? prev?.provider,
    departmentId: input.departmentId ?? prev?.departmentId,
    mapping: input.mapping || prev?.mapping || {},
    tabs: input.tabs !== undefined ? cleanTabs(input.tabs) : prev?.tabs,
    baselined: input.baselined ?? prev?.baselined,
    enabled: input.enabled ?? prev?.enabled ?? true,
    createdAt: prev?.createdAt || Date.now(),
    columns: input.columns || prev?.columns,
  };
  if (prev && (prev.url !== next.url || (prev.provider || 'sheet') !== (next.provider || 'sheet'))) {
    // A different sheet: start from a fresh baseline so its rows are not "new".
    removeSourceRecords(next.id);
    const r = rt(tenantId, next.id);
    r.lastReadAt = null; r.rows = 0; r.columns = []; r.lastError = null; r.nextAt = 0;
  }
  if (idx >= 0) list[idx] = next; else list.push(next);
  persist(list, tenantId);
  return next;
}

export function deleteSource(id: string, tenantId = currentTenantId()): boolean {
  if (FED_SOURCES.has(id)) return false;
  const list = getTenantIntegrations(tenantId).dataSources || [];
  if (!list.some((s) => s.id === id)) return false;
  persist(list.filter((s) => s.id !== id), tenantId);
  removeSourceRecords(id);
  return true;
}

/* ── Reading a sheet ──────────────────────────────────────────────────────── */

export async function fetchSheet(url: string): Promise<{ headers: string[]; rows: string[][] }> {
  const csv = toCsvUrl(url.trim());
  if (!csv) throw new Error('That is not a Google Sheets link.');
  const res = await fetch(`${csv}${csv.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Google answered HTTP ${res.status}. Share the sheet as "Anyone with the link: Viewer".`);
  const text = await res.text();
  if (/^\s*<!DOCTYPE html|<html/i.test(text)) throw new Error('Google returned a sign-in page. Share the sheet as "Anyone with the link: Viewer".');
  const all = parseCsv(text);
  // Some trackers have a title row above the headers: use the first row with 3+ filled cells.
  const headIdx = Math.max(0, all.findIndex((r) => r.filter((c) => c.trim()).length >= 3));
  const headers = (all[headIdx] || []).map((h, i) => h.trim() || `Column ${i + 1}`);
  const rows = all.slice(headIdx + 1).filter((r) => r.some((c) => c.trim()));
  return { headers, rows };
}

const cleanPhone = (raw: string) => {
  let p = raw.replace(/[^\d+]/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  if (/^0\d{9}$/.test(p)) p = `+27${p.slice(1)}`;
  else if (/^27\d{9}$/.test(p)) p = `+${p}`;
  return p;
};

const PAID = /^(paid|paid in full|fully paid!?|settled|cleared|ok|complete|completed)$/i;
const ARRANGED = /arrang|payment plan|instal|partial|promise/i;
const OVERDUE = /overdue|arrear|late|outstanding|owing|unpaid|default|hold|suspend|behind|blocked/i;
/** Not studying (left, paused, deferred) or handed over (bad debt): never sent a reminder by an agent. */
const INACTIVE = /drop+ed|dropout|paused|def+er+ed|cancel|withdr|bad debt|written off|inactive/i;

/** One sheet row → a record. Money and dates are normalised; every column is kept too. */
export function rowToRecord(source: DataSource, headers: string[], row: string[], index: number): Omit<DataRecord, 'sourceId' | 'firstSeenAt' | 'updatedAt'> {
  const fields: Record<string, string> = {};
  headers.forEach((h, i) => {
    const k = snake(h);
    if (k) fields[k] = (row[i] ?? '').trim();
  });
  const get = (f: RecordField) => {
    const col = source.mapping[f];
    if (!col) return '';
    const i = headers.indexOf(col);
    return i >= 0 ? (row[i] ?? '').trim() : '';
  };
  for (const f of Object.keys(source.mapping) as RecordField[]) fields[f] = get(f);

  const first = get('first_name');
  const last = get('last_name');
  const email = get('email').toLowerCase();
  let name = get('name') || [first, last].filter(Boolean).join(' ');
  if (!name) name = source.kind === 'prospects' ? get('company') : '';
  if (!name && email) name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (!name) name = `Row ${index + 2}`;
  fields.name = name;
  fields.first_name = first || name.split(/\s+/)[0];
  const phone = cleanPhone(get('phone'));
  fields.phone = phone;
  fields.email = email;

  // Money: amount_due is the outstanding balance; work it out from fee - paid when the sheet has no balance column.
  const due = parseMoney(get('amount_due'));
  const paid = parseMoney(get('amount_paid'));
  const total = parseMoney(get('total_fee'));
  if (due !== null) fields.amount_due = String(due);
  else if (!source.mapping.amount_due && total !== null && paid !== null) fields.amount_due = String(Math.max(0, total - paid));
  if (paid !== null) fields.amount_paid = String(paid);
  if (total !== null) fields.total_fee = String(total);
  const dueDate = parseDate(get('due_date'));
  if (dueDate) fields.due_date = isoDate(dueDate);
  const lastPaid = parseDate(get('last_payment_date'));
  if (lastPaid) fields.last_payment_date = isoDate(lastPaid);

  return { key: recordKey({ email, id: get('id'), row: index + 2 }), name, email, phone, fields };
}

/** Fields worked out at the moment of use (they change with the calendar, so they are never stored). */
export function liveFields(rec: Pick<DataRecord, 'fields' | 'name' | 'email' | 'phone'>, now = new Date()): Record<string, string> {
  const f: Record<string, string> = { ...rec.fields, name: rec.name, email: rec.email, phone: rec.phone };
  f.first_name ||= rec.name.split(/\s+/)[0] || rec.name;
  // How they will pay, their monthly budget, the track: the same words whichever form they filled in.
  for (const [k, v] of Object.entries(leadProfile(f))) if (!f[k]) f[k] = v;
  const amount = parseMoney(f.amount_due);
  const due = parseDate(f.due_date);
  if (due) {
    const d = daysUntil(due, now);
    f.days_until_due = String(d);
    f.days_overdue = String(Math.max(0, -d));
  }
  // payment_state: paid | due | overdue | arrangement | unknown, from the status column when it says, else from balance and date.
  const said = (f.payment_status || '').trim();
  let state = 'unknown';
  if (INACTIVE.test(said) || INACTIVE.test(f.status || '')) state = 'inactive';
  else if (said && PAID.test(said)) state = 'paid';
  else if (said && ARRANGED.test(said)) state = 'arrangement';
  else if (amount !== null && amount <= 0) state = 'paid';
  // An amount owed is overdue when its date has passed, or when the tracker already says so (Behind, BLOCKED).
  else if (amount !== null && amount > 0) state = (due && daysUntil(due, now) < 0) || (said && OVERDUE.test(said)) ? 'overdue' : 'due';
  else if (said && OVERDUE.test(said)) state = 'overdue';
  f.payment_state = state;
  if (amount !== null) f.amount_due_display = `R ${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (due) f.due_date_display = due.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  return f;
}

/* ── Polling ──────────────────────────────────────────────────────────────── */

export interface RecordEvent { source: DataSource; record: DataRecord; kind: 'added' | 'changed'; changed: string[] }

const POLL_MS = Math.max(15, Number(process.env.SHEET_POLL_SECONDS || 30)) * 1000;

/** Read one source now. Returns what changed since the last read (nothing on the first read). */
export async function readSource(source: DataSource, tenantId = currentTenantId()): Promise<RecordEvent[]> {
  if (source.provider === 'dialer') return readDialerSource(source, tenantId);
  const r = rt(tenantId, source.id);
  if (!source.url || r.reading) return [];
  r.reading = true;
  try {
    const { headers, rows } = await fetchSheet(source.url);
    let mapping = source.mapping;
    if (!Object.keys(mapping).length) {
      // First read of a sheet nobody mapped: map it now and keep the mapping.
      mapping = await aiMap(headers, rows, source.kind, autoMap(headers));
      saveSource({ ...source, mapping, columns: headers }, tenantId);
      source = { ...source, mapping };
    } else if (JSON.stringify(source.columns || []) !== JSON.stringify(headers)) {
      saveSource({ ...source, columns: headers }, tenantId);
    }
    // The main tab, then any other tabs of the same list (each with its own columns).
    const merged = new Map<string, Omit<DataRecord, 'sourceId' | 'firstSeenAt' | 'updatedAt'>>();
    const take = (rec: Omit<DataRecord, 'sourceId' | 'firstSeenAt' | 'updatedAt'>, rowNo: number, tab: number) => {
      // A totals or notes row (no name, email or phone) is not a person.
      if (!rec.email && !rec.phone && /^Row \d+$/.test(rec.name)) return;
      if (rec.key.startsWith('row:')) rec.key = tab ? `row:t${tab}:${rowNo}` : rec.key;
      const prev = merged.get(rec.key);
      if (!prev) { merged.set(rec.key, rec); return; }
      if (!rec.email && !rec.key.includes('@')) { rec.key = `${rec.key}#${rowNo}`; merged.set(rec.key, rec); return; }
      // The same person on two tabs: one record, later tabs fill in or update what they have.
      const fields = { ...prev.fields };
      for (const [k, v] of Object.entries(rec.fields)) if (v !== '') fields[k] = v;
      merged.set(rec.key, { ...prev, name: rec.name && !/^Row \d+$/.test(rec.name) ? rec.name : prev.name, phone: rec.phone || prev.phone, email: rec.email || prev.email, fields });
    };
    rows.forEach((row, i) => take(rowToRecord(source, headers, row, i), i + 2, 0));
    const tabs = source.tabs || [];
    let tabsChanged = false;
    for (let t = 0; t < tabs.length; t++) {
      const tab = tabs[t];
      const sheet = await fetchSheet(tab.url);
      if (!tab.mapping || !Object.keys(tab.mapping).length) { tab.mapping = autoMap(sheet.headers); tabsChanged = true; }
      const tabSource: DataSource = { ...source, mapping: tab.mapping };
      // Which tab a person came from (WhatsApp, TikTok...): kept as an agent field, so it never counts as a change.
      const label = (tab.label || '').trim();
      sheet.rows.forEach((row, i) => {
        const rec = rowToRecord(tabSource, sheet.headers, row, i);
        if (label) rec.fields.agent_sheet_tab = label;
        take(rec, i + 2, t + 1);
      });
    }
    const urls = [source.url, ...tabs.map((x) => x.url)];
    const known = new Set(source.baselined || []);
    // A tab read for the first time (or the list's very first read) is a baseline: its people are imported, nobody is messaged.
    const newTab = urls.some((u) => !known.has(u));
    const baseline = newTab || (r.lastReadAt === null && countRecords(source.id) === 0);
    if (newTab || tabsChanged) {
      saveSource({ ...source, tabs, baselined: urls }, tenantId);
      source = { ...source, tabs, baselined: urls };
    }
    const events: RecordEvent[] = [];
    for (const rec of merged.values()) {
      const out = upsertRecord(source.id, rec);
      if (baseline) continue;
      if (out.created) events.push({ source, record: out.record, kind: 'added', changed: [] });
      else if (out.changed.length) events.push({ source, record: out.record, kind: 'changed', changed: out.changed });
    }
    r.lastReadAt = Date.now(); r.lastError = null; r.rows = merged.size; r.columns = headers;
    if (source.kind === 'students' || source.kind === 'finance') void mirrorToLearners(source, events, tenantId);
    return events;
  } catch (e) {
    r.lastError = (e as Error).message;
    return [];
  } finally {
    r.reading = false;
    r.nextAt = Date.now() + POLL_MS;
  }
}

/** The dialer's people waiting for Thuso (GET /api/v1/nurture), every page. */
async function fetchNurturing(tenantId: string): Promise<{ id: string; source: string; tab: string | null; name: string; phone: string; email: string; cells: Record<string, unknown> }[]> {
  const { dialerConnection } = await import('@/lib/nurture/qualify');
  const { url, key } = dialerConnection(tenantId);
  if (!url || !key) throw new Error('The dialer is not connected: add its address and API key in Channels & API → Qualified leads (or DIALER_URL and DIALER_API_KEY on the server).');
  const rows: Awaited<ReturnType<typeof fetchNurturing>> = [];
  for (let page = 1; page <= 60; page++) {
    const res = await fetch(`${url}/api/v1/nurture?page=${page}&per=500`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000), cache: 'no-store' });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; rows?: typeof rows; total?: number; per?: number };
    if (!res.ok || !j.ok) throw new Error(res.status === 404 ? 'The dialer does not have the Thuso update yet (deploy it, and run its 2026-11-19 migration).' : j.error || `The dialer answered HTTP ${res.status}.`);
    rows.push(...(j.rows || []));
    if (!j.rows?.length || (j.rows.length < (j.per || 500)) || rows.length >= (j.total || 0)) break;
  }
  return rows;
}

/** A leads list read from the dialer: everyone it holds for Thuso, with every column of their sheet row.
 *  Nobody here is a baseline: the dialer only holds people for Thuso to nurture. Someone who leaves the
 *  queue without Thuso qualifying them was taken over in the dialer, so their nurturing stops. */
async function readDialerSource(source: DataSource, tenantId: string): Promise<RecordEvent[]> {
  const r = rt(tenantId, source.id);
  if (r.reading) return [];
  r.reading = true;
  try {
    const rows = await fetchNurturing(tenantId);
    const events: RecordEvent[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const headers = Object.keys(row.cells || {});
      const values = headers.map((h) => String((row.cells as Record<string, unknown>)[h] ?? ''));
      const rec = rowToRecord({ ...source, mapping: autoMap(headers) }, headers, values, 0);
      // The dialer's reading of the person: the name, number and email it will call and write to.
      const email = (row.email || rec.email || '').trim().toLowerCase();
      const phone = cleanPhone(row.phone || rec.phone || '');
      if (row.name) { rec.name = row.name; rec.fields.name = row.name; rec.fields.first_name = row.name.split(/\s+/)[0]; }
      rec.email = email; rec.fields.email = email;
      rec.phone = phone; rec.fields.phone = phone;
      rec.key = email || (phone ? `phone:${phone}` : `dialer:${row.id}`);
      rec.fields.agent_dialer_row_id = row.id;
      rec.fields.agent_sheet_tab = row.tab || row.source || '';
      rec.fields.agent_dialer_source = row.source || '';
      if (seen.has(rec.key)) continue;
      seen.add(rec.key);
      const out = upsertRecord(source.id, rec);
      if (out.created) events.push({ source, record: out.record, kind: 'added', changed: [] });
      else if (out.changed.length) events.push({ source, record: out.record, kind: 'changed', changed: out.changed });
    }
    // Taken over in the dialer (or their row removed): Thuso stops nurturing them.
    const left = listRecords(source.id).filter((x) => !seen.has(x.key) && x.fields.dialer_row_id && x.fields.qualified !== 'yes' && x.fields.dialer_left !== 'yes');
    if (left.length) {
      const { stopRunsFor } = await import('@/lib/engine/agentRuns');
      for (const x of left) {
        setRecordField(source.id, x.key, 'dialer_left', 'yes');
        setRecordField(source.id, x.key, 'status', 'with sales');
        stopRunsFor(x.email, x.key, `${x.name} is no longer waiting for Thuso in the dialer (the team took them over), so nurturing stops.`);
      }
    }
    r.lastReadAt = Date.now(); r.lastError = null; r.rows = seen.size; r.columns = ['dialer'];
    return events;
  } catch (e) {
    r.lastError = (e as Error).message;
    return [];
  } finally {
    r.reading = false;
    r.nextAt = Date.now() + POLL_MS;
  }
}

/** Read every enabled sheet that is due. Called by the always-on pump. */
export async function pollSources(tenantId = currentTenantId()): Promise<RecordEvent[]> {
  const out: RecordEvent[] = [];
  for (const s of listSources(tenantId)) {
    if (!s.enabled || (!s.url && s.provider !== 'dialer')) continue;
    const r = rt(tenantId, s.id);
    if (r.reading || Date.now() < r.nextAt) continue;
    out.push(...(await readSource(s, tenantId)));
  }
  return out;
}

/** Keep the Students page honest: payment status from the tracker, for learners we already know. */
async function mirrorToLearners(source: DataSource, events: RecordEvent[], tenantId: string) {
  for (const ev of events.slice(0, 50)) {
    const email = ev.record.email;
    if (!email) continue;
    try {
      const known = await findSyncedLearnerByEmailOrId(email, null, tenantId);
      if (!known) continue;
      const state = liveFields(ev.record).payment_state;
      const paymentStatus = state === 'overdue' ? 'overdue' : state === 'arrangement' ? 'arrangement' : state === 'paid' || state === 'due' ? 'ok' : null;
      if (paymentStatus) await mergeLearnerPatchByEmailOrId({ id: known.id, email, paymentStatus, lastEvent: `${source.name} updated` }, tenantId);
    } catch { /* the tracker still works without the learner mirror */ }
  }
}

/** Totals for reports and scheduled agents. */
export function sourceSummary(sourceId: string): string {
  const recs = listRecords(sourceId).map((r) => ({ r, f: liveFields(r) }));
  if (!recs.length) return 'No records.';
  const money = (n: number) => `R ${n.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}`;
  const due = recs.filter(({ f }) => f.payment_state === 'due');
  const overdue = recs.filter(({ f }) => f.payment_state === 'overdue');
  const sum = (xs: typeof recs) => xs.reduce((n, { f }) => n + (parseMoney(f.amount_due) || 0), 0);
  const lines = [`${recs.length} records.`];
  if (due.length || overdue.length) {
    lines.push(`${due.length} with a balance not yet due (${money(sum(due))}); ${overdue.length} overdue (${money(sum(overdue))}).`);
    const top = overdue.sort((a, b) => (parseMoney(b.f.amount_due) || 0) - (parseMoney(a.f.amount_due) || 0)).slice(0, 10);
    if (top.length) lines.push(`Largest overdue: ${top.map(({ r, f }) => `${r.name} ${f.amount_due_display || ''} (${f.days_overdue || '?'} days)`).join('; ')}.`);
  }
  const statuses = new Map<string, number>();
  for (const { f } of recs) if (f.status) statuses.set(f.status, (statuses.get(f.status) || 0) + 1);
  if (statuses.size) lines.push(`By status: ${[...statuses.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  return lines.join(' ');
}

/** Write a field back to the sheet through the workspace's Apps Script web app, if one is set. */
export async function writeBackField(source: DataSource | null, rec: DataRecord, field: string, value: string): Promise<boolean> {
  const ti = getTenantIntegrations(currentTenantId());
  const url = (ti.sheetWritebackUrl || '').trim();
  if (!url || !source?.url || sendingPaused()) return false;
  const column = source.mapping[field as RecordField] || field;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'set', sheetUrl: source.url, email: rec.email, id: rec.fields.id || '', key: rec.key, column, value }),
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
