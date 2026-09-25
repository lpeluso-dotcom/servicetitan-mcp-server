import { describe, it, expect } from 'vitest';
import { delete_proposal_template } from '../../sales/delete_proposal_template';
import { PUBLIC_TOOLS } from '../../public-registry';
import { makeBackendEnv, CTX } from './helpers';

describe('delete_proposal_template', () => {
  it('previews, then sends DELETE to the template path on confirm', async () => {
    const { env, calls } = makeBackendEnv(() => ({}));
    const preview: any = await delete_proposal_template.handler(env, { templateId: 20, dryRun: true }, CTX);
    expect(preview).toMatchObject({ st_endpoint: '/sales/v2/tenant/000000000/proposal-templates/20', st_method: 'DELETE' });
    expect(calls).toHaveLength(0);
    await delete_proposal_template.handler(env, { templateId: 20, dryRun: false, confirmation_token: preview.confirmation_token }, CTX);
    expect(calls).toEqual([{ kind: 'write', endpoint: '/sales/v2/tenant/000000000/proposal-templates/20', method: 'DELETE', body: {} }]);
  });

  it('is registered in PUBLIC_TOOLS', () => {
    expect(PUBLIC_TOOLS).toContain(delete_proposal_template);
  });
});
