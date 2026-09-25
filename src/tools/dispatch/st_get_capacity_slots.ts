import { z } from 'zod';
import { readSTPost } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  startsOnOrAfter: string;
  endsOnOrBefore: string;
  businessUnitIds?: number[];
  skillBasedAvailability?: boolean;
}

export const st_get_capacity_slots: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'st_get_capacity_slots',
  description:
    'Return bookable capacity SLOTS for a date range (the slot-finder used for live availability). POSTs to /dispatch/v2/tenant/{tid}/capacity. Overlaps `get_capacity` — both call the same ST /capacity endpoint. Source: live ST.',
  zodSchema: {
    startsOnOrAfter: z
      .string()
      .describe('ISO 8601 datetime — earliest slot start (inclusive)'),
    endsOnOrBefore: z
      .string()
      .describe('ISO 8601 datetime — latest slot end (inclusive)'),
    businessUnitIds: z
      .array(z.number().int().positive())
      .optional()
      .describe('Business unit IDs to constrain slot search'),
    skillBasedAvailability: z
      .boolean()
      .optional()
      .describe('Use skill-based availability matching (default: false)'),
  },
  stEndpoint: {
    method: 'POST',
    path: '/dispatch/v2/tenant/{tid}/capacity',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const body: Record<string, unknown> = {
      startsOnOrAfter: args.startsOnOrAfter,
      endsOnOrBefore: args.endsOnOrBefore,
      skillBasedAvailability: args.skillBasedAvailability ?? false,
    };
    if (args.businessUnitIds && args.businessUnitIds.length > 0) {
      body.businessUnitIds = args.businessUnitIds;
    }

    const data = await readSTPost<unknown>(
      env,
      { actor, correlation },
      '/dispatch/v2/tenant/000000000/capacity',
      body,
    );
    return { slots: data, _source: 'live' };
  },
  transformResult: defaultShaper,
};
