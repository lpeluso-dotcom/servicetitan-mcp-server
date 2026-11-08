import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { agreementId: number }

export const service_agreement_get: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'service_agreement_get',
  description:
    'Get one service agreement by ID with every ST field, including its visits and pricing terms. Source: live ST. Service agreements are not memberships; for memberships use get_customer_membership.',
  zodSchema: {
    agreementId: z.number().int().positive().describe('ST service agreement ID'),
  },
  stEndpoint: { method: 'GET', path: '/service-agreements/v2/tenant/{tid}/service-agreements/{id}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const agreement = await readST<Record<string, unknown>>(
      env,
      { actor, correlation },
      `/service-agreements/v2/tenant/${env.ST_TENANT_ID}/service-agreements/${args.agreementId}`,
    );
    return { agreement, _source: 'live' };
  },
  transformResult: defaultShaper,
};
