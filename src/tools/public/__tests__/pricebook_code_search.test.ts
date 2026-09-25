import { describe, it, expect } from 'vitest';
import { search_pricebook_services_public, search_materials_public } from '../pricebook_code_search';
import { PUBLIC_TOOLS } from '../../public-registry';
import { makeBackendEnv, page, path, query, CTX } from './helpers';

const SERVICES = [{ id: 1, code: 'WHEH-140', displayName: 'Element', active: true }, { id: 2, code: 'DIAG-1', displayName: 'Diag', active: false }];
const MATERIALS = [{ id: 3, code: 'PRV-075', displayName: 'PRV', active: true }];

describe('search_pricebook_services / search_materials (public)', () => {
  it('finds a service by code variant, scanning active and inactive rows', async () => {
    const { env, calls } = makeBackendEnv(() => page(SERVICES));
    const out: any = await search_pricebook_services_public.handler(env, { code: 'wheh140', page: 1, pageSize: 50 }, CTX);
    expect(Object.fromEntries(query(calls[0]))).toEqual({ page: '1', pageSize: '200' });
    expect(out._source).toBe('live-scan');
    
    expect(out._matched_code).toBe('wheh140');
    expect(out.services).toHaveLength(1);

    expect(out.services[0]).toEqual({
      id: 1,
      code: 'WHEH-140',
      name: 'Element',
      description: null,
      category_name: null,
      price: null,
      member_price: null,
      hours: null,
      is_labor: null,
      material_cost: null,
      active: true,
      cost: null,
      use_static_prices: null,
      calculated_price: null,
      addon_price: null,
      addon_member_price: null,
      taxable: null,
      account: null,
    });
  });

  it('returns an empty result with a note when no code matches', async () => {
    const { env } = makeBackendEnv(() => page(SERVICES));
    const out: any = await search_pricebook_services_public.handler(env, { code: 'nope-1', page: 1, pageSize: 50 }, CTX);
    expect(out.services).toEqual([]);
    expect(out._matched_code).toBeNull();
    expect(out._note).toContain('Tried variants: nope-1, NOPE-1');
  });

  it('lists one live page when no code is given', async () => {
    const { env, calls } = makeBackendEnv(() => ({ ...page(MATERIALS), hasMore: true }));
    const out: any = await search_materials_public.handler(env, { active: true, page: 3, pageSize: 20 }, CTX);
    expect(path(calls[0])).toBe('/pricebook/v2/tenant/000000000/materials');
    expect(Object.fromEntries(query(calls[0]))).toEqual({ active: 'true', page: '3', pageSize: '20' });
    expect(out).toEqual({ materials: MATERIALS, page: 3, pageSize: 20, has_more: true, _source: 'live', _pricing_note: expect.any(String) });
  });

  it('refuses name and categoryId before any call', async () => {
    const { env, calls } = makeBackendEnv(() => page([]));
    await expect(search_materials_public.handler(env, { name: 'valve', page: 1, pageSize: 50 }, CTX)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringContaining('/pricebook/v2/tenant/{tid}/materials'),
    });
    await expect(search_pricebook_services_public.handler(env, { categoryId: 4, page: 1, pageSize: 50 }, CTX)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringContaining('/pricebook/v2/tenant/{tid}/services'),
    });
    expect(calls).toHaveLength(0);
  });

  it('both are registered in PUBLIC_TOOLS under the same tool names', () => {
    expect(PUBLIC_TOOLS).toContain(search_pricebook_services_public);
    expect(PUBLIC_TOOLS).toContain(search_materials_public);
    expect([search_pricebook_services_public.name, search_materials_public.name]).toEqual(['search_pricebook_services', 'search_materials']);
  });
});
