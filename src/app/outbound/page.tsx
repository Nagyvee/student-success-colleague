import AppShell from '@/components/AppShell';
import OutboundClient from '@/components/outbound/OutboundClient';
import { requireWorkspaceAccess } from '@/lib/auth/serverAuth';
import '../pages.css';

export const dynamic = 'force-dynamic';

export default async function OutboundPage() {
  await requireWorkspaceAccess();
  return (
    <AppShell
      title="B2B Outbound"
      subtitle="Thuso finds companies like your ideal ones, you choose, and it starts the conversation. One email until they answer, and a call when they are ready."
    >
      <OutboundClient />
    </AppShell>
  );
}
