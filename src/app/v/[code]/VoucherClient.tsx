'use client';

import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Check, Ticket } from 'lucide-react';
import '../../fit/fit.css';

/* A voucher someone passed on. The friend sees what it is worth and leaves
 * their details; they become a lead with the code, and Admissions picks them
 * up the way it picks up every new lead. */

interface View {
  code: string; state: 'valid' | 'used' | 'ended'; value: string; appliesTo: string; expires: string; shareable: boolean;
  from: string; academy: string; brand: { base: string; deep: string; accent: string }; programmes: string[]; applyUrl: string | null;
}

export default function VoucherClient({ code }: { code: string }) {
  const reduced = useReducedMotion();
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', interest: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [sample, setSample] = useState(false);

  useEffect(() => {
    fetch(`/api/nurture/public?voucher=${encodeURIComponent(code)}`, { cache: 'no-store' })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Not found'); setV(d as View); })
      .catch((e) => setErr((e as Error).message));
  }, [code]);

  async function claim(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/nurture/public', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voucher: code, ...form }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'That did not work.');
      setDone(d.first || form.name.split(' ')[0] || 'there');
      setSample(Boolean(d.sample));
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const brand = v?.brand || { base: '#0a1733', deep: '#5e0743', accent: '#ff7300' };
  const style = { ['--base' as string]: brand.base, ['--deep' as string]: brand.deep, ['--a' as string]: brand.accent };
  return (
    <div className="fit-page" style={style}>
      <header className="fit-top"><b>{v?.academy || ''}</b><span>Voucher</span></header>
      <main className="fit-main">
        {!v && !err && <div className="fit-card fit-loading"><span className="fit-spin" aria-hidden="true" />Loading…</div>}
        {!v && err && <div className="fit-card"><h1>Voucher not found</h1><p>{err}</p></div>}
        {v && (
          <motion.section className="fit-card fit-result" initial={reduced ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}>
            <span className="fit-badge"><Ticket size={40} aria-hidden="true" /></span>
            <small className="fit-kicker">{v.from} passed this on to you</small>
            <h1>{v.value}</h1>
            <p className="fit-tagline">{v.appliesTo} at {v.academy}</p>
            <div className="fit-match"><span>Your code</span><b style={{ fontFamily: 'Consolas, Menlo, monospace', letterSpacing: '.12em' }}>{v.code}</b></div>
            {v.state === 'valid' ? <p>Valid until {v.expires}.</p> : <p>{v.state === 'used' ? 'This voucher has already been used.' : 'This voucher has ended.'} You can still leave your details and we will tell you about current offers.</p>}

            {done ? (
              <div className="vc-done"><span><Check size={18} /></span><p>{sample ? `This is a sample voucher, so nobody was added. For a real one, ${done} would now be a new lead with this code, and Naledi would welcome them within minutes.` : `Thank you, ${done}. Someone from our admissions team will be in touch soon${v.state === 'valid' ? ', and your voucher is saved with your details' : ''}.`}</p></div>
            ) : (
              <form className="vc-form" onSubmit={claim}>
                <input required placeholder="Your name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
                <input type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
                <input type="tel" placeholder="Phone or WhatsApp" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" />
                {v.programmes.length > 0 && (
                  <select value={form.interest} onChange={(e) => setForm({ ...form, interest: e.target.value })}>
                    <option value="">What would you like to study?</option>
                    {v.programmes.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                )}
                {err && <p className="vc-err">{err}</p>}
                <button type="submit" className="fit-btn" disabled={busy}>{busy ? 'Saving…' : 'Claim it'} <ArrowRight size={16} /></button>
                <small>We only use your details to talk to you about studying with us. You can say stop at any time.</small>
              </form>
            )}
          </motion.section>
        )}
      </main>
    </div>
  );
}
