import AppShell from '@/components/AppShell';
import ReportsClient from './ReportsClient';
import { requireWorkspaceAccess } from '@/lib/auth/serverAuth';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  await requireWorkspaceAccess();
  return (
    <AppShell title="Reports" subtitle="Student recovery outcomes, quiz pass rates, and verified agent quality checks.">
      <ReportsClient />
    </AppShell>
  );
}
