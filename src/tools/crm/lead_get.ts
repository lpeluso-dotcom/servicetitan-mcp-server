import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { leadId: number }

export const lead_get: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'lead_get',
  description:
    'Get one CRM lead by ID with full detail (status, source call or booking, follow-up date, tags, dismissal reason). Source: live ST.',
  zodSchema: {
    leadId: z.number().int().positive().describe('ST lead ID'),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/leads/{id}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const lead = await readST<Record<string, unknown>>(
      env,
      { actor, correlation },
      `/crm/v2/tenant/${env.ST_TENANT_ID}/leads/${args.leadId}`,
    );
    return { lead, _source: 'live' };
  },
  transformResult: defaultShaper,
};
