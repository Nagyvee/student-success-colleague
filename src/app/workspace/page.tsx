import AppShell from '@/components/AppShell';
import { requireWorkspaceAccess } from '@/lib/auth/serverAuth';
import WorkspaceClient from './WorkspaceClient';

export const dynamic = 'force-dynamic';

export default async function WorkspacePage() {
  await requireWorkspaceAccess();
  return (
    <AppShell
      title="Channels & API"
      subtitle="Connect your LMS or signed webhooks, own SMTP email, WhatsApp, ManyChat API, and team members"
    >
      <WorkspaceClient />
    </AppShell>
  );
}
