import { describe, it, expect } from 'vitest';
import { list_technicians_available_public } from '../list_technicians_available';
import { PUBLIC_TOOLS } from '../../public-registry';
import { makeBackendEnv, page, path, query, CTX } from './helpers';

const TECHS = [{ id: 11, name: 'Alex Rivera' }];

describe('list_technicians_available (public)', () => {
  it('lists the active roster with paging and makes exactly one call', async () => {
    const { env, calls } = makeBackendEnv(() => page(TECHS));
    const out: any = await list_technicians_available_public.handler(env, { page: 2, pageSize: 25 }, CTX);
    expect(out).toEqual({ technicians: TECHS, _source: 'live' });
    expect(calls).toHaveLength(1);
    expect(path(calls[0])).toBe('/settings/v2/tenant/000000000/technicians');
    expect(Object.fromEntries(query(calls[0]))).toEqual({ active: 'true', page: '2', pageSize: '25' });
  });

  it('warns instead of silently dropping date and business-unit filters', async () => {
    const { env, calls } = makeBackendEnv(() => page(TECHS));
    const out: any = await list_technicians_available_public.handler(env, { date: '2026-09-25', businessUnitName: 'HVAC' }, CTX);
    expect(calls).toHaveLength(1);
    expect(out._warnings).toEqual([
      'date_ignored: ServiceTitan has no technician-availability-by-date endpoint; returning the active roster',
      'businessUnit_ignored: the ServiceTitan technician roster cannot be filtered by business unit',
    ]);
  });

  it('rejects businessUnitId together with businessUnitName', async () => {
    const { env } = makeBackendEnv(() => page(TECHS));
    await expect(
      list_technicians_available_public.handler(env, { businessUnitId: 5, businessUnitName: 'HVAC' }, CTX),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('is registered in PUBLIC_TOOLS under the same tool name', () => {
    expect(PUBLIC_TOOLS).toContain(list_technicians_available_public);
    expect(list_technicians_available_public.name).toBe('list_technicians_available');
  });
});
