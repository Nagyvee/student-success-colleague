'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Icon, { type IconName } from '@/components/Icon';
import { STAGE_INFO, ago, nurturePost, pct, useNurture, type NurtureAgent, type Overview } from './api';
import { Chip, Empty, Field, Notice } from './ui';
import MessagesTab from './MessagesTab';
import BankTab from './BankTab';
import { CampaignsTab, LeadsTab } from './LeadsTab';
import VouchersTab from './VouchersTab';
import './nurture.css';

/* Lead Nurturing: the Admissions floor's marketing desk.
 *
 * Leads from Facebook and TikTok land in the leads sheet, come in here, and
 * Naledi walks each one through a journey of saved messages: a welcome with
 * the career-fit quiz, their personal programme video, proof, an invitation
 * to apply. The library is written and approved once; AI writes for one
 * person only when Zinhle sees a hot lead. */

type Tab = 'journey' | 'messages' | 'bank' | 'leads' | 'campaigns' | 'vouchers' | 'quiz';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'journey', label: 'Journey', icon: 'flow' },
  { id: 'messages', label: 'Messages', icon: 'mail' },
  { id: 'bank', label: 'Content bank', icon: 'layers' },
  { id: 'leads', label: 'Leads', icon: 'users' },
  { id: 'campaigns', label: 'Campaigns', icon: 'send' },
  { id: 'vouchers', label: 'Vouchers', icon: 'receipt' },
  { id: 'quiz', label: 'Quiz & videos', icon: 'video' },
];

export default function NurtureClient() {
  const { data, error, refresh } = useNurture();
  const [tab, setTab] = useState<Tab>('journey');
  // ?tab=leads&q=… (from the Leads drawer in the office) opens that tab with the search filled in.
  const [initialQ, setInitialQ] = useState('');
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get('tab');
    if (t) setTab(t as Tab);
    setInitialQ(p.get('q') || '');
  }, []);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const [campaignFor, setCampaignFor] = useState<string | null>(null);
  const notify = useCallback((kind: 'ok' | 'bad', text: string) => setNotice({ kind, text }), []);
  const clear = useCallback(() => setNotice(null), []);

  if (error && !data) return <main className="pg-main"><div className="pg-banner bad"><Icon name="warn" size={15} /> {error}</div></main>;
  if (!data) return <main className="pg-main"><div className="nu-loading"><Icon name="spinner" size={16} className="spin" /> Loading lead nurturing…</div></main>;

  const drafts = data.messages.filter((m) => m.status === 'draft').length;
  return (
    <main className="pg-main nu">
      <div className="nu-status">
        {data.sendingPaused
          ? <Chip tone="warn"><Icon name="pause" size={12} /> Sending paused (test phase): messages stay in the Inbox</Chip>
          : data.liveOutreach ? <Chip tone="good"><Icon name="send" size={12} /> Live: messages are sent</Chip> : <Chip tone="warn">Safe Test Mode: messages stay in the Inbox</Chip>}
        <Chip tone={data.autopilot ? 'good' : 'muted'}><Icon name="zap" size={12} /> Autopilot {data.autopilot ? 'on: journeys start by themselves' : 'off: journeys start only when you press Run'}</Chip>
        {data.leadsSource?.provider === 'dialer'
          ? <Chip tone={data.leadsSource.lastError ? 'warn' : 'good'}><Icon name="phoneCall" size={12} /> Leads from the dialer · {data.funnel.total} in nurturing</Chip>
          : data.leadsSource?.url ? <Chip tone="good"><Icon name="sheet" size={12} /> Leads sheet connected · {data.leadsSource.rows ?? 0} rows</Chip> : <Chip tone="warn"><Icon name="sheet" size={12} /> Leads sheet not connected</Chip>}
      </div>
      {(data.problems || []).map((p) => (
        <p key={p.what} className={`pg-banner ${p.critical ? 'bad' : 'warn'}`} role="alert">
          <Icon name="warn" size={15} />
          <span><b>{p.critical ? 'Critical: ' : ''}{p.what}</b> since {new Date(p.since).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Why: {p.why}{/[.!?]$/.test(p.why) ? '' : '.'} {p.fix}</span>
        </p>
      ))}
      <Notice n={notice} onClose={clear} />

      <Kpis data={data} />

      <nav className="nu-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={14} /> {t.label}
            {t.id === 'messages' && drafts > 0 && <em>{drafts}</em>}
            {t.id === 'leads' && data.funnel.hot > 0 && <em className="t-hot">{data.funnel.hot}</em>}
            {t.id === 'vouchers' && data.offers.some((o) => o.status === 'draft') && <em>{data.offers.filter((o) => o.status === 'draft').length}</em>}
          </button>
        ))}
      </nav>

      {tab === 'journey' && <JourneyTab data={data} refresh={refresh} notify={notify} go={setTab} />}
      {tab === 'messages' && <MessagesTab data={data} refresh={refresh} notify={notify} onCampaign={(id) => { setCampaignFor(id); setTab('campaigns'); }} />}
      {tab === 'bank' && <BankTab data={data} refresh={refresh} notify={notify} />}
      {tab === 'leads' && <LeadsTab data={data} refresh={refresh} notify={notify} initialQ={initialQ} />}
      {tab === 'campaigns' && <CampaignsTab data={data} refresh={refresh} notify={notify} preselect={campaignFor} />}
      {tab === 'vouchers' && <VouchersTab data={data} refresh={refresh} notify={notify} onCampaign={(id) => { setCampaignFor(id); setTab('campaigns'); }} />}
      {tab === 'quiz' && <QuizVideoTab data={data} refresh={refresh} notify={notify} />}
    </main>
  );
}

