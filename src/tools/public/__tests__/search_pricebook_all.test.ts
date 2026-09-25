import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { search_pricebook_all_public, fallbackFitsBudget } from '../search_pricebook_all';
import { PUBLIC_TOOLS } from '../../public-registry';
import { makeBackendEnv, page, path, query, CTX } from './helpers';
import * as requestBudget from '../../../request-budget';
import { CATALOG_MAX_PAGES } from '../../pricebook/catalog-scan';

const SERVICES = [
  { id: 1, code: 'FLU-150', displayName: 'Flush water heater', description: 'Tank flush', price: 0, memberPrice: null, hours: 1.5, active: true },
  { id: 2, code: 'DIAG-1', displayName: 'Diagnostic', description: 'Service call', price: 89, hours: 0.5, active: true },
];
const MATERIALS = [{ id: 3, code: 'PRV-075', displayName: 'Pressure reducing valve 3/4', description: 'Brass PRV', price: 42, active: true }];
const EQUIPMENT = [{ id: 4, code: 'WH-50', displayName: 'Water heater 50 gal', description: 'Gas tank water heater', price: 1500, hours: 4, active: true }];
const KINDS_COUNT = 3; 

const RATE_LIMITER_STUB = { idFromName: () => 'id', get: () => ({ fetch: async () => Response.json({ allowed: true }) }) };

function fixture(truncateMaterials = false) {
  return makeBackendEnv((call) => {
    const p = path(call);
    if (p.endsWith('/services')) return page(SERVICES);
    if (p.endsWith('/materials')) return truncateMaterials ? { ...page(MATERIALS), hasMore: true } : page(MATERIALS);
    if (p.endsWith('/equipment')) return page(EQUIPMENT);
    throw new Error(`unexpected ${call.endpoint}`);
  });
}

