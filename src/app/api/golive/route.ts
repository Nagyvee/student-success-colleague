import { NextResponse } from 'next/server';
import { runWithSessionTenant } from '@/lib/auth/requestTenant';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { bootReady } from '@/lib/engine/automation';
import { ensureDepartmentModel } from '@/lib/engine/departments';
import { readiness } from '@/lib/readiness';
import { pingDb } from '@/lib/db/postgres';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* GET: the go-live checklist, read from the live workspace (secrets are never returned, only whether they are set). */
export async function GET(req: Request) {
  return runWithSessionTenant(req, async () => {
    await bootReady(currentTenantId());
    ensureDepartmentModel();
    return NextResponse.json(readiness(currentTenantId(), await pingDb()));
  });
}
