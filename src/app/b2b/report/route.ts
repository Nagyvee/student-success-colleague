import { readReport } from '@/lib/outbound/report';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* The free report our B2B emails give away: our own copy, true on the day it is
 * opened. Anyone with the link may read it. */
export async function GET() {
  try {
    const pdf = readReport();
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length),
        'Content-Disposition': 'inline; filename="The State of South African Skills Development in 2026.pdf"',
        'Cache-Control': 'public, max-age=600', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('The report is not available right now. Please try again later.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
}
