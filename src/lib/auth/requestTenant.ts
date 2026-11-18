import { NextResponse } from 'next/server';
import { DEFAULT_TENANT_ID, withTenant } from './tenantContext';
import {
  findTenantBySlugOrId,
  hydrateAuthFromDb,
  listTenantIds,
  sessionFromRequest,
  verifyInboundToken,
  type SessionPayload,
} from './accounts';
import { findQuiz } from '@/lib/engine/quiz';

/* How a request finds its workspace.
 *
 * Staff APIs need a signed-in session: no cookie, no data. There is no
 * fallback to a default workspace, so an anonymous caller can never read
 * learners, approve outreach or change integrations.
 *
 * Webhooks name their workspace (?tenant=slug or X-Tenant-Slug) and prove
 * who they are with a signature or the workspace's inbound token. */

const unauthorized = () => NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
const forbidden = () => NextResponse.json({ error: 'Your role cannot do that. Ask a workspace owner or admin.' }, { status: 403 });

export async function runWithSessionTenant<T>(
  req: Request,
  fn: (session: SessionPayload) => T | Promise<T>,
  opts: { roles?: SessionPayload['role'][] } = {},
): Promise<T | Response> {
  await hydrateAuthFromDb();
  const s = sessionFromRequest(req);
  if (!s) return unauthorized();
  if (opts.roles && !opts.roles.includes(s.role)) return forbidden();
  return withTenant(s.tenantId, () => fn(s));
}

/** Staff roles that may change integrations, workflows and team settings. */
export const MANAGER_ROLES: SessionPayload['role'][] = ['owner', 'admin'];

/** Resolve the workspace a webhook is addressed to. Unknown names fall back to
 *  the default workspace only when no name was given at all. */
export async function resolveWebhookTenant(req: Request): Promise<{ tenantId: string; named: boolean } | null> {
  await hydrateAuthFromDb();
  const url = new URL(req.url);
  const key = url.searchParams.get('tenant') || req.headers.get('x-tenant-slug') || req.headers.get('x-tenant-id');
  if (key) {
    const tenant = findTenantBySlugOrId(key);
    return tenant ? { tenantId: tenant.id, named: true } : null;
  }
  const s = sessionFromRequest(req);
  return { tenantId: s?.tenantId || DEFAULT_TENANT_ID, named: false };
}

/** For signed webhooks (the signature is checked inside with the tenant's secret). */
export async function runWithWebhookTenant<T>(req: Request, fn: (tenantId: string) => T | Promise<T>): Promise<T | Response> {
  const t = await resolveWebhookTenant(req);
  if (!t) return NextResponse.json({ error: 'Unknown workspace.' }, { status: 404 });
  return withTenant(t.tenantId, () => fn(t.tenantId));
}

/** For webhooks from tools that cannot sign (Zapier, Make, email forwarders):
 *  a signed-in staff session, or the workspace's inbound token. */
export async function runWithInboundAuth<T>(req: Request, fn: (tenantId: string) => T | Promise<T>): Promise<T | Response> {
  await hydrateAuthFromDb();
  const s = sessionFromRequest(req);
  const t = await resolveWebhookTenant(req);
  if (!t) return NextResponse.json({ error: 'Unknown workspace.' }, { status: 404 });
  const tenantId = s && !t.named ? s.tenantId : t.tenantId;
  const allowed = (s && s.tenantId === tenantId) || verifyInboundToken(req, tenantId);
  if (!allowed) return NextResponse.json({ error: 'Missing or wrong token. Send the workspace inbound token as X-Thuso-Token or ?token=.' }, { status: 401 });
  return withTenant(tenantId, () => fn(tenantId));
}

export async function findTenantForQuiz(quizId: string): Promise<string> {
  await hydrateAuthFromDb();
  for (const tid of listTenantIds()) {
    const found = withTenant(tid, () => findQuiz(quizId));
    if (found) return tid;
  }
  return DEFAULT_TENANT_ID;
}
