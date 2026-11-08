import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import { assertRowsMatchFilters } from '../filter-guard';
import type { ToolDef } from '../index';
import { slimInstalledEquipment, type RawInstalledEquipment } from './installed_equipment_shape';

interface Args {
  locationId?: number;
  customerId?: number;
  active?: 'True' | 'Any' | 'False';
  modifiedOnOrAfter?: string;
  createdOnOrAfter?: string;
  page?: number;
  pageSize?: number;
  includeTotal?: boolean;
}

const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const equipment_installed_list: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'equipment_installed_list',
  description:
    'List installed equipment records (make, model, serial, warranty dates) at a location or for a customer. Source: live ST. Slim rows; use equipment_installed_get for the full record. Default page size 25, max 100.',
  zodSchema: {
    locationId: z.number().int().positive().optional().describe('Filter by ST location ID'),
    customerId: z.number().int().positive().optional().describe('Filter by ST customer ID'),
    active: z.enum(['True', 'Any', 'False']).optional().describe('ST active filter; omit for ST default (active only)'),
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601; records modified at or after this instant'),
    createdOnOrAfter: z.string().optional().describe('ISO 8601; records created at or after this instant'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
    includeTotal: z.boolean().optional().describe('Ask ST for totalCount; returned as total_count (null when omitted)'),
  },
  stEndpoint: { method: 'GET', path: '/equipmentsystems/v2/tenant/{tid}/installed-equipment', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const data = await readST<{ data?: RawInstalledEquipment[]; hasMore?: boolean; totalCount?: number }>(
      env,
      { actor, correlation },
      `/equipmentsystems/v2/tenant/${env.ST_TENANT_ID}/installed-equipment`,
      {
        locationId: args.locationId,
        customerId: args.customerId,
        active: args.active,
        modifiedOnOrAfter: args.modifiedOnOrAfter,
        createdOnOrAfter: args.createdOnOrAfter,
        includeTotal: args.includeTotal,
        page,
        pageSize,
      },
    );
    const rows = data.data ?? [];
    assertRowsMatchFilters<RawInstalledEquipment>('equipment_installed_list', rows, [
      { param: 'locationId', want: args.locationId, get: (r) => r.locationId },
      { param: 'customerId', want: args.customerId, get: (r) => r.customerId },
    ], correlation);
    return {
      count: rows.length,
      equipment: rows.map(slimInstalledEquipment),
      has_more: !!data.hasMore,
      total_count: data.totalCount ?? null,
      page,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
