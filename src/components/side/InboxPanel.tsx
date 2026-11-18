'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { InboxMail, PendingOutreach } from '@/lib/types';
import Icon from '@/components/Icon';

/* What the office has sent. Real mail via Nodemailer (SMTP) when configured;
 * the exact message it would have sent when it is not. Quiz mails carry a QR
 * code so a room full of phones can take the student's side of the loop. */

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
          <span className={`badge ${m.delivery !== 'simulated' ? 'badge-good' : m.error ? 'badge-bad' : 'badge-soft'}`} title={m.error || undefined}><Icon name={m.delivery !== 'simulated' ? 'send' : m.error ? 'warn' : 'mail'} size={10} />{m.delivery === 'smtp' ? 'Delivered by email' : m.error ? 'Not sent: email server unreachable' : 'Preview (not sent)'}</span>
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

export default function InboxPanel({
  inbox,
  pending = [],
  onOpen,
  onInspect,
  paused = false,
}: {
  inbox: InboxMail[];
  pending?: PendingOutreach[];
  onOpen: (id: string) => void;
  onInspect: (id: string) => void;
  /** The server's sending lock: approving keeps the message here instead of sending it. */
  paused?: boolean;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState<{ busy: boolean; note: string | null; lessonUrl?: string }>({ busy: false, note: null });

  // A sample of what a learner receives after a failed assessment: the personal video lesson + test.
  const makeSample = async () => {
    setSample({ busy: true, note: null });
    try {
      const res = await fetch('/api/departments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sampleStudyPack' }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) setSample({ busy: false, note: j.error || 'Could not build the sample.' });
      else {
        setSample({ busy: false, note: `Ready: a ${j.questions}-question test and a personal video lesson. It is the top email below.`, lessonUrl: j.lessonUrl });
        if (j.mailId) setTimeout(() => onOpen(j.mailId), 600);
      }
    } catch (e) {
      setSample({ busy: false, note: (e as Error).message });
    }
  };

  const sampleBar = (
    <div className="mail" style={{ borderStyle: 'dashed' }}>
      <div className="mail-t" style={{ display: 'grid', gap: 6 }}>
        <b style={{ fontSize: 12.5 }}>See what a student receives</b>
        <span style={{ fontSize: 12, opacity: 0.8 }}>Builds a sample study pack (a video lesson that greets the student by name, and a 10-question test) for a sample student. It stays in this Inbox.</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn btn-outline btn-sm" disabled={sample.busy} onClick={() => void makeSample()}>
            <Icon name="play" size={12} />{sample.busy ? 'Building… (about a minute)' : 'Preview a sample study pack'}
          </button>
          {sample.lessonUrl && <a className="btn btn-ghost btn-sm" href={sample.lessonUrl} target="_blank" rel="noreferrer"><Icon name="external" size={12} />Open the video lesson</a>}
          <a className="btn btn-outline btn-sm" href="/nurture"><Icon name="target" size={12} />Preview a lead journey</a>
        </div>
        {sample.note && <span style={{ fontSize: 12 }}>{sample.note}</span>}
      </div>
    </div>
  );

  const act = async (payload: { action: 'approve' | 'reject' | 'approveAll'; id?: string }) => {
    setError(null);
    setBusyId(payload.id || 'all');
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || 'Approval action failed');
      }
    } finally {
      setBusyId(null);
    }
  };

  if (!inbox.length && !pending.length) {
    return (
      <div className="list">
        {sampleBar}
        <div className="feed-empty">
          Nothing sent yet. Approved deliverables are emailed from here via Nodemailer (SMTP) when configured, or into this preview without it.
        </div>
      </div>
    );
  }

  const pauseNote = paused && (
    <div className="mail" style={{ borderColor: '#d97706', background: 'rgba(217,119,6,.07)' }}>
      <div className="mail-t" style={{ display: 'grid', gap: 4 }}>
        <b style={{ fontSize: 12.5 }}><Icon name="shield" size={12} /> Sending is paused (test phase)</b>
        <span style={{ fontSize: 12, opacity: 0.85 }}>Nothing goes to students. Approving a draft marks it approved and keeps the email here so you can read it.</span>
      </div>
    </div>
  );

  return (
    <div className="list">
      {pauseNote}
      {sampleBar}
      {error && (
        <div className="mail" style={{ borderColor: '#dc2626' }}>
          <div className="mail-t"><strong style={{ color: '#dc2626' }}>{error}</strong></div>
        </div>
      )}

      {pending.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '2px 2px 4px' }}>
            <strong style={{ fontSize: 12 }}>Waiting for Your Approval ({pending.length})</strong>
            <button
              type="button"
              className="btn btn-cta btn-sm"
              disabled={busyId !== null}
              onClick={() => act({ action: 'approveAll' })}
            >
              <Icon name="check" size={12} />{busyId === 'all' ? 'Working...' : paused ? 'Approve all (paused, not sent)' : 'Approve all & send'}
            </button>
          </div>
          {pending.map((p) => (
            <div key={p.id} className="mail" style={{ borderColor: '#d97706' }}>
              <div className="mail-t">
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                  <span className="badge badge-soft"><Icon name="warn" size={10} />Awaiting approval &middot; {p.workflowName}</span>
                  <span className="faint" style={{ fontSize: 11 }}>{new Date(p.createdAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <b>{p.subject}</b>
                <span>To {p.learnerName} · {p.learnerEmail}</span>
                {p.previewText && <p style={{ fontSize: 12, opacity: 0.8, margin: '6px 0 0' }}>{p.previewText}</p>}
                <div className="mail-acts" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-cta btn-sm"
                    disabled={busyId !== null}
                    onClick={() => act({ action: 'approve', id: p.id })}
                  >
                    <Icon name="send" size={12} />{busyId === p.id ? 'Working...' : paused ? 'Approve (paused, not sent)' : 'Approve & Send'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={busyId !== null}
                    onClick={() => act({ action: 'reject', id: p.id })}
                  >
                    Hold / Reject
                  </button>
                  {p.deliverableId && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onInspect(p.deliverableId)}>
                      <Icon name="file" size={12} />Deliverable
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {inbox.map((m) => <MailCard key={m.id} m={m} onOpen={onOpen} onInspect={onInspect} />)}
    </div>
  );
}
