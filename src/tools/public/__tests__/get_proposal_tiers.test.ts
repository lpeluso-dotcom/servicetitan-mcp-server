import { describe, it, expect } from 'vitest';
import { get_proposal_tiers_public, MAX_TIERS } from '../get_proposal_tiers';
import { PUBLIC_TOOLS } from '../../public-registry';
import { makeBackendEnv, path, CTX } from './helpers';

const PROPOSAL = {
  id: 20, name: 'Water Heater Options',
  estimateAssignments: [
    { order: 2, estimateTemplateId: 11, proposalTypeOptionId: 102 },
    { order: 1, estimateTemplateId: 10, proposalTypeOptionId: 101 },
  ],
};

function fixture() {
  return makeBackendEnv((call) => {
    const p = path(call);
    if (p === '/sales/v2/tenant/000000000/proposal-templates/20') return PROPOSAL;
    if (p === '/sales/v2/tenant/000000000/estimate-templates/10') return { id: 10, name: 'Good', active: true, items: [{}, {}] };
    if (p === '/sales/v2/tenant/000000000/estimate-templates/11') return { id: 11, name: 'Better', active: true, items: [{}, {}, {}] };
    if (p === '/sales/v2/tenant/000000000/proposal-templates/404') return new Response('{}', { status: 404 });
    throw new Error(`unexpected ${call.endpoint}`);
  });
}

describe('get_proposal_tiers (public)', () => {
  it('returns tiers in assignment order with template names and item counts', async () => {
    const { env } = fixture();
    const out: any = await get_proposal_tiers_public.handler(env, { proposalId: 20 }, CTX);
    expect(out).toEqual({
      proposalId: 20,
      proposalName: 'Water Heater Options',
      tiers: [
        { order: 1, proposalTypeOptionId: 101, estimateTemplateId: 10, templateName: 'Good', itemCount: 2, active: true },
        { order: 2, proposalTypeOptionId: 102, estimateTemplateId: 11, templateName: 'Better', itemCount: 3, active: true },
      ],
      _source: 'live',
      _pricing_note: 'Tier prices are computed by ServiceTitan when an estimate is built (dynamic pricing); this tool does not report tier totals.',
    });
  });

  it('propagates a missing proposal as not_found', async () => {
    const { env } = fixture();
    await expect(get_proposal_tiers_public.handler(env, { proposalId: 404 }, CTX)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('is registered in PUBLIC_TOOLS under the same tool name', () => {
    expect(PUBLIC_TOOLS).toContain(get_proposal_tiers_public);
    expect(get_proposal_tiers_public.name).toBe('get_proposal_tiers');
  });

  it('caps tiers at MAX_TIERS and warns, keeping the lowest-order assignments', async () => {
    const manyAssignments = Array.from({ length: MAX_TIERS + 3 }, (_, i) => ({
      order: i + 1,
      estimateTemplateId: 100 + i,
      proposalTypeOptionId: 200 + i,
    }));
    const { env } = makeBackendEnv((call) => {
      const p = path(call);
      if (p === '/sales/v2/tenant/000000000/proposal-templates/30') {
        return { id: 30, name: 'Big Ladder', estimateAssignments: manyAssignments };
      }
      const m = p.match(/estimate-templates\/(\d+)$/);
      if (m) return { id: Number(m[1]), name: `Tier ${m[1]}`, active: true, items: [{}] };
      throw new Error(`unexpected ${call.endpoint}`);
    });
    const out: any = await get_proposal_tiers_public.handler(env, { proposalId: 30 }, CTX);
    expect(out.tiers).toHaveLength(MAX_TIERS);
    expect(out.tiers[0].order).toBe(1);
    expect(out.tiers[MAX_TIERS - 1].order).toBe(MAX_TIERS);
    expect(out._warnings).toBeDefined();
    expect(out._warnings.some((w: string) => w.startsWith('tiers_truncated:'))).toBe(true);
  });

  it('fails soft on an unreadable estimate template: null fields plus a warning, other tiers unaffected', async () => {
    const { env } = makeBackendEnv((call) => {
      const p = path(call);
      if (p === '/sales/v2/tenant/000000000/proposal-templates/40') {
        return {
          id: 40, name: 'Partial',
          estimateAssignments: [
            { order: 1, estimateTemplateId: 10, proposalTypeOptionId: 101 },
            { order: 2, estimateTemplateId: 999, proposalTypeOptionId: 102 },
          ],
        };
      }
      if (p === '/sales/v2/tenant/000000000/estimate-templates/10') return { id: 10, name: 'Good', active: true, items: [{}, {}] };
      if (p === '/sales/v2/tenant/000000000/estimate-templates/999') return new Response('{}', { status: 404 });
      throw new Error(`unexpected ${call.endpoint}`);
    });
    const out: any = await get_proposal_tiers_public.handler(env, { proposalId: 40 }, CTX);
    expect(out.tiers).toEqual([
      { order: 1, proposalTypeOptionId: 101, estimateTemplateId: 10, templateName: 'Good', itemCount: 2, active: true },
      { order: 2, proposalTypeOptionId: 102, estimateTemplateId: 999, templateName: null, itemCount: null, active: null },
    ]);
    expect(out._warnings).toBeDefined();
    expect(out._warnings.some((w: string) => w.startsWith('estimate_template_unresolved:') && w.includes('999'))).toBe(true);
  });
});
