import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/auth/tenantContext';
import { getAcademyContext, getTenantIntegrations, listTenantIds } from '@/lib/auth/accounts';
import { bootReady } from '@/lib/engine/automation';
import { getRecord } from '@/lib/data/records';
import { getResource } from '@/lib/nurture/bank';
import { getMessage } from '@/lib/nurture/library';
import { isBot, noteEngagement, readTrack } from '@/lib/nurture/track';
import { getFile } from '@/lib/files/store';
import { CTA_LABEL } from '@/lib/nurture/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* Every link in a nurture message comes through here.
 *
 *   GET /go/<token>        a click: count it, then go where the link points
 *                          (the quiz, their video, a guide, the application)
 *   GET /go/<token>?o=1    the open pixel
 *   GET /go/<token>?u=1    "stop these emails": a page with one button
 *   POST /go/<token>?u=1   the button: they are unsubscribed, agents stop
 *
 * The token is signed, so nobody can make one up. Mail scanners that open
 * links are not counted as people. */

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const pixel = () => new Response(new Uint8Array(PIXEL), { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0', 'Content-Length': String(PIXEL.length) } });

const escHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
:root{--navy:#0a1733;--maroon:#5e0743;--orange:#ff7300}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;font-family:Inter,system-ui,sans-serif;background:linear-gradient(135deg,#0a1733,#5e0743);color:#fff}
.card{max-width:460px;width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:20px;padding:32px 28px;text-align:center;backdrop-filter:blur(6px)}
h1{font-size:24px;font-weight:800;letter-spacing:-.02em;margin:0 0 10px}p{font-size:15px;line-height:1.6;color:#dbe4ff;margin:0 0 18px}
button,.btn{display:inline-block;border:0;cursor:pointer;background:var(--orange);color:#fff;font:800 15px Inter,system-ui,sans-serif;padding:13px 22px;border-radius:12px;text-decoration:none}
.muted{font-size:12px;color:#aab6d6;margin:16px 0 0}
</style></head><body><main class="card">${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

async function handle(req: Request, token: string, method: 'GET' | 'POST'): Promise<Response> {
  const p = readTrack(token);
  const url = new URL(req.url);
  if (!p || !listTenantIds().includes(p.t)) return page('Link not found', '<h1>This link has expired</h1><p>It may be from an old email. Reply to the email and we will help you.</p>', 404);
  await bootReady(p.t);
  return withTenant(p.t, async () => {
    const ac = getAcademyContext();
    const rec = getRecord(p.s, p.k);
    const first = rec ? (rec.fields.first_name || rec.name).split(/\s+/)[0] : '';

    // Open pixel.
    if (url.searchParams.get('o')) {
      if (rec && method === 'GET') await noteEngagement(p, 'open').catch(() => null);
      return pixel();
    }

    // Unsubscribe: a page with a button (scanners only GET, so they never unsubscribe anyone).
    if (url.searchParams.get('u')) {
      if (method === 'POST') {
        if (rec) await noteEngagement(p, 'unsub');
        return page('You are unsubscribed', `<h1>Done${first ? `, ${escHtml(first)}` : ''}</h1><p>You won't get any more of these emails from ${escHtml(ac.academyName)}. If you ever want to talk about studying with us, just reply to any of our emails.</p>`);
      }
      return page('Stop these emails', `<h1>Stop these emails?</h1><p>${first ? `${escHtml(first)}, you` : 'You'} will no longer get messages about studying at ${escHtml(ac.academyName)}.</p><form method="post"><button type="submit">Yes, stop them</button></form><p class="muted">Changed your mind? Just close this page.</p>`);
    }

    // A click.
    const res = p.r ? getResource(p.r) : null;
    const msg = p.m.startsWith('msg_') ? getMessage(p.m) : null;
    const detail = res ? res.title : p.x === 'quiz' ? 'the career-fit quiz' : p.x === 'video' ? 'their programme video' : p.x === 'apply' ? 'the application' : msg?.cta.label || CTA_LABEL[p.x as keyof typeof CTA_LABEL] || 'a link';
    const human = method === 'GET' && !isBot(req.headers.get('user-agent')) && req.method !== 'HEAD';
    if (rec && human) await noteEngagement(p, 'click', detail).catch(() => null);

    const origin = url.origin;
    if (p.x === 'quiz') return NextResponse.redirect(`${origin}/fit/${token}`, 302);
    if (p.x === 'video') return NextResponse.redirect(`${origin}/watch/${token}`, 302);
    if (p.x === 'url' && p.u) return NextResponse.redirect(p.u, 302);
    if (p.x === 'apply') {
      const apply = (getTenantIntegrations(p.t).applyUrl || '').trim();
      if (/^https?:\/\//i.test(apply)) return NextResponse.redirect(apply, 302);
      return page('Let us help you apply', `<h1>Great${first ? `, ${escHtml(first)}` : ''}!</h1><p>Reply to the email you got from us and a consultant will help you start your application today.</p>`);
    }
    if ((p.x === 'res' || p.x === 'resource') && res) {
      if (res.url) return NextResponse.redirect(res.url, 302);
      if (res.fileId) {
        const f = await getFile(res.fileId);
        if (f) {
          const name = (res.fileName || `${res.title}.pdf`).replace(/[^\w .-]+/g, '').slice(0, 100) || 'guide.pdf';
          return new Response(new Uint8Array(f.data), { headers: { 'Content-Type': f.mime || 'application/pdf', 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'private, max-age=3600', 'X-Robots-Tag': 'noindex' } });
        }
      }
      return page('Not available', '<h1>This guide is not available anymore</h1><p>Reply to our email and we will send you what you need.</p>', 404);
    }
    return page(ac.academyName, `<h1>Thanks${first ? `, ${escHtml(first)}` : ''}!</h1><p>Just reply to our email with any question and we'll get back to you personally.</p>`);
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle(req, (await ctx.params).token, 'GET');
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle(req, (await ctx.params).token, 'POST');
}
