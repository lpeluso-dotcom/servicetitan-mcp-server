import { describe, it, expect, vi } from 'vitest';
import { payments_list } from '../accounting/payments_list';
import { payment_get } from '../accounting/payment_get';
import { ap_bills_list } from '../accounting/ap_bills_list';
import { ap_bill_get } from '../accounting/ap_bill_get';

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

const RAW_PAYMENT = {
  id: 5001,
  status: 'Posted',
  type: { id: 3, name: 'Credit Card' },
  paidOn: '2026-03-01T00:00:00Z',
  total: 1250.5,
  unappliedAmount: 0,
  referenceNumber: 'AUTH-77',
  customer: { id: 301, name: 'Acme' },
  businessUnit: { id: 12, name: 'Plumbing' },
  appliedTo: [{ appliedId: 1, appliedTo: 88001, appliedAmount: 1250.5 }],
  modifiedOn: '2026-03-02T00:00:00Z',
  _links: { self: 'x' },
};

const RAW_BILL = {
  id: 6001,
  referenceNumber: 'INV-4411',
  vendor: { id: 44, name: 'Ferguson' },
  jobId: 99001,
  businessUnitId: 12,
  billDate: '2026-03-01T00:00:00Z',
  dueDate: '2026-03-31T00:00:00Z',
  total: 593.94,
  tax: 41.58,
  shipping: 0,
  syncStatus: 'Pending',
  items: [{ id: 1 }, { id: 2 }],
  modifiedOn: '2026-03-02T00:00:00Z',
};

describe('payments_list', () => {
  it('forwards filters under ST param names and returns slim rows', async () => {
    const env = envWith({ data: [RAW_PAYMENT, { id: 5002 }], hasMore: false, totalCount: 2 });
    const out = (await payments_list.handler(
      env, { customerId: 301, invoiceId: 88001, businessUnitId: 12, modifiedOnOrAfter: '2026-03-01T00:00:00Z', includeTotal: true }, CTX,
    )) as any;
    const url = calledUrl(env);
    expect(url).toContain('%2Faccounting%2Fv2%2Ftenant%2F000000000%2Fpayments');
    expect(url).toContain('customerId%3D301');
    expect(url).toContain('appliedToInvoiceIds%3D88001');
    expect(url).toContain('businessUnitIds%3D12');
    expect(url).toContain('modifiedOnOrAfter%3D2026-03-01');
    expect(out.payments[0]).toEqual({
      id: 5001, status: 'Posted', type: 'Credit Card', paid_on: '2026-03-01T00:00:00Z', total: 1250.5, unapplied_amount: 0,
      reference_number: 'AUTH-77', customer_id: 301, business_unit_id: 12, applied_invoice_ids: [88001], modified_on: '2026-03-02T00:00:00Z',
    });
    expect(out.payments[1]).toEqual({
      id: 5002, status: '', type: '', paid_on: null, total: 0, unapplied_amount: 0, reference_number: null,
      customer_id: null, business_unit_id: null, applied_invoice_ids: [], modified_on: null,
    });
    expect(out.total_count).toBe(2);
    expect(out._source).toBe('live');
    expectCalledPathMatchesDeclared(payments_list, calledUrl(env), calledInit(env));
  });

  it('returns count 0 on an empty page', async () => {
    const out = (await payments_list.handler(envWith({ data: [] }), {}, CTX)) as any;
    expect(out.count).toBe(0);
    expect(out.payments).toEqual([]);
  });
});

describe('payment_get', () => {
  it('fetches via the list endpoint with ids= and returns the full object', async () => {
    const env = envWith({ data: [RAW_PAYMENT] });
    const out = (await payment_get.handler(env, { paymentId: 5001 }, CTX)) as any;
    expect(calledUrl(env)).toContain('%2Faccounting%2Fv2%2Ftenant%2F000000000%2Fpayments%3Fids%3D5001');
    expect(out.payment.id).toBe(5001);
    expect(out.payment.appliedTo).toHaveLength(1);
    expect(out._source).toBe('live');
    expectCalledPathMatchesDeclared(payment_get, calledUrl(env), calledInit(env));
  });

  it('throws not_found when ST returns no row', async () => {
    await expect(payment_get.handler(envWith({ data: [] }), { paymentId: 5001 }, CTX)).rejects.toThrow(/payment 5001 not found/);
  });

  it('fails loudly when the ids filter is not honoured', async () => {
    await expect(payment_get.handler(envWith({ data: [{ id: 999 }] }), { paymentId: 5001 }, CTX))
      .rejects.toThrow(/ids filter not honored: asked 5001, got 999/);
  });
});

