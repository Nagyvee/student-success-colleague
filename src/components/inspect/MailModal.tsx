'use client';

import { useState } from 'react';
import type { InboxMail } from '@/lib/types';
import Icon from '@/components/Icon';

/* An email from the Inbox, exactly as it was sent (in a sandboxed frame), with
 * the replies it got and a way to reply as the recipient, so the team can see
 * how the agents carry the conversation on. */

export default function MailModal({ mail: m, onClose, onInspect }: { mail: InboxMail; onClose: () => void; onInspect: (id: string) => void }) {
  const [tab, setTab] = useState<'email' | 'reply'>('email');
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const first = (m.toName || '').split(/\s+/)[0] || 'them';
  const replies = m.replies || [];

  async function submitReply(e: React.FormEvent) {
    e.preventDefault();
    if (!replyText.trim() || sending) return;
    setSending(true);
    setNote(null);
    try {
      const res = await fetch('/api/webhooks/email-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: m.to, fromName: m.toName, subject: `Re: ${m.subject}`, text: replyText.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setNote({ ok: false, text: j.error || 'The agents could not take this reply.' });
      } else {
        setReplyText('');
        setNote({
          ok: true,
          text: j.note && !j.continuationSubject
            ? j.note
            : j.agentsStarted
            ? `Passed to the agents (${j.agentsStarted}). Their answer appears in the Inbox${j.delivery === 'queued_for_approval' ? ', waiting for your approval' : ''}.`
            : j.continuationSubject
              ? `Read by the agent (${j.outcome}). "${j.continuationSubject}" ${j.delivery === 'queued_for_approval' ? 'is waiting for your approval in the Inbox' : 'was sent'}.`
              : 'Noted on their record.',
        });
      }
    } catch {
      setNote({ ok: false, text: 'Network error: the reply was not passed on.' });
    } finally {
      setSending(false);
    }
  }

  const status = m.delivery === 'smtp' ? `Delivered by email to ${m.to}` : m.error ? 'Not sent: the email server could not be reached' : 'Kept in the Inbox (sending is paused or not connected)';

  return (
    <div className="gate" onClick={onClose}>
      <div className="gate-card mail-card" role="dialog" aria-modal="true" aria-label={m.subject} onClick={(e) => e.stopPropagation()}>
        <div className="gate-head">
          <div style={{ minWidth: 0 }}>
            <h2>{m.subject}</h2>
            <p className="gate-sub">
              <span className={`badge ${m.delivery === 'smtp' ? 'badge-good' : 'badge-soft'}`}><Icon name={m.delivery === 'smtp' ? 'send' : 'mail'} size={10} />{status}</span>
              <span>To {m.toName} &lt;{m.to}&gt;</span>
              <span>· {new Date(m.ts).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            </p>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>

        <div className="gate-tabwrap">
          <div className="gate-tabs">
            <button type="button" className={tab === 'email' ? 'on' : ''} onClick={() => setTab('email')}><Icon name="mail" size={13} />Email</button>
            <button type="button" className={tab === 'reply' ? 'on' : ''} onClick={() => setTab('reply')}>
              <Icon name="chat" size={13} />Reply as {first}{replies.length ? <span className="badge badge-mute" style={{ marginLeft: 2 }}>{replies.length}</span> : null}
            </button>
          </div>
        </div>

        {tab === 'email' ? (
          <div className="gate-body mail-body">
            {m.html
              ? <iframe title="The email as sent" className="mail-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={m.html} />
              : <pre className="mail-text">{m.text}</pre>}
          </div>
        ) : (
          <div className="gate-body">
            {replies.length > 0 && (
              <div className="mail-replies">
                <h4>Replies so far</h4>
                {replies.map((r, i) => (
                  <div key={i} className="mail-reply">
                    <small><b>{r.from}</b> · {new Date(r.ts).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
                    <p>{r.text}</p>
                  </div>
                ))}
              </div>
            )}
            <form onSubmit={submitReply} className="mail-replyform">
              <label className="field">
                <span>What {first} writes back</span>
                <textarea
                  rows={4}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder={`e.g. "Thanks! I work full time. Can I study in the evenings, and can I pay monthly?"`}
                />
              </label>
              <p className="mail-hint">
                The reply goes to the agents as if {first} had answered this email: their follow-ups stop, and the agent whose job is replies answers it.
                With sending paused, the answer stays in the Inbox.
              </p>
              {note && <div className={`pg-banner ${note.ok ? 'ok' : 'bad'}`}><Icon name={note.ok ? 'ok' : 'warn'} size={14} /> {note.text}</div>}
              <div className="mail-actions">
                <button type="submit" className="btn btn-cta" disabled={sending || !replyText.trim()}>
                  <Icon name="send" size={13} />{sending ? 'Passing it on…' : 'Send the reply to the agents'}
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="mail-foot">
          {m.link && <a className="btn btn-outline btn-sm" href={m.link} target="_blank" rel="noreferrer"><Icon name="external" size={13} />Open the button&apos;s link</a>}
          {m.deliverableId && <button type="button" className="btn btn-outline btn-sm" onClick={() => { onClose(); onInspect(m.deliverableId as string); }}><Icon name="file" size={13} />Deliverable and review trail</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} style={{ marginLeft: 'auto' }}>Close</button>
        </div>
      </div>
    </div>
  );
}
