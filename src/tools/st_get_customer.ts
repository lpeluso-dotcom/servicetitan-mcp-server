// st_get_customer — fetch a single ServiceTitan customer by ID. Cached 5 min.
// Returns the raw customer record (get_customer wraps it as { customer, _source }).

import { z } from 'zod';
import { cacheGet } from '../cache';
import { McpError } from '../errors';
import { readST } from '../st';
import type { ToolDef } from './index';
import { defaultShaper } from '../response-shape';

const TENANT_ID = '000000000';
const NAMESPACE = 'servicetitan:customer';
const CACHE_TTL_SEC = 300;

interface Args {
  customerId: number;
}

export const st_get_customer: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'st_get_customer',
  description: 'Get a single ServiceTitan customer by ID. Read-only. Cached 5 min. Source: live ServiceTitan.',
  zodSchema: {
    customerId: z.number().int().positive().describe('ServiceTitan customer ID'),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/customers/{customerId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    if (!args.customerId || typeof args.customerId !== 'number') {
      throw new McpError('validation_error', 'customerId is required and must be a number', { correlation });
    }
    const endpoint = `/crm/v2/tenant/${TENANT_ID}/customers/${args.customerId}`;
    const cacheKey = String(args.customerId);

    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, async () =>
      readST(env, { actor, correlation }, endpoint),
    );
  },
  transformResult: defaultShaper,
};
