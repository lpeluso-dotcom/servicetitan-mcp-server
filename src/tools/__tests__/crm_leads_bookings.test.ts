import { describe, it, expect, vi } from 'vitest';
import { leads_list } from '../crm/leads_list';
import { lead_get } from '../crm/lead_get';
import { bookings_list } from '../crm/bookings_list';
import { booking_get } from '../crm/booking_get';
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

const RAW_LEAD = {
  id: 3001, status: 'Open', customerId: 301, locationId: 501, businessUnitId: 12, jobTypeId: 76017219, priority: 'Normal',
  campaignId: 9, summary: 'Wants generator quote', followUpDate: '2026-03-05T00:00:00Z', callId: 4001, bookingId: null,
  createdOn: '2026-03-01T10:00:00Z', modifiedOn: '2026-03-02T10:00:00Z', tagTypeIds: [1], _links: { self: 'x' },
};
const RAW_BOOKING = {
  id: 2001, status: 'New', source: 'Scorpion', name: 'Jane Doe', summary: 'No heat', start: '2026-03-03T13:00:00Z', businessUnitId: 12,
  jobTypeId: 76017219, campaignId: 9, jobId: null, externalId: 'ext-77', isFirstTimeClient: true,
  address: { street: '1 Main St', city: 'Florence', state: 'SC', zip: '29501' }, contacts: [{ type: 'Phone', value: '8435550100' }],
  createdOn: '2026-03-01T10:00:00Z', modifiedOn: '2026-03-02T10:00:00Z',
};

describe('leads_list', () => {
  it('forwards filters and returns slim rows', async () => {
    const env = envWith({ data: [RAW_LEAD, { id: 3002 }], hasMore: false, totalCount: 2 });
    const out = (await leads_list.handler(
      env, { customerId: 301, status: 'Open', isProspect: true, createdOnOrAfter: '2026-03-01T00:00:00Z', modifiedOnOrAfter: '2026-03-01T00:00:00Z', includeTotal: true }, CTX,
    )) as any;
    const url = calledUrl(env);
    expect(url).toContain('%2Fcrm%2Fv2%2Ftenant%2F000000000%2Fleads');
    for (const p of ['customerId%3D301', 'status%3DOpen', 'isProspect%3Dtrue', 'createdOnOrAfter%3D2026-03-01', 'modifiedOnOrAfter%3D2026-03-01', 'includeTotal%3Dtrue']) expect(url).toContain(p);
    expectCalledPathMatchesDeclared(leads_list, url, calledInit(env));
    expect(out.leads[0]).toEqual({
      id: 3001, status: 'Open', customer_id: 301, location_id: 501, business_unit_id: 12, job_type_id: 76017219, priority: 'Normal', campaign_id: 9,
      summary: 'Wants generator quote', follow_up_date: '2026-03-05T00:00:00Z', call_id: 4001, booking_id: null,
      created_on: '2026-03-01T10:00:00Z', modified_on: '2026-03-02T10:00:00Z',
    });
    expect(out.leads[1]).toEqual({
      id: 3002, status: '', customer_id: null, location_id: null, business_unit_id: null, job_type_id: null, priority: null, campaign_id: null,
      summary: '', follow_up_date: null, call_id: null, booking_id: null, created_on: null, modified_on: null,
    });
    expect(out.total_count).toBe(2);
    expect(out._source).toBe('live');
  });

  it('returns count 0 on an empty page', async () => {
    const out = (await leads_list.handler(envWith({ data: [] }), {}, CTX)) as any;
    expect(out.count).toBe(0);
    expect(out.leads).toEqual([]);
  });
});

describe('lead_get', () => {
  it('fetches by id and returns the full object', async () => {
    const env = envWith(RAW_LEAD);
    const out = (await lead_get.handler(env, { leadId: 3001 }, CTX)) as any;
    expect(calledUrl(env)).toContain('%2Fcrm%2Fv2%2Ftenant%2F000000000%2Fleads%2F3001');
    expectCalledPathMatchesDeclared(lead_get, calledUrl(env), calledInit(env));
    expect(out.lead.tagTypeIds).toEqual([1]);
    expect((lead_get.transformResult!(out) as any).lead._links).toBeUndefined();
  });
});

