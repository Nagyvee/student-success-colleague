'use client';

import { useCallback, useMemo, useState } from 'react';
import Icon from '@/components/Icon';
import { Chip, Empty, Notice } from '@/components/nurture/ui';
import { PIPELINE, STAGE_LABEL, onList, peopleOf, type Stage } from '@/lib/outbound/types';
import { outboundPost, useOutbound, type CompanyRow, type Overview } from './api';
import CompanyPanel from './CompanyPanel';
import IdealTab from './IdealTab';
import SettingsTab from './SettingsTab';
import '../nurture/nurture.css';
import './outbound.css';

/* B2B Outbound: today's companies to choose from, the emails to check, the
 * pipeline (its own CRM), our ideal companies, and the settings. */

const TABS = [
  { id: 'today', label: 'Today', icon: 'calendar' },
  { id: 'pipeline', label: 'Pipeline', icon: 'layers' },
  { id: 'companies', label: 'Companies', icon: 'building' },
  { id: 'ideal', label: 'Ideal companies', icon: 'target' },
  { id: 'settings', label: 'Settings', icon: 'sliders' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export type Act = (body: Record<string, unknown>, ok?: string) => Promise<boolean>;

export default function OutboundClient() {
  const { data, error, refresh } = useOutbound();
  const [tab, setTab] = useState<Tab>('today');
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const clear = useCallback(() => setNotice(null), []);
  const act: Act = useCallback(async (body, ok) => {
    const r = await outboundPost(body);
    setNotice(r.error ? { kind: 'bad', text: r.error } : r.detail || ok ? { kind: 'ok', text: r.detail || ok! } : null);
    await refresh();
    return !r.error;
  }, [refresh]);

  if (error && !data) return <main className="pg-main"><div className="pg-banner bad"><Icon name="warn" size={15} /> {error}</div></main>;
  if (!data) return <main className="pg-main"><div className="nu-loading"><Icon name="spinner" size={16} className="spin" /> Loading B2B outbound…</div></main>;

  const toCheck = data.companies.filter((c) => c.drafts > 0).length;
  const toChoose = data.companies.filter((c) => c.stage === 'found' && onList(c, data.settings.minScore)).length;
  return (
    <main className="pg-main nu ob">
      <div className="nu-status">
        <Chip tone={data.research.doing || data.research.extra ? 'brand' : data.research.on ? 'good' : 'muted'}><Icon name={data.research.doing ? 'spinner' : 'scanSearch'} size={12} className={data.research.doing ? 'spin' : ''} /> {data.research.doing || (data.research.on ? `Research on: ${data.settings.perDay} a day` : 'Research off')}</Chip>
        <Chip tone={data.sending.on ? (data.sending.blocked ? 'warn' : 'good') : 'muted'} title={data.sending.blocked}><Icon name="send" size={12} /> {data.sending.on ? (data.sending.blocked ? 'Sending waits' : `Sending on: ${data.sending.sentToday} of ${data.sending.perDay} today`) : 'Sending off'}</Chip>
        <Chip tone={data.spend.usd >= data.spend.budget * 0.9 ? 'warn' : undefined} title={`${data.spend.searches} searches, ${data.spend.companies} companies looked at this month, about $${data.spend.each.toFixed(2)} each (an estimate from the price list)`}><Icon name="coins" size={12} /> ${data.spend.usd.toFixed(2)} of ${data.spend.budget} this month</Chip>
        {data.sending.pausedUntil > 0 && <Chip tone="bad"><Icon name="warn" size={12} /> The outreach mailbox refused: trying again later</Chip>}
        {data.sending.mailError && <Chip tone="bad" title={data.sending.mailError}><Icon name="warn" size={12} /> Replies cannot be read</Chip>}
      </div>
      {data.research.lastError && Date.now() - data.research.lastErrorAt < 86_400_000 && <p className="pg-banner warn" role="status"><Icon name="warn" size={15} /> <span>Last problem: {data.research.lastError}</span></p>}
      <Notice n={notice} onClose={clear} />

      <nav className="nu-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={15} /> {t.label}
            {t.id === 'today' && toChoose + toCheck > 0 && <em>{toChoose + toCheck}</em>}
          </button>
        ))}
      </nav>

      {tab === 'today' && <Today data={data} act={act} open={setOpen} go={setTab} />}
      {tab === 'pipeline' && <Pipeline data={data} act={act} open={setOpen} />}
      {tab === 'companies' && <Companies data={data} act={act} open={setOpen} />}
      {tab === 'ideal' && <IdealTab data={data} act={act} />}
      {tab === 'settings' && <SettingsTab data={data} act={act} />}
      {open && <CompanyPanel id={open} data={data} act={act} onClose={() => setOpen(null)} />}
    </main>
  );
}

/* ── Today ────────────────────────────────────────────────────────────────── */

