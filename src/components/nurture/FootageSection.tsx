'use client';

import { useState } from 'react';
import type { MediaItem } from '@/lib/nurture/types';
import { FOOTAGE_TAGS } from '@/lib/nurture/types';
import Icon from '@/components/Icon';
import { nurturePost, type Overview } from './api';
import { Chip, Empty } from './ui';

/* Footage and music for the videos: the academy's own clips and photos play behind the
 * greeting and the big moments of every lesson and lead video, graded into the brand. */

const SHOTS: { tag: string; what: string }[] = [
  { tag: 'welcome', what: 'Someone from the team smiling or waving at the camera (the greeting)' },
  { tag: 'students', what: 'Students working together, laughing, in a class or online session' },
  { tag: 'coding', what: 'Hands on a keyboard, code on a screen, someone building something' },
  { tag: 'campus', what: 'The building, the entrance, the space where classes happen' },
  { tag: 'celebration', what: 'A graduation, high-fives, a team celebrating (the ending)' },
];

type Media = MediaItem & { url: string };

export default function FootageSection({ data, refresh, notify }: { data: Overview; refresh: () => Promise<void>; notify: (k: 'ok' | 'bad', t: string) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const can = data.canManage;
  const media = (data.media || []) as Media[];
  const visual = media.filter((m) => m.kind !== 'music');
  const music = media.filter((m) => m.kind === 'music');

  async function upload() {
    let ok = 0;
    for (const [k, f] of files.entries()) {
      setBusy(`Uploading ${k + 1} of ${files.length}…`);
      const fd = new FormData();
      fd.set('file', f); fd.set('kind', 'media'); if (tags.length) fd.set('tags', tags.join(','));
      try {
        const r = await fetch('/api/nurture/upload', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) notify('bad', `${f.name}: ${j.error || `upload failed (${r.status})`}`); else ok++;
      } catch (e) {
        notify('bad', `${f.name}: ${(e as Error).message}`);
      }
    }
    setBusy(null);
    if (ok) notify('ok', `${ok} file${ok === 1 ? '' : 's'} added. The next video that plays uses ${ok === 1 ? 'it' : 'them'}.`);
    setFiles([]); setTags([]);
    await refresh();
  }

  async function patch(id: string, p: Record<string, unknown>) {
    const r = await nurturePost({ action: 'updateMedia', id, patch: p });
    if (r.error) notify('bad', r.error);
    await refresh();
  }

  return (
    <section className="pg-card">
      <div className="pg-card-h">
        <div>
          <h2><Icon name="video" size={16} /> Footage and music for the videos</h2>
          <p className="pg-sub">
            Your own clips and photos play behind the greeting and the big moments of every lesson and lead video, slowly zooming and tinted in the Melsoft colours,
            so the videos feel like Melsoft and not like slides. Each scene picks a shot by its tags. A music track (optional) replaces the soft built-in music bed.
          </p>
        </div>
        <div className="nu-kpis"><span><b>{visual.length}</b> clips &amp; photos</span><span><b>{music.length}</b> music</span></div>
      </div>

      <div className="nu-shotlist">
        <b>What to film (phone footage is fine)</b>
        <ul>{SHOTS.map((s) => <li key={s.tag}><Chip tone="brand">{s.tag}</Chip> {s.what}</li>)}</ul>
        <small>Landscape (horizontal), 5 to 15 seconds each, steady, good light, no talking needed (the narration plays over it). MP4 up to 60 MB; photos JPG or PNG; music MP3 you have the rights to.</small>
      </div>

      {can && (
        <div className="nu-addform">
          <label className="field nu-field is-full">
            <span>Clips, photos or a music track</span>
            <input className="in" type="file" multiple accept="video/mp4,video/webm,video/quicktime,image/jpeg,image/png,image/webp,audio/mpeg,audio/mp4,.mp3,.m4a" onChange={(e) => setFiles(Array.from(e.target.files || []))} />
          </label>
          <div className="field nu-field is-full">
            <span>What they show (optional: photos are tagged automatically, clips by their file name)</span>
            <div className="nu-pickres">
              {FOOTAGE_TAGS.map((t) => <button key={t} type="button" className={tags.includes(t) ? 'on' : ''} onClick={() => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])}>{t}</button>)}
            </div>
          </div>
          <button type="button" className="btn btn-cta" disabled={!files.length || Boolean(busy)} onClick={upload}><Icon name="upload" size={14} /> {busy || `Upload ${files.length || ''}`.trim()}</button>
        </div>
      )}

      {visual.length ? (
        <div className="nu-footage-grid">
          {visual.map((m) => (
            <article key={m.id} className={`nu-footage${m.enabled ? '' : ' is-off'}`}>
              <div className="nu-footage-media">
                {m.kind === 'video' ? <video src={m.url} muted loop playsInline preload="metadata" onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} /> : <img src={m.url} alt={m.title} />}
                <span className="nu-footage-kind"><Icon name={m.kind === 'video' ? 'video' : 'eye'} size={11} /> {m.kind}</span>
              </div>
              <b>{m.title}</b>
              {m.description && <small>{m.description}</small>}
              <div className="nu-pickres nu-footage-tags">
                {FOOTAGE_TAGS.map((t) => (
                  <button key={t} type="button" disabled={!can} className={m.tags.includes(t) ? 'on' : ''} onClick={() => patch(m.id, { tags: m.tags.includes(t) ? m.tags.filter((x) => x !== t) : [...m.tags, t] })}>{t}</button>
                ))}
              </div>
              {can && (
                <div className="nu-acts">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => patch(m.id, { enabled: !m.enabled })}>{m.enabled ? 'Pause' : 'Use again'}</button>
                  <button type="button" className="btn btn-sm btn-ghost" title="Delete" onClick={async () => { if (confirm(`Delete "${m.title}"?`)) { await nurturePost({ action: 'deleteMedia', id: m.id }); await refresh(); } }}><Icon name="trash" size={12} /></button>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : <Empty icon="video" title="No footage yet">Without footage the videos use their animated backdrop. Add a few clips of the team, students and the campus and every video starts to look like Melsoft.</Empty>}

      {music.length > 0 && (
        <div className="nu-music">
          {music.map((m) => (
            <div key={m.id} className="nu-music-row">
              <Icon name="volume" size={14} />
              <b>{m.title}</b>
              <audio src={m.url} controls preload="none" />
              {m.enabled ? <Chip tone="good">Plays under the voice</Chip> : <Chip tone="muted">Paused</Chip>}
              {can && <button type="button" className="btn btn-sm btn-ghost" onClick={() => patch(m.id, { enabled: !m.enabled })}>{m.enabled ? 'Pause' : 'Use'}</button>}
              {can && <button type="button" className="btn btn-sm btn-ghost" title="Delete" onClick={async () => { if (confirm(`Delete "${m.title}"?`)) { await nurturePost({ action: 'deleteMedia', id: m.id }); await refresh(); } }}><Icon name="trash" size={12} /></button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
