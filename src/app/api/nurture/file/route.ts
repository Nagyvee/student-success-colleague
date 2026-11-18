import { NextResponse } from 'next/server';
import { runWithSessionTenant } from '@/lib/auth/requestTenant';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { bootReady } from '@/lib/engine/automation';
import { getResource } from '@/lib/nurture/bank';
import { getFile } from '@/lib/files/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* An uploaded guide, for the team to open (leads get it through their tracked link). */
export async function GET(req: Request) {
  return runWithSessionTenant(req, async () => {
    await bootReady(currentTenantId());
    const r = getResource(new URL(req.url).searchParams.get('id') || '');
    if (!r?.fileId) return NextResponse.json({ error: 'No such file.' }, { status: 404 });
    const f = await getFile(r.fileId);
    if (!f) return NextResponse.json({ error: 'The file is missing.' }, { status: 404 });
    const name = (r.fileName || `${r.title}.pdf`).replace(/[^\w .-]+/g, '').slice(0, 100) || 'guide.pdf';
    return new Response(new Uint8Array(f.data), { headers: { 'Content-Type': f.mime, 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'private, no-store' } });
  });
}
