'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentRun,
  AgentTrigger,
  CustomAgentDef,
  DataSource,
  DataSourceKind,
  OfficeDef,
  RecordField,
  WorkflowDef,
} from '@/lib/types';

/* The building as the screens see it: GET /api/departments, polled.
 *
 * Floors are departments (floor 1 at the bottom), each with its agents, each
 * agent with its workflow and latest run. The helpers here turn runs and
 * triggers into the plain words shown on desks and in lists. */

export interface AgentRow extends CustomAgentDef {
  workflow: WorkflowDef | null;
  activeRuns: number;
  /** An agent of this floor is working right now. */
  working?: boolean;
  /** Its latest run failed or had a failed step (last 24h). */
  hasError?: boolean;
  lastRun: AgentRun | null;
}

export interface DepartmentRow extends OfficeDef {
  agents: AgentRow[];
}

export interface BuildingData {
  departments: DepartmentRow[];
  sources: DataSource[];
  runs: AgentRun[];
  autopilot: boolean;
  requireApproval: boolean;
  liveOutreach: boolean;
  /** The server's sending lock (test phase). */
  sendingPaused?: boolean;
  knowledge: { agentKnowledge: string; applyUrl: string };
  leadsWebhook: { path: string; token: string | null };
  fieldLabels: Record<RecordField, string>;
  kindFields: Record<DataSourceKind, RecordField[]>;
}

export const ACTIVE_STATUSES: AgentRun['status'][] = ['running', 'waiting', 'awaiting_approval'];

/** Poll the building every `everyMs` (default 10s). */
export function useBuildingData(everyMs = 10_000) {
  const [data, setData] = useState<BuildingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/departments', { cache: 'no-store' });
      const j = await res.json().catch(() => null);
      if (!alive.current) return;
      if (!res.ok || !j || !Array.isArray(j.departments)) {
        setError((j && j.error) || `Could not load the building (HTTP ${res.status}).`);
        return;
      }
      setError(null);
      setData(j as BuildingData);
    } catch {
      if (alive.current) setError('Could not reach the server.');
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = setInterval(() => { void refresh(); }, everyMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [refresh, everyMs]);

  return { data, error, refresh };
}

export async function postDepartments<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T & { ok?: boolean; error?: string }> {
  const res = await fetch('/api/departments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok && !j.error) j.error = `Request failed (HTTP ${res.status}).`;
  return j;
}

/* ── Words ────────────────────────────────────────────────────────────────── */

export const sortedFloors = (d: DepartmentRow[]) => [...d].sort((a, b) => (a.floor ?? 99) - (b.floor ?? 99));

const shortName = (n: string) => {
  const parts = n.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] || n;
};

export function whenLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const days = Math.round((ts - now) / 86_400_000);
  if (days >= -6 && days <= 6) return `${d.toLocaleDateString('en-ZA', { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })} ${time}`;
}

export function agoLabel(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export type DeskMood = 'working' | 'waiting' | 'approval' | 'idle' | 'error' | 'done';

/** What an agent is doing now, from its latest run. */
export function agentNow(a: AgentRow, now = Date.now()): { mood: DeskMood; text: string } {
  const r = a.lastRun;
  if (a.enabled === false || a.workflow?.enabled === false) return { mood: 'idle', text: 'Paused' };
  if (!r) return { mood: 'idle', text: a.workflow?.steps?.length ? 'Idle · waiting for work' : 'No job set up yet' };
  const who = shortName(r.record.name);
  const last = r.logs[r.logs.length - 1];
  switch (r.status) {
    case 'running':
      return { mood: 'working', text: `${last?.title && last.title !== 'Run' ? last.title : 'Working'} · ${who}` };
    case 'waiting':
      return { mood: 'waiting', text: r.resumeAt ? `Waiting until ${whenLabel(r.resumeAt, now)} · ${who}` : `Waiting · ${who}` };
    case 'awaiting_approval':
      return { mood: 'approval', text: `Draft ready, waiting for approval · ${who}` };
    case 'failed':
      return { mood: 'error', text: `Stopped by an error · ${who}` };
    default: {
      const ended = r.endedAt || r.updatedAt;
      if (ended && now - ended < 15 * 60_000) return { mood: 'done', text: `Just finished · ${who}` };
      return { mood: 'idle', text: `Idle · last helped ${who} ${agoLabel(ended, now)}` };
    }
  }
}

export const RUN_STATUS_LABEL: Record<AgentRun['status'], string> = {
  running: 'Working',
  waiting: 'Waiting',
  awaiting_approval: 'Needs approval',
  completed: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
};

const LMS_EVENT: Record<string, string> = {
  'quiz.failed': 'a student fails a quiz',
  'login.gap': 'a student stops logging in',
  'attendance.missed': 'a student misses classes',
  'assignment.missed': 'an assignment is overdue',
  'payment.overdue': 'a payment is overdue',
  'invoice.unpaid': 'an invoice is unpaid',
};

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function scheduleLabel(s: AgentTrigger['schedule']): string {
  if (!s) return 'every day at 08:00';
  const hh = `${String(s.hour ?? 8).padStart(2, '0')}:00`;
  if (s.every === 'hour') return 'every hour';
  if (s.every === 'week') return `every ${WEEKDAY[s.weekday ?? 1]} at ${hh}`;
  return `every day at ${hh}`;
}

/** "When a new lead arrives", "Every day at 08:00 · Student tracker". */
export function triggerLabel(t: AgentTrigger | undefined, sources: DataSource[] = []): string {
  if (!t) return 'Runs when someone presses Run';
  const src = sources.find((x) => x.id === t.sourceId)?.name;
  switch (t.kind) {
    case 'lead.created': return 'When a new lead arrives from ads or forms';
    case 'record.added': return `When a new row appears${src ? ` in ${src}` : ''}`;
    case 'record.changed': return `When ${t.field ? `“${t.field.replace(/_/g, ' ')}”` : 'a row'} changes${src ? ` in ${src}` : ''}`;
    case 'record.match': return `Checks ${scheduleLabel(t.schedule)}${src ? ` · ${src}` : ''}`;
    case 'lms.event': return `When ${LMS_EVENT[t.lmsEvent || ''] || 'the LMS reports an event'}`;
    case 'reply.received': return 'When someone replies by email';
    case 'schedule': return `Runs ${scheduleLabel(t.schedule)}`;
    default: return 'Runs when someone presses Run';
  }
}

export function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] || '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

export const KIND_LABEL: Record<DataSourceKind, string> = {
  students: 'Student records',
  finance: 'Student tracker / fees',
  leads: 'Leads',
  prospects: 'B2B prospects',
  custom: 'Other list',
};
