import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { billId: number }

export const ap_bill_get: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'ap_bill_get',
  description:
    'Get one posted AP bill by ID with its line items, expense items, vendor and job linkage. Source: live ST.',
  zodSchema: {
    billId: z.number().int().positive().describe('ST AP bill ID'),
  },
  stEndpoint: { method: 'GET', path: '/accounting/v2/tenant/{tid}/ap-bills/{billId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const bill = await readST<Record<string, unknown>>(
      env,
      { actor, correlation },
      `/accounting/v2/tenant/${env.ST_TENANT_ID}/ap-bills/${args.billId}`,
    );
    return { bill, _source: 'live' };
  },
  transformResult: defaultShaper,
};
