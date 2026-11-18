'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Icon from '@/components/Icon';
import Logo from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';
import '../pages.css';

export default function LoginPage() {
  const router = useRouter();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [academyName, setAcademyName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.authenticated) {
          router.replace(d.tenant?.onboardingCompleted ? '/' : '/onboarding');
        }
      })
      .catch(() => {});
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload =
        tab === 'register'
          ? { action: 'register', academyName, name, email, password }
          : { action: 'login', email, password };
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Authentication failed.');
        return;
      }
      if (tab === 'register' || !json.tenant?.onboardingCompleted) {
        router.replace('/onboarding');
      } else {
        router.replace('/');
      }
    } catch {
      setError('Could not reach authentication service.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <section className="auth-hero">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Logo size="lg" word="Thuso" />
          <ThemeToggle className="iconbtn theme-btn" />
        </div>

        <div>
          <span
            className="badge badge-soft"
            style={{
              marginBottom: 16,
              padding: '5px 12px',
              background: 'rgba(255,255,255,.12)',
              color: '#fff',
              border: '1px solid rgba(255,255,255,.22)',
            }}
          >
            Personalized Student Success Platform
          </span>
          <h1>Every learner gets a personal AI coach before they fall behind.</h1>
          <p>
            Connect Moodle or any custom LMS via signed webhooks, deliver through your own academy
            Email SMTP, WhatsApp bridge, and ManyChat API, and guide every student with warm,
            personalized catch-up plans.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0,1fr))',
              gap: 14,
              marginTop: 30,
            }}
          >
            <div
              style={{
                padding: 16,
                borderRadius: 14,
                background: 'rgba(255,255,255,.07)',
                border: '1px solid rgba(255,255,255,.14)',
              }}
            >
              <Icon name="webhook" size={18} />
              <div style={{ fontWeight: 700, fontSize: 13.5, marginTop: 10 }}>
                Moodle + Webhooks
              </div>
              <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 4, lineHeight: 1.45 }}>
                Syncs full Moodle course progress, grades &amp; assignments, or live LMS webhooks.
              </div>
            </div>
            <div
              style={{
                padding: 16,
                borderRadius: 14,
                background: 'rgba(255,255,255,.07)',
                border: '1px solid rgba(255,255,255,.14)',
              }}
            >
              <Icon name="mail" size={18} />
              <div style={{ fontWeight: 700, fontSize: 13.5, marginTop: 10 }}>
                Own Academy Channels
              </div>
              <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 4, lineHeight: 1.45 }}>
                Use your own SMTP server, WhatsApp Business bridge, and ManyChat flows.
              </div>
            </div>
            <div
              style={{
                padding: 16,
                borderRadius: 14,
                background: 'rgba(255,255,255,.07)',
                border: '1px solid rgba(255,255,255,.14)',
              }}
            >
              <Icon name="shield" size={18} />
              <div style={{ fontWeight: 700, fontSize: 13.5, marginTop: 10 }}>
                Approval Safety
              </div>
              <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 4, lineHeight: 1.45 }}>
                Review outreach drafts before they go out, or enable full autopilot anytime.
              </div>
            </div>
          </div>
        </div>

        <div style={{ fontSize: 12.5, opacity: 0.68 }}>
          Isolated multi-tenant workspaces &middot; PostgreSQL learner memory &middot; Zero demo clutter
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div>
            <h2 style={{ margin: '0 0 6px', fontSize: 23, fontWeight: 800, letterSpacing: '-.02em' }}>
              {tab === 'login' ? 'Sign in to your academy' : 'Create your academy workspace'}
            </h2>
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.5 }}>
              {tab === 'login'
                ? 'Access your workflow offices, live student telemetry, and outreach channels.'
                : 'Set up an isolated workspace and connect your LMS, SMTP email, WhatsApp, or ManyChat.'}
            </p>
          </div>

          <div className="auth-tabs">
            <button
              type="button"
              className={`auth-tab${tab === 'login' ? ' on' : ''}`}
              onClick={() => {
                setTab('login');
                setError(null);
              }}
            >
              Sign In
            </button>
            <button
              type="button"
              className={`auth-tab${tab === 'register' ? ' on' : ''}`}
              onClick={() => {
                setTab('register');
                setError(null);
              }}
            >
              Create Account
            </button>
          </div>

          {error && (
            <div className="pg-err">
              <Icon name="warn" size={16} />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
            {tab === 'register' && (
              <>
                <label className="field">
                  <span>Academy / Organization Name</span>
                  <input
                    className="in"
                    placeholder="e.g. Melsoft Academy"
                    value={academyName}
                    onChange={(e) => setAcademyName(e.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Your Full Name</span>
                  <input
                    className="in"
                    placeholder="e.g. Thabo Mokoena"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </label>
              </>
            )}

            <label className="field">
              <span>Work Email</span>
              <input
                className="in"
                type="email"
                autoComplete="email"
                placeholder="name@academy.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>

            <label className="field">
              <span>Password</span>
              <div className="in-pw-wrap">
                <input
                  className="in"
                  type={showPw ? 'text' : 'password'}
                  autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                  placeholder={
                    tab === 'register'
                      ? 'Create a password (min 6 characters)'
                      : 'Enter your password'
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                />
                <button
                  type="button"
                  className="in-pw-btn"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  <Icon name="eye" size={16} />
                </button>
              </div>
            </label>

            <button type="submit" className="auth-submit" disabled={busy} style={{ marginTop: 4 }}>
              {busy
                ? tab === 'register'
                  ? 'Creating workspace...'
                  : 'Signing in...'
                : tab === 'register'
                  ? 'Create Workspace & Start Onboarding'
                  : 'Sign In to Workspace'}
              <Icon name="arrowRight" size={15} />
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
