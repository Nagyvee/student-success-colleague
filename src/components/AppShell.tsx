'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import Icon, { type IconName } from '@/components/Icon';
import Logo, { LogoMark } from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';

interface ShellInfo {
  userName: string;
  userEmail: string;
  userRole: string;
  tenantName: string;
  tenantSlug: string;
  pendingCount: number;
  learnerCount: number;
  requireApproval: boolean;
  liveOutreachEnabled: boolean;
}

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  badgeKey?: 'pending' | 'learners';
}

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Workspace',
    items: [
      { href: '/', label: 'Live Office', icon: 'building', badgeKey: 'pending' },
      { href: '/learners', label: 'Students', icon: 'users', badgeKey: 'learners' },
      { href: '/nurture', label: 'Lead Nurturing', icon: 'target' },
    ],
  },
  {
    title: 'Automation',
    items: [
      { href: '/workflows', label: 'Agents & Workflows', icon: 'flow' },
      { href: '/workspace', label: 'Channels & API', icon: 'plug' },
    ],
  },
  {
    title: 'Control',
    items: [
      { href: '/golive', label: 'Go-live checklist', icon: 'list' },
      { href: '/reports', label: 'Reports', icon: 'chart' },
      { href: '/settings', label: 'Settings', icon: 'gear' },
      { href: '/onboarding', label: 'Setup Wizard', icon: 'zap' },
    ],
  },
];

const DEFAULT_SHELL_INFO: ShellInfo = {
  userName: 'Workspace Admin',
  userEmail: '',
  userRole: 'owner',
  tenantName: 'Academy',
  tenantSlug: 'default',
  pendingCount: 0,
  learnerCount: 0,
  requireApproval: true,
  liveOutreachEnabled: false,
};

let cachedShellInfo: ShellInfo | null = null;

export default function AppShell({
  children,
  title,
  subtitle,
  actions,
  fullBleed = false,
}: {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  fullBleed?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [compact, setCompact] = useState(false);
  const [info, setInfo] = useState<ShellInfo>(() => cachedShellInfo || DEFAULT_SHELL_INFO);

  useEffect(() => {
    try {
      setCompact(localStorage.getItem('thuso-side-compact') === '1');
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [aRes, sRes] = await Promise.all([
          fetch('/api/auth', { cache: 'no-store' }),
          fetch('/api/state', { cache: 'no-store' }),
        ]);
        const auth = aRes.ok ? await aRes.json() : null;
        const st = sRes.ok ? await sRes.json() : null;
        if (!active) return;
        const pendingCount = Array.isArray(st?.pendingOutreach)
          ? st.pendingOutreach.filter((x: { status: string }) => x.status === 'pending').length
          : 0;
        const learnerCount = Array.isArray(st?.learners) ? st.learners.length : 0;
        const next: ShellInfo = {
          userName: auth?.user?.name || 'Workspace User',
          userEmail: auth?.user?.email || '',
          userRole: auth?.user?.role || 'owner',
          tenantName: auth?.tenant?.name || st?.tenant?.name || 'Academy',
          tenantSlug: auth?.tenant?.slug || 'default',
          pendingCount,
          learnerCount,
          requireApproval: Boolean(st?.settings?.requireApproval ?? auth?.tenant?.requireApproval ?? true),
          liveOutreachEnabled: Boolean(st?.settings?.liveOutreachEnabled ?? auth?.tenant?.liveOutreachEnabled ?? false),
        };
        cachedShellInfo = next;
        setInfo(next);
      } catch { /* ignore transient poll failure */ }
    };
    if (!cachedShellInfo) {
      void load();
    }
    const id = setInterval(load, 25000);
    const onRefresh = () => {
      void load();
    };
    window.addEventListener('thuso:refresh-shell', onRefresh);
    return () => {
      active = false;
      clearInterval(id);
      window.removeEventListener('thuso:refresh-shell', onRefresh);
    };
  }, []);

  const toggleCompact = () => {
    setCompact((prev) => {
      const next = !prev;
      try { localStorage.setItem('thuso-side-compact', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  const signOut = async () => {
    await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    });
    router.replace('/login');
  };

  return (
    <div className="shell">
      <aside className={`side${compact ? ' is-compact' : ''}`}>
        <div className="side-brand">
          <Link href="/" className="side-logo-full" style={{ textDecoration: 'none', color: 'inherit' }}>
            <Logo size="sm" word={info.tenantName || 'Thuso'} />
          </Link>
          <Link href="/" className="side-logo-mark" style={{ textDecoration: 'none' }} title={info.tenantName}>
            <LogoMark size={28} />
          </Link>
          <button
            type="button"
            className="side-toggle"
            onClick={toggleCompact}
            title={compact ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={compact ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <Icon name={compact ? 'unfoldL' : 'foldL'} size={15} />
          </button>
        </div>

        <nav className="side-nav" aria-label="Workspace Navigation">
          {SECTIONS.map((sec) => (
            <div key={sec.title}>
              <div className="side-sec">{sec.title}</div>
              {sec.items.map((item) => {
                const isActive = item.href === '/'
                  ? pathname === '/'
                  : pathname === item.href || pathname.startsWith(`${item.href}/`) || (item.href === '/learners' && pathname === '/lms');
                const badge = item.badgeKey === 'pending'
                  ? info.pendingCount
                  : item.badgeKey === 'learners'
                    ? info.learnerCount
                    : 0;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`navlink${isActive ? ' on' : ''}`}
                    data-tip={item.label}
                    style={{ textDecoration: 'none' }}
                  >
                    <Icon name={item.icon} size={16} />
                    <span className="navlink-t">{item.label}</span>
                    {badge > 0 && <span className="count">{badge}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="side-status" data-tip={`${info.tenantName} · ${info.liveOutreachEnabled ? (info.requireApproval ? 'Live · Approval Gate ON' : 'LIVE Auto-Send') : 'Safe Test Mode (No Live Sends)'}`}>
          <div className="side-status-top">
            <span className="pdot" style={{ background: !info.liveOutreachEnabled ? '#118276' : info.requireApproval ? '#d97706' : '#dc2626' }} />
            <span className="side-status-text">
              <b>{info.tenantName}</b>
              <span>{!info.liveOutreachEnabled ? 'Test Mode · No live sends' : info.requireApproval ? 'Live · Approval gate ON' : 'LIVE Auto-send active'}</span>
            </span>
          </div>
          <div className="side-status-nums">
            <span><b>{info.learnerCount}</b>Learners</span>
            <span><b>{info.pendingCount}</b>Pending</span>
          </div>
        </div>

        <div className="side-foot">
          <div className="side-me-t" style={{ minWidth: 0 }}>
            <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 132 }}>{info.userName}</div>
            <span>{info.userRole}</span>
          </div>
          <div className="side-foot-acts" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <ThemeToggle className="iconbtn theme-btn" />
            <button type="button" className="iconbtn" onClick={signOut} title="Sign out">
              <Icon name="door" size={15} />
            </button>
          </div>
        </div>
      </aside>

      {fullBleed ? (
        children
      ) : (
        <div className="app-main">
          {(title || actions) && (
            <header className="app-head">
              <div>
                {title && <h1>{title}</h1>}
                {subtitle && <p>{subtitle}</p>}
              </div>
              {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{actions}</div>}
            </header>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

