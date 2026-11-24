import { listTenantIds } from '@/lib/auth/accounts';
import { getAcademyContext } from '@/lib/auth/accounts';
import { withTenant } from '@/lib/auth/tenantContext';
import { bootReady } from '@/lib/engine/automation';
import { readStop, stopFor } from '@/lib/outbound/outreach';
import { getCompany } from '@/lib/outbound/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* "Do not write to us again", from any B2B email. The link is signed. Opening
 * it changes nothing (mail scanners open links); the button does, and so does
 * the mail program's own one-click unsubscribe (a POST). */

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(title: string, body: string, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;font-family:Inter,system-ui,Arial,sans-serif;background:linear-gradient(135deg,#0a1733,#5e0743);color:#fff}main{max-width:460px;width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:20px;padding:32px 28px;text-align:center}h1{font-size:23px;margin:0 0 10px}p{font-size:15px;line-height:1.6;color:#dbe4ff;margin:0 0 18px}button{border:0;cursor:pointer;background:#ff7300;color:#0a1733;font:700 15px Inter,system-ui,Arial,sans-serif;padding:13px 22px;border-radius:12px}</style></head><body><main>${body}</main></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

async function handle(token: string, method: 'GET' | 'POST') {
  const t = readStop(token);
  if (!t || !listTenantIds().includes(t.tenantId)) return page('Link not found', '<h1>This link does not work</h1><p>Reply "no" to our email and we will not write again.</p>', 404);
  await bootReady(t.tenantId);
  return withTenant(t.tenantId, () => {
    const c = getCompany(t.id);
    const academy = esc(getAcademyContext().academyName);
    if (method === 'POST') {
      if (c && c.consent !== 'no') stopFor(c, 'asked us to stop');
      return page('Done', `<h1>Done</h1><p>${academy} will not write to ${c ? esc(c.name) : 'you'} again.</p>`);
    }
    return page('Stop these emails', `<h1>Stop our emails?</h1><p>${academy} will not write to ${c ? esc(c.name) : 'you'} again.</p><form method="post"><button type="submit">Yes, stop them</button></form>`);
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) { return handle((await params).token, 'GET'); }
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) { return handle((await params).token, 'POST'); }
