import fs from 'node:fs';
import { sendingPaused } from '@/lib/email/pause';
import path from 'node:path';
import type { LearnerStatus, MissedQuestion } from '@/lib/types';
import { MODULES, SEED, roughRisk } from './sandboxData';
import { MoodleLmsAdapter, moodleConfigured } from './moodleAdapter';

/* The LMS · the integration layer.
 *
 * Agents never see a database row. They see these interfaces, and an adapter
 * fills them: the HttpLmsAdapter from the academy's LMS API, the
 * SandboxLmsAdapter from the seeded demo cohort. Swapping one for the other
 * changes nothing upstream, which is the point: the office runs on stage with
 * no Wi-Fi, and in production against the real student records.
 *
 *   LMS_API_URL   e.g. https://lms.example.org/api/v1
 *   LMS_API_KEY   bearer token
 *
 * The live adapter expects these routes, and tolerates missing fields:
 *   GET  /students                         → StudentProfile[]
 *   GET  /students/:id                     → StudentProfile
 *   GET  /students/:id/engagement          → EngagementMetrics
 *   GET  /students/:id/assessments         → AssessmentRecord[]
 *   GET  /modules/:code                    → ModuleSyllabus
 *   POST /students/:id/assessments         ← RemedialQuizRecord
 *   PATCH /students/:id/status             ← { status, note }
 */

export interface StudentProfile {
  id: string;
  name: string;
  email: string;
  phone?: string;
  cohort: string;
  programme: string;
  programmeCode: string;
  enrolledAt: string;
  status: LearnerStatus;
  /** Moodle groups (intakes) the student is in. */
  groups?: string[];
}

export interface EngagementMetrics {
  studentId: string;
  loginStreakDays: number;
  daysSinceLastLogin: number;
  neverLoggedIn?: boolean;
  modulesCompleted: number;
  modulesTotal: number;
  completionPct: number;
  currentModule: { code: string; title: string; progressPct: number };
  hoursThisWeek: number;
  forumPosts: number;
  lastActivityAt: string;
  attendancePct?: number;
  missedClasses?: number;
  missedAssignments?: number;
  overdueAssignments?: number;
  paymentStatus?: 'ok' | 'overdue' | 'arrangement';
  courses?: {
    id: number;
    code: string;
    name: string;
    progressPct: number | null;
    completedActivities: number;
    totalActivities: number;
  }[];
  incompleteActivities?: {
    name: string;
    type: string;
    course: string;
    dueAt?: string;
  }[];
  /** Assignments not submitted yet whose due date is still ahead, soonest first. */
  upcoming?: { name: string; course: string; dueAt: string }[];
}

export interface AssessmentRecord {
  id: string;
  studentId: string;
  moduleCode: string;
  moduleTitle: string;
  title: string;
  scorePct: number;
  passMark: number;
  passed: boolean;
  takenAt: string;
  weakTopics: string[];
  missedQuestions?: MissedQuestion[];
  feedback?: string;
  courseName?: string;
  kind: 'quiz' | 'project' | 'remedial';
}

export interface ModuleSyllabus {
  code: string;
  title: string;
  programmeCode: string;
  topics: string[];
  /** words the Reviewer uses to check a remedial question really tests this module */
  keywords: string[];
}

/** What goes back to the LMS when a student completes a remedial quiz. */
export interface RemedialQuizRecord {
  quizId: string;
  studentId: string;
  moduleCode: string;
  topic: string;
  scorePct: number;
  passed: boolean;
  questions: number;
  completedAt: string;
}

export interface RiskAssessment {
  score: number;
  band: 'on_track' | 'watch' | 'at_risk';
  signals: string[];
  weakModule: { code: string; title: string } | null;
  weakTopic: string | null;
  topicKeywords: string[];
}

export interface LmsAdapter {
  readonly mode: 'sandbox' | 'live';
  listStudents(): Promise<StudentProfile[]>;
  getStudent(id: string): Promise<StudentProfile | null>;
  getEngagement(id: string): Promise<EngagementMetrics | null>;
  getAssessments(id: string, opts?: { includeMissedQuestions?: boolean }): Promise<AssessmentRecord[]>;
  getModule(code: string): Promise<ModuleSyllabus | null>;
  recordRemedialQuiz(record: RemedialQuizRecord): Promise<{ ok: boolean; syncedAt: string }>;
  updateStudentStatus(id: string, status: LearnerStatus, note: string): Promise<{ ok: boolean }>;
}