/* ── The numbers on top ───────────────────────────────────────────────────── */

function Kpis({ data }: { data: Overview }) {
  const f = data.funnel;
  const s = data.stats;
  const sends = s.librarySends + s.aiSends;
  const free = pct(s.librarySends, sends);
  // The same stages and numbers as the Leads tab and the office's Leads drawer (each lead in one stage).
  const steps: { label: string; n: number; tone?: string }[] = [
    { label: 'Leads', n: f.total }, { label: 'Got a message', n: f.contacted }, { label: 'Warming up', n: f.warm, tone: 'warm' },
    { label: 'Hot', n: f.hot, tone: 'hot' }, { label: 'Qualified', n: f.qualified ?? 0, tone: 'good' }, { label: 'Applied', n: f.applied + f.enrolled, tone: 'good' },
  ];
  const did = data.did || { opened: s.opens, clicked: s.clicks, quiz: s.quizzes, video: s.videoViews, replied: 0 };
  const max = Math.max(1, f.total);
  return (
    <section className="nu-kpi-row">
      <div className="nu-kpi nu-funnel">
        <h3><Icon name="target" size={14} /> The funnel</h3>
        <div className="nu-funnel-steps">
          {steps.map((x) => (
            <div key={x.label} className={`nu-fstep${x.tone ? ` t-${x.tone}` : ''}`}>
              <b>{x.n}</b>
              <i><em style={{ height: `${Math.max(4, (x.n / max) * 100)}%` }} /></i>
              <span>{x.label}</span>
            </div>
          ))}
        </div>
        <p className="nu-kpi-foot">{f.cold} not opened anything yet · {f.optedOut} unsubscribed</p>
      </div>
      <div className="nu-kpi nu-cost">
        <h3><Icon name="coins" size={14} /> What AI costs here</h3>
        <div className="nu-cost-big">{sends ? <><b>{free}%</b><span>of messages to leads cost no AI</span></> : <b className="is-none">No messages to leads yet</b>}</div>
        <div className="nu-cost-bar" aria-hidden="true"><i style={{ width: `${sends ? free : 0}%` }} /></div>
        <ul>
          <li><span className="dot d-free" /> <b>{s.librarySends}</b> saved messages sent (no AI)</li>
          <li><span className="dot d-ai" /> <b>{s.aiSends}</b> written by AI for one person (hot leads, replies)</li>
          {s.aiLines > 0 && <li><span className="dot d-ai" /> <b>{s.aiLines}</b> saved messages with one AI line about what they wrote</li>}
          <li><span className="dot d-once" /> <b>{s.aiBuilds}</b> AI jobs done once (library, bank, quiz, videos)</li>
        </ul>
      </div>
      <div className="nu-kpi nu-eng">
        <h3><Icon name="activity" size={14} /> What leads did</h3>
        <div className="nu-eng-grid">
          <div><b>{did.opened}</b><span>opened an email</span></div>
          <div><b>{did.clicked}</b><span>clicked a link</span></div>
          <div><b>{did.quiz}</b><span>took the quiz</span></div>
          <div><b>{did.replied}</b><span>replied</span></div>
        </div>
        <p className="nu-kpi-foot">People, each counted once{did.video ? ` · ${did.video} watched their video` : ''}</p>
      </div>
    </section>
  );
}

