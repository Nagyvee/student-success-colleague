import { NextResponse } from 'next/server';
import { listTenantIds } from '@/lib/auth/accounts';
import { withTenant } from '@/lib/auth/tenantContext';
import { bootReady } from '@/lib/engine/automation';
import { getFile } from '@/lib/files/store';
import { mediaDoc } from '@/lib/nurture/store';
import { serveMedia } from '@/lib/media/serve';

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
    return serveMedia(req, f.data, {
      'Content-Type': f.mime || item.mime,
      'Cache-Control': 'public, max-age=2592000, immutable',
      'X-Robots-Tag': 'noindex',
    });
  });
}
