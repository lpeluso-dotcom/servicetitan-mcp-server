import { z } from 'zod';
import { McpError } from '../../errors';
import { cacheGet } from '../../cache';
import { readST, readSTPaged, type ReadSTContext } from '../../st';
import type { ToolDef } from '../index';
import type { Env } from '../../env';
import { defaultShaper } from '../../response-shape';

const TENANT_ID = '000000000';

const ST_IDS_BATCH_MAX = 50;

interface Args {
  status?: string;
  businessUnitId?: number;
  businessUnitName?: string;
  technicianId?: number;
  technicianName?: string;
  
  
  page?: number;
  pageSize?: number;
}

export const DEFAULT_TIMEZONE = 'America/New_York';


export function configuredTimeZone(env: Pick<Env, 'ST_TIMEZONE'>): string {
  const tz = env.ST_TIMEZONE?.trim();
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    
    
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new McpError('validation_error', `ST_TIMEZONE is not a valid IANA time zone: ${tz}`);
  }
  return tz;
}

export type NameResolver = (env: Env, input: string, ctx: ReadSTContext) => Promise<{ id: number; ambiguous: boolean }>;

export interface ListJobsTodayDeps {
  description: string;
  argHelp: { businessUnitName: string; technicianName: string };
  resolveBusinessUnit: NameResolver;
  resolveTechnician: NameResolver;
}


function zonedDateParts(now: Date, tz: string): { y: number; m: number; d: number } {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function zonedMidnightToUtcIso(y: number, m: number, d: number, tz: string): string {
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcGuess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  let hour = get('hour');
  if (hour === 24) hour = 0; 
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  const offset = asIfUtc - utcGuess;
  return new Date(utcGuess - offset).toISOString();
}

export function makeListJobsToday(deps: ListJobsTodayDeps): ToolDef<Args> {
  return {
  isWrite: false,
  permission: "staff",
  name: 'list_jobs_today',
  description: deps.description,
  zodSchema: {
    status: z.string().optional().describe('Filter by job status (e.g. "Scheduled", "InProgress")'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    businessUnitName: z.string().min(1).optional().describe(deps.argHelp.businessUnitName),
    technicianId: z.number().int().positive().optional().describe('Filter by assigned technician ID'),
    technicianName: z.string().min(1).optional().describe(deps.argHelp.technicianName),
    page: z.number().int().positive().optional().describe('Deprecated/ignored — pagination is automatic.'),
    pageSize: z.number().int().positive().max(200).optional().describe('Deprecated/ignored — pagination is automatic.'),
  },

  outputSchema: {
    jobs: z.array(z.record(z.string(), z.unknown())),
    date: z.string(),
    _source: z.string(),
    _warnings: z.array(z.string()).optional(),
  },
  
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/appointments', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    if (args.businessUnitId !== undefined && args.businessUnitName !== undefined) {
      throw new McpError('validation_error', 'pass at most one of businessUnitId or businessUnitName', { correlation });
    }
    if (args.technicianId !== undefined && args.technicianName !== undefined) {
      throw new McpError('validation_error', 'pass at most one of technicianId or technicianName', { correlation });
    }

    const warnings: string[] = [];
    let buId = args.businessUnitId;
    if (args.businessUnitName !== undefined) {
      const r = await deps.resolveBusinessUnit(env, args.businessUnitName, { actor, correlation });
      buId = r.id;
      if (r.ambiguous) warnings.push(`businessUnit_name_ambiguous: chose ${r.id} for "${args.businessUnitName}"`);
    }
    let techId = args.technicianId;
    if (args.technicianName !== undefined) {
      const r = await deps.resolveTechnician(env, args.technicianName, { actor, correlation });
      techId = r.id;
      if (r.ambiguous) warnings.push(`technician_name_ambiguous: chose ${r.id} for "${args.technicianName}"`);
    }

    const now = new Date();
    const tz = configuredTimeZone(env);
    const { y, m, d } = zonedDateParts(now, tz);
    const today = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const startUtc = zonedMidnightToUtcIso(y, m, d, tz);
    const tmr = new Date(Date.UTC(y, m - 1, d + 1)); 
    const endUtc = zonedMidnightToUtcIso(tmr.getUTCFullYear(), tmr.getUTCMonth() + 1, tmr.getUTCDate(), tz);

    const cacheKey = JSON.stringify({ today, status: args.status ?? '', bu: buId ?? 0, tech: techId ?? 0 });

    const result = await cacheGet(env, 'servicetitan:list_jobs_today', cacheKey, 60, async () => {
      
      const apptQuery: Record<string, unknown> = { startsOnOrAfter: startUtc, startsBefore: endUtc };
      if (techId !== undefined) apptQuery.technicianId = techId;
      const appts = await readSTPaged<{ jobId?: number }>(
        env,
        { actor, correlation },
        `/jpm/v2/tenant/${TENANT_ID}/appointments`,
        apptQuery,
        { pageSize: 200, maxPages: 20 },
      );
      if (appts.hitCap) {
        warnings.push(`appointment_pages_capped: drained ${appts.pagesFetched} pages; some of today's jobs may be omitted`);
      }
      const jobIds = Array.from(
        new Set(appts.rows.map((a) => a.jobId).filter((id): id is number => typeof id === 'number')),
      );
      if (jobIds.length === 0) {
        return { jobs: [] as Array<Record<string, unknown>>, date: today, _source: 'live' as const };
      }

      const jobs: Array<Record<string, unknown>> = [];
      for (let i = 0; i < jobIds.length; i += ST_IDS_BATCH_MAX) {
        const chunk = jobIds.slice(i, i + ST_IDS_BATCH_MAX);
        const resp = await readST<{ data?: Array<Record<string, unknown>> }>(
          env,
          { actor, correlation },
          `/jpm/v2/tenant/${TENANT_ID}/jobs`,
          { ids: chunk.join(','), pageSize: chunk.length },
        );
        jobs.push(...(resp.data ?? []));
      }

      
      let filtered = jobs;
      if (buId !== undefined) filtered = filtered.filter((j) => j.businessUnitId === buId);
      if (args.status !== undefined) {
        const want = args.status.toLowerCase();
        filtered = filtered.filter((j) => String(j.jobStatus).toLowerCase() === want);
      }

      return { jobs: filtered, date: today, _source: 'live' as const };
    });

    return warnings.length > 0 ? { ...result, _warnings: warnings } : result;
  },
  transformResult: defaultShaper,
  };
}
