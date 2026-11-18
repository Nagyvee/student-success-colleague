import AppShell from '@/components/AppShell';
import NurtureClient from '@/components/nurture/NurtureClient';
import { requireWorkspaceAccess } from '@/lib/auth/serverAuth';
import '../pages.css';

export const dynamic = 'force-dynamic';

export default async function NurturePage() {
  await requireWorkspaceAccess();
  return (
    <AppShell
      title="Lead Nurturing"
      subtitle="Admissions' marketing desk: every lead hears from us until they apply. Saved messages for everyone; AI, personal videos and vouchers where they win the sale."
    >
      <NurtureClient />
    </AppShell>
  );
}
