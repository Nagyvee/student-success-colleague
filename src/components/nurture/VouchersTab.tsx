'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Voucher, VoucherOffer } from '@/lib/nurture/types';
import Icon from '@/components/Icon';
import { ago, nurturePost, type Overview } from './api';
import { Chip, Empty, Field, Modal } from './ui';

/* Vouchers: offers the team approves once, codes the system makes per lead. */

const money = (o: Pick<VoucherOffer, 'kind' | 'value'>) => (o.kind === 'percent' ? `${o.value}% off` : `R ${o.value.toLocaleString('en-ZA')} off`);
const day = (ms: number) => new Date(ms).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const expiryText = (o: VoucherOffer) => (o.expiry.kind === 'date' ? `until ${day(o.expiry.date)}` : `${o.expiry.days} days from when it is given`);

type Draft = Partial<VoucherOffer> & { name: string };

export default function VouchersTab({ data, refresh, notify, onCampaign }: { data: Overview; refresh: () => Promise<void>; notify: (k: 'ok' | 'bad', t: string) => void; onCampaign: (id: string) => void }) {
  const [editing, setEditing] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<VoucherOffer | null>(null);
  const [code, setCode] = useState('');
  const [q, setQ] = useState('');
  const can = data.canManage;
  const offerName = (id: string) => data.offers.find((o) => o.id === id)?.name || 'Removed offer';
  const codes = useMemo(() => data.vouchers.filter((v) => !q || `${v.code} ${v.leadName}`.toLowerCase().includes(q.toLowerCase())), [data.vouchers, q]);

  async function act(body: Record<string, unknown>, ok: string) {
    const r = await nurturePost(body);
    notify(r.error ? 'bad' : 'ok', r.error || ok);
    await refresh();
    return !r.error;
  }

  return (
    <div className="nu-tab">
      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2><Icon name="receipt" size={16} /> Vouchers</h2>
            <p className="pg-sub">
              You set up each voucher once (what it is worth, what it is for, how long it lasts, whether it can be passed on) and make it active.
              The agents decide who gets one and when (Zinhle for hot leads, Thabo when cost comes up, or you with a campaign), the system makes a unique code for each
              person, and every code is tracked until it is used. A shared voucher brings the friend in as a new lead.
            </p>
          </div>
          {can && <button type="button" className="btn btn-cta" onClick={() => setEditing({ name: '', kind: 'amount', value: 500, appliesTo: 'the registration fee', expiry: { kind: 'days', days: 14 }, shareable: true, prefix: 'MEL' })}><Icon name="plus" size={14} /> New voucher</button>}
        </div>
        {can && (
          <div className="nu-redeem">
            <Icon name="stamp" size={15} />
            <span>Someone used a code?</span>
            <input className="in" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="MEL-THAN-7K3Q" />
            <button type="button" className="btn btn-outline btn-sm" disabled={!code.trim()} onClick={async () => { if (await act({ action: 'redeemVoucher', code }, `${code} is marked as used.`)) setCode(''); }}>Mark as used</button>
          </div>
        )}
      </section>

      <section className="nu-stage">
        <header className="nu-stage-h"><h3>Offers</h3><span>Only active offers are given out</span><em>{data.offers.length}</em></header>
        {data.offers.length ? (
          <div className="nu-msg-grid">
            {data.offers.map((o) => {
              const ended = o.expiry.kind === 'date' && o.expiry.date < Date.now();
              return (
                <article key={o.id} className={`nu-msg nu-offer${o.status === 'active' && !ended ? ' is-ok' : ''}`}>
                  <div className="nu-msg-top">
                    {ended ? <Chip tone="muted">Ended</Chip> : o.status === 'active' ? <Chip tone="good"><Icon name="ok" size={11} /> Active</Chip> : o.status === 'paused' ? <Chip tone="muted">Paused</Chip> : <Chip tone="warn">Draft</Chip>}
                    {o.shareable && <Chip tone="brand">Can be passed on</Chip>}
                    <Chip>{o.prefix}-…</Chip>
                  </div>
                  <b className="nu-msg-name">{o.name}</b>
                  <div className="nu-offer-value">{money(o)}<small>{o.appliesTo}</small></div>
                  <div className="nu-msg-meta"><span><Icon name="clock" size={12} /> Valid {expiryText(o)}</span>{o.maxIssued ? <span><Icon name="tag" size={12} /> At most {o.maxIssued} codes</span> : null}</div>
                  <div className="nu-msg-stats"><span><b>{o.stats.issued}</b> given</span><span><b>{o.stats.redeemed}</b> used</span><span><b>{o.stats.shared}</b> passed on</span></div>
                  <div className="nu-acts">
                    <button type="button" className="btn btn-sm btn-outline" onClick={() => setPreview(o)}><Icon name="eye" size={13} /> Email</button>
                    {can && <button type="button" className="btn btn-sm btn-outline" onClick={() => setEditing({ ...o })}><Icon name="edit" size={13} /> Edit</button>}
                    {can && o.status !== 'active' && !ended && <button type="button" className="btn btn-sm btn-cta" onClick={() => act({ action: 'setOfferStatus', id: o.id, status: 'active' }, `"${o.name}" is active: the agents can give it out.`)}><Icon name="stamp" size={13} /> Make active</button>}
                    {can && o.status === 'active' && !ended && <button type="button" className="btn btn-sm btn-primary" onClick={() => onCampaign(`vou_${o.id}`)}><Icon name="send" size={13} /> Send to a group</button>}
                    {can && o.status === 'active' && <button type="button" className="btn btn-sm btn-ghost" onClick={() => act({ action: 'setOfferStatus', id: o.id, status: 'paused' }, `"${o.name}" is paused.`)}>Pause</button>}
                    {can && o.stats.issued === 0 && <button type="button" className="btn btn-sm btn-ghost" title="Delete" onClick={() => { if (confirm(`Delete "${o.name}"?`)) void act({ action: 'deleteOffer', id: o.id }, 'Deleted.'); }}><Icon name="trash" size={13} /></button>}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <Empty icon="receipt" title="No vouchers yet">Create one: a thank-you for taking the quiz, a Black Friday offer, a referral reward.</Empty>}
      </section>

      <section className="nu-stage">
        <header className="nu-stage-h"><h3>Codes given out</h3><span>Newest first</span><em>{data.vouchers.length}</em></header>
        {data.vouchers.length ? (
          <>
            <input className="in nu-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a code or a name…" />
            <div className="nu-table-wrap">
              <table className="nu-table">
                <thead><tr><th>Code</th><th>Given to</th><th>Voucher</th><th>Given</th><th>Valid until</th><th>Passed on</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {codes.map((v: Voucher) => {
                    const expired = v.status === 'issued' && v.expiresAt < Date.now();
                    return (
                      <tr key={v.code} style={{ cursor: 'default' }}>
                        <td><b style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '.05em' }}>{v.code}</b></td>
                        <td>{v.leadName}</td>
                        <td>{offerName(v.offerId)}</td>
                        <td>{ago(v.issuedAt)}</td>
                        <td>{day(v.expiresAt)}</td>
                        <td>{v.referred.length || <em>—</em>}</td>
                        <td>{v.status === 'redeemed' ? <Chip tone="good">Used {v.redeemedAt ? ago(v.redeemedAt) : ''}</Chip> : v.status === 'cancelled' ? <Chip tone="muted">Cancelled</Chip> : expired ? <Chip tone="muted">Expired</Chip> : <Chip tone="brand">Valid</Chip>}</td>
                        <td>{can && v.status === 'issued' && !expired && (
                          <span className="nu-acts" style={{ padding: 0, flexWrap: 'nowrap' }}>
                            <button type="button" className="btn btn-sm btn-outline" onClick={() => act({ action: 'redeemVoucher', code: v.code }, `${v.code} is marked as used.`)}>Used</button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => { if (confirm(`Cancel ${v.code}?`)) void act({ action: 'cancelVoucher', code: v.code }, 'Cancelled.'); }}>Cancel</button>
                          </span>
                        )}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : <Empty icon="tag" title="No codes given out yet">Codes appear here as the agents and campaigns give vouchers to leads.</Empty>}
      </section>

      {editing && <OfferEditor draft={editing} onClose={() => setEditing(null)} onSaved={async (o) => { setEditing(null); await refresh(); notify('ok', o.status === 'active' ? `Saved "${o.name}".` : `Saved "${o.name}" as a draft. Make it active when you are happy with it.`); }} notify={notify} />}
      {preview && <OfferPreview offer={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function OfferEditor({ draft, onClose, onSaved, notify }: { draft: Draft; onClose: () => void; onSaved: (o: VoucherOffer) => void; notify: (k: 'ok' | 'bad', t: string) => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const exp = d.expiry || { kind: 'days' as const, days: 14 };
  async function save() {
    setBusy(true);
    const r = await nurturePost<{ offer: VoucherOffer }>({ action: 'saveOffer', offer: d });
    setBusy(false);
    if (r.error || !r.offer) { notify('bad', r.error || 'Could not save.'); return; }
    onSaved(r.offer);
  }
  return (
    <Modal wide title={d.id ? `Edit "${d.name}"` : 'New voucher'} sub="Changing what it is worth, how long it lasts or its email sends it back to draft: a person approves what is given away." onClose={onClose}
      foot={<><button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button><button type="button" className="btn btn-cta" onClick={save} disabled={busy || !d.name.trim()}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="nu-form">
        <Field label="Name (the team sees it)"><input className="in" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Quiz thank-you, Black Friday…" /></Field>
        <Field label="Code starts with" hint="Codes look like MEL-THAN-7K3Q."><input className="in" value={d.prefix || ''} onChange={(e) => set({ prefix: e.target.value.toUpperCase() })} maxLength={6} /></Field>
        <Field label="Worth">
          <div className="nu-sheet">
            <select className="in" value={d.kind} onChange={(e) => set({ kind: e.target.value as VoucherOffer['kind'] })} style={{ maxWidth: 140 }}>
              <option value="amount">Rand off</option>
              <option value="percent">% off</option>
            </select>
            <input className="in" type="number" min={1} value={d.value ?? ''} onChange={(e) => set({ value: Number(e.target.value) })} />
          </div>
        </Field>
        <Field label="Off what"><input className="in" value={d.appliesTo || ''} onChange={(e) => set({ appliesTo: e.target.value })} placeholder="the registration fee" /></Field>
        <Field label="Valid">
          <div className="nu-sheet">
            <select className="in" value={exp.kind} onChange={(e) => set({ expiry: e.target.value === 'date' ? { kind: 'date', date: Date.now() + 14 * 86_400_000 } : { kind: 'days', days: 14 } })} style={{ maxWidth: 210 }}>
              <option value="days">For a number of days</option>
              <option value="date">Until a date (a promotion)</option>
            </select>
            {exp.kind === 'days'
              ? <input className="in" type="number" min={1} max={365} value={exp.days} onChange={(e) => set({ expiry: { kind: 'days', days: Number(e.target.value) } })} />
              : <input className="in" type="date" value={new Date(exp.date).toISOString().slice(0, 10)} onChange={(e) => set({ expiry: { kind: 'date', date: new Date(`${e.target.value}T23:59:00`).getTime() } })} />}
          </div>
        </Field>
        <Field label="At most this many codes (optional)"><input className="in" type="number" min={1} value={d.maxIssued ?? ''} onChange={(e) => set({ maxIssued: e.target.value ? Number(e.target.value) : null })} placeholder="No limit" /></Field>
        <label className="nu-check is-full"><input type="checkbox" checked={d.shareable !== false} onChange={(e) => set({ shareable: e.target.checked })} /> They can pass it on to a friend (the friend becomes a new lead)</label>
        <Field label="Email subject" full><input className="in" value={d.subject ?? ''} onChange={(e) => set({ subject: e.target.value })} placeholder="{{first_name}}, a voucher for you: {{voucher_value}} {{voucher_for}}" /></Field>
        <Field label="Email" full hint="{{first_name}}, {{voucher_value}}, {{voucher_for}}, {{voucher_expires}} are filled in; the code appears in a card under the message, with a pass-it-on link.">
          <textarea className="in nu-body" rows={8} value={d.body ?? ''} onChange={(e) => set({ body: e.target.value })} placeholder="Leave empty for the standard voucher email." />
        </Field>
      </div>
    </Modal>
  );
}

function OfferPreview({ offer, onClose }: { offer: VoucherOffer; onClose: () => void }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/nurture?preview=${encodeURIComponent(`vou_${offer.id}`)}`, { cache: 'no-store' })
      .then((r) => r.json()).then((j) => { if (live) setHtml(j.html || ''); }).catch(() => { if (live) setHtml(''); });
    return () => { live = false; };
  }, [offer.id]);
  return (
    <Modal wide title={`${offer.name}: the email`} sub="As a sample lead (Thandi) gets it, with a sample code." onClose={onClose} foot={<button type="button" className="btn btn-cta" onClick={onClose}>Done</button>}>
      {html === null ? <div className="nu-loading"><Icon name="spinner" size={15} className="spin" /> Rendering…</div> : <iframe className="nu-prev-frame" title="Voucher email" srcDoc={html} sandbox="allow-popups allow-popups-to-escape-sandbox" />}
    </Modal>
  );
}
