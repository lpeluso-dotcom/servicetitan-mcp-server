import { describe, it, expect } from 'vitest';
import { create_proposal_template } from '../../sales/create_proposal_template';
import { PUBLIC_TOOLS } from '../../public-registry';
import { makeBackendEnv, CTX } from './helpers';

const ARGS = {
  name: 'Water Heater Options',
  proposalTypeId: 5,
  businessUnitIds: [100],
  estimateAssignments: [
    { order: 1, estimateTemplateId: 10, proposalTypeOptionId: 11 },
    { order: 2, estimateTemplateId: 11, proposalTypeOptionId: 12 },
  ],
};

describe('create_proposal_template', () => {
  it('dryRun previews without calling ServiceTitan; confirm POSTs the write shape', async () => {
    const { env, calls } = makeBackendEnv(() => 321);
    const preview: any = await create_proposal_template.handler(env, { ...ARGS, dryRun: true }, CTX);
    expect(preview).toMatchObject({ dryRun: true, st_endpoint: '/sales/v2/tenant/000000000/proposal-templates', st_method: 'POST' });
    expect(calls).toHaveLength(0);

    const done: any = await create_proposal_template.handler(env, { ...ARGS, dryRun: false, confirmation_token: preview.confirmation_token }, CTX);
    expect(done).toMatchObject({ dryRun: false, tool: 'create_proposal_template', result: 321 });
    expect(calls).toEqual([{ kind: 'write', endpoint: '/sales/v2/tenant/000000000/proposal-templates', method: 'POST', body: ARGS }]);
  });

  it('refuses categoryIds before issuing a token', async () => {
    const { env, calls } = makeBackendEnv(() => 1);
    await expect(create_proposal_template.handler(env, { ...ARGS, categoryIds: [7], dryRun: true }, CTX)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringContaining('categoryIds'),
    });
    expect(calls).toHaveLength(0);
  });

  it('is registered in PUBLIC_TOOLS as a write', () => {
    expect(PUBLIC_TOOLS).toContain(create_proposal_template);
    expect(create_proposal_template.isWrite).toBe(true);
  });
});
