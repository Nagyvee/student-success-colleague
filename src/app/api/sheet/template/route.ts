import { templateCsv } from '@/lib/lms/sheet';
import { runWithSessionTenant } from '@/lib/auth/requestTenant';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* The starter Google Sheet: download, then File → Import in Google Sheets. */
export async function GET(req: Request) {
  return runWithSessionTenant(req, () => new Response(templateCsv(), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="thuso-learners.csv"' } }));
}
