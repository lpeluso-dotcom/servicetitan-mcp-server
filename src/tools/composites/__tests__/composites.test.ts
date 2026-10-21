import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { customer_snapshot } from '../customer_snapshot';
import { job_closeout_report } from '../job_closeout_report';
import { gatherFetchesWithTruncation } from '../composite-helpers';
import { PUBLIC_TOOLS } from '../../public-registry';
import { filterToolsForRole } from '../../role-filter';

const CTX = { actor: 'vitest', correlation: 'test-corr' };

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  const rateLimiterDO = {
    idFromName: vi.fn().mockReturnValue('rl-id'),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(
        async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }),
      ),
    }),
  };
  return {
    ST_TENANT_ID: '000000000',
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_TRANSPORT: { fetch: vi.fn(fetchImpl) },
    ST_RATE_LIMITER: rateLimiterDO,
  };
}

function liveOk(data: unknown) {
  return async () => new Response(JSON.stringify({ data }), { status: 200 });
}

/** Decoded ServiceTitan endpoints the transport was asked to read. */
function endpoints(env: any): string[] {
  return (env.ST_TRANSPORT.fetch as any).mock.calls.map((c: unknown[]) => {
    const u = new URL(c[0] as string);
    return u.searchParams.get('endpoint') as string;
  });
}

function endpointOf(url: string): string {
  return new URL(url).searchParams.get('endpoint') ?? '';
}

