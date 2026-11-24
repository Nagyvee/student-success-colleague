'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Icon, { type IconName } from '@/components/Icon';
import type { Magnet, OutboundSettings } from '@/lib/outbound/types';
import type { Overview } from './api';
import type { Act } from './OutboundClient';

/* What Thuso looks for, what it may spend, what we give away, and the mailbox
 * it writes from. Both switches are off until someone turns them on. */

function Card({ icon, title, sub, children }: { icon: IconName; title: string; sub: string; children: ReactNode }) {
  return <section className="pg-card"><div className="pg-card-h"><div><h2><Icon name={icon} size={16} /> {title}</h2><p className="pg-sub">{sub}</p></div></div>{children}</section>;
}

function Switch({ on, set, title, children, disabled }: { on: boolean; set: (v: boolean) => void; title: string; children: ReactNode; disabled?: boolean }) {
  return <label className="switch ob-switch"><input type="checkbox" checked={on} disabled={disabled} onChange={(e) => set(e.target.checked)} /><i /><span><b>{title}</b><br />{children}</span></label>;
}

export default function SettingsTab({ data, act }: { data: Overview; act: Act }) {
  const [f, setF] = useState<OutboundSettings>(data.settings);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  // What was saved elsewhere (learnt from the ideal companies) shows here, unless something is being typed.
  useEffect(() => { if (!dirty) setF(data.settings); }, [data.settings, dirty]);
  const set = <K extends keyof OutboundSettings>(k: K, v: OutboundSettings[K]) => { setF((x) => ({ ...x, [k]: v })); setDirty(true); };
  const text = (k: keyof OutboundSettings) => ({ value: String(f[k] ?? ''), onChange: (e: { target: { value: string } }) => set(k, e.target.value as never) });
  const num = (k: keyof OutboundSettings) => ({ type: 'number', value: String(f[k] ?? ''), onChange: (e: { target: { value: string } }) => set(k, (e.target.value === '' ? '' : Number(e.target.value)) as never) });
  const run = async (key: string, body: Record<string, unknown>) => { setBusy(key); const ok = await act(body); setBusy(''); return ok; };
  const save = async (extra: Partial<OutboundSettings> = {}) => { await run('save', { action: 'saveSettings', settings: { ...f, ...extra } }); setDirty(false); };
  const magnet = (i: number, p: Partial<Magnet>) => set('magnets', f.magnets.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const daily = (f.perDay * 0.06 + 0.2) * 21;

  if (!data.canManage) return <section className="pg-card"><p className="nu-hint">Only owners and admins can change these.</p></section>;
  return (
    <div className="nu-tab">
      <Card icon="target" title="What we look for" sub="Thuso reads this before every search. Nothing is searched until what we sell, and what an ideal company looks like, are filled in.">
        <div className="nu-form">
          <label className="field is-full"><span>What we sell (one per line, the most important first)</span><textarea {...text('services')} placeholder={'Learnerships: we train your people or new juniors in software, data or cybersecurity\nTeam training for the people you have'} /></label>
          <label className="field is-full"><span>About us, in facts it may use</span><textarea {...text('about')} placeholder="Who we are, how we train, accreditation, clients we may name" /></label>
          <label className="field is-full"><span>Our ideal company, in your words</span><textarea {...text('ideal')} placeholder="Growing, employs juniors in numbers, struggles to find tech skills…" /></label>
          <label className="field is-full"><span>What our ideal companies have in common {f.profile ? '' : '(learnt on the Ideal companies tab)'}</span><textarea {...text('profile')} /></label>
          <label className="field"><span>Sectors</span><input {...text('sectors')} placeholder="Logistics, Retail, Financial services" /></label>
          <label className="field"><span>Places</span><input {...text('provinces')} placeholder="Gauteng, KwaZulu-Natal" /></label>
          <label className="field"><span>Smallest (people)</span><input {...num('sizeMin')} min={1} /></label>
          <label className="field"><span>Largest (people)</span><input {...num('sizeMax')} min={2} /></label>
          <label className="field is-full"><span>Never contact (names or websites, one per line: clients, companies the team is talking to)</span><textarea {...text('avoid')} placeholder={'acme.co.za\nBeta Retail'} /></label>
        </div>
      </Card>

      <Card icon="scanSearch" title="Research" sub={`At ${f.perDay} a day this is about $${daily.toFixed(0)} a month. It stops at the limit, whatever happens.`}>
        <div className="nu-form">
          <label className="field"><span>Companies to look at a day</span><input {...num('perDay')} min={1} max={40} /></label>
          <label className="field"><span>Best ones to show</span><input {...num('showPerDay')} min={1} max={40} /></label>
          <label className="field"><span>Limit a month (US dollars)</span><input {...num('budgetUsd')} min={1} /></label>
          <label className="field"><span>Starts at (weekdays)</span><select value={f.hour} onChange={(e) => set('hour', Number(e.target.value))}>{[5, 6, 7, 8, 9, 10].map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></label>
          <label className="field is-full"><span>Who writes the emails</span><select value={f.writer} onChange={(e) => set('writer', e.target.value as 'haiku' | 'sonnet')}><option value="haiku">Haiku 5.5 (cheapest)</option><option value="sonnet">Sonnet 5.5 (better words, about $4 a month more)</option></select></label>
        </div>
        <Switch on={f.researchOn} set={(v) => set('researchOn', v)} title="Look for companies every weekday">Sends nothing to anyone. The best are listed here, and in the B2B channel if it is connected.</Switch>
      </Card>

      <Card icon="file" title="What we give away" sub="The first email only offers one thing and asks if we may send it. The links go out after they say yes, so each one needs its link.">
        <div className="ob-magnets">
          {f.magnets.map((m, i) => (
            <div key={m.id} className="ob-magnet">
              <label className="field"><span>Name</span><input value={m.name} onChange={(e) => magnet(i, { name: e.target.value })} /></label>
              <label className="field"><span>What it gives them, one sentence</span><input value={m.about} onChange={(e) => magnet(i, { about: e.target.value })} /></label>
              <label className="field"><span>Link</span><input value={m.link} onChange={(e) => magnet(i, { link: e.target.value })} placeholder="https://" /></label>
              <label className="field"><span>When</span><select value={m.when} onChange={(e) => magnet(i, { when: e.target.value as 'open' | 'yes' })}><option value="open">Offered in the first email</option><option value="yes">After they say yes</option></select></label>
              <div className="ob-magnet-end">
                <label className="nu-check"><input type="checkbox" checked={m.on} onChange={(e) => magnet(i, { on: e.target.checked })} /> On</label>
                <button type="button" className="nu-x" aria-label={`Remove ${m.name}`} onClick={() => set('magnets', f.magnets.filter((_, j) => j !== i))}><Icon name="trash" size={15} /></button>
              </div>
              {m.on && !m.link && <p className="ob-con"><Icon name="warn" size={12} /> No link yet: it cannot be sent.</p>}
            </div>
          ))}
          <button type="button" className="btn ghost sm" onClick={() => set('magnets', [...f.magnets, { id: `mg_${Date.now().toString(36)}`, name: '', about: '', link: '', when: 'yes', on: true }])}><Icon name="plus" size={14} /> Add another</button>
        </div>
      </Card>

      <Card icon="chat" title="The B2B Discord channel" sub="The morning's companies, and a card when one is ready for a call. Not the Admissions channel.">
        <div className="nu-form"><label className="field is-full"><span>Webhook address</span><input {...text('discordWebhook')} placeholder="https://discord.com/api/webhooks/…" autoComplete="off" /></label></div>
        <div className="pg-actions"><button type="button" className="btn ghost sm" disabled={Boolean(busy) || dirty} onClick={() => void run('discord', { action: 'testDiscord' })}>{busy === 'discord' ? 'Posting…' : 'Send a test'}</button>{dirty && <span className="nu-hint">Save first.</span>}</div>
      </Card>

      <Card icon="mail" title="The outreach mailbox" sub="The domain you use already is fine: give B2B its own address on it (like partnerships@), so its replies and limits stay apart from Admissions, and start with 5 a day. Only a brand-new domain needs three to four weeks of warming up.">
        <div className="nu-form">
          <label className="field"><span>Outgoing server</span><input {...text('smtpHost')} placeholder="smtp.gmail.com" /></label>
          <label className="field"><span>Port</span><input {...num('smtpPort')} /></label>
          <label className="field"><span>Address</span><input {...text('smtpUser')} placeholder="name@yourdomain.co.za" autoComplete="off" /></label>
          <label className="field"><span>Password (an app password for Gmail)</span><input type="password" {...text('smtpPass')} autoComplete="new-password" /></label>
          <label className="field"><span>Incoming server (empty: worked out)</span><input {...text('imapHost')} placeholder="imap.gmail.com" /></label>
          <label className="field"><span>Emails are from</span><input {...text('fromName')} placeholder="A real person's name" /></label>
          <label className="field"><span>Their title</span><input {...text('fromTitle')} placeholder="Partnerships" /></label>
          <label className="field"><span>Who takes the calls</span><input {...text('callsWith')} /></label>
          <label className="field"><span>Booking link</span><input {...text('bookingLink')} placeholder="https://" /></label>
          <label className="field"><span>Our address (in every email)</span><input {...text('address')} /></label>
        </div>
        <div className="pg-actions"><button type="button" className="btn ghost sm" disabled={Boolean(busy) || dirty} onClick={() => void run('mailbox', { action: 'testMailbox' })}>{busy === 'mailbox' ? 'Signing in…' : 'Check the mailbox'}</button>{dirty && <span className="nu-hint">Save first.</span>}</div>
      </Card>

      <Card icon="send" title="Sending" sub="One email to each company, asking if we may send something useful. No answer: no more emails. No: never again. Have the wording checked by whoever handles POPIA for you before you switch it on.">
        <div className="nu-form"><label className="field"><span>First emails a day (start with 5)</span><input {...num('sendPerDay')} min={1} max={40} /></label></div>
        <Switch on={f.checkFirst} set={(v) => set('checkFirst', v)} title="A person checks every first email">Off: they go by themselves once a company is approved.</Switch>
        <Switch on={f.checkReplies} set={(v) => set('checkReplies', v)} title="A person checks every answer">Off: Thuso answers by itself, in office hours.</Switch>
        <Switch on={f.sendingOn} set={(v) => set('sendingOn', v)} title="Send emails to companies">{data.missingForSending.length ? `Still missing: ${data.missingForSending.join(', ')}.` : 'Weekdays 08:30 to 16:30, spread out over the day. Also needs Live Outreach.'}</Switch>
      </Card>

      <div className={`ob-save${dirty ? ' on' : ''}`}>
        <span>{dirty ? 'Not saved yet.' : 'Saved.'}</span>
        <button type="button" className="btn primary sm" disabled={!dirty || Boolean(busy)} onClick={() => { if (f.sendingOn && !data.settings.sendingOn && !window.confirm('Saving this lets Thuso email real companies (the ones you approved). Carry on?')) return; void save(); }}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}