/* ── Journey ──────────────────────────────────────────────────────────────── */

const STEP_ICON: Record<string, IconName> = {
  send_library: 'mail', ai_message: 'brain', ai_video: 'video', ai_task: 'cpu', condition: 'flow', wait: 'clock', repeat: 'refresh',
  update_record: 'database', notify_team: 'bell', ai_call: 'phoneCall', stop: 'circle', webhook: 'webhook', ai_lesson: 'graduation',
};

function JourneyTab({ data, refresh, notify, go }: { data: Overview; refresh: () => Promise<void>; notify: (k: 'ok' | 'bad', t: string) => void; go: (t: Tab) => void }) {
  const [url, setUrl] = useState(data.leadsSource?.url || '');
  const [busy, setBusy] = useState(false);
  const order = ['ag_naledi', 'ag_zinhle', 'ag_thabo', 'ag_ayanda'];
  const agents = [...data.agents].sort((a, b) => (order.indexOf(a.id) + 99) % 99 - (order.indexOf(b.id) + 99) % 99);

  async function saveSheet() {
    setBusy(true);
    const r = await nurturePost<{ rows: number }>({ action: 'saveLeadsSheet', url });
    setBusy(false);
    notify(r.error ? 'bad' : 'ok', r.error || (url.trim() ? `Connected. ${r.rows} lead${r.rows === 1 ? '' : 's'} imported without being messaged; every new row from now on starts Naledi's journey. To welcome the ones already there, send a campaign to "Leads we have never messaged".` : 'Disconnected.'));
    await refresh();
  }

  return (
    <div className="nu-tab">
      <SampleCard data={data} notify={notify} />
      <RepliesCard data={data} refresh={refresh} notify={notify} />

      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2><Icon name="sheet" size={16} /> Where leads come from</h2>
            <p className="pg-sub">
              Facebook and TikTok lead forms → your Google Sheet → here. Paste the sheet&apos;s link (shared as &ldquo;Anyone with the link: Viewer&rdquo;).
              It is read every half minute; each new row is a new lead and Naledi welcomes them within minutes. Leads can also come straight from Zapier, Make or a website form (Channels &amp; API → Leads webhook).
            </p>
          </div>
        </div>
        {data.canManage ? (
          <div className="nu-sheet">
            <input className="in" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
            <button type="button" className="btn btn-cta" onClick={saveSheet} disabled={busy || url.trim() === (data.leadsSource?.url || '')}>{busy ? 'Reading…' : data.leadsSource?.url ? 'Save' : 'Connect'}</button>
          </div>
        ) : <p className="nu-hint">Only an owner or admin can connect the sheet.</p>}
        {data.leadsSource?.url && (
          <div className="nu-sheet-meta">
            <span><Icon name="database" size={12} /> {data.leadsSource.rows ?? 0} rows</span>
            {data.leadsSource.lastReadAt && <span><Icon name="refresh" size={12} /> read {ago(data.leadsSource.lastReadAt)}</span>}
            {data.leadsSource.columns.length > 0 && <span><Icon name="list" size={12} /> {data.leadsSource.columns.slice(0, 6).join(', ')}{data.leadsSource.columns.length > 6 ? '…' : ''}</span>}
            {data.leadsSource.lastError && <span className="t-bad"><Icon name="warn" size={12} /> {data.leadsSource.lastError}</span>}
          </div>
        )}
      </section>

      <section className="nu-tiers">
        <div className="nu-tier">
          <span className="nu-tier-n">1</span>
          <b>Everyone: saved messages</b>
          <p>Welcome, their video, proof, the invitation to apply. Written and approved once, merged per lead. <em>No AI.</em></p>
        </div>
        <div className="nu-tier">
          <span className="nu-tier-n">2</span>
          <b>Made once, personal for each</b>
          <p>The career-fit quiz and one video per programme greet each lead by name and mention what they looked at. <em>AI once, not per lead.</em></p>
        </div>
        <div className="nu-tier is-hot">
          <span className="nu-tier-n">3</span>
          <b>Hot leads and replies: AI sells</b>
          <p>A lead who turns hot gets a video made for them and a personal note from Zinhle, and a consultant is asked to call. Every reply gets an answer from Thabo that moves them towards applying. <em>AI where it wins the sale.</em></p>
        </div>
      </section>

      <section className="nu-agents">
        {agents.map((a) => <AgentJourney key={a.id} a={a} />)}
      </section>
      {!data.autopilot && <div className="pg-banner warn"><Icon name="zap" size={15} /> Autopilot is off, so journeys do not start by themselves yet. Turn it on in Agents &amp; Workflows when you are ready (sending stays paused on this server during the test phase).</div>}
      <p className="nu-hint">Each journey is an ordinary agent workflow: open it in the builder to change the steps, the waits or the conditions. <button type="button" className="nu-link" onClick={() => go('messages')}>The messages it sends are in the library →</button></p>
    </div>
  );
}

