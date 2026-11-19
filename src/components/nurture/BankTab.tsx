'use client';

import { useState } from 'react';
import type { NurtureResource } from '@/lib/nurture/types';
import Icon, { type IconName } from '@/components/Icon';
import { AUDIENCE_INFO, STAGES, STAGE_INFO, nurturePost, pct, type Overview } from './api';
import { Chip, Empty, Field, Modal } from './ui';
import FootageSection from './FootageSection';

/* The content bank: guides, videos, links and what the team knows.
 * Each item is read by AI once when it is added; choosing what to send a lead after that is rules, not AI. */

type Adder = 'pdf' | 'youtube' | 'link' | 'whatsapp' | 'note' | null;

const KIND: Record<NurtureResource['kind'], { icon: IconName; label: string }> = {
  pdf: { icon: 'file', label: 'PDF guide' },
  video: { icon: 'video', label: 'Video' },
  link: { icon: 'link', label: 'Link' },
  note: { icon: 'edit', label: 'Note for the agents' },
  faq: { icon: 'chat', label: 'WhatsApp FAQs' },
};

export default function BankTab({ data, refresh, notify }: { data: Overview; refresh: () => Promise<void>; notify: (k: 'ok' | 'bad', t: string) => void }) {
  const [adder, setAdder] = useState<Adder>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<NurtureResource | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const can = data.canManage;
  const shareable = data.resources.filter((r) => ['pdf', 'video', 'link'].includes(r.kind));
  const knowledge = data.resources.filter((r) => r.kind === 'note' || r.kind === 'faq');

  const reset = () => { setUrl(''); setTitle(''); setText(''); setFile(null); };

  async function upload(kind: 'pdf' | 'whatsapp') {
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.set('file', file); fd.set('kind', kind); if (title.trim()) fd.set('title', title.trim());
    try {
      const r = await fetch('/api/nurture/upload', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) notify('bad', j.error || `Upload failed (${r.status}).`);
      else { notify('ok', kind === 'pdf' ? `Added "${j.resource?.title}". It was read and summarised; the agents can share it now.` : `Learned ${j.faqs} common questions from the chat. Names and numbers were removed first; the chat itself is not kept.`); reset(); setAdder(null); }
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function post(body: Record<string, unknown>, ok: (j: Record<string, unknown>) => string) {
    setBusy(true);
    const r = await nurturePost(body);
    setBusy(false);
    if (r.error) notify('bad', r.error); else { notify('ok', ok(r)); reset(); setAdder(null); }
    await refresh();
  }

  const ADDERS: { id: Exclude<Adder, null>; icon: IconName; label: string; hint: string }[] = [
    { id: 'pdf', icon: 'upload', label: 'Upload a PDF', hint: 'A guide for parents, a prospectus' },
    { id: 'youtube', icon: 'video', label: 'Import YouTube', hint: 'Your channel or a playlist' },
    { id: 'link', icon: 'link', label: 'Add a link', hint: 'An article or a page on your site' },
    { id: 'whatsapp', icon: 'chat', label: 'Learn from WhatsApp', hint: 'What leads ask, and your answers' },
    { id: 'note', icon: 'edit', label: 'Write a note', hint: 'Fees, intakes, how classes work' },
  ];

  return (
    <div className="nu-tab">
      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2><Icon name="layers" size={16} /> The content bank</h2>
            <p className="pg-sub">
              Everything the nurturing can share or learn from. AI reads each item once, when you add it, and notes what it is, who it helps and when to send it.
              From then on the right guide or video is picked for each lead by simple rules, so there is no AI cost per lead.
            </p>
          </div>
          <div className="nu-kpis">
            <span><b>{shareable.length}</b> to share</span>
            <span><b>{knowledge.length}</b> notes &amp; FAQs</span>
          </div>
        </div>

        {can && (
          <div className="nu-adders">
            {ADDERS.map((a) => (
              <button key={a.id} type="button" className={`nu-adder${adder === a.id ? ' on' : ''}`} onClick={() => { setAdder(adder === a.id ? null : a.id); reset(); }}>
                <span><Icon name={a.icon} size={18} /></span>
                <b>{a.label}</b>
                <small>{a.hint}</small>
              </button>
            ))}
          </div>
        )}

        {adder === 'pdf' && (
          <div className="nu-addform">
            <Field label="PDF file (up to 12 MB)"><input className="in" type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
            <Field label="Title (optional)"><input className="in" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A parent's guide to tech careers" /></Field>
            <button type="button" className="btn btn-cta" disabled={!file || busy} onClick={() => upload('pdf')}>{busy ? 'Reading it…' : 'Upload and read'}</button>
          </div>
        )}
        {adder === 'youtube' && (
          <div className="nu-addform">
            <Field label="Channel or playlist link" hint="youtube.com/@yourchannel, a playlist, or one video. The latest 15 videos are imported; clips that would not help a prospective student are left out.">
              <input className="in" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/@melsoftacademy" />
            </Field>
            <button type="button" className="btn btn-cta" disabled={!url.trim() || busy} onClick={() => post(/youtube\.com\/(watch|shorts)|youtu\.be\//i.test(url) ? { action: 'addLink', url } : { action: 'importYouTube', url }, (j) => typeof j.added === 'number' ? `Imported ${j.added} video${j.added === 1 ? '' : 's'}${j.skipped ? ` (${j.skipped} skipped: already in the bank or not useful for leads)` : ''}.` : 'Video added.')}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        )}
        {adder === 'link' && (
          <div className="nu-addform">
            <Field label="Link"><input className="in" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></Field>
            <Field label="Title (optional)"><input className="in" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <button type="button" className="btn btn-cta" disabled={!url.trim() || busy} onClick={() => post({ action: 'addLink', url, title }, () => 'Link added and summarised.')}>{busy ? 'Reading it…' : 'Add'}</button>
          </div>
        )}
        {adder === 'whatsapp' && (
          <div className="nu-addform">
            <p className="nu-hint is-full">
              In WhatsApp: open a chat (or your business chats) → ⋮ → More → Export chat → <b>Without media</b>, and upload the .txt here.
              Names, phone numbers and emails are removed before anything is read, and only the questions and answers are kept, never the chat.
            </p>
            <Field label="Chat export (.txt)"><input className="in" type="file" accept=".txt,text/plain" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
            <button type="button" className="btn btn-cta" disabled={!file || busy} onClick={() => upload('whatsapp')}>{busy ? 'Learning…' : 'Learn from it'}</button>
            <Field label="…or paste messages (a channel post, a few chats)" full>
              <textarea className="in" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <button type="button" className="btn btn-outline" disabled={text.trim().length < 40 || busy} onClick={() => post({ action: 'importWhatsApp', text }, (j) => `Learned ${j.faqs} common questions.`)}>Learn from the pasted text</button>
          </div>
        )}
        {adder === 'note' && (
          <div className="nu-addform">
            <Field label="Title"><input className="in" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fees and payment plans 2027" /></Field>
            <Field label="What the agents may say" full hint="Only facts. The agents never invent anything beyond what is here and in Channels & API → What the agents know.">
              <textarea className="in" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <button type="button" className="btn btn-cta" disabled={!text.trim() || busy} onClick={() => post({ action: 'addNote', title, text }, () => 'Note saved. Every agent reads it before writing.')}>{busy ? 'Saving…' : 'Save note'}</button>
          </div>
        )}
      </section>

      <section className="nu-stage">
        <header className="nu-stage-h"><h3>To share with leads</h3><span>Sent as cards in messages, with tracked links</span><em>{shareable.length}</em></header>
        {shareable.length ? (
          <div className="nu-res-grid">
            {shareable.map((r) => <ResourceCard key={r.id} r={r} can={can} onEdit={() => setEditing(r)} onToggle={() => post({ action: 'updateResource', id: r.id, patch: { enabled: !r.enabled } }, () => (r.enabled ? `"${r.title}" will not be sent.` : `"${r.title}" can be sent again.`))} onDelete={() => { if (confirm(`Remove "${r.title}" from the bank?`)) void post({ action: 'deleteResource', id: r.id }, () => 'Removed.'); }} />)}
          </div>
        ) : <Empty icon="layers" title="Nothing to share yet">Upload your parents' guide or import your YouTube channel: the nurturing attaches the right one for each lead.</Empty>}
      </section>

      <section className="nu-stage">
        <header className="nu-stage-h"><h3>What the agents know</h3><span>Notes and WhatsApp FAQs: read before every message, never sent as links</span><em>{knowledge.length}</em></header>
        {knowledge.length ? (
          <div className="nu-res-grid">
            {knowledge.map((r) => <ResourceCard key={r.id} r={r} can={can} onEdit={() => setEditing(r)} onToggle={() => post({ action: 'updateResource', id: r.id, patch: { enabled: !r.enabled } }, () => 'Updated.')} onDelete={() => { if (confirm(`Remove "${r.title}"?`)) void post({ action: 'deleteResource', id: r.id }, () => 'Removed.'); }} />)}
          </div>
        ) : <Empty icon="chat" title="No notes yet">Upload a WhatsApp chat export to learn what leads really ask, or write a note with fees and intakes.</Empty>}
      </section>

      <FootageSection data={data} refresh={refresh} notify={notify} />

      {editing && <ResourceEditor r={editing} programmes={data.programmes} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); notify('ok', 'Saved.'); await refresh(); }} notify={notify} />}
    </div>
  );
}

function ResourceCard({ r, can, onEdit, onToggle, onDelete }: { r: NurtureResource; can: boolean; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const k = KIND[r.kind];
  const href = r.url || (r.fileId ? `/api/nurture/file?id=${encodeURIComponent(r.id)}` : null);
  return (
    <article className={`nu-res${r.enabled ? '' : ' is-off'}`}>
      {r.thumb ? <div className="nu-res-thumb" style={{ backgroundImage: `url(${r.thumb})` }}><span><Icon name="play" size={16} /></span></div> : null}
      <div className="nu-res-h">
        <span className={`nu-res-ic k-${r.kind}`}><Icon name={k.icon} size={16} /></span>
        <div><b>{r.title}</b><small>{k.label}{r.digest === 'ai' ? ' · read by AI' : ''}{r.origin === 'youtube' ? ' · YouTube' : ''}</small></div>
      </div>
      {r.summary && <p className="nu-res-sum">{r.summary}</p>}
      {r.hook && <p className="nu-res-hook">“{r.hook}”</p>}
      <div className="nu-msg-top">
        {r.audience.map((a) => <Chip key={a} tone={a === 'everyone' ? undefined : 'brand'}>{AUDIENCE_INFO[a] || a}</Chip>)}
        {r.stage !== 'any' && <Chip>{STAGE_INFO[r.stage]?.label || r.stage}</Chip>}
        {r.programmes.map((p) => <Chip key={p}>{p}</Chip>)}
      </div>
      {r.text && (r.kind === 'faq' || r.kind === 'note') && (
        <>
          <button type="button" className="nu-link" onClick={() => setOpen(!open)}><Icon name={open ? 'shrink' : 'expand'} size={12} /> {open ? 'Hide' : 'Show'} what the agents read</button>
          {open && <pre className="nu-res-text">{r.text}</pre>}
        </>
      )}
      {['pdf', 'video', 'link'].includes(r.kind) && <div className="nu-msg-stats"><span><b>{r.stats.sent}</b> sent</span><span><b>{r.stats.clicks}</b> opened</span><span><b>{pct(r.stats.clicks, r.stats.sent)}%</b> rate</span></div>}
      <div className="nu-acts">
        {href && <a className="btn btn-sm btn-outline" href={href} target="_blank" rel="noreferrer"><Icon name="external" size={12} /> Open</a>}
        {can && <button type="button" className="btn btn-sm btn-outline" onClick={onEdit}><Icon name="edit" size={12} /> Edit</button>}
        {can && <button type="button" className="btn btn-sm btn-ghost" onClick={onToggle}>{r.enabled ? 'Pause' : 'Use again'}</button>}
        {can && <button type="button" className="btn btn-sm btn-ghost" onClick={onDelete} title="Remove"><Icon name="trash" size={12} /></button>}
      </div>
    </article>
  );
}

function ResourceEditor({ r, programmes, onClose, onSaved, notify }: { r: NurtureResource; programmes: string[]; onClose: () => void; onSaved: () => void; notify: (k: 'ok' | 'bad', t: string) => void }) {
  const [d, setD] = useState({ title: r.title, summary: r.summary, hook: r.hook, audience: r.audience, stage: r.stage, programmes: r.programmes, text: r.text || '' });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const res = await nurturePost({ action: 'updateResource', id: r.id, patch: d });
    setBusy(false);
    if (res.error) notify('bad', res.error); else onSaved();
  }
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <Modal title={`Edit "${r.title}"`} sub="How it is chosen for leads: who it helps, the journey stage, the programmes." onClose={onClose}
      foot={<><button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button><button type="button" className="btn btn-cta" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="nu-form">
        <Field label="Title" full><input className="in" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
        <Field label="Summary (for the team and the agents)" full><textarea className="in" rows={2} value={d.summary} onChange={(e) => setD({ ...d, summary: e.target.value })} /></Field>
        {r.kind !== 'note' && r.kind !== 'faq' && <Field label="The line that introduces it in an email" full><input className="in" value={d.hook} onChange={(e) => setD({ ...d, hook: e.target.value })} /></Field>}
        <Field label="Who it helps" full>
          <div className="nu-pickres">
            {Object.entries(AUDIENCE_INFO).map(([k, v]) => <button key={k} type="button" className={d.audience.includes(k as never) ? 'on' : ''} onClick={() => setD({ ...d, audience: toggle(d.audience, k as NurtureResource['audience'][number]) })}>{v}</button>)}
          </div>
        </Field>
        <Field label="Best at this stage">
          <select className="in" value={d.stage} onChange={(e) => setD({ ...d, stage: e.target.value as NurtureResource['stage'] })}>
            <option value="any">Any stage</option>
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_INFO[s].label}</option>)}
          </select>
        </Field>
        <Field label="Programmes (none = all)" full>
          <div className="nu-pickres">
            {programmes.map((p) => <button key={p} type="button" className={d.programmes.includes(p) ? 'on' : ''} onClick={() => setD({ ...d, programmes: toggle(d.programmes, p) })}>{p}</button>)}
          </div>
        </Field>
        {(r.kind === 'note' || r.kind === 'faq' || r.text) && (
          <Field label="What the agents may use from it" full><textarea className="in" rows={8} value={d.text} onChange={(e) => setD({ ...d, text: e.target.value })} /></Field>
        )}
      </div>
    </Modal>
  );
}
