import { describe, it, expect } from 'vitest';
import { resolveTechnicianLive, resolveBusinessUnitLive } from './st-roster';
import { makeBackendEnv, page, path, CTX } from './tools/public/__tests__/helpers';

describe('resolveTechnicianLive / resolveBusinessUnitLive — truncated roster', () => {
  it('resolveTechnicianLive: a miss against a truncated roster says the roster was cut off', async () => {
    const { env } = makeBackendEnv((call) => {
      const p = path(call);
      if (p === '/settings/v2/tenant/000000000/technicians') return page([{ id: 1, name: 'Someone Else' }], true);
      throw new Error(`unexpected ${call.endpoint}`);
    });

    await expect(resolveTechnicianLive(env, 'nobody-like-this', CTX)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(/technicianName not found: nobody-like-this.*cut off after \d+ rows.*may exist beyond the cap/),
    });
  });

  it('resolveBusinessUnitLive: a miss against a truncated roster says the roster was cut off', async () => {
    const { env } = makeBackendEnv((call) => {
      const p = path(call);
      if (p === '/settings/v2/tenant/000000000/business-units') return page([{ id: 1, name: 'Someone Else' }], true);
      throw new Error(`unexpected ${call.endpoint}`);
    });

    await expect(resolveBusinessUnitLive(env, 'nobody-like-this', CTX)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(/businessUnitName not found: nobody-like-this.*cut off after \d+ rows.*may exist beyond the cap/),
    });
  });

  it('resolveTechnicianLive: a miss against a NON-truncated roster keeps the plain message', async () => {
    const { env } = makeBackendEnv((call) => {
      const p = path(call);
      if (p === '/settings/v2/tenant/000000000/technicians') return page([{ id: 1, name: 'Someone Else' }], false);
      throw new Error(`unexpected ${call.endpoint}`);
    });

    await expect(resolveTechnicianLive(env, 'nobody-like-this', CTX)).rejects.toMatchObject({
      code: 'validation_error',
      message: 'technicianName not found: nobody-like-this',
    });
  });

  it('resolveBusinessUnitLive: a miss against a NON-truncated roster keeps the plain message', async () => {
    const { env } = makeBackendEnv((call) => {
      const p = path(call);
      if (p === '/settings/v2/tenant/000000000/business-units') return page([{ id: 1, name: 'Someone Else' }], false);
      throw new Error(`unexpected ${call.endpoint}`);
    });

    await expect(resolveBusinessUnitLive(env, 'nobody-like-this', CTX)).rejects.toMatchObject({
      code: 'validation_error',
      message: 'businessUnitName not found: nobody-like-this',
    });
  });
});
