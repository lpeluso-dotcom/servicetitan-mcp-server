import { describe, it, expect, vi } from 'vitest';
import { get_customer_membership } from '../crm/get_customer_membership';
import { list_memberships_active } from '../memberships/list_memberships_active';
import { list_memberships_expiring } from '../memberships/list_memberships_expiring';
import { customer_snapshot } from '../composites/customer_snapshot';

const CTX = { actor: 'vitest', correlation: 'test-corr' };
const DAY = 24 * 60 * 60 * 1000;

function makeEnv(fetchImpl: (url: string) => Promise<Response>): any {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  return {
    ST_TRANSPORT: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: { prepare: vi.fn().mockReturnValue(stmt) },
    STATE_KV: {},
    CUSTOMER_SNAPSHOT_FLIGHT: {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ acquired: true }), { status: 200 })),
      }),
    },
  };
}

function page(data: unknown[], hasMore = false) {
  return new Response(JSON.stringify({ data, hasMore }), { status: 200 });
}

/** Query params of the ST call, decoded out of the proxy URL. */
function stParams(url: string): URLSearchParams {
  const decoded = decodeURIComponent(url);
  const q = decoded.lastIndexOf('?');
  return new URLSearchParams(q === -1 ? '' : decoded.slice(q + 1));
}

function membershipCalls(env: any): URLSearchParams[] {
  return env.ST_TRANSPORT.fetch.mock.calls
    .map(([u]: [string]) => u)
    .filter((u: string) => decodeURIComponent(u).includes('/memberships/v2/'))
    .map(stParams);
}

describe('get_customer_membership', () => {
  it('sends customerIds (the param ST honors), never customerId', async () => {
    const env = makeEnv(async () => page([{ id: 1, customerId: 101, status: 'Active' }]));
    await get_customer_membership.handler(env, { customerId: 101 }, CTX);
    const [q] = membershipCalls(env);
    expect(q.get('customerIds')).toBe('101');
    expect(q.has('customerId')).toBe(false);
  });

  it('fails loudly when ST returns another customer\'s memberships', async () => {
    const env = makeEnv(async () => page([
      { id: 1, customerId: 103, status: 'Active' },
      { id: 2, customerId: 105, status: 'Active' },
    ]));
    await expect(get_customer_membership.handler(env, { customerId: 101 }, CTX))
      .rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('active:true filters on the status enum, not ST\'s soft-delete flag', async () => {
    const env = makeEnv(async () => page([
      { id: 1, customerId: 101, status: 'Active' },
      { id: 2, customerId: 101, status: 'Expired' },
    ]));
    const result: any = await get_customer_membership.handler(env, { customerId: 101, active: true }, CTX);
    const [q] = membershipCalls(env);
    expect(q.get('status')).toBe('Active');
    expect(q.has('active')).toBe(false);
    expect(result.memberships.map((m: any) => m.id)).toEqual([1]);
  });

  it('active:false returns every status and does not ask ST for deleted-only rows', async () => {
    const env = makeEnv(async () => page([
      { id: 1, customerId: 101, status: 'Active' },
      { id: 2, customerId: 101, status: 'Expired' },
    ]));
    const result: any = await get_customer_membership.handler(env, { customerId: 101, active: false }, CTX);
    const [q] = membershipCalls(env);
    expect(q.has('status')).toBe(false);
    expect(q.has('active')).toBe(false);
    expect(result.memberships).toHaveLength(2);
  });

  it('reads every page for the customer', async () => {
    let n = 0;
    const env = makeEnv(async () => {
      n += 1;
      return n === 1
        ? page([{ id: 1, customerId: 101, status: 'Active' }], true)
        : page([{ id: 2, customerId: 101, status: 'Expired' }], false);
    });
    const result: any = await get_customer_membership.handler(env, { customerId: 101 }, CTX);
    expect(result.memberships.map((m: any) => m.id)).toEqual([1, 2]);
    expect(result._truncated).toBeUndefined();
  });
});

describe('list_memberships_active', () => {
  it('sends customerIds, never customerId', async () => {
    const env = makeEnv(async () => page([{ id: 1, customerId: 102, status: 'Active' }]));
    await list_memberships_active.handler(env, { customerId: 102 }, CTX);
    const [q] = membershipCalls(env);
    expect(q.get('customerIds')).toBe('102');
    expect(q.has('customerId')).toBe(false);
  });

  it('fails loudly when ST returns another customer\'s memberships', async () => {
    const env = makeEnv(async () => page([{ id: 1, customerId: 103, status: 'Active' }]));
    await expect(list_memberships_active.handler(env, { customerId: 102 }, CTX))
      .rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('rejects locationId (ST has no location filter on this endpoint)', async () => {
    const env = makeEnv(async () => page([]));
    await expect(list_memberships_active.handler(env, { locationId: 270407 }, CTX))
      .rejects.toMatchObject({ code: 'validation_error' });
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });
});

describe('list_memberships_expiring', () => {
  it('sends customerIds and none of the date params ST ignores', async () => {
    const env = makeEnv(async () => page([]));
    await list_memberships_expiring.handler(env, { windowDays: 30, customerId: 101 }, CTX);
    const [q] = membershipCalls(env);
    expect(q.get('customerIds')).toBe('101');
    expect(q.has('customerId')).toBe(false);
    expect(q.has('activeThroughOnOrAfter')).toBe(false);
    expect(q.has('activeThroughBefore')).toBe(false);
  });

  it('keeps only memberships whose `to` falls inside the window', async () => {
    const now = Date.now();
    const env = makeEnv(async () => page([
      { id: 1, status: 'Active', to: null },                                    // ongoing
      { id: 2, status: 'Active', to: new Date(now + 2 * DAY).toISOString() },   // inside
      { id: 3, status: 'Active', to: new Date(now + 40 * DAY).toISOString() },  // after window
      { id: 4, status: 'Active', to: new Date(now - 5 * DAY).toISOString() },   // already past
    ]));
    const result: any = await list_memberships_expiring.handler(env, { windowDays: 30 }, CTX);
    expect(result.memberships.map((m: any) => m.id)).toEqual([2]);
  });

  it('scans past page one, because ST cannot filter by end date', async () => {
    const now = Date.now();
    let n = 0;
    const env = makeEnv(async () => {
      n += 1;
      return n === 1
        ? page([{ id: 1, status: 'Active', to: null }], true)
        : page([{ id: 2, status: 'Active', to: new Date(now + DAY).toISOString() }], false);
    });
    const result: any = await list_memberships_expiring.handler(env, { windowDays: 7 }, CTX);
    expect(result.memberships.map((m: any) => m.id)).toEqual([2]);
    expect(membershipCalls(env)).toHaveLength(2);
  });
});

describe('customer_snapshot memberships arm', () => {
  it('sends customerIds on the memberships call', async () => {
    const env = makeEnv(async () => page([]));
    await customer_snapshot.handler(env, { customerId: 101 }, CTX);
    const [q] = membershipCalls(env);
    expect(q.get('customerIds')).toBe('101');
    expect(q.has('customerId')).toBe(false);
  });
});
