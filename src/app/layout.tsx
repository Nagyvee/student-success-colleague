import type { Metadata, Viewport } from 'next';
import './globals.css';
import './office.css';
import './shell.css';
import './light.css';
import './pages.css';
import './dark.css';

export const metadata: Metadata = {
  title: { default: 'Thuso · Student Success Colleague', template: '%s · Thuso' },
  description: 'Give it a goal. Four AI agents find the learners falling behind, work out why, write each one a reviewed catch-up plan, fix their own mistakes and deliver it, with no human in the loop.',
  applicationName: 'Thuso',
  openGraph: { type: 'website', locale: 'en_ZA', siteName: 'Thuso', title: 'Thuso · Student Success Colleague' },
  formatDetection: { telephone: false },
  icons: { icon: '/thuso-mark.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafbfe' },
    { media: '(prefers-color-scheme: dark)', color: '#081023' },
  ],
};

/* Light by default, like the dialer. The choice is
 * stamped on <html> before first paint so there is no flash. */
const themeBoot = `(function(){try{var t=localStorage.getItem('cz-theme');document.documentElement.setAttribute('data-theme',t==='dark'?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-ZA" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
