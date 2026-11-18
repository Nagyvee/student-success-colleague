import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SESSION_COOKIE,
  findTenantBySlugOrId,
  getTenantIntegrations,
  getTenantSummary,
  hydrateAuthFromDb,
  verifySessionToken,
  type SessionPayload,
} from './accounts';

export async function getServerSession(): Promise<{
  session: SessionPayload;
  onboardingCompleted: boolean;
} | null> {
  await hydrateAuthFromDb();
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value || null;
  const session = verifySessionToken(token);
  if (!session || !findTenantBySlugOrId(session.tenantId)) return null;
  const ti = getTenantIntegrations(session.tenantId);
  const summary = getTenantSummary(session.tenantId);
  return {
    session,
    onboardingCompleted: Boolean(ti.onboardingCompleted ?? summary.onboardingCompleted),
  };
}

export async function requireWorkspaceAccess(opts?: { allowIncompleteOnboarding?: boolean }): Promise<SessionPayload> {
  const auth = await getServerSession();
  if (!auth) redirect('/login');
  if (!opts?.allowIncompleteOnboarding && !auth.onboardingCompleted) {
    redirect('/onboarding');
  }
  return auth.session;
}