/* ── See it as a lead ─────────────────────────────────────────────────────── */

function SampleCard({ data, notify }: { data: Overview; notify: (k: 'ok' | 'bad', t: string) => void }) {
  const [programme, setProgramme] = useState(data.programmes[0] || '');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ mails: { id: string; subject: string }[]; quizUrl: string; videoUrl: string; voucherUrl?: string | null; personal: boolean } | null>(null);
  async function go() {
    setBusy(true);
    const r = await nurturePost<{ mails: { id: string; subject: string }[]; quizUrl: string; videoUrl: string; voucherUrl?: string | null; personal: boolean }>({ action: 'sampleJourney', programme });
    setBusy(false);
    if (r.error || !r.mails) { notify('bad', r.error || 'Could not build the sample.'); return; }
    setRes(r);
    notify('ok', `${r.mails.length} sample emails are in the Inbox on the Live Office, in the order a lead gets them.`);
  }
  return (
    <section className="pg-card nu-sample">
      <div className="pg-card-h">
        <div>
          <h2><Icon name="eye" size={16} /> See it as a lead</h2>
          <p className="pg-sub">
            You become a sample lead interested in a programme. Every email the journey sends lands in the Inbox, in order: the welcome with the career-fit quiz,
            their programme video, proof, the invitation to apply, and what a hot lead gets (a video made for them, a personal note and a voucher).
            After these, they keep hearing from us (weekly, then every three weeks) with something new each time, until they apply.
            The buttons work. Nothing goes to a real lead and nothing is counted.
          </p>
        </div>
      </div>
      <div className="nu-sample-row">
        <select className="in" value={programme} onChange={(e) => setProgramme(e.target.value)}>
          {data.programmes.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button type="button" className="btn btn-cta" onClick={go} disabled={busy}><Icon name="play" size={14} /> {busy ? 'Building it… (about a minute)' : 'Show me the journey'}</button>
      </div>
      {res && (
        <div className="nu-sample-out">
          <ol>{res.mails.map((m) => <li key={m.id}>{m.subject.replace(/^\[Sample [^\]]*\]\s*/, '')}<small>{(m.subject.match(/^\[Sample [^·]*· ([^\]]*)\]/) || [])[1] || ''}</small></li>)}</ol>
          <div className="nu-acts">
            <Link className="btn btn-sm btn-outline" href="/"><Icon name="inbox" size={12} /> Open the Inbox</Link>
            <a className="btn btn-sm btn-outline" href={res.quizUrl} target="_blank" rel="noreferrer"><Icon name="target" size={12} /> Take the quiz</a>
            <a className="btn btn-sm btn-outline" href={res.videoUrl} target="_blank" rel="noreferrer"><Icon name="video" size={12} /> Watch {res.personal ? 'the video made for you' : 'the programme video'}</a>
            {res.voucherUrl && <a className="btn btn-sm btn-outline" href={res.voucherUrl} target="_blank" rel="noreferrer"><Icon name="receipt" size={12} /> The voucher a friend sees</a>}
          </div>
        </div>
      )}
    </section>
  );
}

