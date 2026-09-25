import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  templateId: number;
}

export const get_estimate_template: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'get_estimate_template',
  description: 'Get full details for a single estimate template, including its line items. Source: live ST.',
  zodSchema: {
    templateId: z.number().int().positive().describe('ST estimate template ID'),
  },
  outputSchema: {
    template: z.unknown(),
    _source: z.string(),
  },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/estimate-templates/{templateId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<unknown>(
      env,
      { actor, correlation },
      `/sales/v2/tenant/000000000/estimate-templates/${args.templateId}`,
    );
    return { template: data, _source: 'live' };
  },
  transformResult: defaultShaper,
};
