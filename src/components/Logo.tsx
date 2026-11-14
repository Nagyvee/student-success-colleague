/* The Thuso mark: a learner (the orange dot) held up by a hand (the white
 * curve). "Thuso" means help in Sesotho and Setswana. Drawn, not an image,
 * so it is crisp at any size and needs no files. */

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ flexShrink: 0, display: 'block' }}>
      <rect width="64" height="64" rx="16" fill="#0a1733" />
      <circle cx="32" cy="23" r="7.5" fill="#ff7300" />
      <path d="M15 34c5 10 11 14 17 14s12-4 17-14" fill="none" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
}

export default function Logo({ size = 'md', word = 'Thuso' }: { size?: 'sm' | 'md' | 'lg'; word?: string }) {
  const mark = { sm: 22, md: 28, lg: 36 }[size];
  const wordSize = { sm: 15, md: 18, lg: 24 }[size];
  return (
    <span className="logo" style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <LogoMark size={mark} />
      <span className="logo-word" style={{ fontSize: wordSize, fontWeight: 800, letterSpacing: '-.02em' }}>{word}</span>
    </span>
  );
}