/* ── Replies (the mailbox) ────────────────────────────────────────────────── */

function RepliesCard({ data, refresh, notify }: { data: Overview; refresh: () => Promise<void>; notify: (k: 'ok' | 'bad', t: string) => void }) {
  const r = data.replies;
  const [busy, setBusy] = useState(false);
  async function act(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    const res = await nurturePost<{ handled?: number }>(body);
    setBusy(false);
    notify(res.error ? 'bad' : 'ok', res.error || ok.replace('{n}', String(res.handled ?? 0)));
    await refresh();
  }
  return (
    <section className="pg-card">
      <div className="pg-card-h">
        <div>
          <h2><Icon name="mail" size={16} /> Replies: the agents read and answer</h2>
          <p className="pg-sub">
            Sending uses SMTP, which cannot read mail, so the same mailbox is read over IMAP once a minute (Gmail: the same app password; IMAP must be on in Gmail settings).
            A reply from a lead goes to Thabo, who answers in the same email thread and moves them towards applying. Strangers, auto-replies and newsletters are ignored,
            old mail is never answered, nothing is marked as read, and after {4} AI answers in a day a person takes over.
          </p>
        </div>
        {data.canManage && r.configured && (
          <div className="pg-actions">
            {r.enabled && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => act({ action: 'checkReplies' }, 'Checked: {n} new replies.')}><Icon name="refresh" size={13} /> Check now</button>}
            <button type="button" className={`btn btn-sm ${r.enabled ? 'btn-ghost' : 'btn-cta'}`} disabled={busy} onClick={() => act({ action: 'setWatch', on: !r.enabled }, r.enabled ? 'Stopped reading replies.' : 'Reading replies now. From this moment, replies from leads and students are answered.')}>
              {busy ? 'Connecting…' : r.enabled ? 'Stop reading replies' : 'Start reading replies'}
            </button>
          </div>
        )}
      </div>
      {!r.configured ? <p className="nu-hint">Set up the sending email first (Settings → email). The same account is read for replies.</p> : (
        <div className="nu-sheet-meta">
          <span><Icon name="at" size={12} /> {r.mailbox}</span>
          <span><Icon name={r.enabled ? 'ok' : 'pause'} size={12} /> {r.enabled ? `reading${r.lastCheck ? `, checked ${ago(r.lastCheck)}` : ''}` : 'not reading yet'}</span>
          <span><Icon name="chat" size={12} /> {r.handled} repl{r.handled === 1 ? 'y' : 'ies'} handled · {r.ignored} ignored</span>
          {r.lastError && <span className="t-bad"><Icon name="warn" size={12} /> {r.lastError}</span>}
        </div>
      )}
      {r.recent.length > 0 && (
        <ul className="nu-replies">
          {r.recent.map((x, i) => <li key={i}><b>{x.from}</b> <span>{x.subject}</span> <em>{x.action} · {ago(x.ts)}</em></li>)}
        </ul>
      )}
      {!data.autopilot && r.enabled && <p className="nu-hint"><Icon name="zap" size={12} /> Autopilot is off: replies are noted (follow-ups stop) but Thabo answers only when Autopilot is on.</p>}
    </section>
  );
}

