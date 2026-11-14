'use client';

import { useEffect, useRef, useState } from 'react';
import type { WorldState } from '@/lib/types';

/* The office, live.
 *
 * One EventSource to /api/stream. Every message is the whole world, so the
 * screen never drifts from the server; a dropped connection reconnects and
 * the first message puts everything back where it belongs. */

export function useOfficeStream() {
  const [state, setState] = useState<WorldState | null>(null);
  const [connected, setConnected] = useState(false);
  const retry = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const open = () => {
      if (stopped) return;
      fetch('/api/state', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => { if (!stopped && s) setState((prev) => prev ?? (s as WorldState)); })
        .catch(() => {});
      es = new EventSource('/api/stream');
      es.addEventListener('state', (ev) => {
        try { setState(JSON.parse((ev as MessageEvent).data) as WorldState); retry.current = 0; setConnected(true); }
        catch { /* a torn frame; the next one is whole */ }
      });
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        const wait = Math.min(8000, 500 * 2 ** retry.current++);
        timer = setTimeout(open, wait);
      };
    };
    open();
    return () => { stopped = true; es?.close(); if (timer) clearTimeout(timer); };
  }, []);

  return { state, connected };
}

export async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data;
}
