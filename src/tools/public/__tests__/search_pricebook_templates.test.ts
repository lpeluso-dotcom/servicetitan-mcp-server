import { describe, it, expect } from 'vitest';
import { search_pricebook_templates_public } from '../search_pricebook_templates';
import { PUBLIC_TOOLS } from '../../public-registry';
import { makeBackendEnv, page, path, query, CTX } from './helpers';

const ESTIMATES = [
  { id: 10, name: 'Water Heater Replace 50 gal', active: true, items: [] },
  { id: 11, name: 'Drain Clean', active: false, items: [] },
];
const PROPOSALS = [{ id: 20, name: 'Water Heater Options', active: true }];

function fixture() {
  return makeBackendEnv((call) => {
    if (path(call).endsWith('/estimate-templates')) return page(ESTIMATES);
    if (path(call).endsWith('/proposal-templates')) return page(PROPOSALS);
    throw new Error(`unexpected ${call.endpoint}`);
  });
}

describe('search_pricebook_templates (public)', () => {
  it('matches every word across estimate and proposal templates, active or not', async () => {
    const { env, calls } = fixture();
    const out: any = await search_pricebook_templates_public.handler(env, { query: 'water heater' }, CTX);
    expect(out.results).toEqual([
      { kind: 'estimate_template', id: 10, name: 'Water Heater Replace 50 gal', active: true },
      { kind: 'proposal_template', id: 20, name: 'Water Heater Options', active: true },
    ]);
    expect(out).toMatchObject({ count: 2, _source: 'live-scan' });
    expect(Object.fromEntries(query(calls[0]))).toEqual({ active: 'Any', page: '1', pageSize: '50' });
  });

  it('respects limit', async () => {
    const { env } = fixture();
    const out: any = await search_pricebook_templates_public.handler(env, { query: 'water', limit: 1 }, CTX);
    expect(out.results).toHaveLength(1);
    expect(out.total_matches).toBe(2);
  });

  it('is registered in PUBLIC_TOOLS under the same tool name', () => {
    expect(PUBLIC_TOOLS).toContain(search_pricebook_templates_public);
    expect(search_pricebook_templates_public.name).toBe('search_pricebook_templates');
  });
});
