import { z } from 'zod';
import type { ToolDef } from './types';

export const get_result_page: ToolDef = {
  name: 'get_result_page', permission: 'staff', isWrite: false,
  description: 'Retrieve one authenticated, computed page from a previously offloaded result. Pass _result_id and _next_cursor from the original response. Pages are independently parseable; next_cursor is null on the final page. Ownership, role, original-tool allowlist and 15-minute expiry are enforced.',
  zodSchema: {
    result_id: z.string().min(1).max(128),
    cursor: z.number().int().nonnegative().optional().describe('Page cursor; default 0'),
  },
  stEndpoint: { method: 'GET', path: 'local:result-pages', source: 'computed' },
  handler: async () => { throw new Error('Registry handles result retrieval'); },
};

export const st_operation_status: ToolDef = {
  name: 'st_operation_status', permission: 'staff', isWrite: false,
  description: 'Recover a previously submitted write by operation_id, from a computed, local record of its current status. Identity and current role must match. Never resubmit an unknown write.',
  zodSchema: { operation_id: z.string().regex(/^[a-f0-9]{64}$/) },
  stEndpoint: { method: 'GET', path: 'local:operations', source: 'computed' },
  handler: async () => { throw new Error('Registry handles operation recovery'); },
};
