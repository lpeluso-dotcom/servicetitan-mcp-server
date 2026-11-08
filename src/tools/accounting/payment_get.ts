import { z } from 'zod';
import { readST } from '../../st';
import { McpError } from '../../errors';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { paymentId: number }

export const payment_get: ToolDef<Args> = {
  isWrite: false,
  permission: 'staff',
  name: 'payment_get',
  description:
    'Get one payment by ID with every ST field (type, status, memo, applied invoices, batch). Source: live ST, fetched through the payments list with ids= because ST has no GET /payments/{id}; the call fails loudly if ST ignores the ids filter.',
  zodSchema: {
    paymentId: z.number().int().positive().describe('ST payment ID'),
  },
  stEndpoint: { method: 'GET', path: '/accounting/v2/tenant/{tid}/payments', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<{ data?: Array<{ id?: unknown }> }>(
      env,
      { actor, correlation },
      `/accounting/v2/tenant/${env.ST_TENANT_ID}/payments`,
      { ids: args.paymentId },
    );
    const row = data.data?.[0] ?? null;
    if (!row) throw new McpError('not_found', `payment ${args.paymentId} not found`, { correlation });
    const gotId = Number(row.id);
    if (gotId !== args.paymentId)
      throw new McpError('upstream_error', `ids filter not honored: asked ${args.paymentId}, got ${gotId}`, { correlation });
    return { payment: row, _source: 'live' };
  },
  transformResult: defaultShaper,
};
