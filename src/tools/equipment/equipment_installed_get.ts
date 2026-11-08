import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { equipmentId: number }

export const equipment_installed_get: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'equipment_installed_get',
  description:
    'Get one installed equipment record by ID with every ST field (warranties, memo, tags, custom fields). Source: live ST.',
  zodSchema: {
    equipmentId: z.number().int().positive().describe('ST installed-equipment ID (not the pricebook equipment SKU id)'),
  },
  stEndpoint: { method: 'GET', path: '/equipmentsystems/v2/tenant/{tid}/installed-equipment/{id}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const equipment = await readST<Record<string, unknown>>(
      env,
      { actor, correlation },
      `/equipmentsystems/v2/tenant/${env.ST_TENANT_ID}/installed-equipment/${args.equipmentId}`,
    );
    return { equipment, _source: 'live' };
  },
  transformResult: defaultShaper,
};