function AgentJourney({ a }: { a: NurtureAgent }) {
  return (
    <article className="nu-agent" style={{ ['--ac' as string]: a.color || '#7c3aed' }}>
      <header>
        <span className="nu-agent-av">{a.name.charAt(0)}</span>
        <div><b>{a.name}</b><small>{a.title}</small></div>
        {a.active > 0 && <Chip tone="brand">{a.active} active</Chip>}
      </header>
      <h4>{a.job || 'No job yet'}</h4>
      <p>{a.description}</p>
      {a.steps.length > 0 && (
        <ol className="nu-steps">
          {a.steps.map((s) => (
            <li key={s.id} className={`k-${s.kind}`}>
              <span className="nu-step-ic"><Icon name={STEP_ICON[s.kind] || 'circle'} size={12} /></span>
              {s.title}
              {s.kind === 'send_library' && <Chip tone="muted">{STAGE_INFO[s.stage || 'learn']?.label || 'saved'} · no AI</Chip>}
              {s.kind === 'ai_message' && <Chip tone="hot">AI writes</Chip>}
              {s.kind === 'ai_video' && <Chip tone="hot">Video for them</Chip>}
            </li>
          ))}
        </ol>
      )}
      {a.workflowId && <Link className="btn btn-sm btn-outline" href={`/workflows/${a.workflowId}`}><Icon name="edit" size={12} /> Open in the builder</Link>}
    </article>
  );
}

/* ── Quiz & videos ────────────────────────────────────────────────────────── */

