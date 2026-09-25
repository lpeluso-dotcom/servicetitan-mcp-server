import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args { estimateId: number }


export const get_estimate: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'get_estimate',
  description:
    'Get full details for a single estimate including line items and status. ' +
    'Source: live ST — fetched by id via /sales/v2 estimates/{id} (a valid by-id route; missing ids return a logical 404).',
  zodSchema: {
    estimateId: z.number().int().positive().describe('ST estimate ID'),
  },

  outputSchema: {
    estimate: z.unknown(),
    _source: z.string(),
  },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/estimates/{estimateId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<unknown>(
      env,
      { actor, correlation },
      `/sales/v2/tenant/000000000/estimates/${args.estimateId}`,
    );
    return { estimate: data, _source: 'live' };
  },
  transformResult: defaultShaper,
};
