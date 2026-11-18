import { AsyncLocalStorage } from 'node:async_hooks';

/* Request-scoped tenant isolation.
 *
 * Every store, workflow list, follow-up scheduler, sheet poller, and DB query
 * reads currentTenantId() so multiple academies (Melsoft or any other school)
 * run inside completely isolated workspaces in the same server process. */

const g = globalThis as unknown as { __thusoTenantAls?: AsyncLocalStorage<string> };
const als = (g.__thusoTenantAls ??= new AsyncLocalStorage<string>());

export const DEFAULT_TENANT_ID = 'default';

export function currentTenantId(): string {
  return als.getStore() || DEFAULT_TENANT_ID;
}

export function withTenant<T>(tenantId: string, fn: () => T): T {
  return als.run(tenantId || DEFAULT_TENANT_ID, fn);
}

