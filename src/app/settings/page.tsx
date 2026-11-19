import AppShell from '@/components/AppShell';
import SettingsClient from './SettingsClient';
import { requireWorkspaceAccess } from '@/lib/auth/serverAuth';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await requireWorkspaceAccess();
  return (
    <AppShell title="Settings" subtitle="Agent instructions, approval gate, tutoring language, and workspace preferences.">
      <SettingsClient />
    </AppShell>
  );
}
