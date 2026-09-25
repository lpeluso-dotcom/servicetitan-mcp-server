import { z } from 'zod';
import { readSTPost } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  businessUnitIds: number[];
  startDate: string;
  endDate: string;
  skillBasedAvailability?: boolean;
}

export const get_capacity: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'get_capacity',
  description: 'Get dispatch capacity for business units over a date range (POST to ST /dispatch/v2/.../capacity; the body carries the filters). Overlaps st_get_capacity_slots — both call ST /capacity. Source: live ST.',
  zodSchema: {
    businessUnitIds: z.array(z.number().int().positive()).min(1).describe('Business unit IDs to check capacity for'),
    startDate: z.string().describe('Start date (YYYY-MM-DD)'),
    endDate: z.string().describe('End date (YYYY-MM-DD)'),
    skillBasedAvailability: z.boolean().optional().describe('Use skill-based availability matching (default: false)'),
  },
  stEndpoint: {
    method: 'POST',
    path: '/dispatch/v2/tenant/{tid}/capacity',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    
    const body = {
      businessUnitIds: args.businessUnitIds,
      startsOnOrAfter: args.startDate,
      endsOnOrBefore: args.endDate,
      skillBasedAvailability: args.skillBasedAvailability ?? false,
    };

    const data = await readSTPost<unknown>(
      env,
      { actor, correlation },
      '/dispatch/v2/tenant/000000000/capacity',
      body,
    );
    return { capacity: data, _source: 'live' };
  },
  transformResult: defaultShaper,
};
