import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { bookingId: number }

export const booking_get: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'booking_get',
  description:
    'Get one booking by ID with every ST field including service address and contacts. Source: live ST.',
  zodSchema: {
    bookingId: z.number().int().positive().describe('ST booking ID'),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/bookings/{id}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const booking = await readST<Record<string, unknown>>(
      env,
      { actor, correlation },
      `/crm/v2/tenant/${env.ST_TENANT_ID}/bookings/${args.bookingId}`,
    );
    return { booking, _source: 'live' };
  },
  transformResult: defaultShaper,
};
