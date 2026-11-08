import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import { assertRowsMatchFilters } from '../filter-guard';
import type { ToolDef } from '../index';

interface Args {
  jobId?: number;
  technicianId?: number;
  projectId?: number;
  status?: string;
  number?: string;
  createdOnOrAfter?: string;
  modifiedOnOrAfter?: string;
  page?: number;
  pageSize?: number;
  includeTotal?: boolean;
}

interface RawPurchaseOrder {
  id: number;
  number?: string | null;
  status?: string | null;
  jobId?: number | null;
  projectId?: number | null;
  vendorId?: number | null;
  technicianId?: number | null;
  businessUnitId?: number | null;
  date?: string | null;
  requiredOn?: string | null;
  receivedOn?: string | null;
  total?: number;
  tax?: number;
  shipping?: number;
  items?: unknown[];
  modifiedOn?: string | null;
}

interface SlimPurchaseOrder {
  id: number;
  number: string;
  status: string;
  job_id: number | null;
  project_id: number | null;
  vendor_id: number | null;
  technician_id: number | null;
  business_unit_id: number | null;
  date: string | null;
  required_on: string | null;
  received_on: string | null;
  total: number;
  tax: number;
  shipping: number;
  item_count: number;
  modified_on: string | null;
}

function slim(p: RawPurchaseOrder): SlimPurchaseOrder {
  return {
    id: p.id,
    number: p.number ?? '',
    status: p.status ?? '',
    job_id: p.jobId ?? null,
    project_id: p.projectId ?? null,
    vendor_id: p.vendorId ?? null,
    technician_id: p.technicianId ?? null,
    business_unit_id: p.businessUnitId ?? null,
    date: p.date ?? null,
    required_on: p.requiredOn ?? null,
    received_on: p.receivedOn ?? null,
    total: p.total ?? 0,
    tax: p.tax ?? 0,
    shipping: p.shipping ?? 0,
    item_count: Array.isArray(p.items) ? p.items.length : 0,
    modified_on: p.modifiedOn ?? null,
  };
}

const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const purchase_orders_list: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'purchase_orders_list',
  description:
    'List purchase orders by job, technician, project, status, PO number or date window. Slim rows with totals and item_count; use purchase_order_get for line items. Source: live ST. Default page size 25, max 100.',
  zodSchema: {
    jobId: z.number().int().positive().optional().describe('Filter by ST job ID'),
    technicianId: z.number().int().positive().optional().describe('Filter by requesting technician ID'),
    projectId: z.number().int().positive().optional().describe('Filter by project ID'),
    status: z.string().optional().describe('ST PO status, e.g. Pending, Sent, PartiallyReceived, Received, Canceled'),
    number: z.string().optional().describe('Exact PO number'),
    createdOnOrAfter: z.string().optional().describe('ISO 8601; POs created at or after this instant'),
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601; POs modified at or after this instant'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
    includeTotal: z.boolean().optional().describe('Ask ST for totalCount; returned as total_count (null when omitted)'),
  },
  stEndpoint: { method: 'GET', path: '/inventory/v2/tenant/{tid}/purchase-orders', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const data = await readST<{ data?: RawPurchaseOrder[]; hasMore?: boolean; totalCount?: number }>(
      env,
      { actor, correlation },
      `/inventory/v2/tenant/${env.ST_TENANT_ID}/purchase-orders`,
      {
        jobId: args.jobId,
        technicianId: args.technicianId,
        projectId: args.projectId,
        status: args.status,
        number: args.number,
        createdOnOrAfter: args.createdOnOrAfter,
        modifiedOnOrAfter: args.modifiedOnOrAfter,
        includeTotal: args.includeTotal,
        page,
        pageSize,
      },
    );
    const rows = data.data ?? [];
    assertRowsMatchFilters<RawPurchaseOrder>('purchase_orders_list', rows, [
      { param: 'jobId', want: args.jobId, get: (r) => r.jobId },
      { param: 'technicianId', want: args.technicianId, get: (r) => r.technicianId },
      { param: 'projectId', want: args.projectId, get: (r) => r.projectId },
      { param: 'status', want: args.status, get: (r) => r.status },
      { param: 'number', want: args.number, get: (r) => r.number },
    ], correlation);
    return {
      count: rows.length,
      purchase_orders: rows.map(slim),
      has_more: !!data.hasMore,
      total_count: data.totalCount ?? null,
      page,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
