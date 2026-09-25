import { makeListJobsToday } from '../jobs/list_jobs_today.impl';
import { resolveBusinessUnitLive, resolveTechnicianLive } from '../../st-roster';

export const list_jobs_today_public = makeListJobsToday({
  description:
    'List ServiceTitan jobs scheduled for TODAY in the configured time zone (ST_TIMEZONE, default America/New_York). ' +
    "The ST Jobs API has no scheduled-date field, so this lists today's APPOINTMENTS by start time and batch-fetches their parent jobs. " +
    'businessUnitName and technicianName are resolved against the live ServiceTitan Settings roster. Source: live ST. ' +
    'page/pageSize are ignored — pagination is automatic (up to 20 pages of 200 appointments).',
  argHelp: {
    businessUnitName: 'Filter by business unit name (resolved against the live ServiceTitan business-unit list).',
    technicianName: 'Filter by technician name (resolved against the live ServiceTitan technician roster).',
  },
  resolveBusinessUnit: (env, input, ctx) => resolveBusinessUnitLive(env, input, ctx),
  resolveTechnician: (env, input, ctx) => resolveTechnicianLive(env, input, ctx),
});
