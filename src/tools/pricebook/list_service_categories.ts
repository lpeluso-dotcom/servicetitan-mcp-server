import { z } from 'zod';
import { cacheGet } from '../../cache';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

const TENANT_ID = '000000000';

interface Args { active?: boolean; page?: number; pageSize?: number }

// Renamed from list_categories to disambiguate — materials/equipment have separate category trees.
export const list_service_categories: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'list_service_categories',
  description: 'List pricebook categories and their nested subcategory trees. Source: live ST. Default page size 25, max 200. Follow hasMore with the next page; large trees use authorized result pages.',
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/categories', source: 'live' },
  zodSchema: {
    active: z.boolean().optional().describe('Filter by active status (default: all)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(25).describe('Page size, max 200; reduce for large nested trees'),
  },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? 25;
    const cacheKey = JSON.stringify({ active: args.active ?? null, page, pageSize });

    return cacheGet(env, 'servicetitan:list_service_categories', cacheKey, 600, async () => {
      const query: Record<string, unknown> = {
        active: args.active,
        page,
        pageSize,
      };
      const data = await readST<{ data?: unknown[]; hasMore?: boolean; totalCount?: number }>(
        env,
        { actor, correlation },
        `/pricebook/v2/tenant/${TENANT_ID}/categories`,
        query,
      );
      return { categories: data.data ?? [], page, pageSize, hasMore: data.hasMore ?? false, totalCount: data.totalCount, _source: 'live' };
    });
  },
  transformResult: defaultShaper,
};