export class LmsError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) { super(message); this.name = 'LmsError'; this.cause = cause; }
}

/* ── Risk, the same for every adapter ─────────────────────────────────────── */

export function assessRisk(e: EngagementMetrics, assessments: AssessmentRecord[], modules: ModuleSyllabus[] = MODULES): RiskAssessment {
  const sorted = [...assessments].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const latest = sorted[sorted.length - 1];
  const failed = [...sorted].reverse().find((a) => !a.passed) || null;
  let score = roughRisk(e.daysSinceLastLogin, e.completionPct, latest?.scorePct ?? 70, e.loginStreakDays);
  if ((e.missedClasses ?? 0) >= 2) score = Math.min(100, score + 18);
  if ((e.missedAssignments ?? 0) >= 1) score = Math.min(100, score + 12);
  if (e.paymentStatus === 'overdue') score = Math.min(100, Math.max(score, 62));
  const signals: string[] = [];
  if (e.neverLoggedIn) signals.push('no recorded LMS activity yet');
  else if (e.daysSinceLastLogin >= 5) signals.push(`${e.daysSinceLastLogin} days since last activity`);
  if (e.loginStreakDays === 0) signals.push('activity streak broken');
  if (e.hoursThisWeek < 2) signals.push(`${e.hoursThisWeek.toFixed(1)} h of study this week`);
  if (e.completionPct < 60) signals.push(`${e.completionPct}% activity completion (${e.modulesCompleted}/${e.modulesTotal})`);
  if ((e.missedClasses ?? 0) >= 2) signals.push(`missed ${e.missedClasses} recent live classes`);
  if ((e.missedAssignments ?? 0) >= 1) signals.push(`${e.missedAssignments} overdue/missing assignment${e.missedAssignments === 1 ? '' : 's'}`);
  if (e.paymentStatus === 'overdue') signals.push('tuition / admin check-in flagged on billing sheet');
  if (failed) signals.push(`${failed.title || failed.moduleCode} scored ${failed.scorePct}% (pass mark ${failed.passMark}%)`);
  if (e.currentModule.progressPct < 50) signals.push(`${e.currentModule.title || e.currentModule.code} stalled at ${e.currentModule.progressPct}%`);
  const weakCode = failed?.moduleCode || (e.currentModule.progressPct < 50 ? e.currentModule.code : null);
  const mod = weakCode ? modules.find((m) => m.code === weakCode) || null : null;
  const fallbackTopic = failed?.weakTopics[0] || e.incompleteActivities?.[0]?.name || mod?.topics[0] || null;
  return {
    score,
    band: score >= 60 ? 'at_risk' : score >= 35 ? 'watch' : 'on_track',
    signals,
    weakModule: mod ? { code: mod.code, title: mod.title } : weakCode ? { code: weakCode, title: failed?.moduleTitle || e.currentModule.title } : null,
    weakTopic: fallbackTopic,
    topicKeywords: mod?.keywords || [],
  };
}

/* ── Sandbox ──────────────────────────────────────────────────────────────── */

/** A change made in the sandbox LMS console, as an LMS would report it. */
export interface LmsEdit {
  checkpoint?: number;
  daysQuiet?: number;
  missedClasses?: number;
  missedAssignments?: number;
  paymentStatus?: 'ok' | 'overdue' | 'arrangement';
  missedQuestions?: MissedQuestion[];
  at: number;
}

export class SandboxLmsAdapter implements LmsAdapter {
  readonly mode = 'sandbox' as const;
  private statuses = new Map<string, LearnerStatus>();
  private pushed: RemedialQuizRecord[] = [];
  /** Edits made in the LMS console: they change what every later read returns. */
  private edits = new Map<string, LmsEdit>();

  edit(id: string, patch: Omit<LmsEdit, 'at'>) {
    const prev = this.edits.get(id) || { at: 0 };
    const next: LmsEdit = { ...prev, ...patch, at: Date.now() };
    this.edits.set(id, next);
    // A new mark or a new silence reopens the case.
    this.statuses.delete(id);
    this.pushed = this.pushed.filter((p) => p.studentId !== id);
    return next;
  }
  editOf(id: string) { return this.edits.get(id) || null; }

