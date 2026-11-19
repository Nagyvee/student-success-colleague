'use client';

import { useEffect, type ReactNode } from 'react';
import Icon, { type IconName } from '@/components/Icon';

/* Small shared pieces for the Lead Nurturing page. */

export function Modal({ title, sub, onClose, children, wide, foot }: { title: string; sub?: string; onClose: () => void; children: ReactNode; wide?: boolean; foot?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="nu-overlay" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`nu-modal${wide ? ' is-wide' : ''}`}>
        <header className="nu-modal-h">
          <div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
          <button type="button" className="nu-x" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </header>
        <div className="nu-modal-b">{children}</div>
        {foot && <footer className="nu-modal-f">{foot}</footer>}
      </div>
    </div>
  );
}

export function Notice({ n, onClose }: { n: { kind: 'ok' | 'bad'; text: string } | null; onClose: () => void }) {
  useEffect(() => {
    if (!n || n.kind === 'bad') return;
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [n, onClose]);
  if (!n) return null;
  return (
    <div className={`pg-banner ${n.kind === 'ok' ? 'ok' : 'bad'} nu-notice`} role="status">
      <Icon name={n.kind === 'ok' ? 'ok' : 'warn'} size={15} />
      <span>{n.text}</span>
      <button type="button" className="nu-x" onClick={onClose} aria-label="Dismiss"><Icon name="x" size={14} /></button>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="nu-empty">
      <span><Icon name={icon} size={22} /></span>
      <b>{title}</b>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Chip({ tone, children, title }: { tone?: 'good' | 'warn' | 'bad' | 'brand' | 'hot' | 'warm' | 'cold' | 'muted'; children: ReactNode; title?: string }) {
  return <span className={`nu-chip${tone ? ` t-${tone}` : ''}`} title={title}>{children}</span>;
}

export function Field({ label, hint, children, full }: { label: string; hint?: string; children: ReactNode; full?: boolean }) {
  return (
    <label className={`field nu-field${full ? ' is-full' : ''}`}>
      <span>{label}</span>
      {children}
      {hint && <small className="nu-hint">{hint}</small>}
    </label>
  );
}
