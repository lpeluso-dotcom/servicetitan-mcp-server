import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args { jobId: number }

export const get_job: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'get_job',
  description:
    'Get a single ST job by ID. Response includes `isAutoDispatched` (boolean), ' +
    '`projectId` (number|null), and the standard JPM job fields. Source: live ST.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
  },

  outputSchema: {
    job: z.record(z.string(), z.unknown()).nullable(),
    _source: z.string(),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/jobs/{id}',
    source: 'live',
  },
  async handler(env, args, ctx) {
    const tenant = env.ST_TENANT_ID;
    const job = await readST(env, ctx, `/jpm/v2/tenant/${tenant}/jobs/${args.jobId}`);
    return { job, _source: 'live' };
  },
  transformResult: defaultShaper,
};
