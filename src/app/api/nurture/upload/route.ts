import { NextResponse } from 'next/server';
import { MANAGER_ROLES, runWithSessionTenant } from '@/lib/auth/requestTenant';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { bootReady } from '@/lib/engine/automation';
import { addPdf, importWhatsApp } from '@/lib/nurture/bank';
import { MAX_FILE_BYTES, MAX_VIDEO_BYTES } from '@/lib/files/store';
import { addMedia } from '@/lib/nurture/media';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 180;

/* Upload to the content bank (multipart form):
 *   file   a PDF guide, or a WhatsApp chat export (.txt, or the .zip WhatsApp makes is not read: export "without media" as text)
 *   kind   "pdf" | "whatsapp"
 *   title  optional
 * A WhatsApp export is read once for the questions leads ask; the file itself is not kept. */

export async function POST(req: Request) {
  return runWithSessionTenant(req, async () => {
    await bootReady(currentTenantId());
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!form || !file || typeof file === 'string') return NextResponse.json({ error: 'Choose a file to upload.' }, { status: 400 });
    const kind = String(form.get('kind') || (/\.pdf$/i.test(file.name) ? 'pdf' : 'whatsapp'));
    const limit = kind === 'media' ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
    if (file.size > limit) return NextResponse.json({ error: `That file is too big (limit ${Math.round(limit / 1048576)} MB). Short clips of 5 to 15 seconds work best.` }, { status: 413 });
    const title = String(form.get('title') || '').trim() || undefined;
    const data = Buffer.from(await file.arrayBuffer());
    try {
      if (kind === 'media') {
        const tags = String(form.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);
        const m = await addMedia({ name: file.name, mime: file.type, data }, { title, tags });
        return NextResponse.json({ ok: true, media: m });
      }
      if (kind === 'pdf') {
        const r = await addPdf({ name: file.name, mime: file.type || 'application/pdf', data }, title);
        return NextResponse.json({ ok: true, resource: { ...r, text: undefined } });
      }
      if (/\.zip$/i.test(file.name)) return NextResponse.json({ error: 'Export the chat "Without media" and upload the .txt file inside.' }, { status: 400 });
      const r = await importWhatsApp(data.toString('utf8'), title);
      return NextResponse.json({ ok: true, faqs: r.faqs });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }, { roles: MANAGER_ROLES });
}
