import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { purchaseOrderId: number }

export const purchase_order_get: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'purchase_order_get',
  description:
    'Get one purchase order by ID with line items, vendor, ship-to and receiving status. Source: live ST.',
  zodSchema: {
    purchaseOrderId: z.number().int().positive().describe('ST purchase order ID (not the PO number)'),
  },
  stEndpoint: { method: 'GET', path: '/inventory/v2/tenant/{tid}/purchase-orders/{id}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const purchase_order = await readST<Record<string, unknown>>(
      env,
      { actor, correlation },
      `/inventory/v2/tenant/${env.ST_TENANT_ID}/purchase-orders/${args.purchaseOrderId}`,
    );
    return { purchase_order, _source: 'live' };
  },
  transformResult: defaultShaper,
};
