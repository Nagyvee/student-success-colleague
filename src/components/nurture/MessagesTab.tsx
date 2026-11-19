'use client';

import { useEffect, useMemo, useState } from 'react';
import { FUNDINGS, FUNDING_LABEL } from '@/lib/nurture/profile';
import type { MessageChannel } from '@/lib/types';
import type { CtaTarget, NurtureMessage } from '@/lib/nurture/types';
import Icon from '@/components/Icon';
import { AUDIENCE_INFO, CHANNEL_INFO, CTA_INFO, STAGES, STAGE_INFO, nurturePost, pct, type Overview } from './api';
import { Chip, Field, Modal } from './ui';

/* Messages: the library. Written once, checked once, approved once, sent to many. */

type Draft = Partial<NurtureMessage> & { name: string; subject: string; body: string };

const blank = (): Draft => ({
  name: '', subject: '', body: 'Hi {{first_name}},\n\n', waBody: '', stage: 'learn', audience: 'everyone', programme: '', channel: 'email',
  cta: { target: 'reply', label: 'Just reply to this email' }, resourceIds: [], expiresAt: null,
});

const highlight = (t: string) => t.split(/(\{\{\s*[a-z_]+\s*\}\})/gi).map((p, i) => (/^\{\{/.test(p) ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>));

export default function MessagesTab({ data, refresh, notify, onCampaign }: {
  data: Overview;
  refresh: () => Promise<void>;
  notify: (kind: 'ok' | 'bad', text: string) => void;
  onCampaign: (messageId: string) => void;
}) {
  const [editing, setEditing] = useState<Draft | null>(null);
  const [writer, setWriter] = useState(false);
  const [preview, setPreview] = useState<NurtureMessage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const can = data.canManage;

  const groups = useMemo(() => STAGES.map((st) => ({ st, list: data.messages.filter((m) => m.stage === st && m.status !== 'archived') })), [data.messages]);
  const archived = data.messages.filter((m) => m.status === 'archived');
  const drafts = data.messages.filter((m) => m.status === 'draft').length;

  async function act(key: string, body: Record<string, unknown>, ok: string) {
    setBusy(key);
    const r = await nurturePost(body);
    setBusy(null);
    if (r.error) notify('bad', r.error); else notify('ok', ok);
    await refresh();
    return r;
  }

  return (
    <div className="nu-tab">
      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2><Icon name="mail" size={16} /> The message library</h2>
            <p className="pg-sub">
              Each message is written once, checked by the reviewer, and approved by a person once. After that it goes to any number of leads with their
              name and programme filled in, plus the guide or video that fits them, with every link tracked. Sending a saved message costs no AI.
            </p>
          </div>
          {can && (
            <div className="pg-actions">
              <button type="button" className="btn btn-cta" onClick={() => setWriter(true)}><Icon name="zap" size={14} /> Write with AI</button>
              <button type="button" className="btn btn-outline" onClick={() => setEditing(blank())}><Icon name="plus" size={14} /> New message</button>
            </div>
          )}
        </div>
        {drafts > 0 && (
          <div className="pg-banner warn"><Icon name="stamp" size={15} /> {drafts} draft{drafts === 1 ? '' : 's'} waiting for approval. Only approved messages are sent: open one, read it, and press Approve.</div>
        )}
        <div className="nu-merge-help">
          <b>Merge fields</b> <code>{'{{first_name}}'}</code> <code>{'{{programme}}'}</code> <code>{'{{academy}}'}</code> <code>{'{{sender}}'}</code>
          <span>are filled in for each lead. Links go in the button or as resource cards, so every click is counted.</span>
        </div>
      </section>

      {groups.map(({ st, list }) => (
        <section key={st} className="nu-stage">
          <header className="nu-stage-h">
            <h3>{STAGE_INFO[st].label}</h3>
            <span>{STAGE_INFO[st].hint}</span>
            <em>{list.length}</em>
          </header>
          {list.length ? (
            <div className="nu-msg-grid">
              {list.map((m) => (
                <MessageCard
                  key={m.id} m={m} can={can} busy={busy}
                  resources={data.resources}
                  onPreview={() => setPreview(m)}
                  onEdit={() => setEditing({ ...m })}
                  onApprove={() => act(`ap_${m.id}`, { action: 'approveMessage', id: m.id }, `"${m.name}" is approved. Agents and campaigns can send it now.`)}
                  onArchive={() => act(`ar_${m.id}`, { action: 'archiveMessage', id: m.id }, `"${m.name}" archived: it will not be sent.`)}
                  onCampaign={() => onCampaign(m.id)}
                />
              ))}
            </div>
          ) : (
            <p className="nu-stage-empty">No {STAGE_INFO[st].label.toLowerCase()} message yet.{st === 'offer' ? ' Offers go to a group as a campaign: "Write with AI" and give it an end date.' : ''}</p>
          )}
        </section>
      ))}

      {archived.length > 0 && (
        <section className="nu-stage">
          <button type="button" className="nu-link" onClick={() => setShowArchived(!showArchived)}><Icon name={showArchived ? 'shrink' : 'expand'} size={13} /> {archived.length} archived</button>
          {showArchived && (
            <div className="nu-msg-grid">
              {archived.map((m) => (
                <div key={m.id} className="nu-msg is-archived">
                  <b>{m.name}</b>
                  <p className="nu-msg-subj">{m.subject}</p>
                  {can && (
                    <div className="nu-acts">
                      <button type="button" className="btn btn-sm btn-outline" onClick={() => act(`rs_${m.id}`, { action: 'restoreMessage', id: m.id }, 'Restored as a draft.')}>Restore</button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => { if (confirm(`Delete "${m.name}" for good?`)) void act(`del_${m.id}`, { action: 'deleteMessage', id: m.id }, 'Deleted.'); }}>Delete</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {editing && <Editor draft={editing} data={data} onClose={() => setEditing(null)} onSaved={async (m) => { setEditing(null); await refresh(); notify(m.check.pass ? 'ok' : 'bad', m.check.pass ? `Saved "${m.name}" as a draft. Approve it when you are happy.` : `Saved, but fix this before it can be approved: ${m.check.notes[0]}`); }} />}
      {writer && <Writer data={data} onClose={() => setWriter(false)} onWritten={async (m) => { setWriter(false); await refresh(); setEditing({ ...m }); notify('ok', 'Written. Read it, change anything you like, then save and approve.'); }} notify={notify} />}
      {preview && <Preview m={preview} onClose={() => setPreview(null)} notify={notify} can={can} />}
    </div>
  );
}

function MessageCard({ m, can, busy, resources, onPreview, onEdit, onApprove, onArchive, onCampaign }: {
  m: NurtureMessage; can: boolean; busy: string | null; resources: Overview['resources'];
  onPreview: () => void; onEdit: () => void; onApprove: () => void; onArchive: () => void; onCampaign: () => void;
}) {
  const expired = Boolean(m.expiresAt && m.expiresAt < Date.now());
  const res = m.resourceIds.map((id) => resources.find((r) => r.id === id)?.title).filter(Boolean);
  return (
    <article className={`nu-msg${m.status === 'approved' ? ' is-ok' : ''}`}>
      <div className="nu-msg-top">
        {m.status === 'approved' && !expired ? <Chip tone="good"><Icon name="ok" size={11} /> Approved</Chip> : expired ? <Chip tone="muted">Ended</Chip> : <Chip tone="warn">Draft</Chip>}
        {m.audience !== 'everyone' && <Chip tone="brand">{AUDIENCE_INFO[m.audience]}</Chip>}
        {m.programme && <Chip>{m.programme}</Chip>}
        {!!m.funding?.length && <Chip title="Only for leads who pay this way">{m.funding.map((k) => FUNDING_LABEL[k].split(' (')[0]).join(' / ')}</Chip>}
        {m.channel !== 'email' && <Chip>{CHANNEL_INFO[m.channel]}</Chip>}
        {m.origin === 'ai' && <Chip tone="muted" title="Written by AI once, from a brief">AI-written</Chip>}
      </div>
      <b className="nu-msg-name">{m.name}</b>
      <p className="nu-msg-subj">{highlight(m.subject)}</p>
      <p className="nu-msg-body">{highlight(m.body.replace(/^Hi \{\{first_name\}\},\s*/i, '').slice(0, 170))}…</p>
      <div className="nu-msg-meta">
        <span><Icon name="arrowRight" size={12} /> {m.cta.label} <em>({CTA_INFO[m.cta.target]})</em></span>
        {res.length > 0 && <span><Icon name="file" size={12} /> {res.join(', ')}</span>}
        {m.expiresAt && <span><Icon name="clock" size={12} /> {expired ? 'Ended' : 'Ends'} {new Date(m.expiresAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</span>}
      </div>
      {!m.check.pass && <p className="nu-msg-check"><Icon name="warn" size={12} /> {m.check.notes[0]}</p>}
      <div className="nu-msg-stats">
        <span><b>{m.stats.sent}</b> sent</span>
        <span><b>{pct(m.stats.opened, m.stats.sent)}%</b> opened</span>
        <span><b>{pct(m.stats.clicked, m.stats.sent)}%</b> clicked</span>
      </div>
      <div className="nu-acts">
        <button type="button" className="btn btn-sm btn-outline" onClick={onPreview}><Icon name="eye" size={13} /> Preview</button>
        {can && <button type="button" className="btn btn-sm btn-outline" onClick={onEdit}><Icon name="edit" size={13} /> Edit</button>}
        {can && m.status === 'draft' && <button type="button" className="btn btn-sm btn-cta" onClick={onApprove} disabled={busy === `ap_${m.id}` || !m.check.pass}><Icon name="stamp" size={13} /> Approve</button>}
        {can && m.status === 'approved' && !expired && <button type="button" className="btn btn-sm btn-primary" onClick={onCampaign}><Icon name="send" size={13} /> Send to a group</button>}
        {can && <button type="button" className="btn btn-sm btn-ghost" onClick={onArchive} disabled={busy === `ar_${m.id}`} title="Archive"><Icon name="trash" size={13} /></button>}
      </div>
    </article>
  );
}

/* ── Editing a message ────────────────────────────────────────────────────── */

function Editor({ draft, data, onClose, onSaved }: { draft: Draft; data: Overview; onClose: () => void; onSaved: (m: NurtureMessage) => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const cta = d.cta || { target: 'reply' as CtaTarget, label: 'Just reply to this email' };
  const shareable = data.resources.filter((r) => r.enabled && ['pdf', 'video', 'link'].includes(r.kind));
  const insert = (tok: string) => set({ body: `${d.body}${d.body.endsWith(' ') || d.body.endsWith('\n') ? '' : ' '}${tok}` });

  async function save() {
    setSaving(true); setErr(null);
    const r = await nurturePost<{ message: NurtureMessage }>({ action: 'saveMessage', message: d });
    setSaving(false);
    if (r.error || !r.message) { setErr(r.error || 'Could not save.'); return; }
    onSaved(r.message);
  }

  return (
    <Modal
      wide
      title={d.id ? `Edit "${d.name || 'message'}"` : 'New message'}
      sub="Saving an approved message sends it back to draft: a person approves what goes out."
      onClose={onClose}
      foot={<>
        {err && <span className="nu-err"><Icon name="warn" size={13} /> {err}</span>}
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-cta" onClick={save} disabled={saving || !d.subject.trim() || !d.body.trim()}>{saving ? 'Saving…' : 'Save draft'}</button>
      </>}
    >
      <div className="nu-form">
        <Field label="Name (only the team sees it)"><input className="in" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Welcome + fit quiz" /></Field>
        <Field label="Journey stage">
          <select className="in" value={d.stage} onChange={(e) => set({ stage: e.target.value as Draft['stage'] })}>
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_INFO[s].label}: {STAGE_INFO[s].hint}</option>)}
          </select>
        </Field>
        <Field label="Who it is for">
          <select className="in" value={d.audience} onChange={(e) => set({ audience: e.target.value as Draft['audience'] })}>
            {Object.entries(AUDIENCE_INFO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Only for leads interested in">
          <select className="in" value={d.programme || ''} onChange={(e) => set({ programme: e.target.value })}>
            <option value="">Any programme</option>
            {data.programmes.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Only for leads who pay this way (none ticked: everyone)" full hint="From their form: e.g. Black Friday and the Early Bird are not for student loans. A lead who did not say still gets it.">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {FUNDINGS.map((k) => (
              <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={(d.funding || []).includes(k)} onChange={(e) => set({ funding: e.target.checked ? [...(d.funding || []), k] : (d.funding || []).filter((x) => x !== k) })} />
                {FUNDING_LABEL[k]}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Subject" full><input className="in" value={d.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="{{first_name}}, which tech path fits you?" /></Field>
        <Field label="Message" full hint="No sign-off needed: the sender's signature is added.">
          <div className="nu-tokens">
            {['{{first_name}}', '{{programme}}', '{{academy}}'].map((t) => <button key={t} type="button" onClick={() => insert(t)}>{t}</button>)}
          </div>
          <textarea className="in nu-body" value={d.body} onChange={(e) => set({ body: e.target.value })} rows={10} />
        </Field>
        <Field label="WhatsApp version (short; made from the email when empty)" full>
          <textarea className="in" value={d.waBody || ''} onChange={(e) => set({ waBody: e.target.value })} rows={3} placeholder="Hi {{first_name}}, …" />
        </Field>
        <Field label="The button under the message">
          <select className="in" value={cta.target} onChange={(e) => set({ cta: { ...cta, target: e.target.value as CtaTarget } })}>
            {Object.entries(CTA_INFO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Button text"><input className="in" value={cta.label} onChange={(e) => set({ cta: { ...cta, label: e.target.value } })} /></Field>
        {cta.target === 'resource' && (
          <Field label="Which resource" full>
            <select className="in" value={cta.resourceId || ''} onChange={(e) => set({ cta: { ...cta, resourceId: e.target.value } })}>
              <option value="">Choose…</option>
              {shareable.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          </Field>
        )}
        {cta.target === 'url' && <Field label="Link" full><input className="in" value={cta.url || ''} onChange={(e) => set({ cta: { ...cta, url: e.target.value } })} placeholder="https://" /></Field>}
        {cta.target === 'apply' && !data.applyUrl && <p className="nu-hint is-full">No application link is set (Channels &amp; API → What the agents know), so the button asks them to reply and a consultant helps.</p>}
        <Field label="Attach from the content bank (up to 3)" full hint="Empty: the best guide or video for each lead is picked for them.">
          <div className="nu-pickres">
            {shareable.length ? shareable.map((r) => {
              const on = (d.resourceIds || []).includes(r.id);
              return (
                <button key={r.id} type="button" className={on ? 'on' : ''} onClick={() => set({ resourceIds: on ? (d.resourceIds || []).filter((x) => x !== r.id) : [...(d.resourceIds || []), r.id].slice(0, 3) })}>
                  <Icon name={r.kind === 'video' ? 'video' : r.kind === 'pdf' ? 'file' : 'link'} size={12} /> {r.title}
                </button>
              );
            }) : <span className="nu-hint">Nothing in the content bank yet.</span>}
          </div>
        </Field>
        <Field label="Send by">
          <select className="in" value={d.channel} onChange={(e) => set({ channel: e.target.value as MessageChannel })}>
            {Object.entries(CHANNEL_INFO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Offer ends (optional)" hint="Never sent after this date.">
          <input className="in" type="date" value={d.expiresAt ? new Date(d.expiresAt).toISOString().slice(0, 10) : ''} onChange={(e) => set({ expiresAt: e.target.value ? new Date(`${e.target.value}T23:59:00`).getTime() : null })} />
        </Field>
        {d.check && !d.check.pass && (
          <div className="pg-banner warn is-full"><Icon name="warn" size={14} /> {d.check.notes.join(' ')}</div>
        )}
      </div>
    </Modal>
  );
}

/* ── Writing one with AI ──────────────────────────────────────────────────── */

function Writer({ data, onClose, onWritten, notify }: { data: Overview; onClose: () => void; onWritten: (m: NurtureMessage) => void; notify: (k: 'ok' | 'bad', t: string) => void }) {
  const [brief, setBrief] = useState('');
  const [stage, setStage] = useState('offer');
  const [audience, setAudience] = useState('everyone');
  const [programme, setProgramme] = useState('');
  const [cta, setCta] = useState('');
  const [ends, setEnds] = useState('');
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    const r = await nurturePost<{ message: NurtureMessage }>({
      action: 'writeMessage', brief, stage, audience, programme, cta: cta || undefined,
      expiresAt: ends ? new Date(`${ends}T23:59:00`).getTime() : null,
    });
    setBusy(false);
    if (r.error || !r.message) { notify('bad', r.error || 'Could not write it.'); return; }
    onWritten(r.message);
  }

  return (
    <Modal
      title="Write a message with AI"
      sub="One AI call, once. The message is saved as a draft for you to read and approve, then it can go to any number of leads at no extra cost."
      onClose={onClose}
      foot={<>
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-cta" onClick={go} disabled={busy || brief.trim().length < 8}>{busy ? 'Writing…' : 'Write it'}</button>
      </>}
    >
      <div className="nu-form">
        <Field label="What is it for?" full hint="Facts the message may use must be here or in what the agents know. It never invents fees, dates or discounts.">
          <textarea className="in" rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="e.g. 50% off the registration fee for anyone who applies before 30 November. Keep it warm, not salesy." autoFocus />
        </Field>
        <Field label="Journey stage">
          <select className="in" value={stage} onChange={(e) => setStage(e.target.value)}>
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_INFO[s].label}</option>)}
          </select>
        </Field>
        <Field label="Who it is for">
          <select className="in" value={audience} onChange={(e) => setAudience(e.target.value)}>
            {Object.entries(AUDIENCE_INFO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Programme">
          <select className="in" value={programme} onChange={(e) => setProgramme(e.target.value)}>
            <option value="">Any programme</option>
            {data.programmes.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="The button">
          <select className="in" value={cta} onChange={(e) => setCta(e.target.value)}>
            <option value="">Let the stage decide</option>
            {Object.entries(CTA_INFO).filter(([k]) => k !== 'resource' && k !== 'url').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Offer ends (optional)"><input className="in" type="date" value={ends} onChange={(e) => setEnds(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/* ── Preview ──────────────────────────────────────────────────────────────── */

function Preview({ m, onClose, notify, can }: { m: NurtureMessage; onClose: () => void; notify: (k: 'ok' | 'bad', t: string) => void; can: boolean }) {
  const [p, setP] = useState<{ subject: string; html: string; whatsapp: string; resources: string[] } | null>(null);
  const [tab, setTab] = useState<'email' | 'whatsapp'>('email');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/nurture?preview=${encodeURIComponent(m.id)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (live) setP(j); })
      .catch(() => notify('bad', 'Could not load the preview.'));
    return () => { live = false; };
  }, [m.id, notify]);
  async function test() {
    setSending(true);
    const r = await nurturePost<{ detail: string }>({ action: 'testSend', id: m.id });
    setSending(false);
    notify(r.error ? 'bad' : 'ok', r.error || `Test: ${r.detail}. Open the Inbox on the Live Office to see it.`);
  }
  return (
    <Modal
      wide
      title={m.name}
      sub="As a sample lead (Thandi) gets it. Links in a preview are real tracked links; clicking them here is not counted for anyone."
      onClose={onClose}
      foot={<>
        {can && <button type="button" className="btn btn-outline" onClick={test} disabled={sending}><Icon name="send" size={13} /> {sending ? 'Sending…' : 'Send me a test'}</button>}
        <button type="button" className="btn btn-cta" onClick={onClose}>Done</button>
      </>}
    >
      <div className="nu-prev-tabs">
        <button type="button" className={tab === 'email' ? 'on' : ''} onClick={() => setTab('email')}><Icon name="mail" size={13} /> Email</button>
        <button type="button" className={tab === 'whatsapp' ? 'on' : ''} onClick={() => setTab('whatsapp')}><Icon name="chat" size={13} /> WhatsApp</button>
      </div>
      {!p ? <div className="nu-loading"><Icon name="spinner" size={16} className="spin" /> Rendering…</div> : tab === 'email' ? (
        <>
          <p className="nu-prev-subj"><b>Subject:</b> {p.subject}</p>
          <iframe className="nu-prev-frame" title="Email preview" srcDoc={p.html} sandbox="allow-popups allow-popups-to-escape-sandbox" />
        </>
      ) : (
        <div className="nu-wa"><div className="nu-wa-bubble">{p.whatsapp}</div></div>
      )}
    </Modal>
  );
}

