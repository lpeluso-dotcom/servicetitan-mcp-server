import { z } from 'zod';
import { McpError } from '../../errors';
import { cacheGet } from '../../cache';
import { readST, rejectUnsupportedSTFilters } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args { name?: string; phone?: string; email?: string; page?: number; pageSize?: number }

interface RawCustomer {
  id: number;
  active?: boolean;
  name?: string;
  type?: string;
  address?: { street?: string; unit?: string | null; city?: string; state?: string; zip?: string };
  balance?: number;
  doNotService?: boolean;
  doNotMail?: boolean;
}

interface SlimCustomer {
  id: number;
  name: string;
  type: string;
  address: string;
  balance: number;
  do_not_service: boolean;
}

function slim(c: RawCustomer): SlimCustomer {
  const a = c.address || {};
  const parts = [a.street, a.unit, a.city, a.state, a.zip].filter(Boolean);
  return {
    id: c.id,
    name: c.name ?? '',
    type: c.type ?? '',
    address: parts.join(', ') || '',
    balance: c.balance ?? 0,
    do_not_service: !!c.doNotService,
  };
}

const DEFAULT_PAGESIZE = 10;
const MAX_PAGESIZE = 50;

export const find_customer: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'find_customer',
  description: 'Search ST customers by name or phone. Returns up to 10 slim records (id, name, type, address string, balance, do_not_service) by default — pass pageSize up to 50 for more. Source: live ST. NOTE: ServiceTitan has no email filter on this endpoint; passing `email` is rejected rather than silently ignored.',
  zodSchema: {
    name: z.string().optional().describe('Customer name (partial match)'),
    phone: z.string().optional().describe('Phone number. Digits or formatted ("5551234567", "(555) 123-4567", "555-123-4567") — ST normalizes all three.'),
    email: z
      .string()
      .optional()
      .describe('NOT SUPPORTED by ServiceTitan on this endpoint — passing it returns a validation error. Look the customer up by phone or name instead.'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
  },

  outputSchema: {
    count: z.number(),
    customers: z.array(z.record(z.string(), z.unknown())),
    _source: z.string(),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/customers', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    if (!args.name && !args.phone && !args.email) {
      throw new McpError('validation_error', 'find_customer requires at least one of: name, phone', { correlation });
    }
    
    
    rejectUnsupportedSTFilters(
      args as unknown as Record<string, unknown>,
      {
        email:
          'ServiceTitan exposes no email filter on /crm/v2/tenant/{tid}/customers. ' +
          'Search by `phone` or `name` instead; customer email addresses live on the ' +
          '/customers/contacts endpoint, which requires customer IDs up front.',
      },
      correlation,
    );
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const cacheKey = JSON.stringify({ name: args.name ?? '', phone: args.phone ?? '', page, pageSize });

    return cacheGet(env, 'servicetitan:find_customer', cacheKey, 30, async () => {
      const query: Record<string, unknown> = { page, pageSize };
      if (args.name) query.name = args.name;
      if (args.phone) query.phone = args.phone;

      const data = await readST<{ data?: RawCustomer[] }>(
        env,
        { actor, correlation },
        `/crm/v2/tenant/000000000/customers`,
        query,
      );
      const rows = (data.data ?? []).map(slim);
      return { count: rows.length, customers: rows, _source: 'live' };
    });
  },
  transformResult: defaultShaper,
};