describe('bookings_list', () => {
  it('forwards filters and returns slim rows without address or contacts', async () => {
    const env = envWith({ data: [RAW_BOOKING], hasMore: false });
    const out = (await bookings_list.handler(
      env, { externalId: 'ext-77', createdOnOrAfter: '2026-03-01T00:00:00Z', modifiedOnOrAfter: '2026-03-01T00:00:00Z' }, CTX,
    )) as any;
    const url = calledUrl(env);
    expect(url).toContain('%2Fcrm%2Fv2%2Ftenant%2F000000000%2Fbookings');
    for (const p of ['externalId%3Dext-77', 'createdOnOrAfter%3D2026-03-01', 'modifiedOnOrAfter%3D2026-03-01']) expect(url).toContain(p);
    expectCalledPathMatchesDeclared(bookings_list, url, calledInit(env));
    expect(out.bookings[0]).toEqual({
      id: 2001, status: 'New', source: 'Scorpion', name: 'Jane Doe', summary: 'No heat', start: '2026-03-03T13:00:00Z', business_unit_id: 12,
      job_type_id: 76017219, campaign_id: 9, job_id: null, external_id: 'ext-77', is_first_time_client: true,
      created_on: '2026-03-01T10:00:00Z', modified_on: '2026-03-02T10:00:00Z',
    });
    expect(JSON.stringify(out)).not.toContain('8435550100');
    expect(JSON.stringify(out)).not.toContain('1 Main St');
  });

  it('throws McpError on upstream failure', async () => {
    await expect(bookings_list.handler(envWith('', 500), {}, CTX)).rejects.toThrow(/readST 500 on \/crm\/v2\/tenant\/000000000\/bookings/);
  });
});

describe('booking_get', () => {
  it('fetches by id and returns the full object including contacts', async () => {
    const env = envWith(RAW_BOOKING);
    const out = (await booking_get.handler(env, { bookingId: 2001 }, CTX)) as any;
    expect(calledUrl(env)).toContain('%2Fcrm%2Fv2%2Ftenant%2F000000000%2Fbookings%2F2001');
    expectCalledPathMatchesDeclared(booking_get, calledUrl(env), calledInit(env));
    expect(out.booking.contacts).toHaveLength(1);
    expect(out._source).toBe('live');
  });
});

describe('row-match filter guards (ST ignores unknown params)', () => {
  it('leads_list passes when every row matches customerId and status', async () => {
    const env = envWith({ data: [RAW_LEAD, { ...RAW_LEAD, id: 3002 }] });
    const out = (await leads_list.handler(env, { customerId: 301, status: 'Open' }, CTX)) as any;
    expect(out.count).toBe(2);
  });
  it.each([
    ['customerId', { customerId: 301 }, { customerId: 999 }],
    ['status', { status: 'Open' }, { status: 'Dismissed' }],
  ])('leads_list throws when one row mismatches %s', async (param, args, override) => {
    const env = envWith({ data: [RAW_LEAD, { ...RAW_LEAD, id: 3003, ...override }] });
    await expect(leads_list.handler(env, args as any, CTX)).rejects.toMatchObject({
      code: 'upstream_error', message: expect.stringContaining(`leads_list: ST ignored the ${param} filter`),
    });
  });
  it('bookings_list passes when every row matches externalId', async () => {
    const env = envWith({ data: [{ ...RAW_BOOKING, externalId: 'EXT-1' }] });
    const out = (await bookings_list.handler(env, { externalId: 'EXT-1' }, CTX)) as any;
    expect(out.count).toBe(1);
  });
  it('bookings_list throws when one row mismatches externalId', async () => {
    const env = envWith({ data: [{ ...RAW_BOOKING, externalId: 'EXT-1' }, { ...RAW_BOOKING, id: 2002, externalId: 'EXT-2' }] });
    await expect(bookings_list.handler(env, { externalId: 'EXT-1' }, CTX)).rejects.toMatchObject({
      code: 'upstream_error', message: expect.stringContaining('bookings_list: ST ignored the externalId filter'),
    });
  });
});