describe('ap_bills_list', () => {
  it('forwards filters and returns slim rows', async () => {
    const env = envWith({ data: [RAW_BILL, { id: 6002 }], hasMore: true });
    const out = (await ap_bills_list.handler(
      env, { billNumber: 'INV-4411', jobNumber: '99001', syncStatus: 'Pending', dateFrom: '2026-03-01', dateTo: '2026-03-31', modifiedOnOrAfter: '2026-03-01T00:00:00Z' }, CTX,
    )) as any;
    const url = calledUrl(env);
    expect(url).toContain('%2Faccounting%2Fv2%2Ftenant%2F000000000%2Fap-bills');
    expect(url).toContain('billNumber%3DINV-4411');
    expect(url).toContain('jobNumber%3D99001');
    expect(url).toContain('syncStatus%3DPending');
    expect(url).toContain('dateFrom%3D2026-03-01');
    expect(url).toContain('dateTo%3D2026-03-31');
    expect(out.bills[0]).toEqual({
      id: 6001, reference_number: 'INV-4411', vendor_id: 44, vendor_name: 'Ferguson', job_id: 99001, business_unit_id: 12,
      bill_date: '2026-03-01T00:00:00Z', due_date: '2026-03-31T00:00:00Z', total: 593.94, tax: 41.58, shipping: 0,
      sync_status: 'Pending', item_count: 2, modified_on: '2026-03-02T00:00:00Z',
    });
    expect(out.bills[1].item_count).toBe(0);
    expect(out.bills[1].vendor_id).toBeNull();
    expect(out.has_more).toBe(true);
    expect(out.total_count).toBeNull();
    expectCalledPathMatchesDeclared(ap_bills_list, calledUrl(env), calledInit(env));
  });

  it('throws McpError on upstream failure', async () => {
    await expect(ap_bills_list.handler(envWith('', 500), {}, CTX))
      .rejects.toThrow(/readST 500 on \/accounting\/v2\/tenant\/000000000\/ap-bills/);
  });
});

describe('ap_bill_get', () => {
  it('fetches by billId and returns the full object', async () => {
    const env = envWith(RAW_BILL);
    const out = (await ap_bill_get.handler(env, { billId: 6001 }, CTX)) as any;
    expect(calledUrl(env)).toContain('%2Faccounting%2Fv2%2Ftenant%2F000000000%2Fap-bills%2F6001');
    expect(out.bill.items).toHaveLength(2);
    expect(out._source).toBe('live');
    expectCalledPathMatchesDeclared(ap_bill_get, calledUrl(env), calledInit(env));
  });
});

describe('row-match filter guards (ST ignores unknown params)', () => {
  it('payments_list passes when every row matches customerId, invoiceId and businessUnitId', async () => {
    const env = envWith({ data: [RAW_PAYMENT, { ...RAW_PAYMENT, id: 5003 }] });
    const out = (await payments_list.handler(env, { customerId: 301, invoiceId: 88001, businessUnitId: 12 }, CTX)) as any;
    expect(out.count).toBe(2);
  });
  it.each([
    ['customerId', { customerId: 301 }, { customer: { id: 999 } }],
    ['invoiceId', { invoiceId: 88001 }, { appliedTo: [{ appliedTo: 12345 }] }],
    ['businessUnitId', { businessUnitId: 12 }, { businessUnit: { id: 77 } }],
  ])('payments_list throws when one row mismatches %s', async (param, args, override) => {
    const env = envWith({ data: [RAW_PAYMENT, { ...RAW_PAYMENT, id: 5004, ...override }] });
    await expect(payments_list.handler(env, args as any, CTX)).rejects.toMatchObject({
      code: 'upstream_error', message: expect.stringContaining(`payments_list: ST ignored the ${param} filter`),
    });
  });
  it('ap_bills_list passes when every row matches syncStatus', async () => {
    const env = envWith({ data: [RAW_BILL, { ...RAW_BILL, id: 6002 }] });
    const out = (await ap_bills_list.handler(env, { syncStatus: 'Pending' }, CTX)) as any;
    expect(out.count).toBe(2);
  });
  it('ap_bills_list throws when one row mismatches syncStatus', async () => {
    const env = envWith({ data: [RAW_BILL, { ...RAW_BILL, id: 6003, syncStatus: 'Exported' }] });
    await expect(ap_bills_list.handler(env, { syncStatus: 'Pending' }, CTX)).rejects.toMatchObject({
      code: 'upstream_error', message: expect.stringContaining('ap_bills_list: ST ignored the syncStatus filter'),
    });
  });
});
