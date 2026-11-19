import { requireWorkspaceAccess } from '@/lib/auth/serverAuth';
import OnboardingWizard from '@/components/OnboardingWizard';
import '../pages.css';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  await requireWorkspaceAccess({ allowIncompleteOnboarding: true });
  return <OnboardingWizard />;
}

