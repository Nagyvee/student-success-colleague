import AppShell from '@/components/AppShell';
import LearnersDirectory from '@/components/LearnersDirectory';
import { requireWorkspaceAccess } from '@/lib/auth/serverAuth';

export const dynamic = 'force-dynamic';

export default async function LearnersPage() {
  await requireWorkspaceAccess();
  return (
    <AppShell
      title="Students"
      subtitle="Live student roster synchronized from Moodle, Google Sheets, external LMS webhooks, or CSV import."
    >
      <LearnersDirectory />
    </AppShell>
  );
}

