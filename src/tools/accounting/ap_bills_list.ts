import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import { assertRowsMatchFilters } from '../filter-guard';
import type { ToolDef } from '../index';

interface Args {
  billNumber?: string;
  jobNumber?: string;
  syncStatus?: 'Pending' | 'Posted' | 'Exported';
  dateFrom?: string;
  dateTo?: string;
  modifiedOnOrAfter?: string;
  page?: number;
  pageSize?: number;
  includeTotal?: boolean;
}

interface RawBill {
  id: number;
  referenceNumber?: string | null;
  vendor?: { id?: number; name?: string } | null;
  jobId?: number | null;
  businessUnitId?: number | null;
  billDate?: string | null;
  dueDate?: string | null;
  total?: number;
  tax?: number;
  shipping?: number;
  syncStatus?: string;
  items?: unknown[];
  modifiedOn?: string | null;
}

interface SlimBill {
  id: number;
  reference_number: string | null;
  vendor_id: number | null;
  vendor_name: string | null;
  job_id: number | null;
  business_unit_id: number | null;
  bill_date: string | null;
  due_date: string | null;
  total: number;
  tax: number;
  shipping: number;
  sync_status: string;
  item_count: number;
  modified_on: string | null;
}

function slim(b: RawBill): SlimBill {
  return {
    id: b.id,
    reference_number: b.referenceNumber ?? null,
    vendor_id: b.vendor?.id ?? null,
    vendor_name: b.vendor?.name ?? null,
    job_id: b.jobId ?? null,
    business_unit_id: b.businessUnitId ?? null,
    bill_date: b.billDate ?? null,
    due_date: b.dueDate ?? null,
    total: b.total ?? 0,
    tax: b.tax ?? 0,
    shipping: b.shipping ?? 0,
    sync_status: b.syncStatus ?? '',
    item_count: Array.isArray(b.items) ? b.items.length : 0,
    modified_on: b.modifiedOn ?? null,
  };
}

const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const ap_bills_list: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'ap_bills_list',
  description:
    'List posted AP (vendor) bills: vendor, job, dates, totals, sync status. These are filed bills; documents still waiting in the AP inbox are ap_inbox_list_documents. Source: live ST. Default page size 25, max 100.',
  zodSchema: {
    billNumber: z.string().optional().describe('Vendor invoice / bill number as entered on the bill'),
    jobNumber: z.string().optional().describe('ST job number the bill is costed to'),
    syncStatus: z.enum(['Pending', 'Posted', 'Exported']).optional().describe('Accounting sync status'),
    dateFrom: z.string().optional().describe('ISO date; bills dated on or after'),
    dateTo: z.string().optional().describe('ISO date; bills dated on or before'),
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601; bills modified at or after this instant'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
    includeTotal: z.boolean().optional().describe('Ask ST for totalCount; returned as total_count (null when omitted)'),
  },
  stEndpoint: { method: 'GET', path: '/accounting/v2/tenant/{tid}/ap-bills', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const data = await readST<{ data?: RawBill[]; hasMore?: boolean; totalCount?: number }>(
      env,
      { actor, correlation },
      `/accounting/v2/tenant/${env.ST_TENANT_ID}/ap-bills`,
      {
        billNumber: args.billNumber,
        jobNumber: args.jobNumber,
        syncStatus: args.syncStatus,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        modifiedOnOrAfter: args.modifiedOnOrAfter,
        includeTotal: args.includeTotal,
        page,
        pageSize,
      },
    );
    const rows = data.data ?? [];
    assertRowsMatchFilters<RawBill>('ap_bills_list', rows, [{ param: 'syncStatus', want: args.syncStatus, get: (r) => r.syncStatus }], correlation);
    return {
      count: rows.length,
      bills: rows.map(slim),
      has_more: !!data.hasMore,
      total_count: data.totalCount ?? null,
      page,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
