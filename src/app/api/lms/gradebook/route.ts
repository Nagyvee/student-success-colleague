import { NextResponse } from 'next/server';
import { runWithSessionTenant } from '@/lib/auth/requestTenant';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { bootReady } from '@/lib/engine/automation';
import { gradebookCsv, listGradebooks, studentGradebook } from '@/lib/lms/gradebook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* The saved Moodle gradebooks (refreshed by every sync; readable when Moodle is not).
 *
 * GET                      every course: items, students with their groups and grades, course totals
 * GET ?student=<id>        one student's gradebook across their courses
 * GET ?csv=<courseId>      one course as CSV (&group=<name>, or __none__ for students in no group) */
export async function GET(req: Request) {
  return runWithSessionTenant(req, async () => {
    await bootReady(currentTenantId());
    const url = new URL(req.url);
    const student = url.searchParams.get('student');
    if (student) return NextResponse.json({ courses: studentGradebook(student) });
    const csv = url.searchParams.get('csv');
    if (csv) {
      const c = listGradebooks().courses.find((x) => String(x.courseId) === csv);
      if (!c) return NextResponse.json({ error: 'No saved gradebook for that course yet. Sync Moodle first.' }, { status: 404 });
      const group = url.searchParams.get('group') || undefined;
      const name = `${c.code}${group && group !== '__none__' ? `-${group}` : group === '__none__' ? '-no-group' : ''}-gradebook.csv`.replace(/[^A-Za-z0-9._-]+/g, '_');
      return new Response(gradebookCsv(c, group), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` } });
    }
    return NextResponse.json(listGradebooks());
  });
}
