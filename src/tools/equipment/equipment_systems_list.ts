import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args {
  modifiedOnOrAfter?: string;
  createdOnOrAfter?: string;
  page?: number;
  pageSize?: number;
  includeTotal?: boolean;
}

interface RawSystem {
  id: number;
  name?: string;
  locationId?: number;
  customerId?: number;
  active?: boolean;
  modifiedOn?: string | null;
  equipment?: Array<{ id: number }>;
}

interface SlimSystem {
  id: number;
  name: string;
  location_id: number | null;
  customer_id: number | null;
  equipment_ids: number[];
  active: boolean | null;
  modified_on: string | null;
}

function slim(r: RawSystem): SlimSystem {
  return {
    id: r.id,
    name: r.name ?? '',
    location_id: r.locationId ?? null,
    customer_id: r.customerId ?? null,
    equipment_ids: (r.equipment ?? []).map((e) => e.id),
    active: r.active ?? null,
    modified_on: r.modifiedOn ?? null,
  };
}

const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const equipment_systems_list: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'equipment_systems_list',
  description:
    'List equipment systems (groups of installed equipment, e.g. one HVAC system = condenser + air handler). Source: live ST. No location filter exists on this endpoint; filter by date and match location_id client-side. Default page size 25, max 100.',
  zodSchema: {
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601; systems modified at or after this instant'),
    createdOnOrAfter: z.string().optional().describe('ISO 8601; systems created at or after this instant'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
    includeTotal: z.boolean().optional().describe('Ask ST for totalCount; returned as total_count (null when omitted)'),
  },
  stEndpoint: { method: 'GET', path: '/equipmentsystems/v2/tenant/{tid}/equipment-systems', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const data = await readST<{ data?: RawSystem[]; hasMore?: boolean; totalCount?: number }>(
      env,
      { actor, correlation },
      `/equipmentsystems/v2/tenant/${env.ST_TENANT_ID}/equipment-systems`,
      {
        modifiedOnOrAfter: args.modifiedOnOrAfter,
        createdOnOrAfter: args.createdOnOrAfter,
        includeTotal: args.includeTotal,
        page,
        pageSize,
      },
    );
    const rows = data.data ?? [];
    return {
      count: rows.length,
      systems: rows.map(slim),
      has_more: !!data.hasMore,
      total_count: data.totalCount ?? null,
      page,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
