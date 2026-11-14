'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { AgentId, Settings } from '@/lib/types';
import { AGENTS } from '@/lib/office/layout';
import Logo from '@/components/Logo';
import Icon from '@/components/Icon';
import ThemeToggle from '@/components/ThemeToggle';
import { post, useOfficeStream } from '@/hooks/useOfficeStream';

/* Settings: teach the agents, choose what starts them, see where their work
 * goes, and the demo controls. The office itself has no buttons to press. */

const ago = (t: number | null | undefined) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};

export default function SettingsPage() {
  const { state } = useOfficeStream();
  const [teach, setTeach] = useState<Record<AgentId, string> | null>(null);
  const [saved, setSaved] = useState<AgentId | null>(null);
  const [sheet, setSheet] = useState('');
  const [goal, setGoal] = useState('Check every cohort and help the three learners most at risk.');
  const [msg, setMsg] = useState<string | null>(null);
  const [pub, setPub] = useState('');
  useEffect(() => { if (state?.caps.baseUrl && !pub) setPub(state.caps.baseUrl); }, [state?.caps.baseUrl, pub]);
  async function savePublic(url: string) {
    try { await post('/api/state', { action: 'publicUrl', url }); say(`Links in emails now open at ${url}`); } catch (e) { say((e as Error).message); }
  }

  useEffect(() => { fetch('/api/agents').then((r) => r.json()).then((d) => setTeach(d.instructions)).catch(() => {}); }, []);
  useEffect(() => { if (state?.automation?.sheet.url && !sheet) setSheet(state.automation.sheet.url); }, [state?.automation?.sheet.url, sheet]);

  const s = state?.settings;
  const a = state?.automation;
  const say = (t: string) => { setMsg(t); setTimeout(() => setMsg(null), 4000); };
  async function set(patch: Partial<Settings>) { try { await post('/api/state', { action: 'settings', settings: patch }); } catch (e) { say((e as Error).message); } }
  async function saveAgent(id: AgentId) {
    if (!teach) return;
    await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [id]: teach[id] }) });
    setSaved(id); setTimeout(() => setSaved(null), 2500);
  }
  async function connectSheet(url: string | null) {
    try { await post('/api/state', { action: 'sheet', url }); say(url ? 'Sheet connected. Thuso reads it every few seconds.' : 'Sheet disconnected.'); } catch (e) { say((e as Error).message); }
  }

  const engine = state?.caps.ai.provider === 'anthropic' ? `Claude (${state.caps.ai.model})` : state?.caps.ai.provider === 'openai' ? state.caps.ai.model : 'Simulation (no AI key)';
  const email = state?.caps.email;

  return (
    <div className="pg">
      <header className="pg-top">
        <span className="pg-brand"><Logo size="sm" /><em>Settings</em></span>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <Link href="/reports" className="btn btn-outline btn-sm"><Icon name="chart" size={14} />Reports</Link>
          <Link href="/lms" className="btn btn-outline btn-sm" target="_blank"><Icon name="database" size={14} />Learner records</Link>
          <Link href="/" className="btn btn-outline btn-sm"><Icon name="arrowLeft" size={14} />Back to the office</Link>
        </span>
      </header>
      <main className="pg-main">
        {msg && <div className="pg-sent"><Icon name="ok" size={14} />{msg}</div>}

        <section className="set-sec">
          <div className="set-h"><h2>Your agents</h2><p>Teach each agent how you want it to work. These instructions go into its prompt on every task. The Reviewer&apos;s pass/fail rules stay fixed in code.</p></div>
          <div className="agent-grid">
            {AGENTS.map((ag) => (
              <div key={ag.id} className="agent-card">
                <div className="agent-top">
                  <span className="agent-av">{ag.initials}</span>
                  <span><b>{ag.name}</b><em>{ag.title === ag.role ? ag.role : `${ag.title} · ${ag.role}`}</em></span>
                </div>
                <label className="mini">Standing instructions</label>
                <textarea rows={4} value={teach?.[ag.id] ?? ''} onChange={(e) => teach && setTeach({ ...teach, [ag.id]: e.target.value })} disabled={!teach} />
                <button type="button" className="btn btn-outline btn-sm" onClick={() => saveAgent(ag.id)} disabled={!teach}>{saved === ag.id ? <><Icon name="check" size={13} />Saved</> : <><Icon name="save" size={13} />Save</>}</button>
              </div>
            ))}
          </div>
        </section>

        <section className="set-sec">
          <div className="set-h"><h2>What starts Thuso</h2><p>Nobody has to type anything. Thuso reacts to the learner record and runs on a schedule.</p></div>
          <div className="set-cards">
            <div className="set-card">
              <h3><Icon name="webhook" size={15} />LMS webhook <span className="badge badge-good">Listening</span></h3>
              <p>When a mark or a login changes, the LMS sends a signed event to <code>POST {a?.webhookPath || '/api/webhooks/lms'}</code> and Thuso starts.</p>
              <p className="dim">Events received: <b>{a?.events ?? 0}</b> · last: {a?.lastEvent ? `${a.lastEvent.learner}, ${a.lastEvent.detail} (${ago(a.lastEvent.at)})` : 'none yet'}</p>
              <Link href="/lms" target="_blank" className="btn btn-outline btn-sm"><Icon name="database" size={13} />Open learner records</Link>
            </div>
            <div className="set-card">
              <h3><Icon name="sheet" size={15} />Google Sheet {a?.sheet.connected ? <span className={`badge ${a.sheet.lastError ? 'badge-bad' : 'badge-good'}`}>{a.sheet.lastError ? 'Error' : 'Connected'}</span> : <span className="badge badge-mute">Optional</span>}</h3>
              <p>Use a Google Sheet as the learner record. Share it as &quot;Anyone with the link: Viewer&quot; and paste the link. Edit a score in the sheet and Thuso reacts within seconds.</p>
              <div className="set-inline">
                <input value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
                <button type="button" className="btn btn-cta btn-sm" onClick={() => connectSheet(sheet.trim() || null)}>Connect</button>
                {a?.sheet.connected && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSheet(''); void connectSheet(null); }}>Disconnect</button>}
              </div>
              {a?.sheet.connected && <p className="dim">{a.sheet.rows} rows · read {ago(a.sheet.lastReadAt)}{a.sheet.lastError ? ` · ${a.sheet.lastError}` : ''}</p>}
              <a className="btn btn-outline btn-sm" href="/api/sheet/template"><Icon name="download" size={13} />Download the starter sheet (CSV)</a>
            </div>
            <div className="set-card">
              <h3><Icon name="calendar" size={15} />Weekly sweep</h3>
              <p>Every Monday at 07:00 Thuso checks every cohort on its own.</p>
              <div className="set-inline">
                <label className="switch"><input type="checkbox" checked={s?.scheduleEnabled !== false} onChange={(e) => set({ scheduleEnabled: e.target.checked })} /><i /><span>{s?.scheduleEnabled !== false ? 'On' : 'Off'}</span></label>
                <button type="button" className="btn btn-outline btn-sm" onClick={async () => { await post('/api/state', { action: 'sweep' }); say('Weekly sweep queued. Watch the office.'); }}><Icon name="play" size={13} />Run the sweep now</button>
              </div>
              <p className="dim">Next run: {a?.schedule.nextAt ? new Date(a.schedule.nextAt).toLocaleString('en-ZA', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'off'}</p>
            </div>
            <div className="set-card">
              <h3><Icon name="target" size={15} />A one-off goal</h3>
              <p>A manager can still hand over a goal in their own words.</p>
              <div className="set-inline">
                <input value={goal} onChange={(e) => setGoal(e.target.value)} />
                <button type="button" className="btn btn-cta btn-sm" onClick={async () => { await post('/api/state', { action: 'goal', goal }); say('Goal handed over. Watch the office.'); }}>Give goal</button>
              </div>
            </div>
          </div>
        </section>

        <section className="set-sec">
          <div className="set-h"><h2>Where the work goes</h2></div>
          <div className="set-cards">
            <div className="set-card">
              <h3><Icon name="mail" size={15} />Email {email === 'smtp' ? <span className="badge badge-good">Sending (Nodemailer SMTP)</span> : <span className="badge badge-mute">Preview only</span>}</h3>
              <p>{email === 'simulated' ? <>Emails appear in the Inbox tab. To really send, set <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code> in <code>.env.local</code> (Gmail: smtp.gmail.com, 465, an App Password) and restart.</> : 'Study packs, quizzes and check-ins go to each learner\'s email in the learner records.'}</p>
            </div>
            <div className="set-card">
              <h3><Icon name="phoneCall" size={15} />Follow-up call {state?.caps.dialer ? <span className="badge badge-good">Dialer connected</span> : <span className="badge badge-mute">Not connected</span>}</h3>
              <p>After the email, the academy&apos;s dialer phones the learner. Its AI caller greets them by name, says what was sent, and keeps it under a minute. The dialer&apos;s own rules still apply: AI caller on, calling hours, do-not-call list.</p>
              {state?.caps.dialer ? (
                <label className="switch"><input type="checkbox" checked={s?.callFollowUp !== false} onChange={(e) => set({ callFollowUp: e.target.checked })} /><i /><span>{s?.callFollowUp !== false ? 'On: learners with a phone number get a call' : 'Off'}</span></label>
              ) : <p className="dim">Set <code>DIALER_URL</code> and <code>DIALER_API_KEY</code> (a dialer key with the &quot;Start AI calls&quot; scope) in <code>.env.local</code>.</p>}
            </div>
            <div className="set-card">
              <h3><Icon name="link" size={15} />Where links in emails open {/localhost|127\.0\.0\.1/.test(state?.caps.baseUrl || '') ? <span className="badge badge-bad">Only this laptop</span> : <span className="badge badge-good">Reachable</span>}</h3>
              <p>Lesson and quiz links must open on a learner&apos;s phone, so this must be a public address (a tunnel or your server), not localhost.</p>
              <div className="set-inline">
                <input value={pub} onChange={(e) => setPub(e.target.value)} placeholder="https://your-address" />
                <button type="button" className="btn btn-cta btn-sm" onClick={() => savePublic(pub)}>Save</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPub(window.location.origin); void savePublic(window.location.origin); }}>Use this page&apos;s address</button>
              </div>
            </div>
            <div className="set-card">
              <h3><Icon name="cpu" size={15} />AI</h3>
              <p>{engine}. Every answer is checked; if a call fails, that agent falls back to its playbook so the work still finishes.</p>
            </div>
          </div>
        </section>

        <section className="set-sec">
          <div className="set-h"><h2>Presenting</h2></div>
          <div className="set-cards">
            <div className="set-card">
              <div className="set-row2"><span>Test error</span>
                <label className="switch"><input type="checkbox" checked={s?.injectDefects ?? true} onChange={(e) => set({ injectDefects: e.target.checked })} /><i /><span>{s?.injectDefects ? 'On: one wrong question is planted in the first quiz' : 'Off'}</span></label>
              </div>
              <div className="set-row2"><span>Pace</span>
                <div className="seg"><button type="button" className={s?.speed === 'normal' ? 'on' : ''} onClick={() => set({ speed: 'normal' })}>Presentation</button><button type="button" className={s?.speed === 'fast' ? 'on' : ''} onClick={() => set({ speed: 'fast' })}>Fast</button></div>
              </div>
              <div className="set-row2"><span>Tutoring language</span>
                <div className="seg">
                  <button type="button" className={(s?.tutorLanguage ?? 'en') === 'en' ? 'on' : ''} onClick={() => set({ tutorLanguage: 'en' })}>English</button>
                  <button type="button" className={s?.tutorLanguage === 'zu' ? 'on' : ''} onClick={() => set({ tutorLanguage: 'zu' })}>isiZulu</button>
                  <button type="button" className={s?.tutorLanguage === 'st' ? 'on' : ''} onClick={() => set({ tutorLanguage: 'st' })}>Sesotho</button>
                </div>
              </div>
              <div className="set-row2"><span>Theme</span><ThemeToggle /></div>
              <div className="set-row2"><span>Start clean</span>
                <button type="button" className="btn btn-outline btn-sm" disabled={Boolean(state?.busy)} onClick={async () => { if (!confirm('Reset every run, email and learner status?')) return; await post('/api/state', { action: 'reset' }); say('Reset. Learner records are fresh.'); }}><Icon name="reset" size={13} />Reset everything</button>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