describe('customer_snapshot', () => {
  it('requires customerId', () => {
    const schema = z.object(customer_snapshot.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('is a staff-level read tool', () => {
    expect(customer_snapshot.isWrite).toBe(false);
    expect(customer_snapshot.permission).toBe('staff');
  });

  it('reads the customer and the customer invoices in parallel, plus the other four sections', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    const eps = endpoints(env);
    expect(eps).toHaveLength(6);
    expect(eps).toContain('/crm/v2/tenant/000000000/customers/100');
    expect(eps).toContain('/accounting/v2/tenant/000000000/invoices?customerId=100');
    expect(eps).toContain('/crm/v2/tenant/000000000/locations?customerId=100');
    expect(eps).toContain('/jpm/v2/tenant/000000000/jobs?customerId=100');
    expect(eps).toContain('/sales/v2/tenant/000000000/estimates?customerId=100');
    expect(eps).toContain('/memberships/v2/tenant/000000000/memberships?customerId=100&status=Active');
    expect(result.customerId).toBe(100);
    for (const k of ['customer', 'locations', 'jobs', 'memberships', 'estimates', 'invoices']) {
      expect(result).toHaveProperty(k);
    }
    expect(result._partial).toBe(false);
    expect(result._failures).toEqual([]);
    expect(result._source).toBe('live');
  });

  it('resolves the tenant placeholder to the configured tenant id', async () => {
    const env = makeEnv(liveOk([]));
    env.ST_TENANT_ID = '123456789';
    await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    expect(endpoints(env)).toContain('/crm/v2/tenant/123456789/customers/100');
  });

  it('keeps only Active memberships (ServiceTitan status filter is unreliable)', async () => {
    const env = makeEnv(async (url: string) => {
      const ep = endpointOf(url);
      const data = ep.includes('/memberships/v2/')
        ? [{ id: 1, status: 'Active' }, { id: 2, status: 'Expired' }]
        : [];
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const result: any = await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    expect(result.memberships).toEqual([{ id: 1, status: 'Active' }]);
  });

  it('returns a partial result, not a thrown error, when one sub-read fails', async () => {
    const env = makeEnv(async (url: string) => {
      if (endpointOf(url).includes('/memberships/v2/')) {
        return new Response('fail', { status: 503, statusText: 'Bad Gateway' });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const result: any = await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    expect(result._partial).toBe(true);
    expect(result._failures).toHaveLength(1);
    expect(result._failures[0]).toMatchObject({ call: 'memberships', error_class: 'HTTPError' });
    expect(result.memberships).toBeNull();
    expect(result.customer).toEqual([]);
  });

  it('marks the customer section as an error on a 404 instead of throwing', async () => {
    const env = makeEnv(async (url: string) => {
      if (endpointOf(url).endsWith('/customers/999')) {
        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const result: any = await customer_snapshot.handler(env, { customerId: 999 }, CTX);
    expect(result._partial).toBe(true);
    expect(result.customer).toBeNull();
    expect(result._failures[0]).toMatchObject({ call: 'customer', error_class: 'HTTPError' });
    expect(result._failures[0].message).toContain('404');
  });

  it('discloses _truncated arms when a sub-read has more pages', async () => {
    const env = makeEnv(async (url: string) => {
      if (endpointOf(url).includes('/jpm/v2/')) {
        return new Response(JSON.stringify({ data: [{ id: 1 }], hasMore: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [], hasMore: false }), { status: 200 });
    });
    const result: any = await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    expect(result._truncated).toEqual(['jobs']);
    expect(result._partial).toBe(false);
  });

  it('_truncated is empty when every arm is complete', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    expect(result._truncated).toEqual([]);
  });

  // A partial snapshot is never reused: the next call re-reads every section
  // and recovers the one that failed.
  it('does not serve a previous partial snapshot; the next call re-reads and recovers', async () => {
    let membershipsFail = true;
    const env = makeEnv(async (url: string) => {
      if (membershipsFail && endpointOf(url).includes('/memberships/v2/')) {
        return new Response('unavailable', { status: 503 });
      }
      return new Response(JSON.stringify({ data: [], hasMore: false }), { status: 200 });
    });

    const first: any = await customer_snapshot.handler(env, { customerId: 42 }, CTX);
    expect(first._partial).toBe(true);
    expect(first.memberships).toBeNull();
    expect(env.ST_TRANSPORT.fetch).toHaveBeenCalledTimes(6);

    membershipsFail = false;
    const second: any = await customer_snapshot.handler(env, { customerId: 42 }, { ...CTX, correlation: 'next-corr' });
    expect(env.ST_TRANSPORT.fetch).toHaveBeenCalledTimes(12);
    expect(second._partial).toBe(false);
    expect(second._failures).toEqual([]);
    expect(second.memberships).toEqual([]);
    expect(second.correlation).toBe('next-corr');
  });

  it('routes the fanout through the rate limiter', async () => {
    const env = makeEnv(liveOk([]));
    await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    const rlStub = env.ST_RATE_LIMITER.get.mock.results[0]?.value;
    expect(env.ST_RATE_LIMITER.get).toHaveBeenCalled();
    expect(rlStub.fetch).toHaveBeenCalled();
  });

  it('transformResult caps long lists', () => {
    const jobs = Array.from({ length: 40 }, (_, i) => ({ id: i }));
    const out: any = customer_snapshot.transformResult!({ customerId: 1, jobs });
    expect(out.jobs).toHaveLength(25);
  });
});

describe('job_closeout_report', () => {
  it('requires jobId', () => {
    const schema = z.object(job_closeout_report.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('reads the job, its appointments, and its invoices', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await job_closeout_report.handler(env, { jobId: 500 }, CTX);
    const eps = endpoints(env);
    expect(eps).toHaveLength(3);
    expect(eps).toContain('/jpm/v2/tenant/000000000/jobs/500');
    expect(eps).toContain('/jpm/v2/tenant/000000000/appointments?jobId=500');
    expect(eps).toContain('/accounting/v2/tenant/000000000/invoices?jobId=500');
    expect(result.jobId).toBe(500);
    expect(result).toHaveProperty('job');
    expect(result).toHaveProperty('appointments');
    expect(result).toHaveProperty('invoice');
    expect(result._partial).toBe(false);
    expect(result._source).toBe('live');
  });

  it('returns a partial result when an inner fetch rejects', async () => {
    let n = 0;
    const env = makeEnv(async () => {
      n++;
      if (n === 2) throw new TypeError('socket reset');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const result: any = await job_closeout_report.handler(env, { jobId: 500 }, CTX);
    expect(result._partial).toBe(true);
    expect(result._failures).toEqual([
      { call: 'appointments', error_class: 'TypeError', message: 'socket reset' },
    ]);
    expect(result.appointments).toBeNull();
  });

  it('marks the job section as an error on a 404 instead of throwing', async () => {
    const env = makeEnv(async (url: string) => {
      if (endpointOf(url).endsWith('/jobs/404')) {
        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const result: any = await job_closeout_report.handler(env, { jobId: 404 }, CTX);
    expect(result._partial).toBe(true);
    expect(result.job).toBeNull();
    expect(result._failures[0]).toMatchObject({ call: 'job', error_class: 'HTTPError' });
  });

  it('preserves the full invoices array and counts them (no silent 1:N collapse)', async () => {
    const env = makeEnv(async (url: string) => {
      if (endpointOf(url).includes('/accounting/v2/')) {
        return new Response(
          JSON.stringify({ data: [{ id: 1, type: 'base' }, { id: 2, type: 'adjustment' }], hasMore: false }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const result: any = await job_closeout_report.handler(env, { jobId: 500 }, CTX);
    expect(result.invoice).toEqual({ id: 1, type: 'base' });
    expect(result.invoices).toEqual([{ id: 1, type: 'base' }, { id: 2, type: 'adjustment' }]);
    expect(result._invoice_count).toBe(2);
  });

  it('discloses _truncated when the invoices list itself has more pages', async () => {
    const env = makeEnv(async (url: string) => {
      if (endpointOf(url).includes('/accounting/v2/')) {
        return new Response(JSON.stringify({ data: [{ id: 1 }], hasMore: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const result: any = await job_closeout_report.handler(env, { jobId: 500 }, CTX);
    expect(result._truncated).toContain('invoices');
  });

  it('routes the closeout fanout through the rate limiter', async () => {
    const env = makeEnv(liveOk([]));
    await job_closeout_report.handler(env, { jobId: 500 }, CTX);
    expect(env.ST_RATE_LIMITER.get).toHaveBeenCalled();
  });
});

describe('gatherFetchesWithTruncation', () => {
  function resp(body: unknown): Promise<Response> {
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }

  it('flags arms with hasMore:true and returns .data as results', async () => {
    const out = await gatherFetchesWithTruncation([
      { name: 'jobs', promise: resp({ data: [{ id: 1 }], hasMore: true }) },
      { name: 'invoices', promise: resp({ data: [{ id: 2 }], hasMore: false }) },
      { name: 'locations', promise: resp({ data: [{ id: 3 }] }) },
    ]);
    expect(out.results.jobs).toEqual([{ id: 1 }]);
    expect(out.results.invoices).toEqual([{ id: 2 }]);
    expect(out.results.locations).toEqual([{ id: 3 }]);
    expect(out.truncated).toEqual(['jobs']);
    expect(out.partial).toBe(false);
    expect(out.failures).toEqual([]);
  });

  it('returns the whole body when there is no data wrapper', async () => {
    const out = await gatherFetchesWithTruncation([{ name: 'a', promise: resp({ id: 42 }) }]);
    expect(out.results.a).toEqual({ id: 42 });
    expect(out.truncated).toEqual([]);
  });

  it('a failed arm is not in truncated and is reported in failures', async () => {
    const out = await gatherFetchesWithTruncation([
      { name: 'jobs', promise: resp({ data: [], hasMore: true }) },
      { name: 'invoices', promise: Promise.resolve(new Response('x', { status: 503, statusText: 'Bad Gateway' })) },
    ]);
    expect(out.truncated).toEqual(['jobs']);
    expect(out.partial).toBe(true);
    expect(out.failures[0]).toMatchObject({ call: 'invoices', error_class: 'HTTPError' });
    expect(out.results.invoices).toBeNull();
  });

  it('reports a rejected promise and a malformed body by class', async () => {
    const out = await gatherFetchesWithTruncation([
      { name: 'a', promise: Promise.reject(new TypeError('socket timeout')) },
      { name: 'b', promise: Promise.resolve(new Response('not-json', { status: 200 })) },
      { name: 'c', promise: resp({ data: 'ok' }) },
    ]);
    expect(out.partial).toBe(true);
    expect(out.failures.map((f) => f.call)).toEqual(['a', 'b']);
    expect(out.failures[0]).toMatchObject({ error_class: 'TypeError', message: 'socket timeout' });
    expect(out.failures[1]).toMatchObject({ error_class: 'JSONParseError' });
    expect(out.results.c).toBe('ok');
  });

  it('returns empty results on empty input', async () => {
    const out = await gatherFetchesWithTruncation([]);
    expect(out).toEqual({ results: {}, partial: false, failures: [], truncated: [] });
  });
});

describe('composite registry wiring', () => {
  it('registers both composites and keeps them visible to the readonly role', () => {
    const names = PUBLIC_TOOLS.map((t) => t.name);
    expect(names).toContain('customer_snapshot');
    expect(names).toContain('job_closeout_report');
    const readonly = filterToolsForRole(PUBLIC_TOOLS, 'readonly').map((t) => t.name);
    expect(readonly).toContain('customer_snapshot');
    expect(readonly).toContain('job_closeout_report');
  });
});
