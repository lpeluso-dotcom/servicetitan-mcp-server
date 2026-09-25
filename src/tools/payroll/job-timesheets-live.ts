import type { Env } from '../../env';
import { readST } from '../../st';

export interface RawTimesheet {
  id: number;
  jobId: number;
  appointmentId?: number;
  technicianId: number;
  dispatchedOn?: string;
  arrivedOn?: string;
  canceledOn?: string;
  doneOn?: string;
  createdOn?: string;
  modifiedOn?: string;
  active: boolean;
}

export interface SlimTimesheet {
  timesheet_id: number;
  job_id: number;
  appointment_id: number | null;
  technician_id: number;
  dispatched_on: string | null;
  arrived_on: string | null;
  canceled_on: string | null;
  done_on: string | null;
  drive_minutes: number | null;
  working_minutes: number | null;
  active: boolean;
  created_on: string | null;
  modified_on: string | null;
}

export function diffMinutes(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  const s = Date.parse(a);
  const e = Date.parse(b);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  return Math.floor(e / 60000) - Math.floor(s / 60000);
}

export function slimLive(t: RawTimesheet): SlimTimesheet {
  return {
    timesheet_id: t.id,
    job_id: t.jobId,
    appointment_id: t.appointmentId ?? null,
    technician_id: t.technicianId,
    dispatched_on: t.dispatchedOn ?? null,
    arrived_on: t.arrivedOn ?? null,
    canceled_on: t.canceledOn ?? null,
    done_on: t.doneOn ?? null,
    drive_minutes: diffMinutes(t.dispatchedOn, t.arrivedOn),
    working_minutes: diffMinutes(t.arrivedOn, t.doneOn),
    active: t.active !== false,
    created_on: t.createdOn ?? null,
    modified_on: t.modifiedOn ?? null,
  };
}

export interface JobTimesheetLiveArgs {
  jobId?: number;
  modifiedOnOrAfter?: string;
}

export async function readJobTimesheetsLive(
  env: Env,
  args: JobTimesheetLiveArgs,
  tenant: string,
  page: number,
  pageSize: number,
  actor: string,
  correlation: string,
): Promise<{
  count: number;
  timesheets: SlimTimesheet[];
  has_more: boolean;
  _source: 'live';
}> {
  
  if (args.jobId !== undefined) {
    const data = await readST<{ data?: RawTimesheet[] }>(
      env,
      { actor, correlation },
      `/payroll/v2/tenant/${tenant}/jobs/${args.jobId}/timesheets`,
    );
    return {
      count: (data.data ?? []).length,
      timesheets: (data.data ?? []).map(slimLive),
      has_more: false,
      _source: 'live',
    };
  }

  
  const query: Record<string, unknown> = { page, pageSize, active: 'Any' };
  if (args.modifiedOnOrAfter !== undefined) {
    query.modifiedOnOrAfter = args.modifiedOnOrAfter;
  }

  const data = await readST<{ data?: RawTimesheet[]; hasMore?: boolean }>(
    env,
    { actor, correlation },
    `/payroll/v2/tenant/${tenant}/jobs/timesheets`,
    query,
  );
  return {
    count: (data.data ?? []).length,
    timesheets: (data.data ?? []).map(slimLive),
    has_more: !!data.hasMore,
    _source: 'live',
  };
}
