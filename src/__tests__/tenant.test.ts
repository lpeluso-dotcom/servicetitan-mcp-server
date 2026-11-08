import { describe, expect, it } from 'vitest';
import { rewriteTenantPlaceholders } from '../tenant';
describe('tenant placeholder boundaries', () => {
 it('preserves object IDs and query values containing placeholder digits', () => {
  expect(rewriteTenantPlaceholders({ST_TENANT_ID:'123'}, '/crm/v2/tenant/000000000/customers/1000000000?reference=000000000')).toBe('/crm/v2/tenant/123/customers/1000000000?reference=000000000');
 });
 it('does not rewrite a longer tenant ID or a placeholder appearing inside query data', () => {
  expect(rewriteTenantPlaceholders({ST_TENANT_ID:'123'}, '/crm/v2/tenant/0000000001/customers')).toBe('/crm/v2/tenant/0000000001/customers');
  expect(rewriteTenantPlaceholders({ST_TENANT_ID:'123'}, '/crm/v2/tenant/456/customers?q=/crm/v2/tenant/000000000/')).toBe('/crm/v2/tenant/456/customers?q=/crm/v2/tenant/000000000/');
 });
});
