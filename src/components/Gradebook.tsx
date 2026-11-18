'use client';

import { useEffect, useMemo, useState } from 'react';
import Icon from '@/components/Icon';
import type { CourseGradebook, GbCell, GbItem } from '@/lib/lms/gradebook';
import './gradebook.css';

/* The saved Moodle gradebooks: one course at a time, every student (filter by
 * group / intake), every grade item, the course total and the class average.
 * Read from what the last sync saved, so it opens even when Moodle is offline. */

type Books = { courses: CourseGradebook[]; syncedAt: number | null };

const NO_GROUP = '__none__';

const KIND: Record<string, string> = { quiz: 'Quiz', assign: 'Assignment', attendance: 'Attendance', manual: 'Manual', category: 'Category', forum: 'Forum', lesson: 'Lesson', workshop: 'Workshop', h5pactivity: 'H5P', scorm: 'SCORM' };

function tone(cell: GbCell | undefined, it: GbItem): string {
  if (!cell || cell.pct == null) return '';
  const pass = it.pass ?? 50;
  if (cell.pct < pass) return it.pass != null ? 'is-fail' : 'is-low';
  return 'is-ok';
}

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');

export default function Gradebook({ onSync, syncing }: { onSync?: () => void; syncing?: boolean }) {
  const [data, setData] = useState<Books | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [courseId, setCourseId] = useState<number | null>(null);
  const [group, setGroup] = useState<string>('');
  const [q, setQ] = useState('');
  const [gradedOnly, setGradedOnly] = useState(true);

  useEffect(() => {
    let live = true;
    fetch('/api/lms/gradebook', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: Books) => { if (live) { setData(d); setCourseId((c) => c ?? d.courses[0]?.courseId ?? null); } })
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [syncing]);

  const course = data?.courses.find((c) => c.courseId === courseId) || null;

  const students = useMemo(() => {
    if (!course) return [];
    const term = q.trim().toLowerCase();
    return course.students.filter((s) => {
      if (group === NO_GROUP && s.groups.length) return false;
      if (group && group !== NO_GROUP && !s.groups.includes(group)) return false;
      return !term || s.name.toLowerCase().includes(term) || s.email.toLowerCase().includes(term);
    });
  }, [course, group, q]);

  const items = useMemo(() => {
    if (!course) return [];
    return course.items.filter((it) => !gradedOnly || course.students.some((s) => s.cells[String(it.id)]));
  }, [course, gradedOnly]);

  const avg = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const it of items) {
      const v = students.map((s) => s.cells[String(it.id)]?.pct).filter((x): x is number => typeof x === 'number');
      out[String(it.id)] = v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
    }
    const totals = students.map((s) => s.total).filter((x): x is number => typeof x === 'number');
    out.total = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : null;
    return out;
  }, [items, students]);

  if (error) return <div className="pg-err"><Icon name="warn" size={15} /> Could not read the saved gradebooks: {error}</div>;
  if (!data) return <div className="gb-empty"><Icon name="spinner" size={16} className="spin" /> Loading the saved gradebooks…</div>;
  if (!data.courses.length) {
    return (
      <div className="set-card gb-empty-card">
        <h3><Icon name="book" size={18} /> No gradebooks saved yet</h3>
        <p>Every Moodle sync saves each course&apos;s full gradebook here, so it opens even when Moodle is offline.</p>
        {onSync && <button type="button" className="btn btn-cta btn-sm" disabled={syncing} onClick={onSync}><Icon name="refresh" size={14} className={syncing ? 'spin' : undefined} /> {syncing ? 'Syncing…' : 'Sync Moodle now'}</button>}
      </div>
    );
  }

  const groupCount = (g: string) => course?.students.filter((s) => (g === NO_GROUP ? !s.groups.length : s.groups.includes(g))).length ?? 0;
  const groupsHere = course ? [...new Set([...course.groups, ...course.students.flatMap((s) => s.groups)])].sort() : [];
  const hiddenItems = course ? course.items.length - items.length : 0;
  const csvHref = course ? `/api/lms/gradebook?csv=${course.courseId}${group ? `&group=${encodeURIComponent(group)}` : ''}` : '#';

  return (
    <div className="gb">
      <div className="gb-courses" role="tablist" aria-label="Courses">
        {data.courses.map((c) => (
          <button key={c.courseId} type="button" role="tab" aria-selected={c.courseId === courseId} className={`gb-course${c.courseId === courseId ? ' on' : ''}`} onClick={() => { setCourseId(c.courseId); setGroup(''); }}>
            <b>{c.code}</b>
            <span>{c.name}</span>
            <em>{c.students.length} students · {c.items.length} items</em>
          </button>
        ))}
      </div>

      {course && (
        <>
          <div className="gb-bar">
            <label className="gb-field">
              <span>Group</span>
              <select value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">All groups ({course.students.length})</option>
                {groupsHere.map((g) => <option key={g} value={g}>{g} ({groupCount(g)})</option>)}
                <option value={NO_GROUP}>No group in Moodle ({groupCount(NO_GROUP)})</option>
              </select>
            </label>
            <label className="gb-field gb-search">
              <span>Find a student</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or email" />
            </label>
            <label className="gb-check">
              <input type="checkbox" checked={gradedOnly} onChange={(e) => setGradedOnly(e.target.checked)} />
              Only items with grades{gradedOnly && hiddenItems ? ` (${hiddenItems} not graded yet hidden)` : ''}
            </label>
            <a className="btn btn-outline btn-sm" href={csvHref} download><Icon name="download" size={13} /> CSV</a>
          </div>

          {groupCount(NO_GROUP) > 0 && (
            <p className="gb-note"><Icon name="warn" size={13} /> {groupCount(NO_GROUP)} of {course.students.length} students in {course.code} are not in any Moodle group (intake). Add them to their intake group in Moodle and the next sync picks it up.</p>
          )}

          {!items.length ? (
            <p className="gb-note">No grades in {course.code} yet{gradedOnly && course.items.length ? `: its ${course.items.length} items are not graded. Untick "Only items with grades" to see them.` : '.'}</p>
          ) : (
            <div className="gb-scroll">
              <table className="gb-table">
                <thead>
                  <tr>
                    <th className="gb-who">Student <span>{students.length}</span></th>
                    {items.map((it) => (
                      <th key={it.id} title={`${it.name} · out of ${it.max}${it.pass != null ? ` · pass ${it.pass}%` : ''}`}>
                        <span className="gb-kind">{KIND[it.kind] || it.kind}</span>
                        <span className="gb-name">{it.name}</span>
                        <span className="gb-max">/{it.max}{it.pass != null ? ` · pass ${it.pass}%` : ''}</span>
                      </th>
                    ))}
                    <th className="gb-total">Course total</th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => (
                    <tr key={s.id}>
                      <th className="gb-who" scope="row" title={s.email}>
                        <b>{s.name}</b>
                        <span>{s.groups.length ? s.groups.join(', ') : 'No group'}</span>
                      </th>
                      {items.map((it) => {
                        const c = s.cells[String(it.id)];
                        return (
                          <td key={it.id} className={tone(c, it)} title={c ? `${c.g} / ${it.max}${c.at ? ` · ${when(c.at)}` : ''}${c.f ? `\nFeedback: ${c.f}` : ''}` : 'Not graded'}>
                            {c ? (c.pct != null ? `${Math.round(c.pct)}%` : c.g) : <span className="gb-dash">–</span>}
                            {c?.f ? <i className="gb-fb" aria-label="Has feedback" /> : null}
                          </td>
                        );
                      })}
                      <td className="gb-total">{s.total != null ? `${Math.round(s.total)}%` : <span className="gb-dash">–</span>}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th className="gb-who" scope="row"><b>Average</b><span>graded students</span></th>
                    {items.map((it) => <td key={it.id}>{avg[String(it.id)] != null ? `${avg[String(it.id)]}%` : '–'}</td>)}
                    <td className="gb-total">{avg.total != null ? `${avg.total}%` : '–'}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <p className="gb-foot">Saved from Moodle {when(course.syncedAt)}. Opens from this saved copy even when Moodle is offline; every sync refreshes it.</p>
        </>
      )}
    </div>
  );
}

/** One student's full gradebook (every course), for the Inspect panel. */
export function StudentGradebook({ studentId }: { studentId: string }) {
  type Row = { courseId: number; code: string; name: string; groups: string[]; total: number | null; syncedAt: number; items: (GbItem & { cell: GbCell | null })[] };
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/lms/gradebook?student=${encodeURIComponent(studentId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { courses: [] }))
      .then((d: { courses: Row[] }) => live && setRows(d.courses))
      .catch(() => live && setRows([]));
    return () => { live = false; };
  }, [studentId]);
  if (!rows) return <p className="dim">Loading the gradebook…</p>;
  if (!rows.length) return <p className="dim">No saved gradebook for this student yet (sync Moodle).</p>;
  return (
    <div className="gb-student">
      {rows.map((c) => {
        const graded = c.items.filter((i) => i.cell);
        return (
          <div key={c.courseId}>
            <div className="gb-student-h">
              <b>{c.code}</b>
              <span>{c.groups.length ? c.groups.join(', ') : 'No group'} · {graded.length}/{c.items.length} graded · total {c.total != null ? `${Math.round(c.total)}%` : '–'}</span>
            </div>
            {graded.length ? (
              <ul>
                {graded.map((i) => (
                  <li key={i.id} className={tone(i.cell || undefined, i)}>
                    <span>{i.name}</span>
                    <b>{i.cell!.pct != null ? `${Math.round(i.cell!.pct)}%` : i.cell!.g}</b>
                    {i.cell!.f ? <em>{i.cell!.f}</em> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="dim">Nothing graded yet.</p>}
          </div>
        );
      })}
    </div>
  );
}
