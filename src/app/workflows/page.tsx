import { Suspense } from 'react';
import AppShell from '@/components/AppShell';
import WorkflowsClient from './WorkflowsClient';
import { requireWorkspaceAccess } from '@/lib/auth/serverAuth';

export const dynamic = 'force-dynamic';

export default async function WorkflowsPage() {
  await requireWorkspaceAccess();
  return (
    <AppShell title="Agents & Workflows" subtitle="Every floor is a department. Every agent has one job, built from steps the AI carries out.">
      <Suspense fallback={null}>
        <WorkflowsClient />
      </Suspense>
    </AppShell>
  );
}
