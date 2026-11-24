'use client';

import { useRef, useState } from 'react';
import Icon from '@/components/Icon';
import { Chip, Empty } from '@/components/nurture/ui';
import type { Overview } from './api';
import type { Act } from './OutboundClient';

/* Our ideal companies: the pattern Thuso looks for. Nobody on this list is
 * written to unless someone says so (the team may be talking to them). */

export default function IdealTab({ data, act }: { data: Overview; act: Act }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const file = useRef<HTMLInputElement>(null);
  const list = data.ideals.filter((x) => !q || `${x.name} ${x.domain} ${x.sector} ${x.province}`.toLowerCase().includes(q.toLowerCase()));
  const run = async (key: string, body: Record<string, unknown>) => { setBusy(key); const ok = await act(body); setBusy(''); return ok; };
  const ids = [...ticked].filter((id) => data.ideals.some((x) => x.id === id));
  return (
    <div className="nu-tab">
      <section className="pg-card">
        <div className="pg-card-h"><div><h2><Icon name="target" size={16} /> Your ideal companies ({data.ideals.length})</h2><p className="pg-sub">Paste your 100 or 300, one per line, or upload the sheet as a CSV. Columns it understands: company, website, sector, size, province, notes, and use (&quot;ok to contact&quot;). Thuso learns what they have in common and finds companies like them, smaller ones first.</p></div></div>
        {data.canManage && (
          <>
            <textarea className="in" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Company, Website, Sector\nAcme Logistics, acme.co.za, Logistics\nBeta Retail'} aria-label="Your ideal companies" />
            <div className="pg-actions">
              <button type="button" className="btn primary sm" disabled={!text.trim() || Boolean(busy)} onClick={() => void run('add', { action: 'importIdeals', text }).then((ok) => { if (ok) setText(''); })}>{busy === 'add' ? 'Adding…' : 'Add them'}</button>
              <input ref={file} type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void f.text().then((t) => run('add', { action: 'importIdeals', text: t })); }} />
              <button type="button" className="btn ghost sm" disabled={Boolean(busy)} onClick={() => file.current?.click()}><Icon name="upload" size={14} /> Upload a CSV</button>
              <button type="button" className="btn ghost sm" disabled={Boolean(busy) || data.ideals.length < 3 || !data.aiReady} onClick={() => void run('learn', { action: 'learnIdeals' })}><Icon name={busy === 'learn' ? 'spinner' : 'scanSearch'} size={14} className={busy === 'learn' ? 'spin' : ''} /> {busy === 'learn' ? 'Reading them…' : 'Learn what they have in common'}</button>
            </div>
          </>
        )}
        {data.settings.profile && <div className="ob-profile"><b>What they have in common</b><p>{data.settings.profile}</p><small>You can change this in Settings.</small></div>}
      </section>

      <section className="pg-card">
        <div className="nu-filter">
          <input className="in nu-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search ideal companies" />
          {data.canManage && ids.length > 0 && (
            <>
              <b>{ids.length} ticked</b>
              <button type="button" className="btn ghost sm" onClick={() => { if (window.confirm(`Let Thuso research and contact these ${ids.length}? Only do this for companies your team is not talking to.`)) void run('use', { action: 'idealUse', ids, use: 'research' }).then(() => setTicked(new Set())); }}>OK to contact</button>
              <button type="button" className="btn ghost sm" onClick={() => void run('use', { action: 'idealUse', ids, use: 'pattern' }).then(() => setTicked(new Set()))}>Learn from them only</button>
              <button type="button" className="btn ghost sm" onClick={() => { if (window.confirm(`Remove ${ids.length} from the list?`)) void run('rm', { action: 'removeIdeal', ids }).then(() => setTicked(new Set())); }}>Remove</button>
            </>
          )}
        </div>
        {list.length ? (
          <div className="nu-table-wrap ob-ideal">
            <table className="nu-table">
              <thead><tr>{data.canManage && <th><input type="checkbox" aria-label="Tick all" checked={list.length > 0 && list.every((x) => ticked.has(x.id))} onChange={(e) => setTicked(e.target.checked ? new Set(list.map((x) => x.id)) : new Set())} /></th>}<th>Company</th><th>Sector</th><th>Size</th><th>Place</th><th>Use</th></tr></thead>
              <tbody>
                {list.map((x) => (
                  <tr key={x.id}>
                    {data.canManage && <td><input type="checkbox" aria-label={`Tick ${x.name}`} checked={ticked.has(x.id)} onChange={() => setTicked((s) => { const n = new Set(s); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n; })} /></td>}
                    <td><b>{x.name}</b><small>{x.domain}</small></td><td>{x.sector || <em>—</em>}</td><td>{x.size || <em>—</em>}</td><td>{x.province || <em>—</em>}</td>
                    <td><Chip tone={x.use === 'research' ? 'good' : 'muted'}>{x.use === 'research' ? 'OK to contact' : 'Learn from it only'}</Chip></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon="target" title={q ? 'None match' : 'No ideal companies yet'}>{q ? 'Try another search.' : 'Paste your list above. Even 20 names help.'}</Empty>}
      </section>
    </div>
  );
}
