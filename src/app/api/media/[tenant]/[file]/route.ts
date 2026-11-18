import { NextResponse } from 'next/server';
import { listTenantIds } from '@/lib/auth/accounts';
import { withTenant } from '@/lib/auth/tenantContext';
import { bootReady } from '@/lib/engine/automation';
import { getFile } from '@/lib/files/store';
import { mediaDoc } from '@/lib/nurture/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* Footage and music for the videos, served to the player (public, like the
 * videos themselves; only files in the academy's footage library are served).
 * Range requests are answered, so clips start at once and can be skipped through. */

export async function GET(req: Request, ctx: { params: Promise<{ tenant: string; file: string }> }) {
  const { tenant, file } = await ctx.params;
  if (!listTenantIds().includes(tenant) || !/^f_[a-z0-9]+$/.test(file)) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  await bootReady(tenant);
  return withTenant(tenant, async () => {
    const item = mediaDoc.get(tenant).find((m) => m.fileId === file && m.enabled);
    if (!item) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    const f = await getFile(file, tenant);
    if (!f) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    const size = f.data.length;
    const headers: Record<string, string> = {
      'Content-Type': f.mime || item.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
      'X-Robots-Tag': 'noindex',
    };
    const range = req.headers.get('range');
    const m = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      if (!m[1]) end = size - 1;
      start = Math.max(0, Math.min(start, size - 1));
      end = Math.max(start, Math.min(end, size - 1));
      return new Response(new Uint8Array(f.data.subarray(start, end + 1)), {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
      });
    }
    return new Response(new Uint8Array(f.data), { headers: { ...headers, 'Content-Length': String(size) } });
  });
}
