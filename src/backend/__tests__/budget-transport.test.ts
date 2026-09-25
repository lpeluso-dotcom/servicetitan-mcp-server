import { describe, it, expect, vi, afterEach } from 'vitest';
import { withBudget } from '../../request-budget';
import { stTransport, proxyReadUrl } from '../index';
import { clearStTokenCache } from '../st-oauth';

afterEach(() => {
  vi.unstubAllGlobals();
  clearStTokenCache();
});

describe('withBudget over the direct backend', () => {
  it('counts the call and consults the rate limiter', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).endsWith('/connect/token')
        ? new Response('{"access_token":"t","expires_in":900}')
        : new Response('{"data":[{"id":1}]}', { status: 200 }),
    ));
    const limiterFetch = vi.fn(async () => Response.json({ allowed: true }));
    const env: any = {
      ST_BACKEND: 'direct',
      ST_CLIENT_ID: 'c',
      ST_CLIENT_SECRET: 's',
      ST_APP_KEY: 'k',
      ST_TENANT_ID: '555',
      ST_RATE_LIMITER: { idFromName: (n: string) => n, get: () => ({ fetch: limiterFetch }) },
    };
    const upstream = await withBudget(env, 'owner', 5000, async (scoped, budget) => {
      const resp = await stTransport(scoped).fetch(proxyReadUrl('/crm/v2/tenant/555/customers'), { headers: {} });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ data: [{ id: 1 }] });
      return budget.upstream;
    });
    expect(upstream).toBe(1);
    expect(limiterFetch).toHaveBeenCalledTimes(1);
  });
});
