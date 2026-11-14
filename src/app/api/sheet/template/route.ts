import { templateCsv } from '@/lib/lms/sheet';

export const dynamic = 'force-dynamic';

/* The starter Google Sheet: download, then File → Import in Google Sheets. */
export async function GET() {
  return new Response(templateCsv(), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="thuso-learners.csv"' } });
}
