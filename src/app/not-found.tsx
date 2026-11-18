import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: 24,
        background: 'var(--surface-sunken)',
        color: 'var(--ink)',
        textAlign: 'center',
      }}
    >
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>Page not found</h1>
      <p style={{ margin: 0, color: 'var(--muted)', maxWidth: 420 }}>
        The workspace page you requested could not be found.
      </p>
      <Link href="/" className="btn btn-cta">
        Return to Live Office
      </Link>
    </main>
  );
}

