import type { LearnerStatus, MissedQuestion } from '@/lib/types';
import type {
  AssessmentRecord,
  EngagementMetrics,
  LmsAdapter,
  ModuleSyllabus,
  RemedialQuizRecord,
  StudentProfile,
} from './lmsAdapter';
import { LmsError } from './lmsAdapter';
import type { CourseGradebook, GbCell, GbItem } from './gradebook';
import { MODULES } from './sandboxData';

/* Moodle Web Services REST adapter.
 *
 * Connects to Moodle's /webservice/rest/server.php and pulls:
 *   - Course discovery (core_course_get_courses OR core_webservice_get_site_info -> core_enrol_get_users_courses)
 *   - Enrolled learners & last access / profile fields (core_enrol_get_enrolled_users)
 *   - Native course progress (core_enrol_get_users_courses)
 *   - Course structure & activity completion (core_course_get_contents + core_completion_get_activities_completion_status)
 *   - Assignments & submission status (mod_assign_get_assignments + mod_assign_get_submissions)
 *   - Gradebook items & teacher feedback across all enrolled courses (gradereport_user_get_grade_items)
 *   - Quiz attempts & exact missed questions (mod_quiz_get_user_attempts + mod_quiz_get_attempt_review) */

interface MoodleCourse {
  id: number;
  shortname?: string;
  fullname?: string;
  visible?: number;
  progress?: number | null;
  completed?: boolean;
  lastaccess?: number;
}

interface MoodleGroup {
  id: number;
  courseid?: number;
  name: string;
}

interface MoodleUser {
  id: number;
  username?: string;
  fullname?: string;
  firstname?: string;
  lastname?: string;
  email?: string;
  phone1?: string;
  phone2?: string;
  firstaccess?: number;
  lastaccess?: number;
  suspended?: boolean;
  roles?: { shortname?: string }[];
  groups?: { id: number; name?: string }[];
  enrolledcourses?: { id: number; shortname?: string; fullname?: string }[];
}

interface MoodleGradeItem {
  id?: number;
  itemname?: string;
  itemtype?: string;
  gradeishidden?: boolean;
  gradeformatted?: string;
  itemmodule?: string;
  iteminstance?: number;
  graderaw?: number | null;
  grademin?: number;
  grademax?: number;
  gradepass?: string | number | null;
  percentageformatted?: string;
  gradedatesubmitted?: number;
  gradedategraded?: number;
  feedback?: string;
}

interface MoodleQuiz {
  id: number;
  course: number;
  name: string;
  grade?: number;
}

interface MoodleAttempt {
  id: number;
  quiz: number;
  state: string;
  timefinish?: number;
  sumgrades?: number;
}

interface MoodleReviewQuestion {
  questionnumber?: string | number;
  html?: string;
  state?: string;
  status?: string;
  mark?: string;
  maxmark?: string;
}

interface MoodleSectionModule {
  id: number;
  name?: string;
  modname?: string;
  visible?: number;
  uservisible?: boolean;
}

interface MoodleSection {
  id: number;
  name?: string;
  modules?: MoodleSectionModule[];
}

interface MoodleCompletionStatus {
  cmid: number;
  modname?: string;
  state: number; // 0 = incomplete, 1 = complete, 2 = complete_pass, 3 = complete_fail
  timecompleted?: number;
}

interface MoodleAssignment {
  id: number;
  cmid?: number;
  course: number;
  name: string;
  duedate?: number;
}

interface MoodleSubmission {
  userid: number;
  status?: string; // 'submitted' | 'draft' | 'new'
  timemodified?: number;
}

export interface MoodleDiagnostics {
  coursesFound: number;
  studentsFound: number;
  lastSyncAt: number | null;
  lastError: string | null;
  warnings: string[];
}

interface RosterUserEntry {
  user: MoodleUser;
  courses: { id: number; code: string; name: string }[];
  groups: string[];
  /** Group (intake) names per course id. */
  groupsByCourse: Record<number, string[]>;
}

/** A course's whole gradebook in one call: every enrolled user's grade items. */
interface MoodleUserGrades { userid?: number; userfullname?: string; gradeitems?: MoodleGradeItem[] }

const stripHtml = (s: string) =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

export function moodleConfigured() {
  return Boolean(process.env.MOODLE_URL?.trim() && process.env.MOODLE_TOKEN?.trim());
}

