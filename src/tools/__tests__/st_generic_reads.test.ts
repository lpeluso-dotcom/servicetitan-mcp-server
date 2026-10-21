import { describe, it, expect, vi } from 'vitest';
import { st_list_jobs } from '../st_list_jobs';
import { st_list_customers } from '../st_list_customers';
import { st_get_customer } from '../st_get_customer';
import { st_list_appointments } from '../st_list_appointments';
import { PUBLIC_TOOLS } from '../public-registry';
import { McpError } from '../../errors';

const ctx = { actor: 'test', correlation: 'c1' };

function fakeEnv(respond: (url: string) => { body: unknown; status?: number }) {
  const fetcher = vi.fn(async (url: string) => {
    const { body, status = 200 } = respond(url);
    return new Response(JSON.stringify(body), { status });
  });
  return { ST_TENANT_ID: '000000000', ST_TRANSPORT: { fetch: fetcher }, LEGACY_TEST_KEY: 'k' } as any;
}

function calledUrls(env: any): string[] {
  return (env.ST_TRANSPORT.fetch as any).mock.calls.map((c: unknown[]) => decodeURIComponent(decodeURIComponent(c[0] as string)));
}

describe('st_list_jobs', () => {
  it('forwards the jobs path, status and modified filters, and paging', async () => {
    const env = fakeEnv(() => ({ body: { data: [{ id: 1 }], hasMore: false } }));
    await st_list_jobs.handler(
      env,
      { jobStatus: 'Scheduled', modifiedOnOrAfter: '2026-10-01T00:00:00Z', customerId: 55, page: 2, pageSize: 25 },
      ctx,
    );
    const url = calledUrls(env)[0];
    expect(url).toContain('/jpm/v2/tenant/000000000/jobs');
    expect(url).toContain('jobStatus=Scheduled');
    expect(url).toContain('modifiedOnOrAfter=2026-10-01T00:00:00Z');
    expect(url).toContain('customerId=55');
    expect(url).toContain('page=2');
    expect(url).toContain('pageSize=25');
  });

  it('defaults to page 1, size 50 and clamps size at 200', async () => {
    const env = fakeEnv(() => ({ body: { data: [] } }));
    await st_list_jobs.handler(env, {}, ctx);
    await st_list_jobs.handler(env, { pageSize: 999 }, ctx);
    const [first, second] = calledUrls(env);
    expect(first).toContain('page=1');
    expect(first).toContain('pageSize=50');
    expect(second).toContain('pageSize=200');
  });

  it('surfaces hasMore: true from a paged response instead of dropping it', async () => {
    const env = fakeEnv(() => ({ body: { data: [{ id: 1 }, { id: 2 }], hasMore: true, totalCount: 900 } }));
    const raw = await st_list_jobs.handler(env, { pageSize: 2 }, ctx);
    const out = st_list_jobs.transformResult!(raw as any) as any;
    expect(out.hasMore).toBe(true);
    expect(out.totalCount).toBe(900);
    expect(out.data).toHaveLength(2);
  });

  it('rejects a pageSize above 200 in the schema', () => {
    const schema = (st_list_jobs.zodSchema as any).pageSize;
    expect(schema.safeParse(201).success).toBe(false);
  });
});

describe('st_list_customers', () => {
  it('forwards modifiedOnOrAfter and paging to the customers path', async () => {
    const env = fakeEnv(() => ({ body: { data: [], hasMore: true } }));
    const raw = (await st_list_customers.handler(
      env,
      { modifiedOnOrAfter: '2026-10-05T00:00:00Z', page: 3 },
      ctx,
    )) as any;
    const url = calledUrls(env)[0];
    expect(url).toContain('/crm/v2/tenant/000000000/customers');
    expect(url).toContain('modifiedOnOrAfter=2026-10-05T00:00:00Z');
    expect(url).toContain('page=3');
    expect(raw.hasMore).toBe(true);
  });
});

describe('st_get_customer', () => {
  it('reads the customer by id', async () => {
    const env = fakeEnv(() => ({ body: { id: 42, name: 'Test Customer' } }));
    const out = (await st_get_customer.handler(env, { customerId: 42 }, ctx)) as any;
    expect(calledUrls(env)[0]).toContain('/crm/v2/tenant/000000000/customers/42');
    expect(out).toEqual({ id: 42, name: 'Test Customer' });
  });

  it('turns an upstream 404 into a not_found tool error', async () => {
    const env = fakeEnv(() => ({ body: { title: 'Not Found' }, status: 404 }));
    const err: any = await st_get_customer.handler(env, { customerId: 999 }, ctx).catch((e: any) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.toResponse()).toMatchObject({ ok: false, code: 'not_found', correlation: 'c1' });
  });

  it('requires a numeric customerId in the handler', async () => {
    const env = fakeEnv(() => ({ body: {} }));
    const err: any = await st_get_customer.handler(env, {} as any, ctx).catch((e: any) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.toResponse()).toMatchObject({ code: 'validation_error' });
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });
});

describe('st_list_appointments', () => {
  it('forwards date range, technician, job and active filters', async () => {
    const env = fakeEnv(() => ({ body: { data: [], hasMore: false } }));
    await st_list_appointments.handler(
      env,
      {
        startsOnOrAfter: '2026-10-21T00:00:00Z',
        startsBefore: '2026-10-22T00:00:00Z',
        technicianId: 7,
        jobId: 88,
        active: true,
      },
      ctx,
    );
    const url = calledUrls(env)[0];
    expect(url).toContain('/jpm/v2/tenant/000000000/appointments');
    expect(url).toContain('startsOnOrAfter=2026-10-21T00:00:00Z');
    expect(url).toContain('startsBefore=2026-10-22T00:00:00Z');
    expect(url).toContain('technicianId=7');
    expect(url).toContain('jobId=88');
    expect(url).toContain('active=True');
  });

  it('sends active=False for false and omits active when unset', async () => {
    const env = fakeEnv(() => ({ body: { data: [] } }));
    await st_list_appointments.handler(env, { active: false }, ctx);
    await st_list_appointments.handler(env, {}, ctx);
    const [withFalse, without] = calledUrls(env);
    expect(withFalse).toContain('active=False');
    expect(without).not.toContain('active=');
  });
});

describe('registry', () => {
  it('registers the four generic reads as read-only tools', () => {
    for (const name of ['st_list_jobs', 'st_list_customers', 'st_get_customer', 'st_list_appointments']) {
      const t = PUBLIC_TOOLS.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t!.isWrite).toBe(false);
    }
  });
});