function Today({ data, act, open, go }: { data: Overview; act: Act; open: (id: string) => void; go: (t: Tab) => void }) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [more, setMore] = useState(false);
  const found = data.companies.filter((c) => c.stage === 'found');
  const min = data.settings.minScore;
  const listed = found.filter((c) => onList(c, min));
  const rest = found.filter((c) => !onList(c, min));
  const check = data.companies.filter((c) => c.drafts > 0);
  const noAddress = data.companies.filter((c) => c.stage === 'approved' && !c.contact.email);
  const picked = [...ticked].filter((id) => listed.some((c) => c.id === id));
  const run = async (key: string, body: Record<string, unknown>) => { setBusy(key); await act(body); setBusy(''); setTicked(new Set()); };
  const setup = [...data.missingForResearch];

  return (
    <div className="nu-tab">
      {setup.length > 0 && (
        <section className="pg-card ob-setup">
          <div className="pg-card-h"><div><h2><Icon name="flask" size={16} /> Before Thuso can look for companies</h2><p className="pg-sub">It needs to know {setup.join(', and ')}. Nothing is searched, and nothing is sent, until you say so.</p></div></div>
          <div className="pg-actions">
            <button type="button" className="btn primary sm" onClick={() => go('settings')}>Open settings</button>
            <button type="button" className="btn ghost sm" onClick={() => go('ideal')}>Add your ideal companies</button>
          </div>
        </section>
      )}

      {check.length > 0 && (
        <section className="pg-card">
          <div className="pg-card-h">
            <div><h2><Icon name="mail" size={16} /> Emails to check ({check.length})</h2><p className="pg-sub">Open one to read or change it. Once it is OK it goes on a weekday between 08:30 and 16:30, {data.sending.perDay} first emails a day.{data.sending.blocked ? ` Not yet: ${data.sending.blocked}` : ''}</p></div>
            {data.canManage && check.length > 1 && <button type="button" className="btn ghost sm" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`OK all ${check.length} emails as they are, without opening them?`)) void run('okall', { action: 'sendOk', ids: check.map((c) => c.id) }); }}>{busy === 'okall' ? 'Working…' : 'OK them all'}</button>}
          </div>
          <div className="ob-rows">
            {check.map((c) => (
              <button key={c.id} type="button" className="ob-row" onClick={() => open(c.id)}>
                <b>{c.name}</b><span>{c.answered ? 'Our answer to what they wrote' : c.consent === 'yes' ? 'Keeping warm' : 'The first email'}</span><span className="ob-dim">{c.contact.name || c.contact.email}</span><Icon name="chevronRight" size={15} />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2><Icon name="building" size={16} /> Companies to choose from ({listed.length})</h2>
            <p className="pg-sub">Yes writes the first email for you to check. No teaches Thuso what to leave out. {data.research.researched ? `Looked at ${data.research.researched} today, ${data.research.kept} scored ${min} or more.` : ''} {data.research.blocked && !data.research.doing ? data.research.blocked : ''}</p>
          </div>
          {data.canManage && (
            <button type="button" className="btn ghost sm" disabled={Boolean(busy) || data.research.extra > 0} onClick={() => void run('find', { action: 'findNow', n: 5 })}>
              <Icon name={data.research.extra ? 'spinner' : 'scanSearch'} size={14} className={data.research.extra ? 'spin' : ''} /> {data.research.extra ? `Looking (${data.research.extra} to go)` : 'Find 5 now'}
            </button>
          )}
        </div>
        {picked.length > 0 && (
          <div className="ob-bulk">
            <b>{picked.length} ticked</b>
            <button type="button" className="btn primary sm" disabled={Boolean(busy)} onClick={() => void run('yes', { action: 'decide', ids: picked, yes: true })}>Yes to these</button>
            <NoButton reasons={data.rejectReasons} onPick={(reason) => void run('no', { action: 'decide', ids: picked, yes: false, reason })} label="No to these" />
            <button type="button" className="nu-link" onClick={() => setTicked(new Set())}>Clear</button>
          </div>
        )}
        {listed.length ? (
          <div className="ob-cards">
            {listed.map((c) => (
              <CompanyCard key={c.id} c={c} ticked={ticked.has(c.id)} tick={() => setTicked((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} open={() => open(c.id)}
                yes={() => void run(c.id, { action: 'decide', id: c.id, yes: true })} no={(reason) => void run(c.id, { action: 'decide', id: c.id, yes: false, reason })} reasons={data.rejectReasons} busy={busy === c.id} />
            ))}
          </div>
        ) : <Empty icon="building" title="Nothing to choose from yet">{data.research.on ? 'The next companies come in the morning.' : 'Switch daily research on in Settings, or press Find 5 now.'}</Empty>}
        {rest.length > 0 && (
          <div>
            <button type="button" className="nu-link" onClick={() => setMore(!more)}><Icon name="chevronRight" size={13} /> {more ? 'Hide' : 'Show'} {rest.length} more it looked at (below {min}, or not in the best {data.settings.showPerDay})</button>
            {more && <div className="ob-cards" style={{ marginTop: 12 }}>{rest.slice(0, 60).map((c) => <CompanyCard key={c.id} c={c} open={() => open(c.id)} yes={() => void run(c.id, { action: 'decide', id: c.id, yes: true })} no={(reason) => void run(c.id, { action: 'decide', id: c.id, yes: false, reason })} reasons={data.rejectReasons} busy={busy === c.id} />)}</div>}
          </div>
        )}
      </section>

      {noAddress.length > 0 && (
        <section className="pg-card">
          <div className="pg-card-h"><div><h2><Icon name="at" size={16} /> Approved, but no email address ({noAddress.length})</h2><p className="pg-sub">No address was published on their website. Add one, and Thuso writes the first email.</p></div></div>
          <div className="ob-rows">{noAddress.map((c) => <button key={c.id} type="button" className="ob-row" onClick={() => open(c.id)}><b>{c.name}</b><span>{c.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</span><span className="ob-dim">{c.contact.phone}</span><Icon name="chevronRight" size={15} /></button>)}</div>
        </section>
      )}
    </div>
  );
}

function NoButton({ reasons, onPick, label = 'No' }: { reasons: readonly string[]; onPick: (r: string) => void; label?: string }) {
  return (
    <select className="ob-no" value="" aria-label={`${label}: why`} onChange={(e) => { if (e.target.value) onPick(e.target.value); }}>
      <option value="">{label}</option>
      {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
    </select>
  );
}

const place = (c: CompanyRow) => [c.city, c.province].filter(Boolean).join(', ');

function CompanyCard({ c, ticked, tick, open, yes, no, reasons, busy }: { c: CompanyRow; ticked?: boolean; tick?: () => void; open: () => void; yes: () => void; no: (r: string) => void; reasons: readonly string[]; busy: boolean }) {
  return (
    <article className={`ob-card${ticked ? ' on' : ''}`}>
      <header>
        {tick && <input type="checkbox" checked={Boolean(ticked)} onChange={tick} aria-label={`Tick ${c.name}`} />}
        <button type="button" className="ob-name" onClick={open}>{c.name}</button>
        <span className={`ob-score${c.score >= 8 ? ' hi' : c.score >= 6 ? ' mid' : ''}`} title={c.scoreWhy}>{c.score}<small>/10</small></span>
      </header>
      <p className="ob-meta">{[c.sector, place(c), peopleOf(c.size)].filter(Boolean).join(' · ')}</p>
      {c.what && <p className="ob-what">{c.what}</p>}
      {c.fit[0] && <p className="ob-fit"><Icon name="check" size={13} /> {c.fit[0]}</p>}
      {c.facts[0] && <p className="ob-fact">{c.facts[0].text} <a href={c.facts[0].url} target="_blank" rel="noopener noreferrer nofollow" title={c.facts[0].url}><Icon name="external" size={12} /></a></p>}
      {c.concerns && <p className="ob-con"><Icon name="warn" size={12} /> {c.concerns}</p>}
      <div className="ob-tags">
        {c.service && <Chip tone="brand" title={c.service}>{c.service.split(/[(;:,]/)[0].trim()}</Chip>}
        {c.like.length > 0 && <Chip title="One of your ideal companies it looks like">Like {c.like[0]}</Chip>}
        <Chip tone={c.contact.email ? 'good' : 'muted'}>{c.contact.email ? 'Has an address' : 'No address yet'}</Chip>
      </div>
      <footer>
        <button type="button" className="btn primary sm" disabled={busy} onClick={yes}>{busy ? 'Working…' : 'Yes'}</button>
        <NoButton reasons={reasons} onPick={no} />
        <button type="button" className="btn ghost sm" onClick={open}>Details</button>
      </footer>
    </article>
  );
}

/* ── Pipeline ─────────────────────────────────────────────────────────────── */

function Pipeline({ data, act, open }: { data: Overview; act: Act; open: (id: string) => void }) {
  const [over, setOver] = useState<Stage | null>(null);
  const cols = useMemo(() => PIPELINE.map((p) => ({ ...p, list: data.companies.filter((c) => c.stage === p.id && (p.id !== 'found' || onList(c, data.settings.minScore))) })), [data.companies, data.settings.minScore]);
  return (
    <div className="ob-board" role="list" aria-label="Pipeline">
      {cols.map((col) => (
        <section key={col.id} role="listitem" className={`ob-col s-${col.id}${over === col.id ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(col.id); }} onDragLeave={() => setOver(null)}
          onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('text/plain'); if (id) void act({ action: 'stage', id, stage: col.id }); }}>
          <header><b>{col.label}</b><em>{col.list.length}</em><small>{col.hint}</small></header>
          <div className="ob-col-b">
            {col.list.slice(0, 80).map((c) => (
              <button key={c.id} type="button" className="ob-mini" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', c.id)} onClick={() => open(c.id)}>
                <b>{c.name}</b>
                <span>{[c.sector, place(c)].filter(Boolean).join(' · ')}</span>
                <span className="ob-tags">
                  {c.drafts > 0 && <Chip tone="warn">To check</Chip>}
                  {c.ready > 0 && <Chip tone="brand">Going out</Chip>}
                  {c.failed && <Chip tone="bad" title={c.failed}>Failed</Chip>}
                  {c.answered && c.stage !== 'lost' && <Chip tone="good">Answered</Chip>}
                  {c.callAt && <Chip><Icon name="calendar" size={11} /> {c.callAt.replace('T', ' ')}</Chip>}
                  {c.lostReason && c.stage === 'lost' && <Chip tone="muted">{c.lostReason}</Chip>}
                  {c.owner && <Chip tone="muted">{c.owner}</Chip>}
                </span>
                {c.summary && <span className="ob-sum">{c.summary}</span>}
              </button>
            ))}
            {!col.list.length && <p className="ob-empty">None</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ── Companies ────────────────────────────────────────────────────────────── */

function Companies({ data, act, open }: { data: Overview; act: Act; open: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [stage, setStage] = useState<Stage | ''>('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [site, setSite] = useState('');
  const rows = data.companies.filter((c) => (stage ? c.stage === stage : c.stage !== 'rejected') && (!q || `${c.name} ${c.website} ${c.sector} ${c.city} ${c.province} ${c.contact.name} ${c.contact.email} ${c.owner}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <section className="pg-card">
      <div className="pg-card-h">
        <div><h2><Icon name="building" size={16} /> Companies ({rows.length})</h2><p className="pg-sub">Everyone in the pipeline. {data.looked} looked at in all; the ones Thuso left out itself are remembered, so it never looks at them twice.</p></div>
        <div className="pg-actions">
          <button type="button" className="btn ghost sm" onClick={() => setAdding(!adding)}><Icon name="plus" size={14} /> Add a company</button>
          <a className="btn ghost sm" href="/api/outbound?export=csv"><Icon name="download" size={14} /> Export</a>
        </div>
      </div>
      {adding && (
        <form className="nu-addform" onSubmit={(e) => { e.preventDefault(); void act({ action: 'add', name, website: site }).then((ok) => { if (ok) { setName(''); setSite(''); setAdding(false); } }); }}>
          <label className="field"><span>Company</span><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
          <label className="field"><span>Website</span><input value={site} onChange={(e) => setSite(e.target.value)} placeholder="company.co.za" /></label>
          <button type="submit" className="btn primary sm">Add to the list</button>
        </form>
      )}
      <div className="nu-filter">
        <input className="in nu-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, sector, place, contact…" aria-label="Search companies" />
        <select className="in ob-stage" value={stage} onChange={(e) => setStage(e.target.value as Stage | '')} aria-label="Stage">
          <option value="">Every stage</option>
          {(Object.keys(STAGE_LABEL) as Stage[]).map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
      </div>
      {rows.length ? (
        <div className="nu-table-wrap">
          <table className="nu-table">
            <thead><tr><th>Company</th><th>Score</th><th>Stage</th><th>Place</th><th>Size</th><th>Contact</th><th>Last</th></tr></thead>
            <tbody>
              {rows.slice(0, 400).map((c) => (
                <tr key={c.id} tabIndex={0} onClick={() => open(c.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(c.id); }}>
                  <td><b>{c.name}</b><small>{c.sector}</small></td>
                  <td>{c.score || <em>—</em>}</td>
                  <td><Chip tone={c.stage === 'won' || c.stage === 'qualified' || c.stage === 'call_booked' ? 'good' : c.stage === 'lost' || c.stage === 'rejected' ? 'muted' : 'brand'}>{STAGE_LABEL[c.stage]}</Chip>{(c.lostReason || c.rejectReason) && <small>{c.lostReason || c.rejectReason}</small>}</td>
                  <td>{place(c) || <em>—</em>}</td>
                  <td>{c.size || <em>—</em>}</td>
                  <td>{c.contact.name || c.contact.email || <em>—</em>}{c.contact.name && <small>{c.contact.email}</small>}</td>
                  <td>{c.lastAt ? new Date(c.lastAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }) : <em>—</em>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty icon="building" title={q || stage ? 'None match' : 'No companies yet'}>{q || stage ? 'Try another search.' : 'They appear here once you say yes to some.'}</Empty>}
    </section>
  );
}
