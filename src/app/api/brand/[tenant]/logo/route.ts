import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getTenantIntegrations, listTenantIds } from '@/lib/auth/accounts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* The academy's logo for its public pages (quiz, video, voucher, "call me"),
 * from the logo uploaded in Settings → Building. Trimmed to the artwork and
 * sized for the web; ?tone=white gives the same logo in white for dark
 * backgrounds (the brand rule: a light logo on dark, a dark logo on light). */

type Made = { hash: string; png: Buffer };
const g = globalThis as unknown as { __thusoLogos?: Map<string, Made> };
const made = (g.__thusoLogos ||= new Map());

async function render(dataUrl: string, tone: 'white' | 'original'): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const src = Buffer.from(dataUrl.split(',', 2)[1] || '', 'base64');
  const trimmed = await sharp(src).ensureAlpha().trim().resize({ width: 900, withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  if (tone === 'original') return trimmed.data;
  const { width, height } = trimmed.info;
  const alpha = await sharp(trimmed.data).extractChannel(3).raw().toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

export async function GET(req: Request, ctx: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await ctx.params;
  if (!listTenantIds().includes(tenant)) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const logo = getTenantIntegrations(tenant).building?.logoUrl || '';
  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(logo)) return NextResponse.json({ error: 'No logo.' }, { status: 404 });
  const tone = new URL(req.url).searchParams.get('tone') === 'white' ? 'white' : 'original';
  const hash = createHash('sha1').update(logo).digest('hex').slice(0, 12);
  const key = `${tenant}:${tone}`;
  let hit = made.get(key);
  if (!hit || hit.hash !== hash) {
    try {
      hit = { hash, png: await render(logo, tone) };
      made.set(key, hit);
    } catch {
      return NextResponse.json({ error: 'The logo could not be read.' }, { status: 404 });
    }
  }
  return new Response(new Uint8Array(hit.png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', ETag: `"${hash}-${tone}"`, 'X-Robots-Tag': 'noindex' },
  });
}
