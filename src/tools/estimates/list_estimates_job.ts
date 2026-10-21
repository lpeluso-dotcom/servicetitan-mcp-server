import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args { jobId: number; page?: number; pageSize?: number }

export const list_estimates_job: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'list_estimates_job',
  description: 'List all estimates for a specific job. Source: live ST. Default page size 50, max 200. Preserves pagination; continue with pagination.next_page until pagination.complete is true.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/estimates', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = {
      jobId: args.jobId,
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };
    const data = await readST<{ data?: unknown[]; hasMore?: boolean; page?: number; pageSize?: number; totalCount?: number }>(
      env,
      { actor, correlation },
      '/sales/v2/tenant/000000000/estimates',
      query,
    );
    if (!Array.isArray(data.data)) throw new Error('Estimate listing returned an invalid data page.');
    return {
      estimates: data.data,
      pagination: {
        page: data.page ?? query.page,
        page_size: data.pageSize ?? query.pageSize,
        has_more: typeof data.hasMore === 'boolean' ? data.hasMore : null,
        total_count: data.totalCount ?? null,
        next_page: data.hasMore === true ? Number(query.page) + 1 : null,
        complete: data.hasMore === false,
      },
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
