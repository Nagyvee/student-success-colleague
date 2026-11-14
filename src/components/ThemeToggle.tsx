'use client';

import { useEffect, useState } from 'react';
import Icon from './Icon';

export default function ThemeToggle({ className = 'iconbtn' }: { className?: string }) {
  const [theme, setTheme] = useState<'dark' | 'light'>('light');
  useEffect(() => { setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'); }, []);
  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('cz-theme', next); } catch { /* private mode */ }
  }
  return (
    <button type="button" className={className} onClick={toggle} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
    </button>
  );
}
