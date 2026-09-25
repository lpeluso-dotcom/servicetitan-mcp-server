import { z } from 'zod';
import type { ToolDef } from '../types';
import { rejectUnsupportedSTFilters } from '../../st';
import { defaultShaper } from '../../response-shape';
import { readJobTimesheetsLive } from '../payroll/job-timesheets-live';

const DEFAULT_PAGESIZE = 100;
const MAX_PAGESIZE = 500;
const NOT_LIVE =
  'the live ServiceTitan endpoint cannot filter by this field. Pass jobId for one job, or page the tenant-wide list with modifiedOnOrAfter and filter the rows yourself.';

interface Args {
  jobId?: number;
  modifiedOnOrAfter?: string;
  technicianId?: number;
  appointmentId?: number;
  arrivedOnOrAfter?: string;
  arrivedOnOrBefore?: string;
  page?: number;
  pageSize?: number;
}

export const payroll_job_timesheets_list_public: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'payroll_job_timesheets_list',
  description:
    'List ServiceTitan payroll job timesheets (dispatched/arrived/done times per technician per appointment), with ' +
    'minute-truncated drive_minutes and working_minutes. Pass jobId for one job, or page the tenant-wide list with ' +
    'modifiedOnOrAfter. technicianId, appointmentId and arrived* filters are rejected: ServiceTitan cannot apply them. ' +
    'Source: live ST. Default page size 100, max 500.',
  zodSchema: {
    jobId: z.number().int().positive().optional().describe('One job (uses the per-job endpoint; no paging).'),
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601 timestamp for the tenant-wide list.'),
    technicianId: z.number().int().positive().optional().describe('NOT SUPPORTED by ServiceTitan here; returns a validation error.'),
    appointmentId: z.number().int().positive().optional().describe('NOT SUPPORTED by ServiceTitan here; returns a validation error.'),
    arrivedOnOrAfter: z.string().optional().describe('NOT SUPPORTED by ServiceTitan here; returns a validation error.'),
    arrivedOnOrBefore: z.string().optional().describe('NOT SUPPORTED by ServiceTitan here; returns a validation error.'),
    page: z.number().int().positive().optional().describe('Page number, default 1.'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}.`),
  },
  stEndpoint: { method: 'GET', path: '/payroll/v2/tenant/{tid}/jobs/timesheets', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    rejectUnsupportedSTFilters(
      args as unknown as Record<string, unknown>,
      { technicianId: NOT_LIVE, appointmentId: NOT_LIVE, arrivedOnOrAfter: NOT_LIVE, arrivedOnOrBefore: NOT_LIVE },
      correlation,
    );
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    return readJobTimesheetsLive(env, args, env.ST_TENANT_ID, page, pageSize, actor, correlation);
  },
  transformResult: defaultShaper,
};