  /* Your own learners, added in the learner records (or from a sheet), name
   * and email changes for the demo learners, and demo learners you hid. All
   * three are saved to .data/learners.json, so a restart keeps them. */
  private overrides = new Map<string, Partial<StudentProfile>>();
  private extras = new Map<string, { profile: StudentProfile; engagement: Omit<EngagementMetrics, 'studentId'>; assessments: typeof SEED[number]['assessments'] }>();
  private hidden = new Set<string>();
  private readonly tenantId: string;

  constructor(tenantId = currentTenantId()) {
    this.tenantId = tenantId;
    this.load();
  }
  private includeSeed(): boolean {
    return getTenantIntegrations(this.tenantId).lmsProvider === 'sandbox';
  }
  private dataFile(): string {
    return this.tenantId === DEFAULT_TENANT_ID
      ? path.join(process.cwd(), '.data', 'learners.json')
      : path.join(process.cwd(), '.data', 'tenants', this.tenantId, 'learners.json');
  }
  private load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.dataFile(), 'utf8')) as { overrides?: [string, Partial<StudentProfile>][]; extras?: [string, never][]; hidden?: string[] };
      for (const [k, v] of d.overrides || []) this.overrides.set(k, v);
      for (const [k, v] of d.extras || []) this.extras.set(k, v);
      for (const id of d.hidden || []) this.hidden.add(id);
    } catch { /* nothing saved yet */ }
  }
  private save() {
    try {
      const file = this.dataFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ overrides: [...this.overrides], extras: [...this.extras], hidden: [...this.hidden] }, null, 2));
    } catch { /* read-only disk: keep in memory */ }
  }

  override(id: string, patch: Partial<StudentProfile>) { this.overrides.set(id, { ...(this.overrides.get(id) || {}), ...patch }); this.save(); }
  carryProfiles(from: SandboxLmsAdapter) { for (const [k, v] of from.overrides) this.overrides.set(k, v); for (const [k, v] of from.extras) this.extras.set(k, v); for (const id of from.hidden) this.hidden.add(id); }
  knows(id: string) { return (this.includeSeed() && SEED.some((x) => x.profile.id === id)) || this.extras.has(id); }
  isHidden(id: string) { return this.hidden.has(id); }

  /** Upsert a real learner received from an external webhook or CSV sync. */
  upsertExternalLearner(row: {
    id: string;
    name: string;
    email: string;
    phone?: string;
    cohort?: string;
    programme?: string;
    moduleCode?: string;
    checkpoint?: number | null;
    daysSinceLogin?: number | null;
    missedClasses?: number | null;
    missedAssignments?: number | null;
    paymentStatus?: 'ok' | 'overdue' | 'arrangement' | null;
  }) {
    if (!this.extras.has(row.id) && !(this.includeSeed() && SEED.some((x) => x.profile.id === row.id))) {
      this.addLearner({
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        cohort: row.cohort || 'Active Cohort',
        programme: row.programme || 'Enrolled Programme',
        module: row.moduleCode,
        checkpoint: row.checkpoint ?? null,
        daysSinceLogin: row.daysSinceLogin ?? 0,
      });
    } else if (row.email || row.phone || row.cohort || row.programme || row.name) {
      this.override(row.id, {
        ...(row.name ? { name: row.name } : {}),
        ...(row.email ? { email: row.email } : {}),
        ...(row.phone ? { phone: row.phone } : {}),
        ...(row.cohort ? { cohort: row.cohort } : {}),
        ...(row.programme ? { programme: row.programme } : {}),
      });
    }
    const patch: Omit<LmsEdit, 'at'> = {};
    if (typeof row.checkpoint === 'number') patch.checkpoint = row.checkpoint;
    if (typeof row.daysSinceLogin === 'number') patch.daysQuiet = row.daysSinceLogin;
    if (typeof row.missedClasses === 'number') patch.missedClasses = row.missedClasses;
    if (typeof row.missedAssignments === 'number') patch.missedAssignments = row.missedAssignments;
    if (row.paymentStatus) patch.paymentStatus = row.paymentStatus;
    if (Object.keys(patch).length) this.edit(row.id, patch);
  }

  /** Add one of your own learners, with their starting mark and logins. */
  addLearner(row: { id: string; name: string; email: string; phone?: string; cohort: string; programme?: string; module?: string; checkpoint?: number | null; daysSinceLogin?: number | null }) {
    const mod = MODULES.find((m) => m.code === row.module) || MODULES[0];
    const days = typeof row.daysSinceLogin === 'number' ? Math.max(0, Math.round(row.daysSinceLogin)) : 1;
    const cp = typeof row.checkpoint === 'number' ? Math.max(0, Math.min(100, Math.round(row.checkpoint))) : null;
    const prog = { FSWD: 'Full-Stack Web Development', DA: 'Data Analytics with Python & SQL', CYB: 'Cybersecurity Essentials' } as Record<string, string>;
    const code = (row.cohort || 'FSWD').split('-')[0];
    this.extras.set(row.id, {
      profile: {
        id: row.id, name: row.name, email: row.email, phone: row.phone || undefined, cohort: row.cohort || 'FSWD-2026-Q3', programme: row.programme || prog[code] || 'Full-Stack Web Development',
        programmeCode: code, enrolledAt: new Date(Date.now() - 60 * 86_400_000).toISOString(), status: 'on_track',
      },
      engagement: {
        loginStreakDays: days > 0 ? 0 : 3, daysSinceLastLogin: days, modulesCompleted: 6, modulesTotal: 14, completionPct: 50,
        currentModule: { code: mod.code, title: mod.title, progressPct: 45 }, hoursThisWeek: days >= 7 ? 0 : 3, forumPosts: 1, lastActivityAt: new Date(Date.now() - days * 86_400_000).toISOString(),
      },
      assessments: cp === null ? [] : [{
        moduleCode: mod.code, moduleTitle: mod.title, title: `${mod.code} Checkpoint Quiz`, scorePct: cp, passMark: 60, passed: cp >= 60,
        takenAt: new Date().toISOString(), weakTopics: cp >= 60 ? [] : mod.topics.slice(0, 2), kind: 'quiz' as const,
      }],
    });
    this.hidden.delete(row.id);
    this.save();
  }

  /** Take a learner off the records: your own are deleted, demo learners are hidden. */
  remove(id: string) {
    if (this.extras.has(id)) this.extras.delete(id); else this.hidden.add(id);
    this.edits.delete(id); this.statuses.delete(id);
    this.save();
  }
  setDemoHidden(hide: boolean) {
    for (const s of SEED) { if (hide) this.hidden.add(s.profile.id); else this.hidden.delete(s.profile.id); }
    this.save();
  }

  private seedOf(id: string) {
    const s = this.includeSeed() ? SEED.find((x) => x.profile.id === id) : undefined;
    if (s) return { profile: { ...s.profile, ...(this.overrides.get(id) || {}) }, engagement: s.engagement, assessments: s.assessments };
    const x = this.extras.get(id);
    return x ? { profile: { ...x.profile, ...(this.overrides.get(id) || {}) }, engagement: x.engagement, assessments: x.assessments || [] } : null;
  }

  async listStudents() {
    await tick();
    const seedIds = this.includeSeed() ? SEED.map((s) => s.profile.id) : [];
    const ids = [...this.extras.keys(), ...seedIds].filter((id) => !this.hidden.has(id));
    return ids.map((id) => this.seedOf(id)!).map((s) => ({ ...s.profile, status: this.statuses.get(s.profile.id) || s.profile.status }));
  }
  async getStudent(id: string) {
    await tick();
    const s = this.seedOf(id);
    return s ? { ...s.profile, status: this.statuses.get(id) || s.profile.status } : null;
  }
  async getEngagement(id: string) {
    await tick();
    const s = this.seedOf(id);
    if (!s) return null;
    const e = { studentId: id, ...s.engagement, currentModule: { ...s.engagement.currentModule } };
    const ed = this.edits.get(id);
    if (ed?.daysQuiet !== undefined) {
      e.daysSinceLastLogin = ed.daysQuiet;
      e.loginStreakDays = ed.daysQuiet > 0 ? 0 : Math.max(1, e.loginStreakDays);
      e.hoursThisWeek = ed.daysQuiet >= 7 ? 0 : e.hoursThisWeek;
      e.lastActivityAt = new Date(Date.now() - ed.daysQuiet * 86_400_000).toISOString();
    }
    if (ed?.missedClasses !== undefined) e.missedClasses = ed.missedClasses;
    if (ed?.missedAssignments !== undefined) e.missedAssignments = ed.missedAssignments;
    if (ed?.paymentStatus !== undefined) e.paymentStatus = ed.paymentStatus;
    return e;
  }
  async getAssessments(id: string) {
    await tick();
    const s = this.seedOf(id);
    if (!s) return [];
    let base: AssessmentRecord[] = s.assessments.map((a, i) => ({ id: `${id}-A${i + 1}`, studentId: id, ...a }));
    const ed = this.edits.get(id);
    if (ed?.checkpoint !== undefined) {
      // The console's mark replaces the checkpoint on the learner's current module.
      const cur = s.engagement.currentModule;
      const mod = MODULES.find((m) => m.code === cur.code);
      const passed = ed.checkpoint >= 60;
      const rec: AssessmentRecord = {
        id: `${id}-C1`, studentId: id, moduleCode: cur.code, moduleTitle: cur.title, title: `${cur.code} Checkpoint Quiz`,
        scorePct: ed.checkpoint, passMark: 60, passed, takenAt: new Date(ed.at).toISOString(),
        weakTopics: passed ? [] : (mod?.topics.slice(0, 2) || []),
        ...(ed.missedQuestions?.length ? { missedQuestions: ed.missedQuestions } : {}),
        kind: 'quiz' as const,
      };
      base = [...base.filter((a) => !(a.moduleCode === cur.code && a.kind === 'quiz')), rec];
    }
    const extra = this.pushed.filter((p) => p.studentId === id).map((p, i) => ({
      id: `${id}-R${i + 1}`, studentId: id, moduleCode: p.moduleCode, moduleTitle: MODULES.find((m) => m.code === p.moduleCode)?.title || p.moduleCode,
      title: `${p.moduleCode} Remedial Micro-Quiz`, scorePct: p.scorePct, passMark: 67, passed: p.passed, takenAt: p.completedAt, weakTopics: [], kind: 'remedial' as const,
    }));
    return [...base, ...extra];
  }
  async getModule(code: string) { await tick(); return MODULES.find((m) => m.code === code) || null; }
  async recordRemedialQuiz(record: RemedialQuizRecord) {
    await tick(120);
    this.pushed.push(record);
    return { ok: true, syncedAt: new Date().toISOString() };
  }
  async updateStudentStatus(id: string, status: LearnerStatus) {
    await tick();
    this.statuses.set(id, status);
    return { ok: true };
  }
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/* ── Live ─────────────────────────────────────────────────────────────────── */

