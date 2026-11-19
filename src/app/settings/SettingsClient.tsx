'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { AgentId, BuildingConfig, Settings } from '@/lib/types';
import { AGENTS } from '@/lib/office/layout';
import Icon from '@/components/Icon';
import ThemeToggle from '@/components/ThemeToggle';
import { post, useOfficeStream } from '@/hooks/useOfficeStream';
import '../pages.css';

const ago = (t: number | null | undefined) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};

export default function SettingsClient() {
  const { state } = useOfficeStream();
  const [teach, setTeach] = useState<Record<AgentId, string> | null>(null);
  const [saved, setSaved] = useState<AgentId | null>(null);
  const [sheet, setSheet] = useState('');
  const [goal, setGoal] = useState('Check our active learners and help anyone falling behind.');
  const [msg, setMsg] = useState<string | null>(null);
  const [pub, setPub] = useState('');

  // Building & Branding Studio state
  const [academyName, setAcademyName] = useState('Melsoft Academy');
  const [building, setBuilding] = useState<BuildingConfig>({
    facadeStyle: 'sculpted',
    logoUrl: '',
    brandColor: '#2563eb',
    activeFloorColor: '#720075',
    showBillboard: true,
    billboardText: '',
    billboardImageUrl: '',
    showTrees: true,
    showBollards: true,
    showRoofChillers: true,
    showStreetLamps: true,
  });
  const [savingBldg, setSavingBldg] = useState(false);

  useEffect(() => {
    if (state?.tenant?.name) setAcademyName(state.tenant.name);
    if (state?.tenant?.building) {
      setBuilding((prev) => ({ ...prev, ...state.tenant?.building }));
    }
  }, [state?.tenant?.name, state?.tenant?.building]);

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>, key: 'logoUrl' | 'billboardImageUrl') {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setBuilding((prev) => ({ ...prev, [key]: reader.result as string }));
      }
    };
    reader.readAsDataURL(file);
  }

  async function saveBuildingSettings() {
    setSavingBldg(true);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'saveIntegrations',
          integrations: {
            academyName: academyName.trim() || 'Melsoft Academy',
            building,
          },
        }),
      });
      if (res.ok) say('Building branding, logo & architectural elements saved.');
      else say('Could not save building settings.');
    } catch (e) {
      say((e as Error).message);
    } finally {
      setSavingBldg(false);
    }
  }
  useEffect(() => { if (state?.caps.baseUrl && !pub) setPub(state.caps.baseUrl); }, [state?.caps.baseUrl, pub]);
  async function savePublic(url: string) {
    try { await post('/api/state', { action: 'publicUrl', url }); say(`Learner quiz/lesson links now open at ${url}`); } catch (e) { say((e as Error).message); }
  }

  useEffect(() => { fetch('/api/agents').then((r) => r.json()).then((d) => setTeach(d.instructions)).catch(() => {}); }, []);
  useEffect(() => { if (state?.automation?.sheet.url && !sheet) setSheet(state.automation.sheet.url); }, [state?.automation?.sheet.url, sheet]);

  const s = state?.settings;
  const a = state?.automation;
  const say = (t: string) => { setMsg(t); setTimeout(() => setMsg(null), 4000); };
  async function set(patch: Partial<Settings>) { try { await post('/api/state', { action: 'settings', settings: patch }); } catch (e) { say((e as Error).message); } }
  const [clearing, setClearing] = useState(false);
  // Which departments autopilot runs (empty: all of them).
  const [depts, setDepts] = useState<{ id: string; name: string; color?: string }[]>([]);
  const [autoDepts, setAutoDepts] = useState<string[] | null>(null);
  useEffect(() => {
    fetch('/api/departments', { cache: 'no-store' }).then((r) => r.json()).then((j) => setDepts((j.departments || []).map((d: { id: string; name: string; color?: string }) => ({ id: d.id, name: d.name, color: d.color })))).catch(() => {});
    fetch('/api/auth', { cache: 'no-store' }).then((r) => r.json()).then((j) => setAutoDepts(j?.integrations?.autopilotDepartments || [])).catch(() => setAutoDepts([]));
  }, []);
  async function saveAutoDepts(next: string[]) {
    setAutoDepts(next);
    try {
      const r = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'saveIntegrations', integrations: { autopilotDepartments: next } }) });
      if (!r.ok) say((await r.json().catch(() => ({}))).error || 'Could not save.');
    } catch (e) { say((e as Error).message); }
  }
  async function clearSamples() {
    if (!window.confirm('Clear all samples and test data? The inbox, outputs, approvals, plans, activity and test agent runs are removed, with the preview leads and their vouchers. Settings, real leads and students, messages, videos and the quiz stay.')) return;
    setClearing(true);
    try {
      const r = await post('/api/state', { action: 'clearSamples' }) as { cleared?: Record<string, number> };
      const c = r.cleared || {};
      say(`Cleared: ${c.inbox ?? 0} emails, ${c.outputs ?? 0} outputs, ${c.approvals ?? 0} approvals, ${c.runs ?? 0} agent runs, ${c.previewLeads ?? 0} preview leads.`);
    } catch (e) { say((e as Error).message); } finally { setClearing(false); }
  }
  async function saveAgent(id: AgentId) {
    if (!teach) return;
    await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [id]: teach[id] }) });
    setSaved(id); setTimeout(() => setSaved(null), 2500);
  }
  async function connectSheet(url: string | null) {
    try { await post('/api/state', { action: 'sheet', url }); say(url ? 'Google Sheet connected.' : 'Google Sheet disconnected.'); } catch (e) { say((e as Error).message); }
  }

  const engine = state?.caps.ai.provider === 'anthropic' ? `Claude (${state.caps.ai.model})` : state?.caps.ai.provider === 'openai' ? state.caps.ai.model : 'Rule-based fallback';
  const email = state?.caps.email;

  return (
    <main className="pg-main">
      {msg && <div className="pg-sent"><Icon name="ok" size={14} />{msg}</div>}

      <section className="set-sec">
        <div className="set-h" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2>3D Skyscraper Building &amp; Branding Studio</h2>
            <p>Customize your 3D Workplace skyscraper on the Live Office view: attach your company logo, customize the entrance canopy &amp; digital billboard, and toggle architectural elements.</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href="/" className="btn btn-outline btn-sm">
              <Icon name="building" size={13} /> View Live Building
            </Link>
            <button type="button" className="btn btn-cta btn-sm" onClick={() => void saveBuildingSettings()} disabled={savingBldg}>
              <Icon name="save" size={13} /> {savingBldg ? 'Saving...' : 'Save Building & Branding'}
            </button>
          </div>
        </div>

        <div className="set-cards">
          <div className="set-card">
            <h3><Icon name="building" size={15} /> Company Identity &amp; Entrance Canopy</h3>
            <p>Displayed on the white cantilevered entrance canopy over the main glass doors.</p>
            <label className="mini">Company / Academy Name</label>
            <div className="set-inline">
              <input
                value={academyName}
                onChange={(e) => setAcademyName(e.target.value)}
                placeholder="Melsoft Academy"
              />
            </div>
            <label className="mini" style={{ marginTop: 10 }}>Company Logo (Upload image or paste URL)</label>
            <div className="set-inline" style={{ alignItems: 'center', gap: 8 }}>
              {building.logoUrl && (
                <img
                  src={building.logoUrl}
                  alt="Logo preview"
                  style={{ width: 34, height: 34, objectFit: 'contain', borderRadius: 8, border: '1px solid var(--line)', background: '#fff', padding: 3 }}
                />
              )}
              <input
                value={building.logoUrl || ''}
                onChange={(e) => setBuilding((p) => ({ ...p, logoUrl: e.target.value }))}
                placeholder="https://... or upload image file"
              />
              <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
                Upload Logo
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleFileUpload(e, 'logoUrl')}
                  style={{ display: 'none' }}
                />
              </label>
              {building.logoUrl && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setBuilding((p) => ({ ...p, logoUrl: '' }))}
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="set-card">
            <h3><Icon name="gear" size={15} /> Architectural Style &amp; Lighting Colors</h3>
            <p>Choose your building facade geometry, brand accent, and active workflow bottom-edge indicator color.</p>
            <div className="set-row2">
              <span>Facade Architecture</span>
              <div className="seg">
                <button
                  type="button"
                  className={(building.facadeStyle ?? 'sculpted') === 'sculpted' ? 'on' : ''}
                  onClick={() => setBuilding((p) => ({ ...p, facadeStyle: 'sculpted' }))}
                >
                  Sculpted Angular Wings
                </button>
                <button
                  type="button"
                  className={building.facadeStyle === 'classic' ? 'on' : ''}
                  onClick={() => setBuilding((p) => ({ ...p, facadeStyle: 'classic' }))}
                >
                  Classic Tower
                </button>
              </div>
            </div>
            <div className="set-row2">
              <span>Brand Accent Color</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="color"
                  value={building.brandColor || '#2563eb'}
                  onChange={(e) => setBuilding((p) => ({ ...p, brandColor: e.target.value }))}
                  style={{ width: 38, height: 28, border: 'none', borderRadius: 6, cursor: 'pointer' }}
                />
                <code>{building.brandColor || '#2563eb'}</code>
              </div>
            </div>
            <div className="set-row2">
              <span>Active Floor Bottom-Edge Line</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="color"
                  value={building.activeFloorColor || '#720075'}
                  onChange={(e) => setBuilding((p) => ({ ...p, activeFloorColor: e.target.value }))}
                  style={{ width: 38, height: 28, border: 'none', borderRadius: 6, cursor: 'pointer' }}
                />
                <code>{building.activeFloorColor || '#720075'}</code>
              </div>
            </div>
          </div>

          <div className="set-card">
            <h3><Icon name="flow" size={15} /> Upper-Front Widescreen TV &amp; Billboard</h3>
            <p>Paste a YouTube link (or video URL) to play continuously on mute on the upper-front TV screen of your building.</p>
            <label className="switch" style={{ marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={building.showBillboard !== false}
                onChange={(e) => setBuilding((p) => ({ ...p, showBillboard: e.target.checked }))}
              />
              <i />
              <span>{building.showBillboard !== false ? 'Widescreen TV Enabled' : 'Widescreen TV Hidden'}</span>
            </label>
            <label className="mini">Building TV Screen Video (YouTube URL — Plays Muted)</label>
            <div className="set-inline">
              <input
                value={building.videoUrl || ''}
                onChange={(e) => setBuilding((p) => ({ ...p, videoUrl: e.target.value }))}
                placeholder="https://www.youtube.com/watch?v=... (plays continuously on mute)"
              />
              {building.videoUrl && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setBuilding((p) => ({ ...p, videoUrl: '' }))}
                >
                  Default Video
                </button>
              )}
            </div>
            <label className="mini" style={{ marginTop: 8 }}>Billboard Headline Text (fallback if no video)</label>
            <div className="set-inline">
              <input
                value={building.billboardText || ''}
                onChange={(e) => setBuilding((p) => ({ ...p, billboardText: e.target.value }))}
                placeholder="Leave blank for live muted YouTube TV stream"
              />
            </div>
            <label className="mini" style={{ marginTop: 8 }}>Custom Billboard Banner Image (optional)</label>
            <div className="set-inline" style={{ alignItems: 'center', gap: 8 }}>
              <input
                value={building.billboardImageUrl || ''}
                onChange={(e) => setBuilding((p) => ({ ...p, billboardImageUrl: e.target.value }))}
                placeholder="https://... or upload banner image"
              />
              <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
                Upload Banner
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleFileUpload(e, 'billboardImageUrl')}
                  style={{ display: 'none' }}
                />
              </label>
              {building.billboardImageUrl && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setBuilding((p) => ({ ...p, billboardImageUrl: '' }))}
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="set-card">
            <h3><Icon name="check" size={15} /> Building &amp; Street Plaza Elements</h3>
            <p>Toggle architectural details around your skyscraper campus.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={building.showRoofChillers !== false}
                  onChange={(e) => setBuilding((p) => ({ ...p, showRoofChillers: e.target.checked }))}
                />
                <i />
                <span>Dual Rooftop HVAC Chiller Units</span>
              </label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={building.showTrees !== false}
                  onChange={(e) => setBuilding((p) => ({ ...p, showTrees: e.target.checked }))}
                />
                <i />
                <span>Lush Plaza Trees &amp; Raised Stone Planter Beds</span>
              </label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={building.showBollards !== false}
                  onChange={(e) => setBuilding((p) => ({ ...p, showBollards: e.target.checked }))}
                />
                <i />
                <span>Sidewalk Security Bollards</span>
              </label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={building.showStreetLamps !== false}
                  onChange={(e) => setBuilding((p) => ({ ...p, showStreetLamps: e.target.checked }))}
                />
                <i />
                <span>Plaza Street Lamps (Illuminated at Night)</span>
              </label>
            </div>
          </div>
        </div>
      </section>

      <section className="set-sec">
        <div className="set-h">
          <h2>AI Agent Instructions</h2>
          <p>Customize how each specialist agent diagnoses learners and writes personalized guidance for your academy.</p>
        </div>
        <div className="agent-grid">
          {AGENTS.map((ag) => (
            <div key={ag.id} className="agent-card">
              <div className="agent-top">
                <span className="agent-av">{ag.initials}</span>
                <span><b>{ag.name}</b><em>{ag.title === ag.role ? ag.role : `${ag.title} · ${ag.role}`}</em></span>
              </div>
              <label className="mini">Standing instructions</label>
              <textarea rows={4} value={teach?.[ag.id] ?? ''} onChange={(e) => teach && setTeach({ ...teach, [ag.id]: e.target.value })} disabled={!teach} />
              <button type="button" className="btn btn-outline btn-sm" onClick={() => saveAgent(ag.id)} disabled={!teach}>
                {saved === ag.id ? <><Icon name="check" size={13} />Saved</> : <><Icon name="save" size={13} />Save</>}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="set-sec">
        <div className="set-h"><h2>Automation &amp; Triggers</h2><p>Configure scheduled sweeps, Google Sheet sync, or run an immediate sweep on real data.</p></div>
        <div className="set-cards">
          <div className="set-card">
            <h3>
              <Icon name="webhook" size={15} />Moodle &amp; Webhooks{' '}
              <span className="badge badge-good">{state?.caps.moodleConfigured ? 'Moodle + Webhook' : 'Webhook listening'}</span>
            </h3>
            <p>
              Signed events to <code>POST {a?.webhookPath || '/api/webhooks/lms'}</code> trigger matching Workflow Offices for quiz failures, attendance gaps, overdue assignments, or billing notices. Manage URLs &amp; secrets in <Link href="/workspace">Channels &amp; API</Link>.
            </p>
            <p className="dim">Events received: <b>{a?.events ?? 0}</b> · last: {a?.lastEvent ? `${a.lastEvent.learner}, ${a.lastEvent.detail} (${ago(a.lastEvent.at)})` : 'none yet'}</p>
          </div>
          <div className="set-card">
            <h3><Icon name="sheet" size={15} />Google Sheet</h3>
            <p>Sync a published Google Sheet CSV of attendance &amp; tuition records.</p>
            <div className="set-inline">
              <input value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/.../pub?output=csv" />
              <button type="button" className="btn btn-cta btn-sm" onClick={() => connectSheet(sheet.trim() || null)}>{a?.sheet.connected ? 'Update' : 'Connect'}</button>
              {a?.sheet.connected && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSheet(''); void connectSheet(null); }}>Disconnect</button>}
            </div>
          </div>
          <div className="set-card">
            <h3><Icon name="clock" size={15} />Weekly Cohort Sweep</h3>
            <label className="switch">
              <input type="checkbox" checked={s?.scheduleEnabled ?? true} onChange={(e) => set({ scheduleEnabled: e.target.checked })} />
              <i />
              <span>{s?.scheduleEnabled ?? true ? 'On · Mondays 07:00' : 'Paused'}</span>
            </label>
          </div>
          <div className="set-card">
            <h3><Icon name="target" size={15} />Run a Manual Sweep</h3>
            <div className="set-inline">
              <input value={goal} onChange={(e) => setGoal(e.target.value)} />
              <button type="button" className="btn btn-cta btn-sm" onClick={async () => { await post('/api/state', { action: 'goal', goal }); say('Goal started.'); }}>Run</button>
            </div>
          </div>
        </div>
      </section>

      <section className="set-sec">
        <div className="set-h"><h2>Delivery, Safety &amp; Preferences</h2></div>
        <div className="set-cards">
          <div className="set-card">
            <h3><Icon name="trash" size={15} />Samples &amp; test data</h3>
            <p>Before a demo or going live: removes everything made while testing (the inbox, outputs, approvals, plans, activity, agent runs, preview leads and their vouchers). Settings, real leads and students, messages, videos and the quiz stay.</p>
            <button type="button" className="btn btn-outline btn-sm" disabled={clearing} onClick={() => void clearSamples()}>
              <Icon name="trash" size={13} />{clearing ? 'Clearing…' : 'Clear samples & test data'}
            </button>
          </div>
          <div className="set-card">
            <h3>
              <Icon name="shield" size={15} />Outreach Environment{' '}
              <span className={`badge ${state?.caps.sendingPaused ? 'badge-good' : s?.liveOutreachEnabled ? 'badge-warn' : 'badge-good'}`}>
                {state?.caps.sendingPaused ? 'Sending paused (server)' : s?.liveOutreachEnabled ? 'LIVE OUTREACH ON' : 'Safe Test Mode'}
              </span>
            </h3>
            <p>
              In <b>Safe Test Mode</b> (default), agents can sync learners and run flows safely without emailing, calling, or messaging anyone in real life — every message stays inside Live Office → Inbox.
            </p>
            {state?.caps.sendingPaused && (
              <p style={{ marginTop: 6 }}>
                <b>Sending is paused on this server</b> for the test phase: nothing leaves the building even with this switch on. The server owner sets <code>SENDING_PAUSED=false</code> to go live.
              </p>
            )}
            <label className="switch">
              <input
                type="checkbox"
                checked={Boolean(s?.liveOutreachEnabled)}
                onChange={(e) => set({ liveOutreachEnabled: e.target.checked })}
              />
              <i />
              <span>{s?.liveOutreachEnabled ? 'LIVE ON: real SMTP emails, WhatsApp, ManyChat & AI calls can send' : 'Safe Test Mode: zero live emails, calls, or messages will be sent'}</span>
            </label>
          </div>
          <div className="set-card">
            <h3><Icon name="mail" size={15} />Email Sender {s?.liveOutreachEnabled && email === 'smtp' ? <span className="badge badge-good">Academy SMTP Active</span> : <span className="badge badge-mute">Simulated Only (Safe Mode)</span>}</h3>
            <p>Configure your mailbox and optional test redirect address on <Link href="/workspace">Channels &amp; API</Link>.</p>
          </div>
          <div className="set-card">
            <h3>
              <Icon name="zap" size={15} />Autopilot{' '}
              <span className={`badge ${s?.autoRunMode ? 'badge-warn' : 'badge-good'}`}>
                {s?.autoRunMode ? 'On' : 'Off'}
              </span>
            </h3>
            <p>
              With autopilot <b>off</b>, Moodle and sheet syncs update records quietly and agents only work when someone presses <b>Run</b>. Turn it <b>on</b> and the departments ticked below start by themselves: new leads, tracker changes, scheduled checks, LMS events and replies.
            </p>
            <label className="switch">
              <input
                type="checkbox"
                checked={Boolean(s?.autoRunMode)}
                onChange={(e) => set({ autoRunMode: e.target.checked })}
              />
              <i />
              <span>{s?.autoRunMode ? 'On: agents start by themselves from their triggers' : 'Off: agents run only when someone presses Run'}</span>
            </label>
            {depts.length > 0 && autoDepts !== null && (
              <div style={{ marginTop: 12 }}>
                <b style={{ fontSize: 12.5 }}>Departments on autopilot</b>
                <p style={{ margin: '2px 0 8px', fontSize: 12.5 }}>{autoDepts.length ? 'Only these start by themselves; the others work when someone presses Run.' : 'All departments (tick some to limit autopilot to them).'}</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {depts.map((d) => {
                    const on = autoDepts.includes(d.id);
                    return (
                      <label key={d.id} className="switch" style={{ margin: 0 }}>
                        <input type="checkbox" checked={on} onChange={() => void saveAutoDepts(on ? autoDepts.filter((x) => x !== d.id) : [...autoDepts, d.id])} />
                        <i />
                        <span>{d.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div className="set-card">
            <h3><Icon name="check" size={15} />Approval Gate {s?.requireApproval !== false ? <span className="badge badge-good">Safe Mode</span> : <span className="badge badge-mute">Auto-Send</span>}</h3>
            <p>When ON, drafts wait in Live Office → Inbox for your approval before going out via Email, WhatsApp, or ManyChat.</p>
            <label className="switch">
              <input type="checkbox" checked={s?.requireApproval !== false} onChange={(e) => set({ requireApproval: e.target.checked })} />
              <i />
              <span>{s?.requireApproval !== false ? 'On: approve drafts before sending' : 'Off: send immediately after review'}</span>
            </label>
          </div>
          <div className="set-card">
            <h3><Icon name="link" size={15} />Public Lesson &amp; Quiz Base URL</h3>
            <p>Where student quiz/lesson links in emails and WhatsApp messages point.</p>
            <div className="set-inline">
              <input value={pub} onChange={(e) => setPub(e.target.value)} placeholder="https://your-domain.com" />
              <button type="button" className="btn btn-cta btn-sm" onClick={() => savePublic(pub)}>Save</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPub(window.location.origin); void savePublic(window.location.origin); }}>Use current URL</button>
            </div>
          </div>
          <div className="set-card">
            <div className="set-row2"><span>AI Engine</span><span className="badge badge-soft">{engine}</span></div>
            <div className="set-row2"><span>Tutoring Language</span>
              <div className="seg">
                <button type="button" className={(s?.tutorLanguage ?? 'en') === 'en' ? 'on' : ''} onClick={() => set({ tutorLanguage: 'en' })}>English</button>
                <button type="button" className={s?.tutorLanguage === 'zu' ? 'on' : ''} onClick={() => set({ tutorLanguage: 'zu' })}>isiZulu</button>
                <button type="button" className={s?.tutorLanguage === 'st' ? 'on' : ''} onClick={() => set({ tutorLanguage: 'st' })}>Sesotho</button>
              </div>
            </div>
            <div className="set-row2"><span>Theme</span><ThemeToggle /></div>
            <div className="set-row2"><span>Clear History</span>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={Boolean(state?.busy)}
                onClick={async () => {
                  if (!confirm('Clear run history & mailbox logs for this workspace?')) return;
                  await post('/api/state', { action: 'reset' });
                  say('Workspace feed & run history cleared.');
                }}
              >
                <Icon name="reset" size={13} />Reset runs
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

