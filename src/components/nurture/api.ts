'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentTrigger, MessageChannel, StepCondition } from '@/lib/types';
import type { FitQuiz, MediaItem, NurtureCampaign, NurtureMessage, NurtureResource, NurtureStats, ProgrammeVideo, Voucher, VoucherOffer } from '@/lib/nurture/types';

/* The Lead Nurturing page's data: GET /api/nurture, polled, and one POST helper. */

export interface LeadRow {
  key: string; name: string; email: string; phone: string;
  programme: string; interest: string; source: string; status: string;
  engagement: 'cold' | 'warm' | 'hot'; score: number; opens: number; clicks: number; sent: number;
  lastClicked: string; fit: string; optedOut: boolean; firstSeenAt: number; lastEngagedAt: string;
}

export interface NurtureAgent {
  id: string; name: string; title: string; color?: string; workflowId: string | null;
  job: string; description: string; trigger: AgentTrigger | null; enabled: boolean;
  steps: { id: string; kind: string; title: string; stage?: string }[];
  active: number; done: number;
}

export interface Overview {
  role: string;
  canManage: boolean;
  stats: NurtureStats;
  funnel: { total: number; contacted: number; cold: number; warm: number; hot: number; applied: number; enrolled: number; optedOut: number; quiz: number };
  programmes: string[];
  leadsSource: { id: string; name: string; url: string; rows?: number; lastReadAt?: number | null; lastError?: string | null; columns: string[] } | null;
  messages: NurtureMessage[];
  resources: NurtureResource[];
  campaigns: (Omit<NurtureCampaign, 'queue'> & { left: number })[];
  fit: FitQuiz | null;
  videos: (Omit<ProgrammeVideo, 'slides'> & { scenes: number })[];
  agents: NurtureAgent[];
  applyUrl: string;
  autopilot: boolean;
  sendingPaused: boolean;
  liveOutreach: boolean;
  recent: LeadRow[];
  offers: VoucherOffer[];
  media?: (MediaItem & { url: string })[];
  vouchers: Voucher[];
  replies: {
    configured: boolean; enabled: boolean; mailbox: string | null; lastCheck: number | null; lastError: string | null;
    handled: number; ignored: number; recent: { ts: number; from: string; subject: string; action: string }[];
  };
}

export type Post = <T = Record<string, unknown>>(body: Record<string, unknown>) => Promise<T & { ok?: boolean; error?: string }>;

export const nurturePost: Post = async (body) => {
  try {
    const r = await fetch('/api/nurture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.error) j.error = `The server answered ${r.status}.`;
    return j;
  } catch (e) {
    return { error: (e as Error).message } as never;
  }
};

export function useNurture(everyMs = 15_000) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/nurture', { cache: 'no-store' });
      const j = await r.json();
      if (!alive.current) return;
      if (!r.ok) { setError(j.error || 'Could not load lead nurturing.'); return; }
      setData(j as Overview);
      setError(null);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, everyMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [refresh, everyMs]);
  return { data, error, refresh };
}

export const STAGE_INFO: Record<string, { label: string; hint: string }> = {
  welcome: { label: 'Welcome', hint: 'The first hello, within minutes' },
  learn: { label: 'Learn', hint: 'Something useful: a guide, their video' },
  trust: { label: 'Trust', hint: 'Proof: how it works, people like them' },
  offer: { label: 'Offer', hint: 'A promotion with an end date' },
  decide: { label: 'Decide', hint: 'Make applying easy' },
  reengage: { label: 'Re-engage', hint: 'A gentle check-in weeks later' },
};
export const STAGES = Object.keys(STAGE_INFO);

export const AUDIENCE_INFO: Record<string, string> = {
  everyone: 'Everyone', parents: 'Parents', school_leavers: 'School leavers', career_changers: 'Career changers', working: 'Working people',
};

export const CTA_INFO: Record<string, string> = {
  quiz: 'Career-fit quiz', video: 'Their programme video', apply: 'Start the application', resource: 'A guide or video from the bank', reply: 'Reply to the email', url: 'A link',
};

export const CHANNEL_INFO: Record<MessageChannel, string> = { email: 'Email', whatsapp: 'WhatsApp', email_whatsapp: 'Email + WhatsApp' };

export const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

export const ago = (t: number | string | null | undefined) => {
  const ms = typeof t === 'string' ? Date.parse(t) : t;
  if (!ms || Number.isNaN(ms)) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
};

/** Quick groups for campaigns, in plain words. */
export const SEGMENT_PRESETS: { id: string; label: string; segment: StepCondition[] }[] = [
  { id: 'never', label: 'Leads we have never messaged', segment: [{ mode: 'rule', field: 'nurture_count', op: 'empty', value: '' }] },
  { id: 'all', label: 'All open leads', segment: [] },
  { id: 'cold', label: 'Cold leads (no opens or clicks yet)', segment: [{ mode: 'rule', field: 'engagement', op: 'neq', value: 'warm' }, { mode: 'rule', field: 'engagement', op: 'neq', value: 'hot' }] },
  { id: 'warm', label: 'Warm leads', segment: [{ mode: 'rule', field: 'engagement', op: 'eq', value: 'warm' }] },
  { id: 'hot', label: 'Hot leads', segment: [{ mode: 'rule', field: 'engagement', op: 'eq', value: 'hot' }] },
  { id: 'quiz', label: 'Took the career-fit quiz', segment: [{ mode: 'rule', field: 'fit_done', op: 'eq', value: 'yes' }] },
  { id: 'noquiz', label: 'Have not taken the quiz', segment: [{ mode: 'rule', field: 'fit_done', op: 'empty', value: '' }] },
];
