import { describe, it, expect, vi } from 'vitest';
import { readST, readSTPost } from '../st';

const CTX = { actor: 'v', correlation: 'c' };
function envWith404(): any {
  return {
    ST_TENANT_ID: '999888777',
    LEGACY_TEST_KEY: 'k', MCP_SERVICE_VERSION: '0',
    ST_TRANSPORT: { fetch: vi.fn(async () => new Response('nope', { status: 404 })) },
  };
}

describe('st error logging', () => {
  it('readST error shows the resolved tenant, not the placeholder', async () => {
    await expect(readST(envWith404(), CTX, '/accounting/v2/tenant/000000000/invoices/1'))
      .rejects.toThrow('999888777');
  });
  it('readSTPost error shows the resolved tenant, not the placeholder', async () => {
    await expect(readSTPost(envWith404(), CTX, '/dispatch/v2/tenant/000000000/capacity', {}))
      .rejects.toThrow('999888777');
  });
});
