import { z } from 'zod';
import { readST } from '../../st';
import { cacheGet } from '../../cache';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args { businessUnitId?: number; customerId?: number; page?: number; pageSize?: number }

interface RawInvoice {
  balance?: number | string | null;
  [key: string]: unknown;
}

const ST_SCAN_PAGE_SIZE = 50;

const MAX_SCAN_PAGES = 25;

export const list_unpaid_invoices: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'list_unpaid_invoices',
  description:
    'List invoices with an outstanding balance (unpaid or partially paid). Source: live ST (accounting invoices, ' +
    'filtered client-side to balance ≠ 0; cached 120s). ST ignores its own balance filter, so pages are drained and ' +
    'windowed locally. Check `_scan_complete`: when false the scan hit its page budget and the result is NOT ' +
    'exhaustive — an empty list then means "stopped looking", not "nothing outstanding". ' +
    'Default page size 50, max 200.',
  zodSchema: {
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    customerId: z.number().int().positive().optional().describe('Filter by customer ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },

  outputSchema: {
    invoices: z.array(z.record(z.string(), z.unknown())),
    _source: z.string(),
    _scan_complete: z.boolean(),
    _pages_scanned: z.number(),
    _unpaid_found: z.number(),
    _warning: z.string().optional(),
  },
  stEndpoint: { method: 'GET', path: '/accounting/v2/tenant/{tid}/invoices', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? 50;
    const cacheKey = JSON.stringify({ bu: args.businessUnitId ?? 0, customer: args.customerId ?? 0, page, pageSize });

    return cacheGet(env, 'servicetitan:list_unpaid_invoices', cacheKey, 120, async () => {

      const baseQuery: Record<string, unknown> = {};
      if (args.businessUnitId) baseQuery.businessUnitIds = args.businessUnitId;
      if (args.customerId) baseQuery.customerId = args.customerId;

      const needed = page * pageSize;
      const unpaid: RawInvoice[] = [];
      let stPage = 1;
      let exhausted = false;

      while (unpaid.length < needed && stPage <= MAX_SCAN_PAGES) {
        const data = await readST<{ data?: RawInvoice[]; hasMore?: boolean }>(
          env,
          { actor, correlation },
          '/accounting/v2/tenant/000000000/invoices',
          { ...baseQuery, page: stPage, pageSize: ST_SCAN_PAGE_SIZE },
        );
        const rows = data.data ?? [];
        for (const invoice of rows) {
          
          const n = Number(invoice.balance ?? 0);
          if (!Number.isFinite(n) || n !== 0) unpaid.push(invoice);
        }
        if (!data.hasMore) { exhausted = true; break; }
        stPage += 1;
      }

      const pagesScanned = Math.min(stPage, MAX_SCAN_PAGES);
      const scanComplete = exhausted || unpaid.length >= needed;
      const invoices = unpaid.slice((page - 1) * pageSize, needed);

      return {
        invoices,
        _source: 'live',
        _scan_complete: scanComplete,
        _pages_scanned: pagesScanned,
        _unpaid_found: unpaid.length,
        ...(scanComplete ? {} : {
          _warning:
            `page budget reached: scanned ${pagesScanned} ST pages ` +
            `(${pagesScanned * ST_SCAN_PAGE_SIZE} invoices) without exhausting the source, ` +
            `so this result is NOT exhaustive — more unpaid invoices may exist. ` +
            `Narrow with businessUnitId or customerId for a complete answer.`,
        }),
      };
    });
  },
  transformResult: defaultShaper,
};
