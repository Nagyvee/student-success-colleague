'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentRunLog, StepCondition } from '@/lib/types';
import Icon from '@/components/Icon';
import { SEGMENT_PRESETS, ago, nurturePost, pct, type LeadRow, type Overview } from './api';
import { Chip, Empty, Field, Modal } from './ui';

/* Leads: who is warm, who is hot, and everything each one received and did. */

const FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'All' }, { id: 'hot', label: 'Hot' }, { id: 'warm', label: 'Warm' }, { id: 'cold', label: 'Cold' },
  { id: 'applied', label: 'Applied' }, { id: 'opted_out', label: 'Unsubscribed' },
];

const heat = (e: LeadRow['engagement']) => (e === 'hot' ? 'hot' : e === 'warm' ? 'warm' : 'cold');

export function LeadsTab({ data, notify, refresh }: { data: Overview; notify: (k: 'ok' | 'bad', t: string) => void; refresh: () => Promise<void> }) {
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/nurture?leads=1&stage=${encodeURIComponent(filter)}&q=${encodeURIComponent(q)}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    setRows(Array.isArray(j.leads) ? j.leads : []);
  }, [filter, q]);
  useEffect(() => { const t = setTimeout(() => void load(), q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  const f = data.funnel;
  return (
    <div className="nu-tab">
      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2><Icon name="users" size={16} /> Leads</h2>
            <p className="pg-sub">
              Every open, click, quiz answer, video view and reply raises a lead&apos;s score. <b>Warm</b> means they are reading;
              <b> hot</b> means they are deciding, and Zinhle gives them personal attention and asks a consultant to call.
            </p>
          </div>
          <div className="nu-kpis">
            <span className="t-hot"><b>{f.hot}</b> hot</span>
            <span className="t-warm"><b>{f.warm}</b> warm</span>
            <span><b>{f.cold}</b> cold</span>
          </div>
        </div>
        <div className="nu-filter">
          <div className="nu-seg">
            {FILTERS.map((x) => <button key={x.id} type="button" className={filter === x.id ? 'on' : ''} onClick={() => setFilter(x.id)}>{x.label}</button>)}
          </div>
          <input className="in nu-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, programme, source…" />
        </div>
        {!rows ? <div className="nu-loading"><Icon name="spinner" size={15} className="spin" /> Loading…</div> : rows.length ? (
          <div className="nu-table-wrap">
            <table className="nu-table">
              <thead><tr><th>Lead</th><th>Programme</th><th>Source</th><th>Interest</th><th>Opened · clicked</th><th>Sent</th><th>Quiz</th><th>Status</th><th>Last activity</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} onClick={() => setOpen(r.key)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r.key); }}>
                    <td><b>{r.name}</b><small>{r.email || r.phone}</small></td>
                    <td>{r.programme || <em>—</em>}</td>
                    <td>{r.source || <em>—</em>}</td>
                    <td>{r.optedOut ? <Chip tone="muted">Unsubscribed</Chip> : <Chip tone={heat(r.engagement)}>{r.engagement} · {r.score}</Chip>}</td>
                    <td>{r.opens} · {r.clicks}</td>
                    <td>{r.sent}</td>
                    <td>{r.fit ? <span title={r.fit}>{r.fit.split('→')[0].trim()}</span> : <em>—</em>}</td>
                    <td>{r.status}</td>
                    <td>{ago(r.lastEngagedAt) || ago(r.firstSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon="inbox" title={filter || q ? 'Nobody matches' : 'No leads yet'}>{filter || q ? 'Try another filter.' : 'Connect your leads sheet on the Journey tab, or send leads to the webhook (Channels & API).'}</Empty>}
      </section>
      {open && <LeadPanel leadKey={open} onClose={() => setOpen(null)} notify={notify} onChanged={async () => { await load(); await refresh(); }} canManage={data.canManage} />}
    </div>
  );
}

interface LeadDetail {
  lead: LeadRow;
  fields: Record<string, string>;
  got: string[];
  runs: { id: string; agentName: string; workflowName: string; status: string; startedAt: number; resumeAt: number | null; logs: AgentRunLog[] }[];
}

function LeadPanel({ leadKey, onClose, notify, onChanged, canManage }: { leadKey: string; onClose: () => void; notify: (k: 'ok' | 'bad', t: string) => void; onChanged: () => Promise<void>; canManage: boolean }) {
  const [d, setD] = useState<LeadDetail | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(`/api/nurture?lead=${encodeURIComponent(leadKey)}`, { cache: 'no-store' });
    setD(r.ok ? await r.json() : null);
  }, [leadKey]);
  useEffect(() => { void load(); }, [load]);
  async function set(field: string, value: string, ok: string) {
    const r = await nurturePost({ action: 'setLeadField', key: leadKey, field, value });
    notify(r.error ? 'bad' : 'ok', r.error || ok);
    await load();
    await onChanged();
  }
  const said = d ? [d.fields.message, d.fields.notes, d.fields.question].filter(Boolean).join(' ') : '';
  return (
    <Modal wide title={d?.lead.name || 'Lead'} sub={d ? [d.lead.email, d.lead.phone].filter(Boolean).join(' · ') : undefined} onClose={onClose}
      foot={canManage && d ? <>
        {!d.lead.optedOut && <button type="button" className="btn btn-ghost" onClick={() => set('opted_out', 'yes', 'Unsubscribed: no more marketing messages, and their runs stopped.')}>Unsubscribe</button>}
        <button type="button" className="btn btn-outline" onClick={() => set('status', 'applied', `${d.lead.name.split(' ')[0]} is marked as applied: Ayanda takes over enrolment.`)}>Mark as applied</button>
        <button type="button" className="btn btn-cta" onClick={onClose}>Done</button>
      </> : undefined}>
      {!d ? <div className="nu-loading"><Icon name="spinner" size={15} className="spin" /> Loading…</div> : (
        <div className="nu-lead">
          <div className="nu-lead-top">
            <div className={`nu-heat t-${heat(d.lead.engagement)}`}><b>{d.lead.score}</b><span>{d.lead.optedOut ? 'unsubscribed' : d.lead.engagement}</span></div>
            <dl>
              <div><dt>Programme</dt><dd>{d.lead.programme || '—'}</dd></div>
              <div><dt>Came from</dt><dd>{d.lead.source || '—'}</dd></div>
              <div><dt>Quiz result</dt><dd>{d.lead.fit || 'Not taken yet'}</dd></div>
              <div><dt>Status</dt><dd>{d.lead.status}</dd></div>
              <div><dt>Opened · clicked</dt><dd>{d.lead.opens} · {d.lead.clicks}{d.lead.lastClicked ? ` (last: ${d.lead.lastClicked})` : ''}</dd></div>
              <div><dt>First seen</dt><dd>{ago(d.lead.firstSeenAt)}</dd></div>
            </dl>
          </div>
          {said && <blockquote className="nu-said"><Icon name="chat" size={13} /> “{said.slice(0, 400)}”</blockquote>}
          <div className="nu-lead-cols">
            <div>
              <h4>Messages they got ({d.got.length})</h4>
              {d.got.length ? <ol className="nu-got">{d.got.map((g, i) => <li key={i}>{g}</li>)}</ol> : <p className="nu-hint">Nothing yet.</p>}
            </div>
            <div>
              <h4>What the agents did</h4>
              {d.runs.length ? d.runs.map((r) => (
                <div key={r.id} className="nu-run">
                  <div className="nu-run-h"><b>{r.agentName}</b> <span>{r.workflowName}</span> <Chip tone={r.status === 'failed' ? 'bad' : r.status === 'completed' ? 'good' : 'brand'}>{r.status === 'waiting' && r.resumeAt ? `waiting until ${new Date(r.resumeAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}` : r.status.replace('_', ' ')}</Chip></div>
                  <ul>{r.logs.slice(-6).map((l, i) => <li key={i} className={`s-${l.status}`}><span>{l.title}</span> {l.detail}</li>)}</ul>
                </div>
              )) : <p className="nu-hint">No agent has worked on this lead yet{d.lead.sent ? ' (they got campaign messages only)' : ''}.</p>}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ── Campaigns ────────────────────────────────────────────────────────────── */

export function CampaignsTab({ data, notify, refresh, preselect }: { data: Overview; notify: (k: 'ok' | 'bad', t: string) => void; refresh: () => Promise<void>; preselect: string | null }) {
  const approved = useMemo(() => [
    ...data.messages.filter((m) => m.status === 'approved' && !m.repeatable && (!m.expiresAt || m.expiresAt > Date.now())),
    // An active voucher, as its email: each lead gets their own code.
    ...data.offers.filter((o) => o.status === 'active' && (o.expiry.kind !== 'date' || o.expiry.date > Date.now())).map((o) => ({ id: `vou_${o.id}`, name: `Voucher: ${o.name}`, stage: 'offer' })),
  ], [data.messages, data.offers]);
  const [messageId, setMessageId] = useState(preselect || approved[0]?.id || '');
  const [preset, setPreset] = useState('never');
  const [programme, setProgramme] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [count, setCount] = useState<{ count: number; skipped: Record<string, number>; sample: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (preselect) setMessageId(preselect); }, [preselect]);

  const segment = useMemo<StepCondition[]>(() => {
    const base = SEGMENT_PRESETS.find((p) => p.id === preset)?.segment || [];
    return programme ? [...base, { mode: 'rule', field: 'lead_programme', op: 'eq', value: programme }] : base;
  }, [preset, programme]);

  useEffect(() => {
    let live = true;
    void nurturePost<{ count: number; skipped: Record<string, number>; sample: string[] }>({ action: 'previewSegment', segment, messageId }).then((r) => { if (live && !r.error) setCount(r); });
    return () => { live = false; };
  }, [segment, messageId]);

  async function create() {
    setBusy(true);
    const sendAt = when === 'later' && at ? new Date(at).getTime() : undefined;
    const label = SEGMENT_PRESETS.find((p) => p.id === preset)?.label || 'Leads';
    const msg = approved.find((m) => m.id === messageId) as { name: string } | undefined;
    const r = await nurturePost({ action: 'createCampaign', messageId, segment, sendAt, name: `${msg?.name || 'Message'} → ${label}${programme ? ` · ${programme}` : ''}` });
    setBusy(false);
    notify(r.error ? 'bad' : 'ok', r.error || (sendAt ? 'Scheduled.' : 'Sending now, a few at a time. Watch the progress below.'));
    await refresh();
  }

  const skipped = count ? Object.entries(count.skipped).filter(([, n]) => n > 0) : [];
  const SKIP_LABEL: Record<string, string> = { optedOut: 'unsubscribed', alreadyHad: 'already had it', noContact: 'no email or phone', finished: 'applied or enrolled' };

  return (
    <div className="nu-tab">
      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2><Icon name="send" size={16} /> Send a saved message to a group</h2>
            <p className="pg-sub">
              For news and offers (&ldquo;50% off registration until 30 November&rdquo;) and to welcome leads who were on the sheet before it was connected.
              The approved message is merged for each lead and sent a few at a time. Nobody gets it twice, and unsubscribed leads are always left out.
            </p>
          </div>
        </div>
        {!data.canManage ? <p className="nu-hint">Only an owner or admin can send campaigns.</p> : !approved.length ? (
          <div className="pg-banner warn"><Icon name="stamp" size={15} /> Approve a message in the Messages tab first: campaigns only send approved messages.</div>
        ) : (
          <div className="nu-form">
            <Field label="Message" full>
              <select className="in" value={messageId} onChange={(e) => setMessageId(e.target.value)}>
                {approved.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.stage})</option>)}
              </select>
            </Field>
            <Field label="Who gets it">
              <select className="in" value={preset} onChange={(e) => setPreset(e.target.value)}>
                {SEGMENT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
            <Field label="Interested in">
              <select className="in" value={programme} onChange={(e) => setProgramme(e.target.value)}>
                <option value="">Any programme</option>
                {data.programmes.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="When">
              <div className="nu-seg">
                <button type="button" className={when === 'now' ? 'on' : ''} onClick={() => setWhen('now')}>Now</button>
                <button type="button" className={when === 'later' ? 'on' : ''} onClick={() => setWhen('later')}>Later</button>
              </div>
            </Field>
            {when === 'later' && <Field label="Send on"><input className="in" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>}
            <div className="nu-reach is-full">
              <div>
                <b>{count ? count.count : '…'}</b> lead{count?.count === 1 ? '' : 's'} will get it
                {count?.sample.length ? <small> · {count.sample.slice(0, 4).join(', ')}{count.count > 4 ? '…' : ''}</small> : null}
                {skipped.length > 0 && <small className="nu-skip"> Left out: {skipped.map(([k, n]) => `${n} ${SKIP_LABEL[k] || k}`).join(', ')}.</small>}
              </div>
              <button type="button" className="btn btn-cta" onClick={create} disabled={busy || !count?.count || (when === 'later' && !at)}>
                <Icon name="send" size={14} /> {busy ? 'Starting…' : when === 'later' ? 'Schedule' : `Send to ${count?.count ?? 0}`}
              </button>
            </div>
            {data.sendingPaused && <p className="nu-hint is-full"><Icon name="pause" size={12} /> Sending is paused on this server (test phase): the messages are kept in the Inbox, nobody receives them.</p>}
          </div>
        )}
      </section>

      <section className="nu-stage">
        <header className="nu-stage-h"><h3>Campaigns</h3><span>Newest first</span><em>{data.campaigns.length}</em></header>
        {data.campaigns.length ? (
          <div className="nu-camps">
            {data.campaigns.map((c) => {
              const m = data.messages.find((x) => x.id === c.messageId) || (c.messageId.startsWith('vou_') ? { stats: { sent: 0, opened: 0, clicked: 0 } } : undefined);
              const done = c.sent + c.skipped + c.failed;
              return (
                <div key={c.id} className={`nu-camp s-${c.status}`}>
                  <div className="nu-camp-h">
                    <b>{c.name}</b>
                    <Chip tone={c.status === 'done' ? 'good' : c.status === 'cancelled' ? 'muted' : 'brand'}>{c.status === 'scheduled' ? `scheduled ${new Date(c.sendAt).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : c.status}</Chip>
                  </div>
                  <div className="nu-bar"><i style={{ width: `${pct(done, c.total)}%` }} /></div>
                  <div className="nu-msg-stats">
                    <span><b>{c.sent}</b> sent</span>
                    <span><b>{c.skipped}</b> skipped</span>
                    {c.failed > 0 && <span className="t-bad"><b>{c.failed}</b> failed</span>}
                    <span><b>{c.total}</b> in the group</span>
                    {m && <span>{pct(m.stats.opened, m.stats.sent)}% opened · {pct(m.stats.clicked, m.stats.sent)}% clicked (all sends)</span>}
                    <span>by {c.createdBy} · {ago(c.createdAt)}</span>
                  </div>
                  {data.canManage && (c.status === 'scheduled' || c.status === 'sending') && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={async () => { const r = await nurturePost({ action: 'cancelCampaign', id: c.id }); notify(r.error ? 'bad' : 'ok', r.error || 'Stopped.'); await refresh(); }}>Stop</button>
                  )}
                </div>
              );
            })}
          </div>
        ) : <Empty icon="send" title="No campaigns yet">Send an approved message to a group: all warm leads, the parents, everyone interested in Data Science.</Empty>}
      </section>
    </div>
  );
}
