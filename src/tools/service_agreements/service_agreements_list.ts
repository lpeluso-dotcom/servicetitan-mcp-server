import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import { assertRowsMatchFilters } from '../filter-guard';
import type { ToolDef } from '../index';

interface Args {
  customerId?: number;
  businessUnitId?: number;
  status?: string;
  modifiedOnOrAfter?: string;
  createdOnOrAfter?: string;
  page?: number;
  pageSize?: number;
  includeTotal?: boolean;
}

interface RawAgreement {
  id: number;
  name?: string;
  agreementNumber?: string;
  customerId?: number;
  businessUnitId?: number;
  status?: string;
  startDate?: string | null;
  endDate?: string | null;
  totalPrice?: number | null;
  modifiedOn?: string | null;
}

interface SlimAgreement {
  id: number;
  name: string;
  agreement_number: string;
  customer_id: number | null;
  business_unit_id: number | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  total_price: number | null;
  modified_on: string | null;
}

function slim(r: RawAgreement): SlimAgreement {
  return {
    id: r.id,
    name: r.name ?? '',
    agreement_number: r.agreementNumber ?? '',
    customer_id: r.customerId ?? null,
    business_unit_id: r.businessUnitId ?? null,
    status: r.status ?? '',
    start_date: r.startDate ?? null,
    end_date: r.endDate ?? null,
    total_price: r.totalPrice ?? null,
    modified_on: r.modifiedOn ?? null,
  };
}

const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const service_agreements_list: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'service_agreements_list',
  description:
    'List commercial service agreements (not memberships) by customer, business unit, status or modified date. Source: live ST. Slim rows; use service_agreement_get for visits and full detail. Default page size 25, max 100.',
  zodSchema: {
    customerId: z.number().int().positive().optional().describe('Filter by ST customer ID (sent as customerIds)'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID (sent as businessUnitIds)'),
    status: z.string().optional().describe('ST agreement status, e.g. Draft, Active, Expired, Cancelled'),
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601; agreements modified at or after this instant'),
    createdOnOrAfter: z.string().optional().describe('ISO 8601; agreements created at or after this instant'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
    includeTotal: z.boolean().optional().describe('Ask ST for totalCount; returned as total_count (null when omitted)'),
  },
  stEndpoint: { method: 'GET', path: '/service-agreements/v2/tenant/{tid}/service-agreements', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const data = await readST<{ data?: RawAgreement[]; hasMore?: boolean; totalCount?: number }>(
      env,
      { actor, correlation },
      `/service-agreements/v2/tenant/${env.ST_TENANT_ID}/service-agreements`,
      {
        customerIds: args.customerId,
        businessUnitIds: args.businessUnitId,
        status: args.status,
        modifiedOnOrAfter: args.modifiedOnOrAfter,
        createdOnOrAfter: args.createdOnOrAfter,
        includeTotal: args.includeTotal,
        page,
        pageSize,
      },
    );
    const rows = data.data ?? [];
    assertRowsMatchFilters<RawAgreement>('service_agreements_list', rows, [
      { param: 'customerId', want: args.customerId, get: (r) => r.customerId },
      { param: 'businessUnitId', want: args.businessUnitId, get: (r) => r.businessUnitId },
      { param: 'status', want: args.status, get: (r) => r.status },
    ], correlation);
    return {
      count: rows.length,
      agreements: rows.map(slim),
      has_more: !!data.hasMore,
      total_count: data.totalCount ?? null,
      page,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