describe('search_pricebook_all (public)', () => {

  it('finds a spoken code via its variants ("flu150" -> FLU-150)', async () => {
    const { env } = fixture();
    const out: any = await search_pricebook_all_public.handler(env, { code: 'flu150' }, CTX);
    expect(out.status).toBe('success');
    expect(out.matched_code).toBe('FLU-150');
    expect(out.items).toEqual([
      {
        type: 'service', id: 1, code: 'FLU-150', name: 'Flush water heater', description: 'Tank flush',
        category: null, price: 0, member_price: null, hours: 1.5, calculated_price: null, pricing: 'dynamic-unknown',
      },
    ]);
  });

  it('does not narrow by query when code is also set (code wins)', async () => {
    const { env, calls } = fixture();
    const out: any = await search_pricebook_all_public.handler(env, { code: 'flu150', query: 'nothing matches this' }, CTX);
    expect(out.status).toBe('success');
    expect(out.matched_code).toBe('FLU-150');
    expect(Object.fromEntries(query(calls[0]))).toEqual({ active: 'true', page: '1', pageSize: '200' });
  });

  it('code miss has no matched_code and carries a not_found message naming the variants tried', async () => {
    const { env } = fixture();
    const out: any = await search_pricebook_all_public.handler(env, { code: 'zzz-999' }, CTX);
    expect(out.status).toBe('not_found');
    expect(out).not.toHaveProperty('matched_code');
    expect(out.message).toContain('zzz-999');
    expect(out.message).toContain('ZZZ-999');
  });

  it('a query hit never carries matched_code (that key is code-lookup only)', async () => {
    const { env } = fixture();
    const out: any = await search_pricebook_all_public.handler(env, { query: 'water heater' }, CTX);
    expect(out.status).toBe('success');
    expect(out).not.toHaveProperty('matched_code');
  });

  it('a query miss reports not_found with a message', async () => {
    const { env } = fixture();
    const out: any = await search_pricebook_all_public.handler(env, { query: 'nonexistent-item-xyz' }, CTX);
    expect(out.status).toBe('not_found');
    expect(out).not.toHaveProperty('matched_code');
    expect(out.message).toContain('nonexistent-item-xyz');
  });

  it('every result shape validates against outputSchema', async () => {
    const schema = z.object(search_pricebook_all_public.outputSchema!);
    const { env } = fixture();
    const codeHit = await search_pricebook_all_public.handler(env, { code: 'flu150' }, CTX);
    const codeMiss = await search_pricebook_all_public.handler(env, { code: 'zzz-999' }, CTX);
    const queryHit = await search_pricebook_all_public.handler(env, { query: 'water heater' }, CTX);
    const queryMiss = await search_pricebook_all_public.handler(env, { query: 'nonexistent-item-xyz' }, CTX);
    const { env: truncatedEnv } = fixture(true);
    const truncated = await search_pricebook_all_public.handler(truncatedEnv, { query: 'zzz' }, CTX);
    for (const result of [codeHit, codeMiss, queryHit, queryMiss, truncated]) {
      expect(() => schema.parse(result)).not.toThrow();
    }
  });

  it('matches every word of a free-text query across services, materials, and equipment', async () => {
    const { env, calls } = fixture();
    const out: any = await search_pricebook_all_public.handler(env, { query: 'water heater' }, CTX);
    expect(out.items.map((i: any) => `${i.type}:${i.id}`)).toEqual(['service:1', 'equipment:4']);
    expect(calls.map(path)).toEqual([
      '/pricebook/v2/tenant/000000000/services',
      '/pricebook/v2/tenant/000000000/materials',
      '/pricebook/v2/tenant/000000000/equipment',
    ]);

    expect(Object.fromEntries(query(calls[0]))).toEqual({ active: 'true', page: '1', pageSize: '200', searchText: 'water heater' });
    expect(out._pricing_note).toContain('does not mean the item is free');
  });

  it('returns hours null for materials', async () => {
    const { env } = fixture();
    const out: any = await search_pricebook_all_public.handler(env, { query: 'prv' }, CTX);
    expect(out.items).toEqual([expect.objectContaining({ type: 'material', id: 3, hours: null })]);
  });

  it('falls back to a full scan when the searchText-narrowed scan finds 0 hits, and finds a description-only match', async () => {
    const { env, calls } = makeBackendEnv((call) => {
      const p = path(call);
      const narrowed = query(call).has('searchText');

      if (p.endsWith('/services')) return narrowed ? page([]) : page(SERVICES);
      if (p.endsWith('/materials')) return narrowed ? page([]) : page(MATERIALS);
      if (p.endsWith('/equipment')) return narrowed ? page([]) : page(EQUIPMENT);
      throw new Error(`unexpected ${call.endpoint}`);
    });
    
    const out: any = await search_pricebook_all_public.handler(env, { query: 'tank flush' }, CTX);
    expect(out.status).toBe('success');
    expect(out.items).toEqual([expect.objectContaining({ type: 'service', id: 1 })]);
    
    expect(calls.length).toBe(6);
    expect(calls.filter((c) => query(c).has('searchText')).length).toBe(3);
  });

  it('does not re-scan when the searchText-narrowed scan already has hits', async () => {
    const { env, calls } = fixture();
    const out: any = await search_pricebook_all_public.handler(env, { query: 'water heater' }, CTX);
    expect(out.items.length).toBeGreaterThan(0);
    expect(calls.length).toBe(3);
  });

  it('discloses a text-search-narrowing warning on narrowed hits, but not after a fallback scan or on a code lookup', async () => {
    const hasNarrowedWarning = (warnings: string[] | undefined) =>
      (warnings ?? []).some((w) => w.startsWith('text_search_narrowed:'));

    
    const narrowed: any = await search_pricebook_all_public.handler(fixture().env, { query: 'water heater' }, CTX);
    expect(hasNarrowedWarning(narrowed._warnings)).toBe(true);

    const { env: fallbackEnv } = makeBackendEnv((call) => {
      const p = path(call);
      const narrowedCall = query(call).has('searchText');
      if (p.endsWith('/services')) return narrowedCall ? page([]) : page(SERVICES);
      if (p.endsWith('/materials')) return narrowedCall ? page([]) : page(MATERIALS);
      if (p.endsWith('/equipment')) return narrowedCall ? page([]) : page(EQUIPMENT);
      throw new Error(`unexpected ${call.endpoint}`);
    });
    const fallback: any = await search_pricebook_all_public.handler(fallbackEnv, { query: 'tank flush' }, CTX);
    expect(hasNarrowedWarning(fallback._warnings)).toBe(false);

    
    const code: any = await search_pricebook_all_public.handler(fixture().env, { code: 'flu150' }, CTX);
    expect(hasNarrowedWarning(code._warnings)).toBe(false);
  });

  it('discloses a truncated scan and reports not_found honestly', async () => {
    const { env } = fixture(true);
    const out: any = await search_pricebook_all_public.handler(env, { query: 'zzz' }, CTX);
    expect(out.status).toBe('not_found');
    expect(out.message).toContain('zzz');
    expect(out._warnings).toEqual([expect.stringMatching(/^material_scan_truncated:/)]);
  });

  it('does not send searchText for an exact code lookup (variant matching needs the full scan)', async () => {
    const { env, calls } = fixture();
    await search_pricebook_all_public.handler(env, { code: 'flu150' }, CTX);
    expect(Object.fromEntries(query(calls[0]))).toEqual({ active: 'true', page: '1', pageSize: '200' });
  });

  it('requires code or query', async () => {
    const { env } = fixture();
    await expect(search_pricebook_all_public.handler(env, {}, CTX)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('is registered in PUBLIC_TOOLS under the same tool name', () => {
    expect(PUBLIC_TOOLS).toContain(search_pricebook_all_public);
    expect(search_pricebook_all_public.name).toBe('search_pricebook_all');
  });

  describe('fallbackFitsBudget', () => {
    it('allows the fallback when the budget is unreadable (no withBudget wrapper on this call)', () => {
      expect(fallbackFitsBudget(undefined, 48)).toBe(true);
    });

    it('allows the fallback when there is room under the cap', () => {
      expect(fallbackFitsBudget({ upstream: 40 }, 48, 100)).toBe(true); 
    });

    it('allows the fallback exactly at the cap boundary', () => {
      expect(fallbackFitsBudget({ upstream: 52 }, 48, 100)).toBe(true); 
    });

    it('skips the fallback when it would exceed the cap', () => {
      expect(fallbackFitsBudget({ upstream: 60 }, 48, 100)).toBe(false); 
    });
  });

  it('skips the fallback rescan and warns when the upstream budget cannot cover it', async () => {
    const spy = vi.spyOn(requestBudget, 'currentBudget').mockReturnValue({ upstream: 100 - KINDS_COUNT * CATALOG_MAX_PAGES + 1 } as any);
    try {
      const { env, calls } = makeBackendEnv((call) => {
        const p = path(call);
        const narrowed = query(call).has('searchText');
        
        
        if (p.endsWith('/services')) return narrowed ? page([]) : page(SERVICES);
        if (p.endsWith('/materials')) return narrowed ? page([]) : page(MATERIALS);
        if (p.endsWith('/equipment')) return narrowed ? page([]) : page(EQUIPMENT);
        throw new Error(`unexpected ${call.endpoint}`);
      }, { ST_RATE_LIMITER: RATE_LIMITER_STUB });
      const out: any = await search_pricebook_all_public.handler(env, { query: 'tank flush' }, CTX);
      expect(out.status).toBe('not_found');
      expect(out._warnings).toEqual(expect.arrayContaining([expect.stringContaining('budget_fallback_skipped')]));
      
      expect(calls.length).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('still runs the fallback rescan when the upstream budget has enough room', async () => {
    const spy = vi.spyOn(requestBudget, 'currentBudget').mockReturnValue({ upstream: 0 } as any);
    try {
      const { env, calls } = makeBackendEnv((call) => {
        const p = path(call);
        const narrowed = query(call).has('searchText');
        if (p.endsWith('/services')) return narrowed ? page([]) : page(SERVICES);
        if (p.endsWith('/materials')) return narrowed ? page([]) : page(MATERIALS);
        if (p.endsWith('/equipment')) return narrowed ? page([]) : page(EQUIPMENT);
        throw new Error(`unexpected ${call.endpoint}`);
      }, { ST_RATE_LIMITER: RATE_LIMITER_STUB });
      const out: any = await search_pricebook_all_public.handler(env, { query: 'tank flush' }, CTX);
      expect(out.status).toBe('success');
      expect(out._warnings ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('budget_fallback_skipped')]));
      
      expect(calls.length).toBe(6);
    } finally {
      spy.mockRestore();
    }
  });
});
