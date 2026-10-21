import { describe, it, expect, vi } from 'vitest';
import { list_service_categories } from '../list_service_categories';
import { get_service_details } from '../get_service_details';
import { get_configurable_equipment_children } from '../get_configurable_equipment_children';
import { st_get_pricebook } from '../../st_get_pricebook';
import { McpError } from '../../../errors';

const ctx = { actor: 'test', correlation: 'c1' };

function fakeEnv(respond: (url: string) => { body: unknown; status?: number }) {
  const fetcher = vi.fn(async (url: string) => {
    const { body, status = 200 } = respond(url);
    return new Response(JSON.stringify(body), { status });
  });
  return { ST_TENANT_ID: '000000000', ST_TRANSPORT: { fetch: fetcher }, LEGACY_TEST_KEY: 'k' } as any;
}

function calledUrls(env: any): string[] {
  return (env.ST_TRANSPORT.fetch as any).mock.calls.map((c: unknown[]) => decodeURIComponent(c[0] as string));
}

describe('list_service_categories', () => {
  it('reads the categories endpoint and returns the paged shape', async () => {
    const env = fakeEnv(() => ({ body: { data: [{ id: 1, name: 'Plumbing' }], hasMore: true, totalCount: 40 } }));
    const out = (await list_service_categories.handler(env, { active: true, page: 2, pageSize: 10 }, ctx)) as any;
    const url = calledUrls(env)[0];
    expect(url).toContain('/pricebook/v2/tenant/000000000/categories');
    expect(url).toContain('active=true');
    expect(url).toContain('page=2');
    expect(url).toContain('pageSize=10');
    expect(out).toEqual({
      categories: [{ id: 1, name: 'Plumbing' }],
      page: 2,
      pageSize: 10,
      hasMore: true,
      totalCount: 40,
      _source: 'live',
    });
  });

  it('defaults to page 1, size 25 and an empty list', async () => {
    const env = fakeEnv(() => ({ body: {} }));
    const out = (await list_service_categories.handler(env, {}, ctx)) as any;
    expect(out.categories).toEqual([]);
    expect(out.page).toBe(1);
    expect(out.pageSize).toBe(25);
    expect(out.hasMore).toBe(false);
  });
});

describe('get_service_details', () => {
  it('reads the service by id and wraps it', async () => {
    const env = fakeEnv(() => ({ body: { id: 77, code: 'SVC-1' } }));
    const out = (await get_service_details.handler(env, { serviceId: 77 }, ctx)) as any;
    expect(calledUrls(env)[0]).toContain('/pricebook/v2/tenant/000000000/services/77');
    expect(out).toEqual({ service: { id: 77, code: 'SVC-1' }, _source: 'live' });
  });

  it('turns an upstream 404 into a not_found tool error', async () => {
    const env = fakeEnv(() => ({ body: { title: 'Not Found' }, status: 404 }));
    const err: any = await get_service_details.handler(env, { serviceId: 999 }, ctx).catch((e: any) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.toResponse()).toMatchObject({ ok: false, code: 'not_found', correlation: 'c1' });
  });
});

describe('get_configurable_equipment_children', () => {
  it('reads the parent and hydrates bare-id variants', async () => {
    const env = fakeEnv((url) => {
      const u = decodeURIComponent(url);
      if (u.includes('/equipment/10')) {
        return { body: { id: 10, isConfigurableEquipment: true, variationsOrConfigurableEquipment: [11, 12] } };
      }
      return { body: { id: Number(u.match(/equipment\/(\d+)/)![1]) } };
    });
    const out = (await get_configurable_equipment_children.handler(env, { parentEquipmentId: 10 }, ctx)) as any;
    const urls = calledUrls(env);
    expect(urls[0]).toContain('/pricebook/v2/tenant/000000000/equipment/10');
    expect(urls.some((u) => u.includes('/equipment/11'))).toBe(true);
    expect(urls.some((u) => u.includes('/equipment/12'))).toBe(true);
    expect(out).toMatchObject({
      parentEquipmentId: 10,
      isConfigurableEquipment: true,
      variant_count: 2,
      equipment: [{ id: 11 }, { id: 12 }],
      truncated: false,
      _source: 'live',
    });
    expect(out.warning).toBeUndefined();
  });

  it('caps hydration at 25 and flags truncation with the true count', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => 100 + i);
    const env = fakeEnv((url) => {
      const u = decodeURIComponent(url);
      if (u.includes('/equipment/10?') || u.endsWith('/equipment/10')) {
        return { body: { id: 10, isConfigurableEquipment: true, variationsOrConfigurableEquipment: ids } };
      }
      return { body: { id: 1 } };
    });
    const out = (await get_configurable_equipment_children.handler(env, { parentEquipmentId: 10 }, ctx)) as any;
    expect(out.equipment).toHaveLength(25);
    expect(out.variant_count).toBe(30);
    expect(out.truncated).toBe(true);
    expect(out.warning).toMatch(/30 variants/);
  });
});

describe('st_get_pricebook', () => {
  it.each(['services', 'materials', 'equipment'] as const)('reads /%s with paging and the active filter', async (assetType) => {
    const env = fakeEnv(() => ({ body: { data: [{ id: 1 }], hasMore: false } }));
    const out = (await st_get_pricebook.handler(env, { assetType, active: true }, ctx)) as any;
    const url = calledUrls(env)[0];
    expect(url).toContain(`/pricebook/v2/tenant/000000000/${assetType}`);
    expect(url).toContain('page=1');
    expect(url).toContain('pageSize=50');
    expect(url).toContain('active=true');
    expect(out.data).toEqual([{ id: 1 }]);
  });

  it('clamps pageSize at 200', async () => {
    const env = fakeEnv(() => ({ body: { data: [] } }));
    await st_get_pricebook.handler(env, { assetType: 'services', pageSize: 500 }, ctx);
    expect(calledUrls(env)[0]).toContain('pageSize=200');
  });

  it('rejects an assetType outside its enum, at the schema and in the handler', async () => {
    const { z } = await import('zod');
    expect(z.object(st_get_pricebook.zodSchema).safeParse({ assetType: 'vendors' }).success).toBe(false);
    const env = fakeEnv(() => ({ body: {} }));
    const err: any = await st_get_pricebook.handler(env, { assetType: 'vendors' as any }, ctx).catch((e: any) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe('validation_error');
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('refuses the unsupported search filter instead of returning an unfiltered page', async () => {
    const env = fakeEnv(() => ({ body: { data: [] } }));
    const err: any = await st_get_pricebook.handler(env, { assetType: 'services', search: 'generator' }, ctx).catch((e: any) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe('validation_error');
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });
});
