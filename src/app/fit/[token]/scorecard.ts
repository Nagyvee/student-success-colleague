/* The career-fit scorecard: a 1080 × 1350 PNG (a portrait social post) drawn in
 * the browser, in the academy's colours: the navy-to-maroon gradient, the white
 * logo, Inter, one orange accent. Nothing is uploaded; the lead keeps it. */

import type { FitTrack } from '@/lib/nurture/types';

type Track = FitTrack & { strengths?: string[]; careers?: string[]; tryThis?: string };

const W = 1080;
const H = 1350;
const PAD = 84;
const NAVY = '#0a1733';
const MAROON = '#5e0743';
const ORANGE = '#ff7300';
const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Lines of text that fit a width (word wrap). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > width && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function spaced(ctx: CanvasRenderingContext2D, px: number) {
  // Letter spacing for the small capitals (where the browser supports it).
  (ctx as unknown as { letterSpacing?: string }).letterSpacing = `${px}px`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = 'rgba(255,255,255,0.6)') {
  ctx.font = `800 22px ${FONT}`;
  spaced(ctx, 3);
  ctx.fillStyle = color;
  ctx.fillText(text.toUpperCase(), x, y);
  spaced(ctx, 0);
}

export async function drawScorecard(input: {
  first: string; track: Track; tracks: Track[]; scores: Record<string, number> | null; total: number;
  academy: string; site: string; logo: string | null;
}): Promise<Blob> {
  const { first, track, tracks, scores, total } = input;
  if (typeof document !== 'undefined' && document.fonts) {
    await Promise.all([800, 700, 600, 500].map((w) => document.fonts.load(`${w} 40px Inter`).catch(() => null)));
  }
  const logo = input.logo ? await loadImage(input.logo) : null;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas');
  ctx.textBaseline = 'alphabetic';

  // Background: navy to maroon, with a warm glow in one corner.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, NAVY);
  bg.addColorStop(0.55, NAVY);
  bg.addColorStop(1, MAROON);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W - 120, 140, 10, W - 120, 140, 520);
  glow.addColorStop(0, 'rgba(255,115,0,0.20)');
  glow.addColorStop(1, 'rgba(255,115,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Header: the logo, and what this is.
  let y = PAD;
  if (logo) {
    const h = 58;
    const w = (logo.width / logo.height) * h;
    ctx.drawImage(logo, PAD, y, w, h);
  } else {
    ctx.font = `800 40px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(input.academy, PAD, y + 44);
  }
  ctx.textAlign = 'right';
  label(ctx, 'Career-fit scorecard', W - PAD, y + 38, ORANGE);
  ctx.textAlign = 'left';

  // Who they are.
  y += 170;
  label(ctx, `${first}, you are`, PAD, y);
  y += 96;
  let size = 96;
  ctx.font = `800 ${size}px ${FONT}`;
  while (ctx.measureText(track.name).width > W - PAD * 2 && size > 56) { size -= 4; ctx.font = `800 ${size}px ${FONT}`; }
  ctx.fillStyle = '#fff';
  spaced(ctx, -2);
  ctx.fillText(track.name, PAD, y);
  spaced(ctx, 0);
  y += 56;
  ctx.font = `600 34px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  for (const line of wrap(ctx, track.tagline, W - PAD * 2).slice(0, 2)) { ctx.fillText(line, PAD, y); y += 44; }

  // Best fit.
  y += 22;
  roundRect(ctx, PAD, y, W - PAD * 2, 128, 24);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 2;
  ctx.stroke();
  label(ctx, 'Your best fit', PAD + 34, y + 46, 'rgba(255,255,255,0.55)');
  ctx.font = `800 46px ${FONT}`;
  ctx.fillStyle = ORANGE;
  ctx.fillText(track.programme, PAD + 34, y + 100);
  y += 128 + 70;

  // How they matched every path.
  if (scores && total) {
    label(ctx, 'How you matched', PAD, y);
    y += 30;
    const barX = PAD + 360;
    const barW = W - PAD - 90 - barX;
    for (const t of tracks) {
      const pct = Math.round(((scores[t.id] || 0) / total) * 100);
      const top = t.id === track.id;
      ctx.font = `${top ? 700 : 500} 28px ${FONT}`;
      ctx.fillStyle = top ? '#fff' : 'rgba(255,255,255,0.7)';
      const name = wrap(ctx, t.programme, 340)[0];
      ctx.fillText(name, PAD, y + 30);
      roundRect(ctx, barX, y + 12, barW, 18, 9);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fill();
      roundRect(ctx, barX, y + 12, Math.max(18, (barW * pct) / 100), 18, 9);
      ctx.fillStyle = top ? ORANGE : 'rgba(255,255,255,0.4)';
      ctx.fill();
      ctx.textAlign = 'right';
      ctx.font = `700 28px ${FONT}`;
      ctx.fillStyle = top ? '#fff' : 'rgba(255,255,255,0.7)';
      ctx.fillText(`${pct}%`, W - PAD, y + 30);
      ctx.textAlign = 'left';
      y += 54;
    }
    y += 40;
  }

  // Strengths.
  const strengths = (track.strengths || []).slice(0, 3);
  if (strengths.length) {
    label(ctx, 'Your strengths', PAD, y);
    y += 26;
    ctx.font = `600 30px ${FONT}`;
    for (const s of strengths) {
      ctx.fillStyle = ORANGE;
      ctx.beginPath();
      ctx.arc(PAD + 9, y + 20, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(wrap(ctx, s, W - PAD * 2 - 40)[0], PAD + 36, y + 31);
      y += 48;
    }
    y += 36;
  }

  // Where it can take them.
  const careers = (track.careers || []).slice(0, 5);
  if (careers.length && y < H - 230) {
    label(ctx, 'Where it can take you', PAD, y);
    y += 50;
    ctx.font = `500 29px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    for (const line of wrap(ctx, careers.join('  ·  '), W - PAD * 2).slice(0, 2)) { ctx.fillText(line, PAD, y); y += 42; }
  }

  // One thing to try this week, when there is room.
  if (track.tryThis) {
    y += 34;
    ctx.font = `500 28px ${FONT}`;
    const lines = wrap(ctx, track.tryThis, W - PAD * 2 - 68).slice(0, 3);
    const boxH = 70 + lines.length * 38;
    if (y + boxH < H - PAD - 84) {
      roundRect(ctx, PAD, y, W - PAD * 2, boxH, 22);
      ctx.fillStyle = 'rgba(255,115,0,0.12)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,115,0,0.4)';
      ctx.stroke();
      label(ctx, 'Try this week', PAD + 34, y + 48, ORANGE);
      ctx.font = `500 28px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      lines.forEach((l, i) => ctx.fillText(l, PAD + 34, y + 92 + i * 38));
    }
  }

  // Footer.
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(PAD, H - PAD - 54, W - PAD * 2, 2);
  ctx.font = `600 24px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(input.academy, PAD, H - PAD);
  ctx.textAlign = 'right';
  ctx.fillText([input.site, new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })].filter(Boolean).join('  ·  '), W - PAD, H - PAD);
  ctx.textAlign = 'left';

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the image'))), 'image/png'));
}