export class MoodleLmsAdapter implements LmsAdapter {
  readonly mode = 'live' as const;
  private statuses = new Map<string, LearnerStatus>();
  private pushed: RemedialQuizRecord[] = [];
  private rosterCache: {
    at: number;
    courses: MoodleCourse[];
    users: Map<string, RosterUserEntry>;
  } | null = null;
  private courseContentsCache = new Map<number, { at: number; modules: Map<number, { name: string; modname: string; section: string }> }>();
  private assignCache = new Map<number, { at: number; assignments: MoodleAssignment[]; submissionsByAssign: Map<number, Map<number, { status: string; timemodified?: number }>> }>();
  private engagementCache = new Map<string, { at: number; value: EngagementMetrics }>();
  private assessmentsCache = new Map<string, { at: number; detailed: boolean; value: AssessmentRecord[] }>();
  private gradebookCache = new Map<number, { at: number; byUser: Map<number, MoodleGradeItem[]> | null }>();
  private courseGroupNames = new Map<number, string[]>();
  private latestActivityByStudent = new Map<string, number>();
  private diagnostics: MoodleDiagnostics = {
    coursesFound: 0,
    studentsFound: 0,
    lastSyncAt: null,
    lastError: null,
    warnings: [],
  };

  private baseUrl: string;
  private token: string;
  private courseIds?: number[];
  private courseGroups?: Record<number, number[]>;

