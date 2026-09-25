import { describe, it, expect } from 'vitest';
import { update_proposal_template } from '../../sales/update_proposal_template';
import { PUBLIC_TOOLS } from '../../public-registry';
import { makeBackendEnv, CTX } from './helpers';

describe('update_proposal_template', () => {
  it('PATCHes only the provided fields after confirmation', async () => {
    const { env, calls } = makeBackendEnv(() => ({ id: 20 }));
    const args = { templateId: 20, name: 'Renamed', active: false };
    const preview: any = await update_proposal_template.handler(env, { ...args, dryRun: true }, CTX);
    expect(preview).toMatchObject({ st_endpoint: '/sales/v2/tenant/000000000/proposal-templates/20', st_method: 'PATCH' });
    expect(calls).toHaveLength(0);
    await update_proposal_template.handler(env, { ...args, dryRun: false, confirmation_token: preview.confirmation_token }, CTX);
    expect(calls).toEqual([
      { kind: 'write', endpoint: '/sales/v2/tenant/000000000/proposal-templates/20', method: 'PATCH', body: { name: 'Renamed', active: false } },
    ]);
  });

  it('requires at least one field and refuses categoryIds', async () => {
    const { env, calls } = makeBackendEnv(() => ({}));
    await expect(update_proposal_template.handler(env, { templateId: 20, dryRun: true }, CTX)).rejects.toMatchObject({ code: 'validation_error' });
    await expect(update_proposal_template.handler(env, { templateId: 20, categoryIds: [1], dryRun: true }, CTX)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringContaining('categoryIds'),
    });
    expect(calls).toHaveLength(0);
  });

  it('is registered in PUBLIC_TOOLS', () => {
    expect(PUBLIC_TOOLS).toContain(update_proposal_template);
  });
});
