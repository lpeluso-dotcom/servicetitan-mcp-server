import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import { assertRowsMatchFilters } from '../filter-guard';
import type { ToolDef } from '../index';

interface Args {
  customerId?: number;
  invoiceId?: number;
  businessUnitId?: number;
  modifiedOnOrAfter?: string;
  createdOnOrAfter?: string;
  page?: number;
  pageSize?: number;
  includeTotal?: boolean;
}

interface RawPayment {
  id: number;
  status?: string;
  type?: { id?: number; name?: string } | string | null;
  paidOn?: string | null;
  total?: number;
  unappliedAmount?: number;
  referenceNumber?: string | null;
  customer?: { id?: number } | null;
  businessUnit?: { id?: number } | null;
  appliedTo?: Array<{ appliedTo?: number }>;
  modifiedOn?: string | null;
}

interface SlimPayment {
  id: number;
  status: string;
  type: string;
  paid_on: string | null;
  total: number;
  unapplied_amount: number;
  reference_number: string | null;
  customer_id: number | null;
  business_unit_id: number | null;
  applied_invoice_ids: number[];
  modified_on: string | null;
}

function typeName(t: RawPayment['type']): string {
  if (!t) return '';
  return typeof t === 'string' ? t : (t.name ?? '');
}

function slim(p: RawPayment): SlimPayment {
  return {
    id: p.id,
    status: p.status ?? '',
    type: typeName(p.type),
    paid_on: p.paidOn ?? null,
    total: p.total ?? 0,
    unapplied_amount: p.unappliedAmount ?? 0,
    reference_number: p.referenceNumber ?? null,
    customer_id: p.customer?.id ?? null,
    business_unit_id: p.businessUnit?.id ?? null,
    applied_invoice_ids: (p.appliedTo ?? []).map((a) => a.appliedTo).filter((v): v is number => typeof v === 'number'),
    modified_on: p.modifiedOn ?? null,
  };
}

const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const payments_list: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'payments_list',
  description:
    'List customer payments (card, check, cash, financing) with status, amount and the invoice ids each was applied to. Filter by customer, applied invoice, business unit or modified date. Source: live ST. Default page size 25, max 100.',
  zodSchema: {
    customerId: z.number().int().positive().optional().describe('Filter by ST customer ID'),
    invoiceId: z.number().int().positive().optional().describe('Only payments applied to this invoice ID (sent as appliedToInvoiceIds)'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID (sent as businessUnitIds)'),
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601; payments modified at or after this instant'),
    createdOnOrAfter: z.string().optional().describe('ISO 8601; payments created at or after this instant'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
    includeTotal: z.boolean().optional().describe('Ask ST for totalCount; returned as total_count (null when omitted)'),
  },
  stEndpoint: { method: 'GET', path: '/accounting/v2/tenant/{tid}/payments', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const data = await readST<{ data?: RawPayment[]; hasMore?: boolean; totalCount?: number }>(
      env,
      { actor, correlation },
      `/accounting/v2/tenant/${env.ST_TENANT_ID}/payments`,
      {
        customerId: args.customerId,
        appliedToInvoiceIds: args.invoiceId,
        businessUnitIds: args.businessUnitId,
        modifiedOnOrAfter: args.modifiedOnOrAfter,
        createdOnOrAfter: args.createdOnOrAfter,
        includeTotal: args.includeTotal,
        page,
        pageSize,
      },
    );
    const rows = data.data ?? [];
    assertRowsMatchFilters<RawPayment>('payments_list', rows, [
      { param: 'customerId', want: args.customerId, get: (r) => r.customer?.id },
      { param: 'invoiceId', want: args.invoiceId, get: (r) => (r.appliedTo ?? []).map((a) => a.appliedTo) },
      { param: 'businessUnitId', want: args.businessUnitId, get: (r) => r.businessUnit?.id },
    ], correlation);
    return {
      count: rows.length,
      payments: rows.map(slim),
      has_more: !!data.hasMore,
      total_count: data.totalCount ?? null,
      page,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
