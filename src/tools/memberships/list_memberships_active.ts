import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args { customerId?: number; locationId?: number; page?: number; pageSize?: number }

const ESSENTIAL_FIELDS = [
  'id', 'status', 'customerId', 'locationId', 'membershipTypeId',
  'businessUnitId', 'from', 'to', 'duration', 'billingFrequency',
  'followUpStatus', 'cancellationDate', 'nextScheduledBillDate',
] as const;

function trim(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ESSENTIAL_FIELDS) out[k] = m[k];
  return out;
}

export const list_memberships_active: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'list_memberships_active',
  description: 'List active memberships. Source: live ST. Response is trimmed to essential fields; client-side filtered to status=Active since ST statuses param filters on the meaningless active-bool, not the status enum. Default page size 50, max 100 (capped to keep response under the MCP token limit).',
  zodSchema: {
    customerId: z.number().int().positive().optional().describe('Filter by customer ID'),
    locationId: z.number().int().positive().optional().describe('Filter by location ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(100).default(50).describe('Page size, max 100 (capped to keep response under MCP token limit)'),
  },
  stEndpoint: { method: 'GET', path: '/memberships/v2/tenant/{tid}/memberships', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = {
      status: 'Active',
      customerId: args.customerId,
      locationId: args.locationId,
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };

    const data = await readST<{ data?: Record<string, unknown>[] }>(
      env,
      { actor, correlation },
      `/memberships/v2/tenant/000000000/memberships`,
      query,
    );
    const raw = data.data ?? [];
    const activeOnly = raw.filter((m) => m.status === 'Active');
    return {
      memberships: activeOnly.map(trim),
      _source: 'live',
      _filtered: raw.length !== activeOnly.length ? { received: raw.length, kept: activeOnly.length } : undefined,
    };
  },
  transformResult: defaultShaper,
};
