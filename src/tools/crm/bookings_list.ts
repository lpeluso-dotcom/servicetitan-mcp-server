import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import { assertRowsMatchFilters } from '../filter-guard';
import type { ToolDef } from '../index';

interface Args {
  externalId?: string;
  createdOnOrAfter?: string;
  modifiedOnOrAfter?: string;
  page?: number;
  pageSize?: number;
  includeTotal?: boolean;
}

interface RawBooking {
  id: number;
  status?: string;
  source?: string | null;
  name?: string | null;
  summary?: string | null;
  start?: string | null;
  businessUnitId?: number | null;
  jobTypeId?: number | null;
  campaignId?: number | null;
  jobId?: number | null;
  externalId?: string | null;
  isFirstTimeClient?: boolean | null;
  createdOn?: string | null;
  modifiedOn?: string | null;
}

interface SlimBooking {
  id: number;
  status: string;
  source: string | null;
  name: string | null;
  summary: string | null;
  start: string | null;
  business_unit_id: number | null;
  job_type_id: number | null;
  campaign_id: number | null;
  job_id: number | null;
  external_id: string | null;
  is_first_time_client: boolean | null;
  created_on: string | null;
  modified_on: string | null;
}

/** Explicit projection: address and contacts are never copied into the list row. */
function slim(b: RawBooking): SlimBooking {
  return {
    id: b.id,
    status: b.status ?? '',
    source: b.source ?? null,
    name: b.name ?? null,
    summary: b.summary ?? null,
    start: b.start ?? null,
    business_unit_id: b.businessUnitId ?? null,
    job_type_id: b.jobTypeId ?? null,
    campaign_id: b.campaignId ?? null,
    job_id: b.jobId ?? null,
    external_id: b.externalId ?? null,
    is_first_time_client: b.isFirstTimeClient ?? null,
    created_on: b.createdOn ?? null,
    modified_on: b.modifiedOn ?? null,
  };
}

const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const bookings_list: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'bookings_list',
  description:
    'List web/partner bookings (Scorpion, Lace, Reserve with Google requests waiting to become jobs) by external id or date window. Slim rows exclude address and contacts; use booking_get for those. Source: live ST. Default page size 25, max 100.',
  zodSchema: {
    externalId: z.string().optional().describe('Booking provider external ID'),
    createdOnOrAfter: z.string().optional().describe('ISO 8601; bookings created at or after this instant'),
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601; bookings modified at or after this instant'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
    includeTotal: z.boolean().optional().describe('Ask ST for totalCount; returned as total_count (null when omitted)'),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/bookings', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const data = await readST<{ data?: RawBooking[]; hasMore?: boolean; totalCount?: number }>(
      env,
      { actor, correlation },
      `/crm/v2/tenant/${env.ST_TENANT_ID}/bookings`,
      {
        externalId: args.externalId,
        createdOnOrAfter: args.createdOnOrAfter,
        modifiedOnOrAfter: args.modifiedOnOrAfter,
        includeTotal: args.includeTotal,
        page,
        pageSize,
      },
    );
    const rows = data.data ?? [];
    assertRowsMatchFilters<RawBooking>('bookings_list', rows, [{ param: 'externalId', want: args.externalId, get: (r) => r.externalId }], correlation);
    return {
      count: rows.length,
      bookings: rows.map(slim),
      has_more: !!data.hasMore,
      total_count: data.totalCount ?? null,
      page,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
