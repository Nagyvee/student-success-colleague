import { Suspense } from 'react';
import AppShell from '@/components/AppShell';
import AgentBuilderClient from './AgentBuilderClient';
import { requireWorkspaceAccess } from '@/lib/auth/serverAuth';

export const dynamic = 'force-dynamic';

export default async function AgentBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireWorkspaceAccess();
  const { id } = await params;
  return (
    <AppShell fullBleed>
      <Suspense fallback={null}>
        <AgentBuilderClient id={id} />
      </Suspense>
    </AppShell>
  );
}
