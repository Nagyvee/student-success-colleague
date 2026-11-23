'use client';

import { useState } from 'react';
import type { TenantIntegrations } from '@/lib/types';
import Icon from '@/components/Icon';
import { nurturePost } from './api';

/* WhatsApp follow-ups (Channels & API): the two ManyChat automations, a check
 * that the key belongs to the account that has them, a test to one number,
 * who is due, and the switch. Nothing goes to a lead until it is switched on. */

type Value = NonNullable<TenantIntegrations['whatsappFollowups']>;
interface Plan {
  nudge: number; video: number; sample: { name: string; kind: 'nudge' | 'video'; why: string }[];
  perDay: number; sentToday: number; on: boolean; live: boolean; hours: boolean; pausedUntil: number; lastError: string;
}

export default function WhatsAppCard({ value, onChange, onSave, saving, replyUrl, replyKey }: { value: Value; onChange: (v: Value) => void; onSave: () => Promise<void> | void; saving: boolean; replyUrl: string; replyKey: string }) {
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [phone, setPhone] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);

  async function run(id: string, body: Record<string, unknown>) {
    setBusy(id);
    setNote(null);
    const r = await nurturePost<{ detail?: string; plan?: Plan }>(body);
    setBusy('');
    if (r.plan) setPlan(r.plan);
    else setNote({ ok: Boolean(r.ok), text: r.detail || r.error || (r.ok ? 'Done.' : 'That did not work.') });
  }

  return (
    <section className="pg-card" aria-label="WhatsApp follow-ups">
      <div className="pg-card-h">
        <div>
          <h2><Icon name="chat" size={16} /> WhatsApp follow-ups for leads</h2>
          <p className="pg-sub">
            A few WhatsApps where email is not enough, as templates Meta approved. <b>Quiz nudge:</b> three days on, an email delivered, nothing opened.
            <b> Programme video:</b> they clicked or took the quiz but have not watched it. At most one a week per lead, in the daytime, never within a day of an email.
            Never to anyone who unsubscribed, sent STOP, qualified, replied, or is already chatting on WhatsApp.
          </p>
        </div>
      </div>

      <div className="set-grid">
        <label className="field">
          <span>Quiz nudge: ManyChat flow ID</span>
          <input type="text" value={value.nudgeFlow || ''} onChange={(e) => onChange({ ...value, nudgeFlow: e.target.value })} placeholder="content20240101000000_123456" spellCheck={false} />
        </label>
        <label className="field">
          <span>Programme video: ManyChat flow ID</span>
          <input type="text" value={value.videoFlow || ''} onChange={(e) => onChange({ ...value, videoFlow: e.target.value })} placeholder="content20240101000000_123456" spellCheck={false} />
        </label>
        <label className="field">
          <span>Most WhatsApps a day</span>
          <input type="number" min={1} max={200} value={value.perDay ?? 20} onChange={(e) => onChange({ ...value, perDay: Number(e.target.value) })} />
        </label>
        <label className="switch" style={{ gridColumn: '1 / -1', alignItems: 'flex-start', lineHeight: 1.45 }}>
          <input type="checkbox" checked={Boolean(value.addContacts)} onChange={(e) => onChange({ ...value, addContacts: e.target.checked })} />
          <i />
          <span style={{ display: 'block' }}>
            <b style={{ color: 'var(--ink)' }}>Add leads who are not in ManyChat yet</b><br />
            Each one counts towards your ManyChat plan, which can raise its price. Off: only people already in ManyChat get one.
          </span>
        </label>
        <label className="switch" style={{ gridColumn: '1 / -1', alignItems: 'flex-start', lineHeight: 1.45 }}>
          <input type="checkbox" checked={Boolean(value.on)} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
          <i />
          <span style={{ display: 'block' }}>
            <b style={{ color: 'var(--ink)' }}>Send WhatsApp follow-ups</b><br />
            Off until you switch it on and Save. Check and test first: Meta charges for each marketing message.
          </span>
        </label>
      </div>

      <div className="pg-hint" style={{ margin: '12px 0', fontSize: 13, lineHeight: 1.6 }}>
        <b style={{ color: 'var(--ink)' }}>What leads type comes to Thuso.</b> Every lead Thuso messages gets the ManyChat tag <code>thuso_lead</code>. ManyChat&apos;s Default Reply sends people with that tag here
        (an External Request, POST, Full Contact Data), and Naledi or Zinhle answers on WhatsApp.<br />
        Address: <code style={{ wordBreak: 'break-all' }}>{replyUrl}</code><br />
        Header <code>X-Thuso-Token</code>: {replyKey ? <button type="button" className="btn ghost sm" onClick={() => { void navigator.clipboard.writeText(replyKey).then(() => setNote({ ok: true, text: 'Key copied. Paste it in ManyChat yourself; do not share it in a chat.' })); }}>Copy the key</button> : 'only owners and admins can copy the key'}
      </div>

      {note && <p className={`pg-banner ${note.ok ? 'ok' : 'bad'}`} role="status">{note.text}</p>}
      {plan && (
        <div className="pg-banner" role="status">
          <div>
            <b>{plan.nudge}</b> due the quiz nudge and <b>{plan.video}</b> due their video, before ManyChat&apos;s own checks (in ManyChat, opted in, not chatting).
            Sent today: {plan.sentToday} of {plan.perDay}.
            {!plan.on ? ' Switched off, so none go out.' : !plan.live ? ' Live Outreach is off or sending is paused.' : plan.pausedUntil ? ` Paused until ${new Date(plan.pausedUntil).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}: ${plan.lastError}` : !plan.hours ? ' Outside sending hours now.' : ''}
            {plan.sample.length > 0 && <><br />{plan.sample.map((x) => `${x.name} (${x.kind === 'nudge' ? 'quiz' : 'video'})`).join(', ')}</>}
          </div>
        </div>
      )}

      <div className="pg-actions" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="btn primary sm" disabled={saving} onClick={() => void onSave()}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn ghost sm" disabled={Boolean(busy)} onClick={() => void run('check', { action: 'whatsappCheck' })}>{busy === 'check' ? 'Checking…' : 'Check ManyChat'}</button>
        <button type="button" className="btn ghost sm" disabled={Boolean(busy)} onClick={() => void run('preview', { action: 'whatsappPreview' })}>{busy === 'preview' ? 'Reading…' : 'Who is due'}</button>
        <input className="in" style={{ maxWidth: 190 }} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+27821234567" aria-label="Your WhatsApp number for a test" />
        <button type="button" className="btn ghost sm" disabled={Boolean(busy) || !phone.trim()} onClick={() => void run('t1', { action: 'whatsappTest', kind: 'nudge', phone })}>{busy === 't1' ? 'Sending…' : 'Test the nudge'}</button>
        <button type="button" className="btn ghost sm" disabled={Boolean(busy) || !phone.trim()} onClick={() => void run('t2', { action: 'whatsappTest', kind: 'video', phone })}>{busy === 't2' ? 'Sending…' : 'Test the video'}</button>
      </div>
    </section>
  );
}
