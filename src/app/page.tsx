import { Suspense } from 'react';
import AppShell from '@/components/AppShell';
import OfficeApp from '@/components/OfficeApp';
import { requireWorkspaceAccess } from '@/lib/auth/serverAuth';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await requireWorkspaceAccess();
  return (
    <AppShell fullBleed>
      <Suspense fallback={<div className="cz-boot">Opening the office…</div>}>
        <OfficeApp />
      </Suspense>
    </AppShell>
  );
}
