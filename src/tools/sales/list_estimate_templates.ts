import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  active?: 'Any' | 'True' | 'False';
  businessUnitId?: number;
  page?: number;
  pageSize?: number;
}

export const list_estimate_templates: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'list_estimate_templates',
  description:
    'List estimate templates (reusable line-item bundles used to build estimates). ' +
    'Defaults to active=Any rather than active-only — an active-only default would hide the ' +
    'inactive/retired templates that people most often need to find and re-edit. Pass ' +
    'active="True" to see only active templates. Returns one page (default 50); follow hasMore with the next page. Source: live ST.',
  zodSchema: {
    active: z
      .enum(['Any', 'True', 'False'])
      .optional()
      .describe('Filter by active flag. Default "Any" (see description for why active-only is not the default).'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    page: z.number().int().positive().default(1),
    pageSize: z.number().int().positive().max(50).default(50),
  },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/estimate-templates', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? 50;
    const data = await readST<{data?: Record<string, unknown>[]; totalCount?: number; hasMore?: boolean}>(
      env,
      { actor, correlation },
      '/sales/v2/tenant/000000000/estimate-templates',
      { active: args.active ?? 'Any', businessUnitId: args.businessUnitId, page, pageSize },
    );
    const rows = data.data ?? [];
    return { templates: rows, count: data.totalCount ?? rows.length, page, pageSize, hasMore: data.hasMore ?? false, _source: 'live' };
  },
  transformResult: defaultShaper,
};
