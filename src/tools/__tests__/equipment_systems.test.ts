import { describe, it, expect, vi } from 'vitest';
import { equipment_installed_list } from '../equipment/equipment_installed_list';
import { equipment_installed_get } from '../equipment/equipment_installed_get';
import { equipment_systems_list } from '../equipment/equipment_systems_list';
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

const RAW_EQUIPMENT = {
  id: 9001,
  equipmentId: 77,
  name: 'Trane XR14 Condenser',
  locationId: 501,
  customerId: 301,
  manufacturer: 'Trane',
  model: 'XR14',
  serialNumber: 'SN-123',
  installedOn: '2024-06-01T00:00:00Z',
  manufacturerWarrantyEnd: '2034-06-01T00:00:00Z',
  serviceProviderWarrantyEnd: '2026-06-01T00:00:00Z',
  memo: 'attic unit',
  active: true,
  modifiedOn: '2026-01-02T03:04:05Z',
  _links: { self: 'x' },
};

describe('equipment_installed_list', () => {
  it('forwards filters and returns slim rows', async () => {
    const env = envWith({ data: [RAW_EQUIPMENT, { id: 9002 }], hasMore: true, totalCount: 42 });
    const out = (await equipment_installed_list.handler(
      env, { locationId: 501, active: 'True', modifiedOnOrAfter: '2026-01-01T00:00:00Z', includeTotal: true, pageSize: 10 }, CTX,
    )) as any;
    const url = calledUrl(env);
    expect(url).toContain('%2Fequipmentsystems%2Fv2%2Ftenant%2F000000000%2Finstalled-equipment');
    expect(url).toContain('locationId%3D501');
    expect(url).toContain('active%3DTrue');
    expect(url).toContain('modifiedOnOrAfter%3D2026-01-01T00%253A00%253A00Z');
    expect(url).toContain('includeTotal%3Dtrue');
    expect(url).toContain('pageSize%3D10');
    expectCalledPathMatchesDeclared(equipment_installed_list, url);
    expect(out.count).toBe(2);
    expect(out.equipment[0]).toEqual({
      id: 9001, name: 'Trane XR14 Condenser', location_id: 501, customer_id: 301,
      manufacturer: 'Trane', model: 'XR14', serial_number: 'SN-123', installed_on: '2024-06-01T00:00:00Z',
      manufacturer_warranty_end: '2034-06-01T00:00:00Z', service_provider_warranty_end: '2026-06-01T00:00:00Z',
      active: true, modified_on: '2026-01-02T03:04:05Z',
    });
    expect(out.equipment[1]).toEqual({
      id: 9002, name: '', location_id: null, customer_id: null, manufacturer: null, model: null, serial_number: null,
      installed_on: null, manufacturer_warranty_end: null, service_provider_warranty_end: null, active: null, modified_on: null,
    });
    expect(out.has_more).toBe(true);
    expect(out.total_count).toBe(42);
    expect(out.page).toBe(1);
    expect(out._source).toBe('live');
  });

  it('returns count 0, total_count null on an empty page', async () => {
    const out = (await equipment_installed_list.handler(envWith({ data: [] }), {}, CTX)) as any;
    expect(out.count).toBe(0);
    expect(out.equipment).toEqual([]);
    expect(out.total_count).toBeNull();
  });

  it('throws McpError on upstream failure', async () => {
    await expect(equipment_installed_list.handler(envWith('', 500), {}, CTX))
      .rejects.toThrow(/readST 500 on \/equipmentsystems\/v2\/tenant\/000000000\/installed-equipment/);
  });
});

describe('equipment_installed_get', () => {
  it('fetches by id and returns the full object', async () => {
    const env = envWith(RAW_EQUIPMENT);
    const out = (await equipment_installed_get.handler(env, { equipmentId: 9001 }, CTX)) as any;
    expect(calledUrl(env)).toContain('%2Fequipmentsystems%2Fv2%2Ftenant%2F000000000%2Finstalled-equipment%2F9001');
    expectCalledPathMatchesDeclared(equipment_installed_get, calledUrl(env));
    expect(out.equipment.id).toBe(9001);
    expect(out.equipment.memo).toBe('attic unit');
    expect(out._source).toBe('live');
    const shaped = equipment_installed_get.transformResult!(out) as any;
    expect(shaped.equipment._links).toBeUndefined();
  });
});

describe('equipment_systems_list', () => {
  it('returns slim systems with equipment ids', async () => {
    const env = envWith({
      data: [{ id: 11, name: 'Upstairs HVAC', locationId: 501, customerId: 301, active: true, modifiedOn: '2026-01-01T00:00:00Z', equipment: [{ id: 9001 }, { id: 9002 }] }],
      hasMore: false,
    });
    const out = (await equipment_systems_list.handler(env, { modifiedOnOrAfter: '2025-12-01T00:00:00Z' }, CTX)) as any;
    expect(calledUrl(env)).toContain('%2Fequipmentsystems%2Fv2%2Ftenant%2F000000000%2Fequipment-systems');
    expect(calledUrl(env)).toContain('modifiedOnOrAfter%3D2025-12-01');
    expectCalledPathMatchesDeclared(equipment_systems_list, calledUrl(env));
    expect(out.systems[0]).toEqual({
      id: 11, name: 'Upstairs HVAC', location_id: 501, customer_id: 301, equipment_ids: [9001, 9002], active: true, modified_on: '2026-01-01T00:00:00Z',
    });
    expect(out.has_more).toBe(false);
  });
});

describe('row-match filter guards (ST ignores unknown params)', () => {
  it('equipment_installed_list passes when every row matches locationId and customerId', async () => {
    const env = envWith({ data: [RAW_EQUIPMENT, { ...RAW_EQUIPMENT, id: 9002 }] });
    const out = (await equipment_installed_list.handler(env, { locationId: 501, customerId: 301 }, CTX)) as any;
    expect(out.count).toBe(2);
  });
  it.each([
    ['locationId', { locationId: 501 }, { locationId: 999 }],
    ['customerId', { customerId: 301 }, { customerId: 999 }],
  ])('equipment_installed_list throws when one row mismatches %s', async (param, args, override) => {
    const env = envWith({ data: [RAW_EQUIPMENT, { ...RAW_EQUIPMENT, id: 9003, ...override }] });
    await expect(equipment_installed_list.handler(env, args as any, CTX)).rejects.toMatchObject({
      code: 'upstream_error', message: expect.stringContaining(`equipment_installed_list: ST ignored the ${param} filter`),
    });
  });
});