function QuizVideoTab({ data, refresh, notify }: { data: Overview; refresh: () => Promise<void>; notify: (k: 'ok' | 'bad', t: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const fit = data.fit;
  const programmes = [...data.programmes, 'general'];

  async function act(key: string, body: Record<string, unknown>, ok: string) {
    setBusy(key);
    const r = await nurturePost(body);
    setBusy(null);
    notify(r.error ? 'bad' : 'ok', r.error || ok);
    await refresh();
  }
  async function preview(kind: 'quiz' | 'video', programme?: string) {
    const w = window.open('about:blank', '_blank');
    const r = await nurturePost<{ url: string }>({ action: 'previewLink', kind, programme });
    if (r.error || !r.url) { w?.close(); notify('bad', r.error || 'Could not open a preview.'); return; }
    if (w) w.location.href = r.url; else window.location.href = r.url;
  }

  return (
    <div className="nu-tab">
      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2><Icon name="target" size={16} /> The career-fit quiz</h2>
            <p className="pg-sub">
              &ldquo;Which tech path fits you?&rdquo; Six light questions about what they enjoy, no wrong answers. Every lead gets the same quiz through their own link,
              so it costs nothing per lead. Their result (and the programme it points to) is saved on their record, and the messages and video that follow are about that programme.
            </p>
          </div>
          <div className="pg-actions">
            <button type="button" className="btn btn-outline" onClick={() => preview('quiz')}><Icon name="eye" size={14} /> Try it as a lead</button>
            {data.canManage && <button type="button" className="btn btn-outline" onClick={() => act('fit', { action: 'buildFitQuiz' }, 'The quiz was rewritten for your programmes.')} disabled={busy === 'fit'}><Icon name="zap" size={14} /> {busy === 'fit' ? 'Writing…' : fit?.viaAi ? 'Rewrite with AI' : 'Write it with AI'}</button>}
          </div>
        </div>
        {fit ? (
          <>
            <div className="nu-tracks">
              {fit.tracks.map((t) => (
                <div key={t.id} className="nu-track">
                  <b>{t.name}</b>
                  <span>{t.programme}</span>
                  <p>{t.tagline}</p>
                </div>
              ))}
            </div>
            <p className="nu-hint">{fit.questions.length} questions · {fit.viaAi ? 'written by AI for your programmes' : 'from the built-in template (press "Write it with AI" to tailor it)'} · {data.funnel.quiz} lead{data.funnel.quiz === 1 ? '' : 's'} took it</p>
          </>
        ) : <Empty icon="target" title="Add your programmes first">Settings → academy focus: e.g. &ldquo;Software Development, Data Science, Cybersecurity&rdquo;. The quiz gives each one a track.</Empty>}
      </section>

      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2><Icon name="video" size={16} /> Programme videos</h2>
            <p className="pg-sub">
              One animated video per programme, made once. When a lead opens theirs, it starts with a scene made for them alone:
              &ldquo;Hey Thandi, I noticed you&apos;re interested in Data Science and your quiz said you&apos;re a Detective, so I made this for you.&rdquo;
              The personal part needs no AI, and the narration for the shared scenes is recorded once.
            </p>
          </div>
          {data.canManage && (
            <div className="pg-actions">
              <button type="button" className="btn btn-cta" onClick={() => act('all', { action: 'buildMissingVideos' }, 'Videos made.')} disabled={busy === 'all' || programmes.every((p) => data.videos.some((v) => v.programme.toLowerCase() === p.toLowerCase()))}>
                <Icon name="zap" size={14} /> {busy === 'all' ? 'Making them… (about 30 s each)' : 'Make the missing ones'}
              </button>
            </div>
          )}
        </div>
        <div className="nu-videos">
          {programmes.map((p) => {
            const v = data.videos.find((x) => x.programme.toLowerCase() === p.toLowerCase());
            return (
              <div key={p} className={`nu-video${v ? '' : ' is-missing'}`}>
                <div className="nu-video-thumb"><span><Icon name="play" size={18} /></span><b>{p === 'general' ? 'Why tech, why us' : p}</b></div>
                <div className="nu-video-meta">
                  {v ? <><span>{v.scenes} scenes · {v.views} view{v.views === 1 ? '' : 's'}</span><span>{v.viaAi ? 'Written by AI' : 'From the template'} · {ago(v.createdAt)}</span></> : <span>Not made yet{p === 'general' ? ' (for leads with no programme)' : ''}</span>}
                </div>
                <div className="nu-acts">
                  {v && <button type="button" className="btn btn-sm btn-outline" onClick={() => preview('video', p === 'general' ? '' : p)}><Icon name="eye" size={12} /> Watch as a lead</button>}
                  {data.canManage && <button type="button" className="btn btn-sm btn-outline" onClick={() => act(`v_${p}`, { action: 'buildVideo', programme: p }, `${p === 'general' ? 'The general video' : p} is ready.`)} disabled={busy === `v_${p}`}><Icon name="zap" size={12} /> {busy === `v_${p}` ? 'Making…' : v ? 'Remake' : 'Make it'}</button>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="pg-card">
        <div className="pg-card-h">
          <div>
            <h2><Icon name="shield" size={16} /> Respect and consent</h2>
            <p className="pg-sub">
              Every marketing email has a &ldquo;Stop these emails&rdquo; link. One press unsubscribes the lead (POPIA), their journeys stop, and campaigns leave them out.
              Link checkers and mail scanners that open links are not counted as people, and the unsubscribe needs a real button press.
            </p>
          </div>
        </div>
        <Field label="Unsubscribed so far"><span className="nu-big">{data.funnel.optedOut}</span></Field>
      </section>
    </div>
  );
}
