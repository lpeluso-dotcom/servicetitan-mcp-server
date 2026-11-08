import { describe, it, expect, vi } from 'vitest';
import { service_agreements_list } from '../service_agreements/service_agreements_list';
import { service_agreement_get } from '../service_agreements/service_agreement_get';
import { expectCalledPathMatchesDeclared } from './declared_path_helper';

const CTX = { actor: 'test', correlation: 'c1' };
function envWith(body: unknown, status = 200) {
  return {
    ST_TENANT_ID: '000000000',
    ST_TRANSPORT: { fetch: vi.fn(async () => new Response(JSON.stringify(body), { status })) },
    MCP_SYNC_KEY: 'k',
  } as any;
}
const calledUrl = (env: any): string => String(env.ST_TRANSPORT.fetch.mock.calls[0][0]);
const calledInit = (env: any) => env.ST_TRANSPORT.fetch.mock.calls[0][1];

const RAW_SA = {
  id: 7001,
  name: 'Comm HVAC — Quarterly',
  agreementNumber: 'SA-0042',
  customerId: 301,
  businessUnitId: 12,
  status: 'Active',
  startDate: '2026-01-01T00:00:00Z',
  endDate: '2026-12-31T00:00:00Z',
  totalPrice: 2400,
  modifiedOn: '2026-02-01T00:00:00Z',
  visits: [{ id: 1 }],
  _links: { self: 'x' },
};

describe('service_agreements_list', () => {
  it('maps singular id args to ST plural params and returns slim rows', async () => {
    const env = envWith({ data: [RAW_SA, { id: 7002 }], hasMore: false, totalCount: 2 });
    const out = (await service_agreements_list.handler(
      env, { customerId: 301, businessUnitId: 12, status: 'Active', modifiedOnOrAfter: '2026-01-15T00:00:00Z', includeTotal: true }, CTX,
    )) as any;
    const url = calledUrl(env);
    expect(url).toContain('%2Fservice-agreements%2Fv2%2Ftenant%2F000000000%2Fservice-agreements');
    expect(url).toContain('customerIds%3D301');
    expect(url).toContain('businessUnitIds%3D12');
    expect(url).toContain('status%3DActive');
    expect(url).toContain('modifiedOnOrAfter%3D2026-01-15');
    expect(url).toContain('includeTotal%3Dtrue');
    expect(url).not.toContain('customerId%3D');
    expectCalledPathMatchesDeclared(service_agreements_list, url, calledInit(env));
    expect(out.agreements[0]).toEqual({
      id: 7001, name: 'Comm HVAC — Quarterly', agreement_number: 'SA-0042', customer_id: 301, business_unit_id: 12,
      status: 'Active', start_date: '2026-01-01T00:00:00Z', end_date: '2026-12-31T00:00:00Z', total_price: 2400, modified_on: '2026-02-01T00:00:00Z',
    });
    expect(out.agreements[1]).toEqual({
      id: 7002, name: '', agreement_number: '', customer_id: null, business_unit_id: null, status: '', start_date: null, end_date: null, total_price: null, modified_on: null,
    });
    expect(out.count).toBe(2);
    expect(out.total_count).toBe(2);
    expect(out._source).toBe('live');
  });

  it('returns count 0 and total_count null on an empty page', async () => {
    const out = (await service_agreements_list.handler(envWith({}), {}, CTX)) as any;
    expect(out.count).toBe(0);
    expect(out.agreements).toEqual([]);
    expect(out.total_count).toBeNull();
  });

  it('throws McpError on upstream failure', async () => {
    await expect(service_agreements_list.handler(envWith('', 502), {}, CTX))
      .rejects.toThrow(/readST 502 on \/service-agreements\/v2\/tenant\/000000000\/service-agreements/);
  });
});

describe('service_agreement_get', () => {
  it('fetches by id and returns the full object', async () => {
    const env = envWith(RAW_SA);
    const out = (await service_agreement_get.handler(env, { agreementId: 7001 }, CTX)) as any;
    expect(calledUrl(env)).toContain('%2Fservice-agreements%2Fv2%2Ftenant%2F000000000%2Fservice-agreements%2F7001');
    expectCalledPathMatchesDeclared(service_agreement_get, calledUrl(env), calledInit(env));
    expect(out.agreement.id).toBe(7001);
    expect(out.agreement.visits).toEqual([{ id: 1 }]);
    expect((service_agreement_get.transformResult!(out) as any).agreement._links).toBeUndefined();
  });
});

describe('row-match filter guards (ST ignores unknown params)', () => {
  it('service_agreements_list passes when every row matches customerId, businessUnitId and status', async () => {
    const env = envWith({ data: [RAW_SA, { ...RAW_SA, id: 7002, status: 'active' }] });
    const out = (await service_agreements_list.handler(env, { customerId: 301, businessUnitId: 12, status: 'Active' }, CTX)) as any;
    expect(out.count).toBe(2);
  });
  it.each([
    ['customerId', { customerId: 301 }, { customerId: 999 }],
    ['businessUnitId', { businessUnitId: 12 }, { businessUnitId: 77 }],
    ['status', { status: 'Active' }, { status: 'Expired' }],
  ])('service_agreements_list throws when one row mismatches %s', async (param, args, override) => {
    const env = envWith({ data: [RAW_SA, { ...RAW_SA, id: 7003, ...override }] });
    await expect(service_agreements_list.handler(env, args as any, CTX)).rejects.toMatchObject({
      code: 'upstream_error', message: expect.stringContaining(`service_agreements_list: ST ignored the ${param} filter`),
    });
  });
});
