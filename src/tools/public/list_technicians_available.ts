import { z } from 'zod';
import type { ToolDef } from '../types';
import { McpError } from '../../errors';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import { TECHNICIANS_PATH } from '../../st-roster';

interface Args {
  date?: string;
  businessUnitId?: number;
  businessUnitName?: string;
  page?: number;
  pageSize?: number;
}

export const list_technicians_available_public: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'list_technicians_available',
  description:
    'List the active technician roster from ServiceTitan Settings. ServiceTitan has no "available technicians by date" ' +
    'operation, so `date` does not filter by availability, and the roster cannot be filtered by business unit; both surface ' +
    'as _warnings. Source: live ST (Settings technicians). Default page size 50, max 200.',
  zodSchema: {
    date: z.string().optional().describe('Accepted for compatibility; ServiceTitan cannot filter the roster by date (returns a warning).'),
    businessUnitId: z.number().int().positive().optional().describe('Accepted for compatibility; the roster cannot be filtered by business unit (returns a warning).'),
    businessUnitName: z.string().min(1).optional().describe('Accepted for compatibility; the roster cannot be filtered by business unit (returns a warning).'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  stEndpoint: { method: 'GET', path: '/settings/v2/tenant/{tid}/technicians', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    if (args.businessUnitId !== undefined && args.businessUnitName !== undefined) {
      throw new McpError('validation_error', 'pass at most one of businessUnitId or businessUnitName', { correlation });
    }
    const warnings: string[] = [];
    if (args.date) warnings.push('date_ignored: ServiceTitan has no technician-availability-by-date endpoint; returning the active roster');
    if (args.businessUnitId !== undefined || args.businessUnitName !== undefined) {
      warnings.push('businessUnit_ignored: the ServiceTitan technician roster cannot be filtered by business unit');
    }
    const data = await readST<{ data?: unknown[] }>(env, { actor, correlation }, TECHNICIANS_PATH, {
      active: true,
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    });
    return { technicians: data.data ?? [], _source: 'live', ...(warnings.length > 0 ? { _warnings: warnings } : {}) };
  },
  transformResult: defaultShaper,
};
