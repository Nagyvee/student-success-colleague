'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Overview } from '@/app/api/outbound/route';

/* The B2B Outbound page's data: GET /api/outbound, polled, and one POST helper. */

export type { CompanyDetail, CompanyRow, Overview } from '@/app/api/outbound/route';

export interface Reply { ok?: boolean; detail?: string; error?: string; id?: string }

export async function outboundPost(body: Record<string, unknown>): Promise<Reply> {
  try {
    const r = await fetch('/api/outbound', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Reply;
    if (!r.ok && !j.error) j.error = `The server answered ${r.status}.`;
    return j;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function useOutbound() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/outbound', { cache: 'no-store' });
      const j = await r.json();
      if (!alive.current) return;
      if (!r.ok) { setError(j.error || 'Could not load B2B outbound.'); return; }
      setData(j as Overview);
      setError(null);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, []);
  // Quicker while it is looking for companies, so they appear as they are found.
  const working = Boolean(data?.research.doing || data?.research.extra || data?.companies.some((c) => c.stage === 'approved' && c.contact.email && !c.drafts && !c.ready && !c.failed));
  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, working ? 5000 : 15_000);
    return () => { alive.current = false; clearInterval(t); };
  }, [refresh, working]);
  return { data, error, refresh };
}

export const when = (t: number) => (t ? new Date(t).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
