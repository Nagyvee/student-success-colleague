'use client';

import { useCallback, useEffect, useState } from 'react';
import Icon from '@/components/Icon';
import { Chip, Modal } from '@/components/nurture/ui';
import { PIPELINE, STAGE_LABEL, type Stage } from '@/lib/outbound/types';
import { when, type CompanyDetail, type Overview } from './api';
import type { Act } from './OutboundClient';

/* One company: why it fits and where that was read, who to write to, the whole
 * conversation, and every email before it goes. */

export default function CompanyPanel({ id, data, act, onClose }: { id: string; data: Overview; act: Act; onClose: () => void }) {
  const [c, setC] = useState<CompanyDetail | null>(null);
  const [gone, setGone] = useState('');
  const load = useCallback(async () => {
    const r = await fetch(`/api/outbound?company=${encodeURIComponent(id)}`, { cache: 'no-store' }).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (r?.ok && j?.company) setC(j.company as CompanyDetail); else setGone(j?.error || 'Could not load this company.');
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  // The first email is being written: look again until it is there.
  const writing = Boolean(c && c.stage === 'approved' && c.contact.email && !c.thread.length);
  useEffect(() => { if (!writing) return; const t = setInterval(() => void load(), 4000); return () => clearInterval(t); }, [writing, load]);
  const go: Act = useCallback(async (body, ok) => { const r = await act({ id, ...body }, ok); await load(); return r; }, [act, id, load]);

  if (gone) return <Modal title="Company" onClose={onClose}><p className="nu-hint">{gone}</p></Modal>;
  if (!c) return <Modal title="Company" onClose={onClose}><div className="nu-loading"><Icon name="spinner" size={15} className="spin" /> Loading…</div></Modal>;
  const closed = c.consent === 'no';
  return (
    <Modal wide title={c.name} sub={[c.sector, [c.city, c.province].filter(Boolean).join(', '), c.size ? `${c.size} people` : ''].filter(Boolean).join(' · ')} onClose={onClose}>
      <div className="ob-panel">
        <div className="ob-panel-top">
          <span className={`ob-score${c.score >= 8 ? ' hi' : c.score >= 6 ? ' mid' : ''}`} title={c.scoreWhy}>{c.score}<small>/10</small></span>
          <div className="ob-tags">
            <Chip tone={c.stage === 'lost' || c.stage === 'rejected' ? 'muted' : 'brand'}>{STAGE_LABEL[c.stage]}</Chip>
            {c.consent === 'yes' && <Chip tone="good">Said yes to hearing from us</Chip>}
            {c.consent === 'asked' && <Chip>Asked once</Chip>}
            {closed && <Chip tone="bad">Never write again</Chip>}
            {c.like.map((x) => <Chip key={x}>Like {x}</Chip>)}
          </div>
          {c.website && <a className="btn ghost sm" href={c.website} target="_blank" rel="noopener noreferrer nofollow"><Icon name="external" size={13} /> Website</a>}
        </div>

        {c.stage === 'found' && (
          <div className="pg-actions">
            <button type="button" className="btn primary sm" onClick={() => void go({ action: 'decide', yes: true })}>Yes, write to them</button>
            <select className="ob-no" value="" aria-label="No: why" onChange={(e) => { if (e.target.value) void go({ action: 'decide', yes: false, reason: e.target.value }); }}><option value="">No</option>{data.rejectReasons.map((r) => <option key={r}>{r}</option>)}</select>
          </div>
        )}
        {(c.stage === 'rejected' || (c.stage === 'approved' && !c.contactedAt)) && <button type="button" className="nu-link" onClick={() => void go({ action: 'undo' })}><Icon name="reset" size={13} /> Put it back on the list</button>}

        <div className="ob-two">
          <section>
            <h4>Why them</h4>
            {c.what && <p>{c.what}</p>}
            {c.fit.length > 0 && <ul className="ob-list">{c.fit.map((x) => <li key={x}><Icon name="check" size={13} /> {x}</li>)}</ul>}
            {c.concerns && <p className="ob-con"><Icon name="warn" size={12} /> {c.concerns}</p>}
            {c.scoreWhy && <p className="ob-dim">{c.scoreWhy}</p>}
            {c.facts.length > 0 && <><h4>What we know, and where it says so</h4><ul className="ob-list">{c.facts.map((f) => <li key={f.url + f.text}><span>{f.text} <a href={f.url} target="_blank" rel="noopener noreferrer nofollow" title={f.url}><Icon name="external" size={12} /></a></span></li>)}</ul></>}
            {Object.values(c.said).some(Boolean) && <><h4>What they told us</h4><dl className="ob-said">{([['need', 'Need'], ['people', 'People'], ['timing', 'When'], ['budget', 'Budget'], ['decider', 'Decides']] as const).filter(([k]) => c.said[k]).map(([k, l]) => <div key={k}><dt>{l}</dt><dd>{c.said[k]}</dd></div>)}</dl></>}
          </section>
          <Edit c={c} go={go} />
        </div>

        <section>
          <h4>The conversation</h4>
          {writing && <div className="nu-loading"><Icon name="spinner" size={14} className="spin" /> Writing the first email…</div>}
          {!c.thread.length && !writing && <p className="ob-dim">{c.stage === 'approved' && !c.contact.email ? 'Add an email address and Thuso writes the first email.' : 'Nothing yet.'}</p>}
          <div className="ob-thread">
            {c.thread.map((m) => (m.status === 'draft' || m.status === 'ready')
              ? <Draft key={`${m.id}${m.status}${m.text.length}`} m={m} data={data} go={go} why={c.why} first={m.kind === 'first'} />
              : (
                <div key={m.id} className={`ob-msg ${m.who}`}>
                  <header><b>{m.who === 'us' ? 'Us' : m.by || c.contact.name || c.name}</b><span>{m.status === 'failed' ? 'Not sent' : when(m.at)}</span></header>
                  {m.who === 'us' && <p className="ob-subj">{m.subject}</p>}
                  <p>{m.text}</p>
                  {m.error && <p className="ob-con"><Icon name="warn" size={12} /> {m.error}</p>}
                </div>
              ))}
          </div>
          {c.answered && !closed && <Answer go={go} />}
        </section>
        {!closed && c.stage !== 'found' && <button type="button" className="nu-link t-bad" onClick={() => { if (window.confirm(`Never write to ${c.name} again? This cannot be undone.`)) void go({ action: 'never' }); }}>Never write to them again</button>}
      </div>
    </Modal>
  );
}

function Edit({ c, go }: { c: CompanyDetail; go: Act }) {
  const [f, setF] = useState({ name: c.contact.name, role: c.contact.role, email: c.contact.email, phone: c.contact.phone, owner: c.owner, callAt: c.callAt, value: c.value, notes: c.notes });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <section>
      <h4>Who to talk to</h4>
      <div className="ob-form">
        <label className="field"><span>Name</span><input value={f.name} onChange={set('name')} /></label>
        <label className="field"><span>Role</span><input value={f.role} onChange={set('role')} /></label>
        <label className="field"><span>Email</span><input type="email" value={f.email} onChange={set('email')} placeholder="not published" /></label>
        <label className="field"><span>Phone</span><input value={f.phone} onChange={set('phone')} /></label>
      </div>
      {c.contact.source && <p className="ob-dim">Address from: {/^https?:/.test(c.contact.source) ? <a href={c.contact.source} target="_blank" rel="noopener noreferrer nofollow">{c.contact.source}</a> : c.contact.source}</p>}
      <h4>Ours</h4>
      <div className="ob-form">
        <label className="field"><span>Stage</span><select value={c.stage} onChange={(e) => void go({ action: 'stage', stage: e.target.value as Stage })}>{c.stage === 'rejected' && <option value="rejected">{STAGE_LABEL.rejected}</option>}{PIPELINE.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        <label className="field"><span>Owner</span><input value={f.owner} onChange={set('owner')} placeholder="Who takes the call" /></label>
        <label className="field"><span>Call</span><input type="datetime-local" value={f.callAt} onChange={set('callAt')} /></label>
        <label className="field"><span>Worth</span><input value={f.value} onChange={set('value')} placeholder="R" /></label>
        <label className="field is-full"><span>Notes</span><textarea value={f.notes} onChange={set('notes')} /></label>
      </div>
      <button type="button" className="btn ghost sm" onClick={() => void go({ action: 'edit', contact: { name: f.name, role: f.role, email: f.email, phone: f.phone }, owner: f.owner, callAt: f.callAt, value: f.value, notes: f.notes })}>Save</button>
    </section>
  );
}

type DraftMessage = CompanyDetail['thread'][number];

function Draft({ m, data, go, why, first }: { m: DraftMessage; data: Overview; go: Act; why: string; first: boolean }) {
  const [subject, setSubject] = useState(m.subject);
  const [text, setText] = useState(m.text);
  const [magnets, setMagnets] = useState<string[]>(m.magnets || []);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = subject !== m.subject || text !== m.text || magnets.join() !== (m.magnets || []).join();
  const run = async (body: Record<string, unknown>) => { setBusy(true); await go({ message: m.id, ...body }); setBusy(false); };
  const save = () => run({ action: 'saveDraft', subject, text, magnets });
  const gifts = [...data.settings.magnets.filter((x) => x.on && x.link).map((x) => ({ id: x.id, name: x.name })), ...(data.settings.bookingLink ? [{ id: 'booking', name: 'Booking link' }] : [])];
  return (
    <div className={`ob-draft${m.status === 'ready' ? ' ready' : ''}`}>
      <header><b>{first ? 'The first email' : 'Our answer'}</b><Chip tone={m.status === 'ready' ? 'brand' : 'warn'}>{m.status === 'ready' ? 'Goes when it is due' : 'Check it'}</Chip></header>
      {m.error && <p className="ob-con"><Icon name="warn" size={12} /> {m.error}</p>}
      {first && <label className="field"><span>Subject</span><input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={140} disabled={m.status === 'ready'} /></label>}
      <label className="field"><span>Email</span><textarea className="ob-body" value={text} onChange={(e) => setText(e.target.value)} disabled={m.status === 'ready'} /></label>
      {!first && gifts.length > 0 && <div className="ob-tags">{gifts.map((g) => <label key={g.id} className="nu-check"><input type="checkbox" disabled={m.status === 'ready'} checked={magnets.includes(g.id)} onChange={() => setMagnets(magnets.includes(g.id) ? magnets.filter((x) => x !== g.id) : [...magnets, g.id])} /> {g.name}</label>)}</div>}
      {m.problems.length > 0 && <p className="ob-con"><Icon name="warn" size={12} /> Fix first: {m.problems.join(', ')}.</p>}
      {m.status === 'draft' && why && <p className="ob-con"><Icon name="warn" size={12} /> It cannot go: {why}.</p>}
      <button type="button" className="nu-link" onClick={() => setFull(!full)}><Icon name="eye" size={13} /> {full ? 'Hide' : 'See'} the whole email</button>
      {full && <pre className="ob-full">{m.full}</pre>}
      <div className="pg-actions">
        {m.status === 'ready' ? <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void run({ action: 'holdDraft' })}>Hold it</button> : (
          <>
            {dirty && <button type="button" className="btn primary sm" disabled={busy} onClick={() => void save()}>Save changes</button>}
            {data.canManage && !dirty && <button type="button" className="btn primary sm" disabled={busy || Boolean(why) || m.problems.length > 0} onClick={() => void run({ action: 'sendOk' })}>OK to send</button>}
            {data.canManage && !dirty && <button type="button" className="btn ghost sm" disabled={busy || Boolean(why)} onClick={() => { if (window.confirm('Send this email now?')) void run({ action: 'sendNow' }); }}>Send now</button>}
            {first && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void run({ action: 'rewrite' })}><Icon name="refresh" size={13} /> Write it again</button>}
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void run({ action: 'discardDraft' })}>Throw away</button>
          </>
        )}
      </div>
    </div>
  );
}

function Answer({ go }: { go: Act }) {
  const [text, setText] = useState('');
  return (
    <div className="ob-answer">
      <label className="field"><span>Answer in your own words</span><textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="It is saved as a draft first." /></label>
      <button type="button" className="btn ghost sm" disabled={!text.trim()} onClick={() => void go({ action: 'writeReply', text }).then((ok) => { if (ok) setText(''); })}>Save as a draft</button>
    </div>
  );
}