  constructor(baseUrl: string, token: string, courseIds?: number[], courseGroups?: Record<number, number[]>) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.courseIds = courseIds;
    this.courseGroups = courseGroups;
  }

  forceRefresh() {
    this.rosterCache = null;
    this.courseContentsCache.clear();
    this.assignCache.clear();
    this.engagementCache.clear();
    this.assessmentsCache.clear();
    this.gradebookCache.clear();
    this.latestActivityByStudent.clear();
    this.diagnostics.warnings = [];
    this.diagnostics.lastError = null;
  }

  getDiagnostics(): MoodleDiagnostics {
    return { ...this.diagnostics, warnings: [...this.diagnostics.warnings] };
  }

  private warn(msg: string) {
    if (!this.diagnostics.warnings.includes(msg) && this.diagnostics.warnings.length < 8) {
      this.diagnostics.warnings.push(msg);
    }
  }

  private async ws<T>(fn: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    const cleanBase = this.baseUrl.trim().replace(/\/$/, '');
    const url = `${cleanBase}/webservice/rest/server.php`;
    const body = new URLSearchParams({
      wstoken: this.token.trim(),
      wsfunction: fn,
      moodlewsrestformat: 'json',
    });
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 16_000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body,
          signal: ctrl.signal,
          cache: 'no-store',
        });
        if (!res.ok) {
          const httpErr = new LmsError(`Moodle ${fn} → HTTP ${res.status}`);
          if (res.status >= 500 && attempt === 0) {
            lastErr = httpErr;
            await new Promise((r) => setTimeout(r, 450));
            continue;
          }
          throw httpErr;
        }
        const rawText = await res.text();
        let data: (T & { exception?: string; message?: string; errorcode?: string }) | null = null;
        try {
          data = JSON.parse(rawText);
        } catch {
          throw new LmsError(`Moodle ${fn} returned non-JSON (check Moodle URL & Web Services enabled)`);
        }
        if (data && typeof data === 'object' && 'exception' in data && data.exception) {
          throw new LmsError(`Moodle ${fn}: ${data.message || data.errorcode || data.exception}`);
        }
        return data as T;
      } catch (e) {
        const err = e instanceof LmsError ? e : new LmsError(`Moodle ${fn} unreachable: ${(e as Error).message}`, e);
        lastErr = err;
        const retryable = !(e instanceof LmsError);
        if (retryable && attempt === 0) {
          await new Promise((r) => setTimeout(r, 450));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new LmsError(`Moodle ${fn} failed`);
  }

  public async listCoursesWithGroups(): Promise<
    { id: number; shortname: string; fullname: string; groups: { id: number; name: string }[] }[]
  > {
    const saved = this.courseIds;
    this.courseIds = undefined;
    try {
      const courses = await this.discoverCourses();
      const out: { id: number; shortname: string; fullname: string; groups: { id: number; name: string }[] }[] = [];
      for (const c of courses.slice(0, 40)) {
        const groups = await this.ws<MoodleGroup[]>('core_group_get_course_groups', { courseid: c.id }).catch(() => []);
        out.push({
          id: c.id,
          shortname: (c.shortname || `COURSE-${c.id}`).trim(),
          fullname: (c.fullname || c.shortname || `Course ${c.id}`).trim(),
          groups: (Array.isArray(groups) ? groups : [])
            .filter((g) => g && g.id && g.name)
            .map((g) => ({ id: g.id, name: g.name })),
        });
      }
      return out;
    } finally {
      this.courseIds = saved;
    }
  }

  private async discoverCourses(): Promise<MoodleCourse[]> {
    const configuredIds = this.courseIds?.length
      ? new Set(this.courseIds)
      : process.env.MOODLE_COURSE_IDS
        ? new Set(process.env.MOODLE_COURSE_IDS.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0))
        : null;

    let discovered: MoodleCourse[] = [];
    let siteCourseErr: Error | null = null;

    try {
      const all = await this.ws<MoodleCourse[]>('core_course_get_courses');
      if (Array.isArray(all)) discovered = all;
    } catch (e) {
      siteCourseErr = e as Error;
    }

    // Fallback when token lacks site-wide core_course_get_courses capability
    if (!discovered.length) {
      try {
        const info = await this.ws<{ userid?: number }>('core_webservice_get_site_info');
        if (info?.userid) {
          const mine = await this.ws<MoodleCourse[]>('core_enrol_get_users_courses', { userid: info.userid });
          if (Array.isArray(mine) && mine.length) {
            discovered = mine;
            if (siteCourseErr) {
              this.warn('Using token-enrolled courses via core_enrol_get_users_courses.');
            }
          }
        }
      } catch (fallbackErr) {
        if (siteCourseErr) throw siteCourseErr;
        throw fallbackErr;
      }
    }

    let courses = discovered.filter((c) => {
      if (c.id <= 1) return false;
      if (configuredIds) return configuredIds.has(c.id);
      return c.visible !== 0;
    });

    if (!courses.length && configuredIds?.size) {
      courses = [...configuredIds].map((id) => ({ id, shortname: `COURSE-${id}`, fullname: `Moodle Course ${id}` }));
    }

    if (!courses.length && siteCourseErr) {
      throw siteCourseErr;
    }
    return courses;
  }

  private async ensureRoster() {
    if (this.rosterCache && Date.now() - this.rosterCache.at < 90_000) return this.rosterCache;

    try {
      const courses = await this.discoverCourses();
      const users = new Map<string, RosterUserEntry>();
      let enrolErrors = 0;
      let lastEnrolError = '';

      for (const c of courses.slice(0, 20)) {
        try {
          const enrolled = await this.ws<MoodleUser[]>('core_enrol_get_enrolled_users', { courseid: c.id });
          const courseCode = (c.shortname || `COURSE-${c.id}`).trim();
          const courseName = (c.fullname || c.shortname || `Course ${c.id}`).trim();
          const allowedGroupIds = this.courseGroups?.[c.id]?.length ? new Set(this.courseGroups[c.id]) : null;
          const courseGroupNames = new Map<number, string>();
          // The course's groups (its intakes), always: students carry their group names, and the gradebook filters by them.
          const cGroups = await this.ws<MoodleGroup[]>('core_group_get_course_groups', { courseid: c.id }).catch((e) => {
            this.warn(`Groups not read for ${courseCode}: ${(e as Error).message}`);
            return [];
          });
          for (const cg of Array.isArray(cGroups) ? cGroups : []) {
            if (cg?.id && cg?.name) courseGroupNames.set(cg.id, cg.name.trim());
          }
          this.courseGroupNames.set(c.id, [...courseGroupNames.values()].filter((n) => !/^test$/i.test(n)));

          for (const u of Array.isArray(enrolled) ? enrolled : []) {
            if (!u.id || u.suspended) continue;
            const isStaffOnly =
              u.roles?.some((r) => /teacher|editingteacher|manager|coursecreator|admin/i.test(r.shortname || '')) &&
              !u.roles?.some((r) => /student/i.test(r.shortname || ''));
            if (isStaffOnly) continue;

            const userGroups = Array.isArray(u.groups) ? u.groups : [];
            if (allowedGroupIds) {
              const matched = userGroups.filter((g) => allowedGroupIds.has(g.id));
              if (!matched.length) continue;
            }
            const groupNames = (allowedGroupIds
              ? userGroups.filter((g) => allowedGroupIds.has(g.id))
              : userGroups
            )
              .map((g) => (g.name || courseGroupNames.get(g.id) || '').trim())
              .filter(Boolean);

            const sid = `MDL-${u.id}`;
            const existing = users.get(sid);
            if (!existing) {
              users.set(sid, {
                user: u,
                courses: [{ id: c.id, code: courseCode, name: courseName }],
                groups: groupNames,
                groupsByCourse: { [c.id]: groupNames },
              });
            } else {
              existing.groupsByCourse[c.id] = groupNames;
              if (!existing.courses.some((x) => x.id === c.id)) {
                existing.courses.push({ id: c.id, code: courseCode, name: courseName });
              }
              for (const gn of groupNames) {
                if (!existing.groups.includes(gn)) existing.groups.push(gn);
              }
              if ((u.lastaccess || 0) > (existing.user.lastaccess || 0)) {
                existing.user.lastaccess = u.lastaccess;
              }
            }
          }
        } catch (e) {
          enrolErrors += 1;
          lastEnrolError = (e as Error).message;
        }
      }

      if (!users.size && enrolErrors > 0) {
        throw new LmsError(lastEnrolError || 'Moodle core_enrol_get_enrolled_users failed.');
      }

      this.diagnostics.coursesFound = courses.length;
      this.diagnostics.studentsFound = users.size;
      this.diagnostics.lastSyncAt = Date.now();
      this.diagnostics.lastError = null;
      if (enrolErrors > 0) {
        this.warn(`${enrolErrors} course(s) skipped due to enrolment read error: ${lastEnrolError}`);
      }

      this.rosterCache = { at: Date.now(), courses, users };
      return this.rosterCache;
    } catch (e) {
      const msg = (e as Error).message;
      this.diagnostics.lastError = msg;
      throw e instanceof LmsError ? e : new LmsError(msg, e);
    }
  }

  private async courseModuleMap(courseId: number): Promise<Map<number, { name: string; modname: string; section: string }>> {
    const cached = this.courseContentsCache.get(courseId);
    if (cached && Date.now() - cached.at < 300_000) return cached.modules;

    const map = new Map<number, { name: string; modname: string; section: string }>();
    try {
      const sections = await this.ws<MoodleSection[]>('core_course_get_contents', { courseid: courseId });
      for (const sec of Array.isArray(sections) ? sections : []) {
        const secName = sec.name ? stripHtml(sec.name) : `Section ${sec.id}`;
        for (const mod of sec.modules || []) {
          if (!mod.id || mod.visible === 0) continue;
          map.set(mod.id, {
            name: mod.name ? stripHtml(mod.name) : `Activity ${mod.id}`,
            modname: mod.modname || 'activity',
            section: secName,
          });
        }
      }
    } catch {
      this.warn(`core_course_get_contents unavailable for course ${courseId} (enable in Moodle External Service to map activity names).`);
    }
    this.courseContentsCache.set(courseId, { at: Date.now(), modules: map });
    return map;
  }

  private async courseAssignments(courseId: number) {
    const cached = this.assignCache.get(courseId);
    if (cached && Date.now() - cached.at < 180_000) return cached;

    let assignments: MoodleAssignment[] = [];
    const submissionsByAssign = new Map<number, Map<number, { status: string; timemodified?: number }>>();
    try {
      const resp = await this.ws<{ courses?: { id: number; assignments?: MoodleAssignment[] }[] }>('mod_assign_get_assignments', {
        'courseids[0]': courseId,
      });
      assignments = resp.courses?.[0]?.assignments || [];
      if (assignments.length) {
        const params: Record<string, string | number> = {};
        assignments.slice(0, 15).forEach((a, i) => {
          params[`assignmentids[${i}]`] = a.id;
        });
        const subs = await this.ws<{ assignments?: { assignmentid: number; submissions?: MoodleSubmission[] }[] }>(
          'mod_assign_get_submissions',
          params,
        ).catch(() => ({ assignments: [] }));
        for (const aSub of subs.assignments || []) {
          const byUser = new Map<number, { status: string; timemodified?: number }>();
          for (const sub of aSub.submissions || []) {
            byUser.set(sub.userid, { status: sub.status || 'new', timemodified: sub.timemodified });
          }
          submissionsByAssign.set(aSub.assignmentid, byUser);
        }
      }
    } catch {
      /* mod_assign functions optional */
    }
    const entry = { at: Date.now(), assignments, submissionsByAssign };
    this.assignCache.set(courseId, entry);
    return entry;
  }

  private toProfile(sid: string, entry: RosterUserEntry): StudentProfile {
    const u = entry.user;
    const primary = entry.courses[0] || { id: 0, code: 'MOODLE', name: 'Moodle Course' };
    const coursePart =
      entry.courses.length > 1
        ? `${primary.code} (+${entry.courses.length - 1})`
        : primary.code;
    const cohortLabel = entry.groups.length
      ? `${primary.code} · ${entry.groups.slice(0, 2).join(', ')}`
      : coursePart;
    const name = (u.fullname || `${u.firstname || ''} ${u.lastname || ''}`.trim() || u.username || `Learner ${u.id}`).trim();
    return {
      id: sid,
      name,
      email: u.email || `${sid.toLowerCase()}@student.example.com`,
      phone: u.phone1 || u.phone2 || undefined,
      cohort: cohortLabel,
      programme: entry.courses.map((c) => c.name).slice(0, 2).join(' · ') || primary.name,
      programmeCode: primary.code.split(/[-_\s]/)[0] || 'MDL',
      enrolledAt: u.firstaccess ? new Date(u.firstaccess * 1000).toISOString() : new Date().toISOString(),
      status: this.statuses.get(sid) || 'on_track',
      groups: [...entry.groups],
    };
  }

  async listStudents(): Promise<StudentProfile[]> {
    const r = await this.ensureRoster();
    return [...r.users.entries()].map(([sid, entry]) => this.toProfile(sid, entry));
  }

  async getStudent(id: string): Promise<StudentProfile | null> {
    const r = await this.ensureRoster();
    const entry = r.users.get(id);
    return entry ? this.toProfile(id, entry) : null;
  }

  async getEngagement(id: string): Promise<EngagementMetrics | null> {
    const cached = this.engagementCache.get(id);
    if (cached && Date.now() - cached.at < 90_000) return cached.value;

    const r = await this.ensureRoster();
    const entry = r.users.get(id);
    if (!entry) return null;
    const u = entry.user;
    const userid = u.id;

    // Fetch student's own courses with Moodle native progress % when available
    const userCourses = await this.ws<MoodleCourse[]>('core_enrol_get_users_courses', { userid }).catch(() => []);
    const progressByCourse = new Map<number, { progress: number | null; lastaccess?: number }>();
    let latestActivitySec = Math.max(u.lastaccess || 0, this.latestActivityByStudent.get(id) || 0);
    for (const c of Array.isArray(userCourses) ? userCourses : []) {
      progressByCourse.set(c.id, {
        progress: typeof c.progress === 'number' ? Math.round(c.progress) : null,
        lastaccess: c.lastaccess,
      });
      if ((c.lastaccess || 0) > latestActivitySec) latestActivitySec = c.lastaccess || 0;
    }

    let completedTotal = 0;
    let activitiesTotal = 0;
    let overdueAssignments = 0;
    const coursesSummary: NonNullable<EngagementMetrics['courses']> = [];
    const incompleteActivities: NonNullable<EngagementMetrics['incompleteActivities']> = [];
    const upcoming: NonNullable<EngagementMetrics['upcoming']> = [];
    let currentModule: { code: string; title: string; progressPct: number } | null = null;
    const nowSec = Math.floor(Date.now() / 1000);

    for (const c of entry.courses.slice(0, 4)) {
      const [contents, compResp, assignData] = await Promise.all([
        this.courseModuleMap(c.id),
        this.ws<{ statuses?: MoodleCompletionStatus[] }>('core_completion_get_activities_completion_status', {
          courseid: c.id,
          userid,
        }).catch(() => ({ statuses: [] })),
        this.courseAssignments(c.id),
      ]);

      const statuses = compResp.statuses || [];
      for (const st of statuses) {
        if ((st.timecompleted || 0) > latestActivitySec) {
          latestActivitySec = st.timecompleted || 0;
        }
      }
      const done = statuses.filter((s) => s.state === 1 || s.state === 2).length;
      const tot = statuses.length;
      completedTotal += done;
      activitiesTotal += tot;

      const nativePct = progressByCourse.get(c.id)?.progress ?? null;
      const coursePct = tot > 0 ? Math.round((done / tot) * 100) : (nativePct ?? (latestActivitySec <= 0 ? 0 : 50));

      coursesSummary.push({
        id: c.id,
        code: c.code,
        name: c.name,
        progressPct: coursePct,
        completedActivities: done,
        totalActivities: tot,
      });

      // Collect incomplete activities with real Moodle names/sections
      for (const st of statuses) {
        if (st.state === 0 || st.state === 3) {
          const meta = contents.get(st.cmid);
          const itemTitle = meta?.name || `Activity #${st.cmid}`;
          if (incompleteActivities.length < 8) {
            incompleteActivities.push({
              name: meta?.section ? `${meta.section}: ${itemTitle}` : itemTitle,
              type: meta?.modname || st.modname || 'activity',
              course: c.code,
            });
          }
        }
      }

      // Check overdue / unsubmitted assignments & capture submission activity timestamp
      for (const a of assignData.assignments) {
        const duePassed = Boolean(a.duedate && a.duedate > 0 && a.duedate < nowSec);
        const subEntry = assignData.submissionsByAssign.get(a.id)?.get(userid);
        if ((subEntry?.timemodified || 0) > latestActivitySec && (subEntry?.status === 'submitted' || subEntry?.status === 'draft')) {
          latestActivitySec = subEntry?.timemodified || 0;
        }
        const submitted = subEntry?.status === 'submitted';
        if (!duePassed && !submitted && a.duedate && a.duedate > nowSec) {
          upcoming.push({ name: a.name, course: c.code, dueAt: new Date(a.duedate * 1000).toISOString() });
        }
        if (duePassed && !submitted) {
          overdueAssignments += 1;
          incompleteActivities.unshift({
            name: `Overdue assignment: ${a.name}`,
            type: 'assign',
            course: c.code,
            dueAt: a.duedate ? new Date(a.duedate * 1000).toISOString() : undefined,
          });
        }
      }

      if (!currentModule) {
        const firstOpen = statuses.find((st) => st.state === 0 || st.state === 3);
        const openMeta = firstOpen ? contents.get(firstOpen.cmid) : undefined;
        currentModule = {
          code: c.code,
          title: openMeta?.section || openMeta?.name || c.name,
          progressPct: coursePct,
        };
      }
    }

    const neverLoggedIn = latestActivitySec <= 0;
    const daysSinceLastLogin = latestActivitySec > 0
      ? Math.max(0, Math.floor((Date.now() - latestActivitySec * 1000) / 86_400_000))
      : 30;
    if (latestActivitySec > 0) this.latestActivityByStudent.set(id, latestActivitySec);

    const nativeAvg = coursesSummary.length
      ? Math.round(coursesSummary.reduce((sum, c) => sum + (c.progressPct ?? 0), 0) / coursesSummary.length)
      : 0;
    const completionPct = activitiesTotal > 0
      ? Math.round((completedTotal / activitiesTotal) * 100)
      : nativeAvg;

    const primaryCourse = entry.courses[0];
    const value: EngagementMetrics = {
      studentId: id,
      loginStreakDays: neverLoggedIn ? 0 : daysSinceLastLogin <= 1 ? 3 : 0,
      daysSinceLastLogin,
      neverLoggedIn,
      modulesCompleted: activitiesTotal > 0 ? completedTotal : coursesSummary.filter((c) => (c.progressPct ?? 0) >= 80).length,
      modulesTotal: activitiesTotal > 0 ? activitiesTotal : Math.max(1, entry.courses.length),
      completionPct,
      currentModule: currentModule || {
        code: primaryCourse?.code || 'MOODLE',
        title: primaryCourse?.name || 'Moodle Course',
        progressPct: completionPct,
      },
      hoursThisWeek: neverLoggedIn ? 0 : daysSinceLastLogin >= 7 ? 0.5 : daysSinceLastLogin >= 3 ? 2.0 : 4.5,
      forumPosts: 0,
      lastActivityAt: latestActivitySec > 0 ? new Date(latestActivitySec * 1000).toISOString() : new Date(0).toISOString(),
      missedAssignments: overdueAssignments,
      overdueAssignments,
      courses: coursesSummary,
      incompleteActivities: incompleteActivities.slice(0, 8),
      upcoming: upcoming.sort((x, y) => x.dueAt.localeCompare(y.dueAt)).slice(0, 5),
    };

    this.engagementCache.set(id, { at: Date.now(), value });
    return value;
  }

  private async missedQuestionsForAttempt(attemptId: number): Promise<MissedQuestion[]> {
    try {
      const review = await this.ws<{ questions?: MoodleReviewQuestion[] }>('mod_quiz_get_attempt_review', { attemptid: attemptId });
      const out: MissedQuestion[] = [];
      for (const q of review.questions || []) {
        const status = `${q.status || ''} ${q.state || ''}`.toLowerCase();
        const isWrong = /incorrect|gaveup|wrong|partial/.test(status) || (q.mark === '0.00' || q.mark === '0');
        if (!isWrong || !q.html) continue;
        const text = stripHtml(q.html);
        if (text.length < 12) continue;
        out.push({ prompt: text.slice(0, 260) });
        if (out.length >= 4) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  async getAssessments(id: string, opts: { includeMissedQuestions?: boolean } = {}): Promise<AssessmentRecord[]> {
    const wantDetailed = Boolean(opts.includeMissedQuestions);
    const cached = this.assessmentsCache.get(id);
    if (cached && Date.now() - cached.at < 90_000 && (!wantDetailed || cached.detailed)) {
      return cached.value;
    }

    const r = await this.ensureRoster();
    const entry = r.users.get(id);
    if (!entry) return [];
    const userid = entry.user.id;
    const out: AssessmentRecord[] = [];

    for (const c of entry.courses.slice(0, 5)) {
      try {
        const book = await this.courseGrades(c.id);
        const items = book
          ? book.get(userid) || []
          : (await this.ws<{ usergrades?: { gradeitems?: MoodleGradeItem[] }[] }>('gradereport_user_get_grade_items', { courseid: c.id, userid })).usergrades?.[0]?.gradeitems || [];
        const hasFailedQuiz = wantDetailed && items.some((it) => it.itemmodule === 'quiz' && it.graderaw != null && it.grademax && (it.graderaw / it.grademax) * 100 < 60);
        const quizzes = hasFailedQuiz
          ? (await this.ws<{ quizzes?: MoodleQuiz[] }>('mod_quiz_get_quizzes_by_courses', {
              'courseids[0]': c.id,
            }).catch(() => ({ quizzes: [] }))).quizzes || []
          : [];

        let missedQuestionsFetched = 0;
        for (const item of items) {
          if (!item.itemname || item.graderaw == null || !item.grademax || item.grademax <= 0) continue;
          const pct = Math.round((item.graderaw / item.grademax) * 100);
          const rawPass = item.gradepass != null ? Number(item.gradepass) : 0;
          const passMark = rawPass > 0 && item.grademax > 0 ? Math.round((rawPass / item.grademax) * 100) : 60;
          const matchedMod = MODULES.find((m) => item.itemname!.toLowerCase().includes(m.code.toLowerCase()));
          const cleanFeedback = item.feedback ? stripHtml(item.feedback) : undefined;

          let missedQuestions: MissedQuestion[] = [];
          let latestAttemptSec = 0;
          // Two-stage token/API efficiency: ONLY inspect full quiz question HTML when triggered for a low-scoring quiz (max 1 quiz deep dive per call).
          if (wantDetailed && missedQuestionsFetched < 1 && item.itemmodule === 'quiz' && item.iteminstance && pct < passMark) {
            const qz = quizzes.find((x) => x.id === item.iteminstance);
            if (qz) {
              const att = await this.ws<{ attempts?: MoodleAttempt[] }>('mod_quiz_get_user_attempts', {
                quizid: qz.id,
                userid,
                status: 'finished',
              }).catch(() => ({ attempts: [] }));
              const latest = [...(att.attempts || [])].sort((a, b) => (b.timefinish || 0) - (a.timefinish || 0))[0];
              if (latest?.timefinish) latestAttemptSec = latest.timefinish;
              if (latest) {
                missedQuestions = await this.missedQuestionsForAttempt(latest.id);
                if (missedQuestions.length) missedQuestionsFetched += 1;
              }
            }
          }
          const activitySec = Math.max(latestAttemptSec, item.gradedatesubmitted || 0, item.gradedategraded || 0);
          if (activitySec > (this.latestActivityByStudent.get(id) || 0)) {
            this.latestActivityByStudent.set(id, activitySec);
          }

          out.push({
            id: `${id}-MDL-${c.id}-${item.id || out.length + 1}`,
            studentId: id,
            moduleCode: matchedMod?.code || c.code,
            moduleTitle: `${c.code} · ${item.itemname}`,
            title: item.itemname,
            scorePct: pct,
            passMark,
            passed: pct >= passMark,
            takenAt: activitySec > 0 ? new Date(activitySec * 1000).toISOString() : '',
            weakTopics: pct < passMark ? [item.itemname] : [],
            missedQuestions: missedQuestions.length ? missedQuestions : undefined,
            feedback: cleanFeedback || undefined,
            courseName: c.name,
            kind: item.itemmodule === 'assign' ? 'project' : 'quiz',
          });
        }
      } catch (e) {
        this.warn(`Gradebook read skipped on ${c.code}: ${(e as Error).message}`);
      }
    }

    const extra = this.pushed
      .filter((p) => p.studentId === id)
      .map((p, i) => ({
        id: `${id}-R${i + 1}`,
        studentId: id,
        moduleCode: p.moduleCode,
        moduleTitle: MODULES.find((m) => m.code === p.moduleCode)?.title || p.moduleCode,
        title: `${p.moduleCode} Remedial Micro-Quiz`,
        scorePct: p.scorePct,
        passMark: 67,
        passed: p.passed,
        takenAt: p.completedAt,
        weakTopics: [],
        kind: 'remedial' as const,
      }));

    const finalList = [...out, ...extra];
    this.assessmentsCache.set(id, { at: Date.now(), detailed: wantDetailed, value: finalList });
    return finalList;
  }

  /** A course's whole gradebook in one call (every enrolled user), kept for the length of a sync. Null if Moodle refused. */
  private async courseGrades(courseId: number): Promise<Map<number, MoodleGradeItem[]> | null> {
    const hit = this.gradebookCache.get(courseId);
    if (hit && Date.now() - hit.at < 90_000) return hit.byUser;
    let byUser: Map<number, MoodleGradeItem[]> | null = null;
    try {
      const res = await this.ws<{ usergrades?: MoodleUserGrades[] }>('gradereport_user_get_grade_items', { courseid: courseId });
      byUser = new Map();
      for (const ug of res.usergrades || []) if (ug.userid) byUser.set(ug.userid, ug.gradeitems || []);
    } catch (e) {
      this.warn(`Whole-course gradebook not available for course ${courseId} (${(e as Error).message}); reading it student by student.`);
    }
    this.gradebookCache.set(courseId, { at: Date.now(), byUser });
    return byUser;
  }

  /** Every course's full gradebook for the students on the roster: all items (graded or not), feedback, the course total, and each student's group. */
  async getGradebooks(): Promise<CourseGradebook[]> {
    const r = await this.ensureRoster();
    const out: CourseGradebook[] = [];
    for (const c of r.courses.slice(0, 20)) {
      const book = await this.courseGrades(c.id);
      if (!book) continue;
      const code = (c.shortname || `COURSE-${c.id}`).trim();
      const name = (c.fullname || c.shortname || `Course ${c.id}`).trim();
      const items = new Map<number, GbItem>();
      const students: CourseGradebook['students'] = [];
      for (const [sid, entry] of r.users) {
        if (!entry.courses.some((x) => x.id === c.id)) continue;
        const gi = book.get(entry.user.id) || [];
        const cells: Record<string, GbCell> = {};
        let total: number | null = null;
        for (const it of gi) {
          if (!it.id) continue;
          const min = Number(it.grademin || 0);
          const max = Number(it.grademax || 0);
          const pct = it.graderaw != null && max > min ? Math.round(((Number(it.graderaw) - min) / (max - min)) * 1000) / 10 : null;
          if (it.itemtype === 'course') { total = pct; continue; }
          if (!items.has(it.id)) {
            const rawPass = it.gradepass != null ? Number(it.gradepass) : 0;
            items.set(it.id, {
              id: it.id,
              name: stripHtml(it.itemname || (it.itemtype === 'category' ? 'Category total' : `Item ${it.id}`)),
              kind: it.itemmodule || it.itemtype || 'item',
              max,
              pass: rawPass > 0 && max > 0 ? Math.round((rawPass / max) * 100) : null,
              ...(it.gradeishidden ? { hidden: true } : {}),
            });
          }
          if (it.graderaw == null) continue;
          const at = Math.max(it.gradedategraded || 0, it.gradedatesubmitted || 0);
          const fb = it.feedback ? stripHtml(it.feedback).slice(0, 300) : '';
          cells[String(it.id)] = { g: Math.round(Number(it.graderaw) * 100) / 100, pct, ...(fb ? { f: fb } : {}), ...(at ? { at: at * 1000 } : {}) };
        }
        const name2 = (entry.user.fullname || `${entry.user.firstname || ''} ${entry.user.lastname || ''}`.trim() || `Learner ${entry.user.id}`).trim();
        students.push({ id: sid, name: name2, email: entry.user.email || '', groups: entry.groupsByCourse[c.id] || [], cells, total });
      }
      students.sort((a, b) => a.name.localeCompare(b.name));
      out.push({ courseId: c.id, code, name, groups: this.courseGroupNames.get(c.id) || [], items: [...items.values()], students, syncedAt: Date.now() });
    }
    return out;
  }

  async getModule(code: string): Promise<ModuleSyllabus | null> {
    return MODULES.find((m) => m.code === code) || null;
  }

  async recordRemedialQuiz(record: RemedialQuizRecord) {
    this.pushed.push(record);
    this.assessmentsCache.delete(record.studentId);
    return { ok: true, syncedAt: new Date().toISOString() };
  }

  async updateStudentStatus(id: string, status: LearnerStatus) {
    this.statuses.set(id, status);
    return { ok: true };
  }
}

export async function testMoodleConnection(override?: { url?: string; token?: string; courseIds?: string }) {
  const url = (override?.url || process.env.MOODLE_URL || '').trim();
  const token = (override?.token || process.env.MOODLE_TOKEN || '').trim();
  if (!url || !token) return { ok: false, error: 'Moodle URL and Web Service Token are required.' };
  const courseIds = (override?.courseIds || process.env.MOODLE_COURSE_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  try {
    const adapter = new MoodleLmsAdapter(url, token, courseIds.length ? courseIds : undefined);
    const students = await adapter.listStudents();
    const diag = adapter.getDiagnostics();
    return {
      ok: true,
      students: students.length,
      courses: diag.coursesFound,
      detail: `Connected · ${diag.coursesFound} course(s), ${students.length} learner(s)${diag.warnings.length ? ` (${diag.warnings[0]})` : ''}`,
      warnings: diag.warnings,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
