import { describe, it, expect, vi } from 'vitest';
import { purchase_orders_list } from '../inventory/purchase_orders_list';
import { purchase_order_get } from '../inventory/purchase_order_get';

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

const RAW_PO = {
  id: 8001, number: 'PO-1234', status: 'Sent', jobId: 99001, projectId: null, vendorId: 44, technicianId: 75766687, businessUnitId: 12,
  date: '2026-03-01T00:00:00Z', requiredOn: '2026-03-03T00:00:00Z', receivedOn: null, total: 812.4, tax: 56.87, shipping: 0,
  items: [{ id: 1 }, { id: 2 }, { id: 3 }], modifiedOn: '2026-03-02T00:00:00Z', _links: { self: 'x' },
};

describe('purchase_orders_list', () => {
  it('forwards filters and returns slim rows', async () => {
    const env = envWith({ data: [RAW_PO, { id: 8002 }], hasMore: false, totalCount: 2 });
    const out = (await purchase_orders_list.handler(
      env, { jobId: 99001, technicianId: 75766687, status: 'Sent', number: 'PO-1234', modifiedOnOrAfter: '2026-03-01T00:00:00Z', createdOnOrAfter: '2026-02-01T00:00:00Z', includeTotal: true }, CTX,
    )) as any;
    const url = calledUrl(env);
    expect(url).toContain('%2Finventory%2Fv2%2Ftenant%2F000000000%2Fpurchase-orders');
    for (const p of ['jobId%3D99001', 'technicianId%3D75766687', 'status%3DSent', 'number%3DPO-1234', 'modifiedOnOrAfter%3D2026-03-01', 'createdOnOrAfter%3D2026-02-01', 'includeTotal%3Dtrue']) expect(url).toContain(p);
    expectCalledPathMatchesDeclared(purchase_orders_list, url, calledInit(env));
    expect(out.purchase_orders[0]).toEqual({
      id: 8001, number: 'PO-1234', status: 'Sent', job_id: 99001, project_id: null, vendor_id: 44, technician_id: 75766687, business_unit_id: 12,
      date: '2026-03-01T00:00:00Z', required_on: '2026-03-03T00:00:00Z', received_on: null, total: 812.4, tax: 56.87, shipping: 0, item_count: 3, modified_on: '2026-03-02T00:00:00Z',
    });
    expect(out.purchase_orders[1]).toEqual({
      id: 8002, number: '', status: '', job_id: null, project_id: null, vendor_id: null, technician_id: null, business_unit_id: null,
      date: null, required_on: null, received_on: null, total: 0, tax: 0, shipping: 0, item_count: 0, modified_on: null,
    });
    expect(out.count).toBe(2);
    expect(out.total_count).toBe(2);
    expect(out._source).toBe('live');
  });

  it('returns count 0 on an empty page', async () => {
    const out = (await purchase_orders_list.handler(envWith({}), {}, CTX)) as any;
    expect(out.count).toBe(0);
    expect(out.purchase_orders).toEqual([]);
    expect(out.total_count).toBeNull();
  });

  it('throws McpError on upstream failure', async () => {
    await expect(purchase_orders_list.handler(envWith('', 500), {}, CTX)).rejects.toThrow(/readST 500 on \/inventory\/v2\/tenant\/000000000\/purchase-orders/);
  });
});

describe('purchase_order_get', () => {
  it('fetches by id and returns the full object with items', async () => {
    const env = envWith(RAW_PO);
    const out = (await purchase_order_get.handler(env, { purchaseOrderId: 8001 }, CTX)) as any;
    expect(calledUrl(env)).toContain('%2Finventory%2Fv2%2Ftenant%2F000000000%2Fpurchase-orders%2F8001');
    expectCalledPathMatchesDeclared(purchase_order_get, calledUrl(env), calledInit(env));
    expect(out.purchase_order.items).toHaveLength(3);
    expect((purchase_order_get.transformResult!(out) as any).purchase_order._links).toBeUndefined();
    expect(out._source).toBe('live');
  });
});

describe('row-match filter guards (ST ignores unknown params)', () => {
  it('purchase_orders_list passes when every row matches every echoed filter', async () => {
    const env = envWith({ data: [RAW_PO, { ...RAW_PO, id: 8002 }] });
    const out = (await purchase_orders_list.handler(
      env, { jobId: 99001, technicianId: 75766687, status: 'Sent', number: 'PO-1234' }, CTX,
    )) as any;
    expect(out.count).toBe(2);
  });
  it.each([
    ['jobId', { jobId: 99001 }, { jobId: 1 }],
    ['technicianId', { technicianId: 75766687 }, { technicianId: 2 }],
    ['projectId', { projectId: 55 }, { projectId: 56 }],
    ['status', { status: 'Sent' }, { status: 'Received' }],
    ['number', { number: 'PO-1234' }, { number: 'PO-9999' }],
  ])('purchase_orders_list throws when one row mismatches %s', async (param, args, override) => {
    const base = param === 'projectId' ? { ...RAW_PO, projectId: 55 } : RAW_PO;
    const env = envWith({ data: [base, { ...base, id: 8003, ...override }] });
    await expect(purchase_orders_list.handler(env, args as any, CTX)).rejects.toMatchObject({
      code: 'upstream_error', message: expect.stringContaining(`purchase_orders_list: ST ignored the ${param} filter`),
    });
  });
});
