'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { InboxMail } from '@/lib/types';
import Icon from '@/components/Icon';

/* What the office has sent. Real mail when Resend is configured; the exact
 * message it would have sent when it is not. Quiz mails carry a QR code so
 * a room full of phones can take the student's side of the loop. */

export function useQr(text: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!text) { setUrl(null); return; }
    QRCode.toDataURL(text, { margin: 0, width: 220, color: { dark: '#0a1733', light: '#ffffff' } }).then((u) => { if (live) setUrl(u); }).catch(() => setUrl(null));
    return () => { live = false; };
  }, [text]);
  return url;
}

function MailCard({ m, onOpen, onInspect }: { m: InboxMail; onOpen: (id: string) => void; onInspect: (id: string) => void }) {
  const qr = useQr(m.link);
  const [copied, setCopied] = useState(false);
  return (
    <div className="mail">
      <div className="mail-t">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
          <span className={`badge ${m.delivery !== 'simulated' ? 'badge-good' : m.error ? 'badge-bad' : 'badge-soft'}`} title={m.error || undefined}><Icon name={m.delivery !== 'simulated' ? 'send' : m.error ? 'warn' : 'mail'} size={10} />{m.delivery === 'smtp' ? 'Delivered by email' : m.delivery === 'resend' ? 'Sent via Resend' : m.error ? 'Not sent: email server unreachable' : 'Preview (not sent)'}</span>
          <span className="faint" style={{ fontSize: 11 }}>{new Date(m.ts).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <b>{m.subject}</b>
        <span>To {m.toName} · {m.to}</span>
        <div className="mail-acts">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => onOpen(m.id)}><Icon name="eye" size={12} />Open email</button>
          {m.link && <a className="btn btn-cta btn-sm" href={m.link} target="_blank" rel="noreferrer"><Icon name="external" size={12} />Open as the student</a>}
          {m.link && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(m.link as string).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
              <Icon name={copied ? 'check' : 'copy'} size={12} />{copied ? 'Copied' : 'Copy link'}
            </button>
          )}
          {m.deliverableId && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onInspect(m.deliverableId as string)}><Icon name="file" size={12} />Deliverable</button>}
        </div>
      </div>
      {qr && <span className="mail-qr" title="Scan to open the quiz on a phone"><img src={qr} alt="QR code for the quiz link" /></span>}
    </div>
  );
}

export default function InboxPanel({ inbox, onOpen, onInspect }: { inbox: InboxMail[]; onOpen: (id: string) => void; onInspect: (id: string) => void }) {
  if (!inbox.length) return <div className="feed-empty">Nothing sent yet. Approved deliverables are emailed from here: for real with a Resend key, or into this preview without one.</div>;
  return <div className="list">{inbox.map((m) => <MailCard key={m.id} m={m} onOpen={onOpen} onInspect={onInspect} />)}</div>;
}
