import { describe, it, expect } from 'vitest';
import { payroll_job_timesheets_list_public } from '../payroll_job_timesheets_list';
import { PUBLIC_TOOLS } from '../../public-registry';
import { makeBackendEnv, page, path, query, CTX } from './helpers';

const SHEET = {
  id: 1, jobId: 9, appointmentId: 3, technicianId: 13, active: true,
  dispatchedOn: '2026-09-25T13:00:00Z', arrivedOn: '2026-09-25T13:25:40Z', doneOn: '2026-09-25T15:00:10Z',
};

describe('payroll_job_timesheets_list (public)', () => {
  it('reads one job\'s timesheets and computes minute-truncated drive and work time', async () => {
    const { env, calls } = makeBackendEnv(() => page([SHEET]));
    const out: any = await payroll_job_timesheets_list_public.handler(env, { jobId: 9 }, CTX);
    expect(path(calls[0])).toBe('/payroll/v2/tenant/000000000/jobs/9/timesheets');
    expect(out).toMatchObject({ count: 1, has_more: false, _source: 'live' });
    expect(out.timesheets[0]).toMatchObject({ timesheet_id: 1, job_id: 9, technician_id: 13, drive_minutes: 25, working_minutes: 95 });
  });

  it('pages the tenant-wide endpoint with modifiedOnOrAfter', async () => {
    const { env, calls } = makeBackendEnv(() => ({ ...page([SHEET]), hasMore: true }));
    const out: any = await payroll_job_timesheets_list_public.handler(env, { modifiedOnOrAfter: '2026-09-01T00:00:00Z', page: 2, pageSize: 50 }, CTX);
    expect(path(calls[0])).toBe('/payroll/v2/tenant/000000000/jobs/timesheets');
    expect(Object.fromEntries(query(calls[0]))).toEqual({ page: '2', pageSize: '50', active: 'Any', modifiedOnOrAfter: '2026-09-01T00:00:00Z' });
    expect(out.has_more).toBe(true);
  });

  it('rejects filters the live endpoint cannot apply, before any call', async () => {
    const { env, calls } = makeBackendEnv(() => page([]));
    await expect(payroll_job_timesheets_list_public.handler(env, { technicianId: 13 }, CTX)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringContaining('`technicianId`'),
    });
    expect(calls).toHaveLength(0);
  });

  it('is registered in PUBLIC_TOOLS under the same tool name', () => {
    expect(PUBLIC_TOOLS).toContain(payroll_job_timesheets_list_public);
    expect(payroll_job_timesheets_list_public.name).toBe('payroll_job_timesheets_list');
  });
});
