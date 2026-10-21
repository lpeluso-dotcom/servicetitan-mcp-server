import { describe, it, expect } from 'vitest';
import { resolveSku, resolveSkus } from '../sku-resolve';
import { CATALOG_MAX_PAGES } from '../../pricebook/catalog-scan';
import { makeBackendEnv, page, path, CTX } from '../../public/__tests__/helpers';

const SERVICES = '/pricebook/v2/tenant/000000000/services';
const MATERIALS = '/pricebook/v2/tenant/000000000/materials';
const EQUIPMENT = '/pricebook/v2/tenant/000000000/equipment';

interface Catalogs { services?: unknown[]; materials?: unknown[]; equipment?: unknown[] }

function catalogEnv(c: Catalogs, extra: { hasMore?: boolean; fail?: string[] } = {}) {
  return makeBackendEnv((call) => {
    const p = path(call);
    if (extra.fail?.includes(p)) return new Response('upstream broke', { status: 500 });
    const rows = p === SERVICES ? c.services : p === MATERIALS ? c.materials : p === EQUIPMENT ? c.equipment : undefined;
    return page(rows ?? [], extra.hasMore ?? false);
  });
}

describe('resolveSku', () => {
  it('resolves an exact code match on services, after scanning all three catalogues', async () => {
    const { env, calls } = catalogEnv({ services: [{ id: 1, code: 'SKU1', displayName: 'Widget service', active: true }] });
    const res = await resolveSku(env, CTX, 'SKU1');
    expect(res).toEqual({ status: 'resolved', skuName: 'SKU1', matched: 'SKU1', kind: 'service', active: true });
    expect(calls.map(path)).toEqual([SERVICES, MATERIALS, EQUIPMENT]);
  });

  it('resolves a match that exists only in materials, with kind material', async () => {
    const { env } = catalogEnv({
      services: [{ id: 1, code: 'OTHER', displayName: 'Other' }],
      materials: [{ id: 2, code: 'SKU1', displayName: 'Widget part' }],
    });
    expect(await resolveSku(env, CTX, 'SKU1')).toEqual({ status: 'resolved', skuName: 'SKU1', matched: 'SKU1', kind: 'material' });
  });

  it('resolves an equipment-only match with kind equipment', async () => {
    const { env } = catalogEnv({ equipment: [{ id: 3, code: 'SKU1' }] });
    expect(await resolveSku(env, CTX, 'SKU1')).toMatchObject({ status: 'resolved', kind: 'equipment' });
  });

  it('carries active:false from an inactive row into the result, and scans inactive rows', async () => {
    const { env, calls } = catalogEnv({ services: [{ id: 1, code: 'SKU1', active: false }] });
    const res = await resolveSku(env, CTX, 'SKU1');
    expect(res).toMatchObject({ status: 'resolved', active: false });
    expect(new URL(`https://x.invalid${calls[0].endpoint}`).searchParams.has('active')).toBe(false);
  });

  describe('matching levels', () => {
    it('matches the case and hyphen variants of a code and returns the row\'s exact code', async () => {
      const { env } = catalogEnv({ services: [{ id: 1, code: 'AB-12' }] });
      expect(await resolveSku(env, CTX, 'ab12')).toEqual({ status: 'resolved', skuName: 'ab12', matched: 'AB-12', kind: 'service' });
    });

    it('level 1: an exact case-sensitive code beats a variant match in another catalogue', async () => {
      const { env } = catalogEnv({ services: [{ id: 1, code: 'AB-12' }], materials: [{ id: 2, code: 'AB12' }] });
      expect(await resolveSku(env, CTX, 'AB12')).toMatchObject({ status: 'resolved', matched: 'AB12', kind: 'material' });
    });

    it('level 1: an exact case-sensitive code beats a case-only variant', async () => {
      const { env } = catalogEnv({ services: [{ id: 1, code: 'AB12' }], materials: [{ id: 2, code: 'ab12' }] });
      expect(await resolveSku(env, CTX, 'ab12')).toMatchObject({ status: 'resolved', matched: 'ab12', kind: 'material' });
    });

    it('level 2: a single variant match resolves when there is no exact match', async () => {
      const { env } = catalogEnv({ materials: [{ id: 2, code: 'Ab-12' }] });
      expect(await resolveSku(env, CTX, 'ab12')).toMatchObject({ status: 'resolved', matched: 'Ab-12' });
    });

    it('level 1: the same exact code in two catalogues is ambiguous, listing both', async () => {
      const { env } = catalogEnv({ services: [{ id: 1, code: 'SKU1' }], materials: [{ id: 2, code: 'SKU1' }] });
      const res = await resolveSku(env, CTX, 'SKU1');
      expect(res).toEqual({ status: 'ambiguous', skuName: 'SKU1', candidates: ['service SKU1 (id 1)', 'material SKU1 (id 2)'] });
    });

    it('level 1: two rows with the same exact code in one catalogue are ambiguous', async () => {
      const { env } = catalogEnv({ services: [{ id: 1, code: 'SKU1', active: true }, { id: 9, code: 'SKU1', active: false }] });
      expect(await resolveSku(env, CTX, 'SKU1')).toMatchObject({ status: 'ambiguous', candidates: ['service SKU1 (id 1)', 'service SKU1 (id 9)'] });
    });

    it('level 2: two different variant matches and no exact match are ambiguous', async () => {
      const { env } = catalogEnv({ services: [{ id: 1, code: 'AB-12' }], materials: [{ id: 2, code: 'AB12' }] });
      expect(await resolveSku(env, CTX, 'ab12')).toMatchObject({
        status: 'ambiguous',
        candidates: ['service AB-12 (id 1)', 'material AB12 (id 2)'],
      });
    });

    it('is ambiguous even when another catalogue could not be read', async () => {
      const { env } = catalogEnv({ services: [{ id: 1, code: 'SKU1' }], materials: [{ id: 2, code: 'SKU1' }] }, { fail: [EQUIPMENT] });
      expect(await resolveSku(env, CTX, 'SKU1')).toMatchObject({ status: 'ambiguous' });
    });
  });

  it('does not resolve by display name: a name-only input is not_found', async () => {
    const { env } = catalogEnv({ materials: [{ id: 2, code: 'M-9', displayName: 'Widget part' }] });
    expect(await resolveSku(env, CTX, 'Widget part')).toEqual({ status: 'not_found', skuName: 'Widget part' });
  });

  it('ignores a row with no code', async () => {
    const { env } = catalogEnv({ services: [{ id: 1, displayName: 'SKU1' }] });
    expect(await resolveSku(env, CTX, 'SKU1')).toMatchObject({ status: 'not_found' });
  });

  it('returns not_found when no catalog has the code and every scan completed', async () => {
    const { env, calls } = catalogEnv({
      services: [{ id: 1, code: 'A' }],
      materials: [{ id: 2, code: 'B' }],
      equipment: [{ id: 3, code: 'C' }],
    });
    const res = await resolveSku(env, CTX, 'SKU1');
    expect(res).toEqual({ status: 'not_found', skuName: 'SKU1' });
    expect(calls.map(path)).toEqual([SERVICES, MATERIALS, EQUIPMENT]);
  });

  it('does not treat a partial code as a match', async () => {
    const { env } = catalogEnv({ services: [{ id: 1, code: 'SKU10' }], materials: [], equipment: [] });
    expect(await resolveSku(env, CTX, 'SKU1')).toEqual({ status: 'not_found', skuName: 'SKU1' });
  });

  it('returns unavailable, not not_found, when a ServiceTitan read fails and nothing matched', async () => {
    const { env } = catalogEnv({ services: [{ id: 1, code: 'A' }] }, { fail: [MATERIALS] });
    const res = await resolveSku(env, CTX, 'SKU1');
    expect(res.status).toBe('unavailable');
    expect((res as { reason: string }).reason).toContain('materials');
  });

  it('still resolves when a later catalog is down but an earlier one matched', async () => {
    const { env } = catalogEnv({ services: [{ id: 1, code: 'SKU1' }] }, { fail: [MATERIALS, EQUIPMENT] });
    expect(await resolveSku(env, CTX, 'SKU1')).toMatchObject({ status: 'resolved', kind: 'service' });
  });

  it('returns unavailable when every read fails', async () => {
    const { env } = catalogEnv({}, { fail: [SERVICES, MATERIALS, EQUIPMENT] });
    expect(await resolveSku(env, CTX, 'SKU1')).toMatchObject({ status: 'unavailable' });
  });

  it('returns unavailable when a scan hit the page cap without a match (the miss is not proof)', async () => {
    const { env, calls } = catalogEnv({ services: [{ id: 1, code: 'A' }] }, { hasMore: true });
    const res = await resolveSku(env, CTX, 'SKU1');
    expect(res.status).toBe('unavailable');
    expect((res as { reason: string }).reason).toMatch(/truncated|page cap/i);
    expect(calls.length).toBe(3 * CATALOG_MAX_PAGES);
  });

  it('still resolves a unique hit found inside a truncated scan', async () => {
    const { env } = makeBackendEnv((call) => {
      const onFirstPage = new URL(`https://x.invalid${call.endpoint}`).searchParams.get('page') === '1';
      const rows = path(call) === SERVICES && onFirstPage ? [{ id: 1, code: 'SKU1' }] : [];
      return page(rows, true);
    });
    expect(await resolveSku(env, CTX, 'SKU1')).toMatchObject({ status: 'resolved', kind: 'service' });
  });

  it('returns unavailable for a lone variant match when another catalogue could not be read', async () => {
    // An exact code could be sitting in the unread catalogue, and an exact
    // match outranks the variant, so the variant is not a safe answer.
    const { env } = catalogEnv({ materials: [{ id: 2, code: 'Ab-12' }] }, { fail: [EQUIPMENT] });
    const res = await resolveSku(env, CTX, 'ab12');
    expect(res.status).toBe('unavailable');
    expect((res as { reason: string }).reason).toContain('equipment');
  });

  it('returns unavailable for a lone variant match inside a truncated scan', async () => {
    const { env } = makeBackendEnv((call) => {
      const onFirstPage = new URL(`https://x.invalid${call.endpoint}`).searchParams.get('page') === '1';
      const rows = path(call) === SERVICES && onFirstPage ? [{ id: 1, code: 'Ab-12' }] : [];
      return page(rows, true);
    });
    const res = await resolveSku(env, CTX, 'ab12');
    expect(res.status).toBe('unavailable');
    expect((res as { reason: string }).reason).toMatch(/truncated/i);
  });

  it('treats a blank name as not_found without any read', async () => {
    const { env, calls } = catalogEnv({});
    expect(await resolveSku(env, CTX, '   ')).toEqual({ status: 'not_found', skuName: '   ' });
    expect(calls).toHaveLength(0);
  });
});

describe('resolveSkus', () => {
  it('scans each catalog at most once for many names, and answers per name in order', async () => {
    const { env, calls } = catalogEnv({
      services: [{ id: 1, code: 'SKU1' }],
      materials: [{ id: 2, code: 'SKU2' }],
    });
    const out = await resolveSkus(env, CTX, ['SKU1', 'SKU2', 'SKU3', 'SKU1']);
    expect(out.map((r) => [r.skuName, r.status])).toEqual([
      ['SKU1', 'resolved'], ['SKU2', 'resolved'], ['SKU3', 'not_found'], ['SKU1', 'resolved'],
    ]);
    expect(calls.map(path)).toEqual([SERVICES, MATERIALS, EQUIPMENT]);
  });
});
