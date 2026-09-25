import type { Env } from './env';

export const PUBLIC_TENANT_ID_PLACEHOLDER = '000000000';

function configuredTenantId(env: Pick<Env, 'ST_TENANT_ID'>): string {
  const tenantId = env.ST_TENANT_ID?.trim();
  return tenantId || PUBLIC_TENANT_ID_PLACEHOLDER;
}

export function rewriteTenantPlaceholders(
  env: Pick<Env, 'ST_TENANT_ID'>,
  value: string
): string {
  const tenantId = configuredTenantId(env);
  if (tenantId === PUBLIC_TENANT_ID_PLACEHOLDER) return value;
  return value.replaceAll(PUBLIC_TENANT_ID_PLACEHOLDER, tenantId);
}
