import { z } from 'zod';
import { readSTPaged } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';
import { assertRowsMatchFilters } from '../filter-guard';

interface Args { customerId: number; active?: boolean }

// One customer rarely has more than a handful of memberships; 5 x 200 rows is
// a safety cap, disclosed as _truncated if it is ever hit.
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

export const get_customer_membership: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'get_customer_membership',
  description: 'Get every membership for one customer, all statuses unless active=true. Source: live ST (no D1 memberships table).',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    active: z.boolean().optional().describe('true = only memberships with status Active; omit or false = every status'),
  },
  stEndpoint: { method: 'GET', path: '/memberships/v2/tenant/{tid}/memberships', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    // ST takes `customerIds` (plural) and silently ignores `customerId`,
    // returning the tenant-wide list. ST's own `active` param is the
    // soft-delete flag (active=false returns deleted rows only), so the
    // tool's `active` maps to the status enum instead.
    const query: Record<string, unknown> = { customerIds: args.customerId };
    if (args.active) query.status = 'Active';
    const paged = await readSTPaged<Record<string, unknown>>(
      env,
      { actor, correlation },
      `/memberships/v2/tenant/000000000/memberships`,
      query,
      { pageSize: PAGE_SIZE, maxPages: MAX_PAGES },
    );
    assertRowsMatchFilters('get_customer_membership', paged.rows, [
      { param: 'customerId', want: args.customerId, get: (m) => m.customerId },
    ], correlation);
    // ST status filter is unreliable (see list_memberships_active); re-check.
    const memberships = args.active ? paged.rows.filter((m) => m.status === 'Active') : paged.rows;
    return {
      memberships,
      _source: 'live',
      _truncated: paged.hitCap ? { pages: paged.pagesFetched, rows: paged.rows.length } : undefined,
    };
  },
  transformResult: defaultShaper,
};
