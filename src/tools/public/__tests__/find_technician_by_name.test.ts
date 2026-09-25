import { describe, it, expect } from 'vitest';
import { find_technician_by_name_public } from '../find_technician_by_name';
import { PUBLIC_TOOLS } from '../../public-registry';
import { makeBackendEnv, page, path, query, CTX } from './helpers';

const ROSTER = [
  { id: 11, name: 'Alex Rivera', businessUnitId: 5, active: true },
  { id: 12, name: 'Alexis Moore', businessUnitId: 6, active: true },
  { id: 13, name: 'Jordan Lee', businessUnitId: 5, active: true },
];

const BUSINESS_UNITS = [
  { id: 5, name: 'North', active: true },
  { id: 6, name: 'South', active: true },
];

function env() {
  return makeBackendEnv((call) => {
    if (path(call) === '/settings/v2/tenant/000000000/technicians') return page(ROSTER);
    if (path(call) === '/settings/v2/tenant/000000000/technicians/13') return ROSTER[2];
    if (path(call) === '/settings/v2/tenant/000000000/technicians/99') return new Response('{}', { status: 404 });

    if (path(call) === '/settings/v2/tenant/000000000/technicians/14') return { id: 14, name: 'Retired Tech', businessUnitId: 5, active: false };
    if (path(call) === '/settings/v2/tenant/000000000/business-units') return page(BUSINESS_UNITS);
    throw new Error(`unexpected ${call.endpoint}`);
  });
}

function truncatedEnv() {
  return makeBackendEnv((call) => {
    if (path(call) === '/settings/v2/tenant/000000000/technicians') {
      const p = Number(query(call).get('page'));
      if (p === 1) return page(ROSTER, true);
      return page([{ id: 1000 + p, name: `Filler Tech ${p}`, businessUnitId: 9, active: true }], true);
    }
    if (path(call) === '/settings/v2/tenant/000000000/business-units') return page(BUSINESS_UNITS);
    throw new Error(`unexpected ${call.endpoint}`);
  });
}


function buFailEnv() {
  return makeBackendEnv((call) => {
    if (path(call) === '/settings/v2/tenant/000000000/technicians') return page(ROSTER);
    if (path(call) === '/settings/v2/tenant/000000000/business-units') return new Response('{}', { status: 500 });
    throw new Error(`unexpected ${call.endpoint}`);
  });
}

function buTruncatedMissingEnv() {
  return makeBackendEnv((call) => {
    if (path(call) === '/settings/v2/tenant/000000000/technicians') return page(ROSTER);
    if (path(call) === '/settings/v2/tenant/000000000/business-units') {
      const p = Number(query(call).get('page'));
      return page([{ id: 900 + p, name: `Other BU ${p}`, active: true }], true);
    }
    throw new Error(`unexpected ${call.endpoint}`);
  });
}

const run = (e: any, name: string) => find_technician_by_name_public.handler(e, { name }, CTX) as Promise<any>;

describe('find_technician_by_name (public)', () => {
  it('reads the active technician roster once, 500 per page', async () => {
    const { env: e, calls } = env();
    await run(e, 'Jordan Lee');
    const techCalls = calls.filter((c) => path(c) === '/settings/v2/tenant/000000000/technicians');
    expect(techCalls).toHaveLength(1);
    expect(Object.fromEntries(query(techCalls[0]))).toEqual({ active: 'true', page: '1', pageSize: '500' });
  });

  it('exact match wins (case-insensitive)', async () => {
    const { env: e } = env();
    expect(await run(e, 'jordan lee')).toMatchObject({
      status: 'found', technician_id: 13, technician_name: 'Jordan Lee', business_unit_id: 5, resolved: 'exact', _source: 'live',
    });
  });

  it('reports ambiguity with candidates', async () => {
    const { env: e } = env();
    expect(await run(e, 'alex')).toEqual({
      status: 'ambiguous', resolved: 'prefix', _source: 'live',
      candidates: [{ id: 11, name: 'Alex Rivera' }, { id: 12, name: 'Alexis Moore' }],
    });
  });

  it('falls back to contains', async () => {
    const { env: e } = env();
    expect(await run(e, 'rivera')).toMatchObject({ status: 'found', technician_id: 11, resolved: 'contains' });
  });

  it('returns not_found for a name on nobody', async () => {
    const { env: e } = env();
    expect(await run(e, 'zed')).toEqual({ status: 'not_found', _source: 'live' });
  });

  it('looks a numeric string up by ID, and a 404 is not_found', async () => {
    const { env: e } = env();
    expect(await run(e, '13')).toMatchObject({ status: 'found', technician_id: 13, resolved: 'numeric' });
    expect(await run(e, '99')).toEqual({ status: 'not_found', _source: 'live' });
  });

  it('returns not_found for an inactive technician looked up by numeric ID', async () => {
    const { env: e } = env();
    expect(await run(e, '14')).toEqual({ status: 'not_found', _source: 'live' });
  });

  it('is registered in PUBLIC_TOOLS under the same tool name', () => {
    expect(PUBLIC_TOOLS).toContain(find_technician_by_name_public);
    expect(find_technician_by_name_public.name).toBe('find_technician_by_name');
  });

  it('a found result carries business_unit (name) and role keys', async () => {
    const { env: e } = env();
    expect(await run(e, 'Jordan Lee')).toMatchObject({
      status: 'found', business_unit_id: 5, business_unit: 'North', role: null,
    });
  });

  it('a found result on a truncated roster carries _warnings', async () => {
    const { env: e } = truncatedEnv();
    const res = await run(e, 'Jordan Lee');
    expect(res.status).toBe('found');
    expect(res._warnings).toEqual(expect.arrayContaining([expect.stringContaining('truncated')]));
  });

  it('an ambiguous result on a truncated roster carries _warnings', async () => {
    const { env: e } = truncatedEnv();
    const res = await run(e, 'alex');
    expect(res.status).toBe('ambiguous');
    expect(res._warnings).toEqual(expect.arrayContaining([expect.stringContaining('truncated')]));
  });

  it('a failed business-units read still gives found, with business_unit null and a warning', async () => {
    const { env: e } = buFailEnv();
    const res = await run(e, 'Jordan Lee');
    expect(res.status).toBe('found');
    expect(res.business_unit).toBeNull();
    expect(res._warnings).toEqual(expect.arrayContaining([expect.stringContaining('business_unit')]));
  });

  it('a truncated business-units roster missing the id gives a warning', async () => {
    const { env: e } = buTruncatedMissingEnv();
    const res = await run(e, 'Jordan Lee');
    expect(res.status).toBe('found');
    expect(res.business_unit).toBeNull();
    expect(res._warnings).toEqual(expect.arrayContaining([expect.stringContaining('business_unit')]));
  });
});
