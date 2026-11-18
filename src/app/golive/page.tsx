import AppShell from '@/components/AppShell';
import GoLiveClient from './GoLiveClient';
import { requireWorkspaceAccess } from '@/lib/auth/serverAuth';
import '../pages.css';
import './golive.css';

export const dynamic = 'force-dynamic';

export default async function GoLivePage() {
  await requireWorkspaceAccess();
  return (
    <AppShell title="Go-live checklist" subtitle="What is connected, what is missing, and where to fix it. Read from the live workspace.">
      <GoLiveClient />
    </AppShell>
  );
}