export class HttpLmsAdapter implements LmsAdapter {
  readonly mode = 'live' as const;
  private baseUrl: string;
  private apiKey: string;
  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new LmsError(`LMS ${method} ${path} → ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      throw e instanceof LmsError ? e : new LmsError(`LMS ${method} ${path} unreachable`, e);
    } finally { clearTimeout(t); }
  }

  listStudents() { return this.call<StudentProfile[]>('GET', '/students').then((r) => (Array.isArray(r) ? r : [])); }
  getStudent(id: string) { return this.call<StudentProfile>('GET', `/students/${encodeURIComponent(id)}`).catch(() => null); }
  getEngagement(id: string) { return this.call<EngagementMetrics>('GET', `/students/${encodeURIComponent(id)}/engagement`).catch(() => null); }
  getAssessments(id: string) { return this.call<AssessmentRecord[]>('GET', `/students/${encodeURIComponent(id)}/assessments`).then((r) => (Array.isArray(r) ? r : [])).catch(() => []); }
  getModule(code: string) { return this.call<ModuleSyllabus>('GET', `/modules/${encodeURIComponent(code)}`).catch(() => MODULES.find((m) => m.code === code) || null); }
  async recordRemedialQuiz(record: RemedialQuizRecord) {
    await this.call('POST', `/students/${encodeURIComponent(record.studentId)}/assessments`, record);
    return { ok: true, syncedAt: new Date().toISOString() };
  }
  async updateStudentStatus(id: string, status: LearnerStatus, note: string) {
    if (sendingPaused()) return { ok: true };
    await this.call('PATCH', `/students/${encodeURIComponent(id)}/status`, { status, note });
    return { ok: true };
  }
}

/* ── Choosing ─────────────────────────────────────────────────────────────── */

import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import { getTenantIntegrations } from '@/lib/auth/accounts';

const g = globalThis as unknown as {
  __czSandboxes?: Map<string, SandboxLmsAdapter>;
  __thusoMoodleAdapters?: Map<string, MoodleLmsAdapter>;
};

export function sandboxAdapter() {
  const tid = currentTenantId();
  if (!g.__czSandboxes) g.__czSandboxes = new Map();
  const existing = g.__czSandboxes.get(tid);
  if (!existing || typeof (existing as Partial<SandboxLmsAdapter>).upsertExternalLearner !== 'function') {
    g.__czSandboxes.set(tid, new SandboxLmsAdapter(tid));
  }
  return g.__czSandboxes.get(tid)!;
}

/** A clean cohort: forget every status change and synced score from earlier runs. */
export function resetSandbox() {
  const tid = currentTenantId();
  if (!g.__czSandboxes) g.__czSandboxes = new Map();
  const old = g.__czSandboxes.get(tid);
  const fresh = new SandboxLmsAdapter(tid);
  g.__czSandboxes.set(tid, fresh);
  if (old && typeof (old as Partial<SandboxLmsAdapter>).carryProfiles === 'function') fresh.carryProfiles(old);
}

export function liveConfigured() {
  const tid = currentTenantId();
  const ti = getTenantIntegrations(tid);
  if (ti.moodleUrl && ti.moodleToken) return true;
  if (ti.lmsApiUrl && ti.lmsApiKey) return true;
  return tid === DEFAULT_TENANT_ID && (moodleConfigured() || Boolean(process.env.LMS_API_URL && process.env.LMS_API_KEY));
}

/** The adapter for the mode and tenant workspace. Prefers tenant Moodle / REST config. */
export function getLmsAdapter(mode: 'sandbox' | 'live'): LmsAdapter {
  const tid = currentTenantId();
  const ti = getTenantIntegrations(tid);
  if (ti.lmsProvider !== 'sandbox') {
    const mUrl = (ti.moodleUrl || (tid === DEFAULT_TENANT_ID ? process.env.MOODLE_URL : '') || '').trim();
    const mTok = (ti.moodleToken || (tid === DEFAULT_TENANT_ID ? process.env.MOODLE_TOKEN : '') || '').trim();
    const mCoursesRaw = ti.moodleCourseIds || (tid === DEFAULT_TENANT_ID ? process.env.MOODLE_COURSE_IDS : '') || '';
    const mCourses = mCoursesRaw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    const mCourseGroups: Record<number, number[]> = {};
    if (ti.moodleCourseGroups && typeof ti.moodleCourseGroups === 'object') {
      for (const [k, vals] of Object.entries(ti.moodleCourseGroups)) {
        const cid = Number(k);
        if (Number.isFinite(cid) && cid > 0 && Array.isArray(vals) && vals.length) {
          mCourseGroups[cid] = vals.map(Number).filter((gId) => Number.isFinite(gId) && gId > 0);
        }
      }
    }
    const groupsSig = JSON.stringify(mCourseGroups);
    if ((ti.lmsProvider === 'moodle' || (!ti.lmsProvider && mUrl && mTok)) && mUrl && mTok) {
      if (!g.__thusoMoodleAdapters) g.__thusoMoodleAdapters = new Map();
      const cacheKey = `${tid}|${mUrl}|${mTok}|${mCourses.join(',')}|${groupsSig}`;
      let adapter = g.__thusoMoodleAdapters.get(cacheKey);
      if (!adapter || typeof (adapter as Partial<MoodleLmsAdapter>).forceRefresh !== 'function') {
        adapter = new MoodleLmsAdapter(mUrl, mTok, mCourses.length ? mCourses : undefined, Object.keys(mCourseGroups).length ? mCourseGroups : undefined);
        g.__thusoMoodleAdapters.set(cacheKey, adapter);
      }
      return adapter;
    }
    if (mode === 'live') {
      const rUrl = ti.lmsApiUrl || (tid === DEFAULT_TENANT_ID ? process.env.LMS_API_URL : undefined);
      const rKey = ti.lmsApiKey || (tid === DEFAULT_TENANT_ID ? process.env.LMS_API_KEY : undefined);
      if (rUrl && rKey) return new HttpLmsAdapter(rUrl, rKey);
    }
  }
  return sandboxAdapter();
}
