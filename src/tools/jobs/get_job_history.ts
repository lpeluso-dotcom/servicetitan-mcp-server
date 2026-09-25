import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  jobId: number;
  page?: number;
  pageSize?: number;
}

export const get_job_history: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'get_job_history',
  description:
    'Get the audit-log / event timeline for a single ST job: booking events, capacity-tool usage, ' +
    'status changes, reassignments, etc. Returns the raw event list. Use for per-job audits when ' +
    'aggregate reports do not break out the signal you need. Source: live ST. Default page size 100, max 500.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe('Page size, default 100, max 500'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/jobs/{id}/history',
    source: 'live',
  },
  async handler(env, args, ctx) {
    const tenant = env.ST_TENANT_ID;
    const query: Record<string, unknown> = {};
    if (args.page !== undefined) query.page = args.page;
    if (args.pageSize !== undefined) query.pageSize = args.pageSize;

    const data = await readST<{
      data?: unknown[];
      hasMore?: boolean;
      totalCount?: number | null;
    }>(env, ctx, `/jpm/v2/tenant/${tenant}/jobs/${args.jobId}/history`, query);

    return {
      jobId: args.jobId,
      events: data.data ?? [],
      count: (data.data ?? []).length,
      has_more: data.hasMore ?? false,
      total_count: data.totalCount ?? null,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
