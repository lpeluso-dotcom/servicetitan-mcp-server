import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import { assertRowsMatchFilters } from '../filter-guard';
import type { ToolDef } from '../index';

interface Args {
  customerId?: number;
  status?: 'Open' | 'Dismissed' | 'Converted';
  isProspect?: boolean;
  createdOnOrAfter?: string;
  modifiedOnOrAfter?: string;
  page?: number;
  pageSize?: number;
  includeTotal?: boolean;
}

interface RawLead {
  id: number;
  status?: string;
  customerId?: number | null;
  locationId?: number | null;
  businessUnitId?: number | null;
  jobTypeId?: number | null;
  priority?: string | null;
  campaignId?: number | null;
  summary?: string | null;
  followUpDate?: string | null;
  callId?: number | null;
  bookingId?: number | null;
  createdOn?: string | null;
  modifiedOn?: string | null;
}

interface SlimLead {
  id: number;
  status: string;
  customer_id: number | null;
  location_id: number | null;
  business_unit_id: number | null;
  job_type_id: number | null;
  priority: string | null;
  campaign_id: number | null;
  summary: string;
  follow_up_date: string | null;
  call_id: number | null;
  booking_id: number | null;
  created_on: string | null;
  modified_on: string | null;
}

function slim(l: RawLead): SlimLead {
  return {
    id: l.id,
    status: l.status ?? '',
    customer_id: l.customerId ?? null,
    location_id: l.locationId ?? null,
    business_unit_id: l.businessUnitId ?? null,
    job_type_id: l.jobTypeId ?? null,
    priority: l.priority ?? null,
    campaign_id: l.campaignId ?? null,
    summary: l.summary ?? '',
    follow_up_date: l.followUpDate ?? null,
    call_id: l.callId ?? null,
    booking_id: l.bookingId ?? null,
    created_on: l.createdOn ?? null,
    modified_on: l.modifiedOn ?? null,
  };
}

const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const leads_list: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'leads_list',
  description:
    'List CRM leads (unbooked sales opportunities from calls, web forms and Lace) by customer, status, prospect flag or date window. Slim rows; use lead_get for full detail. Source: live ST. Default page size 25, max 100.',
  zodSchema: {
    customerId: z.number().int().positive().optional().describe('Filter by ST customer ID'),
    status: z.enum(['Open', 'Dismissed', 'Converted']).optional().describe('Lead status'),
    isProspect: z.boolean().optional().describe('true = leads with no existing customer record'),
    createdOnOrAfter: z.string().optional().describe('ISO 8601; leads created at or after this instant'),
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601; leads modified at or after this instant'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
    includeTotal: z.boolean().optional().describe('Ask ST for totalCount; returned as total_count (null when omitted)'),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/leads', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const data = await readST<{ data?: RawLead[]; hasMore?: boolean; totalCount?: number }>(
      env,
      { actor, correlation },
      `/crm/v2/tenant/${env.ST_TENANT_ID}/leads`,
      {
        customerId: args.customerId,
        status: args.status,
        isProspect: args.isProspect,
        createdOnOrAfter: args.createdOnOrAfter,
        modifiedOnOrAfter: args.modifiedOnOrAfter,
        includeTotal: args.includeTotal,
        page,
        pageSize,
      },
    );
    const rows = data.data ?? [];
    assertRowsMatchFilters<RawLead>('leads_list', rows, [
      { param: 'customerId', want: args.customerId, get: (r) => r.customerId },
      { param: 'status', want: args.status, get: (r) => r.status },
    ], correlation);
    return {
      count: rows.length,
      leads: rows.map(slim),
      has_more: !!data.hasMore,
      total_count: data.totalCount ?? null,
      page,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
