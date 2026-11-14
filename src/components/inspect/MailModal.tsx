'use client';

import type { InboxMail } from '@/lib/types';
import Icon from '@/components/Icon';

/* The email, exactly as sent, in a sandboxed frame. */

export default function MailModal({ mail: m, onClose, onInspect }: { mail: InboxMail; onClose: () => void; onInspect: (id: string) => void }) {
  return (
    <div className="gate" onClick={onClose}>
      <div className="gate-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="gate-head">
          <div style={{ minWidth: 0 }}>
            <h2>{m.subject}</h2>
            <p className="gate-sub">
              <span className={`badge ${m.delivery !== 'simulated' ? 'badge-good' : 'badge-soft'}`}><Icon name={m.delivery !== 'simulated' ? 'send' : 'mail'} size={10} />{m.delivery === 'smtp' ? `Delivered by email to ${m.to}` : m.delivery === 'resend' ? `Delivered via Resend${m.providerId ? ` · ${m.providerId}` : ''}` : 'Preview (no email account connected)'}</span>
              <span>From {m.from}</span><span>· To {m.toName} &lt;{m.to}&gt;</span>
            </p>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>
        <div className="gate-body" style={{ padding: 0, background: '#f4f7fc' }}>
          <iframe title="Email preview" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={m.html} style={{ width: '100%', height: 'min(70vh, 720px)', border: 'none', display: 'block' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '12px 24px 18px', borderTop: '1px solid var(--line-2)', flexWrap: 'wrap' }}>
          {m.link && <a className="btn btn-cta" href={m.link} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open the link as the student</a>}
          {m.deliverableId && <button type="button" className="btn btn-outline" onClick={() => onInspect(m.deliverableId as string)}><Icon name="file" size={14} />Inspect the deliverable</button>}
        </div>
      </div>
    </div>
  );
}
